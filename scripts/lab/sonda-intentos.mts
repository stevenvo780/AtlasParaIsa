/**
 * scripts/lab/sonda-intentos.mts — corre el mundo de `encender` (un hilo, sin comprobar) y cada día cuenta lo que pasa
 * por los buzones (v23.intentos): intentos enviados por tipo y lo que el aplicador hizo con ellos (aplicados, devueltos,
 * depositados en el Suelo, reenviados, duplicados descartados), por cola. Solo mide: no cambia nada del mundo.
 *
 *   tsx scripts/lab/sonda-intentos.mts --semilla 7 --hasta intentos --dias 2 [--cada 2400]
 */
import { createWorld, stepWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { ctxSi } from '../../src/world/motor/acceso.js';
import { balanceAplicador } from '../../src/world/motor/aplicar.js';
import { TipoIntento } from '../../src/world/motor/contratos.js';
import { argumentosEncender, paramsDeEncender } from './encender.mjs';

const args = process.argv.slice(2);
const iCada = args.indexOf('--cada');
const cada = iCada >= 0 ? Number(args.splice(iCada, 2)[1]) : TICKS_PER_DAY;
const o = argumentosEncender(args);
const mundo = createWorld(o.semilla, paramsDeEncender(o));
process.title = 'carta-isa';

const NOMBRE = Object.fromEntries(Object.entries(TipoIntento).map(([n, t]) => [t, n])) as Record<number, string>;
const enviados: Record<string, number> = {};
const resultado: Record<string, number> = {};
const envuelto = new WeakSet<object>();

/** Envuelve el buzón y el aplicador del dueño único (el contexto nace en el primer paso). */
function envolver(): void {
  const c = ctxSi(mundo) as any;
  if (!c || envuelto.has(c)) return;
  envuelto.add(c);
  const enviar = c.buzon.enviar.bind(c.buzon);
  c.buzon.enviar = (destino: number, i: { tipo: number }) => {
    const k = NOMBRE[i.tipo] ?? String(i.tipo);
    enviados[k] = (enviados[k] ?? 0) + 1;
    return enviar(destino, i);
  };
  const aplicar = c.aplicar.bind(c);
  c.aplicar = (cola: 'M' | 'A' | 'B') => {
    const antes = balanceAplicador(c);
    aplicar(cola);
    const despues = balanceAplicador(c);
    for (const k of ['aplicados', 'devueltos', 'depositados', 'reenviados', 'duplicados'] as const) {
      const d = despues[k] - antes[k];
      if (d) resultado[`${cola}.${k}`] = (resultado[`${cola}.${k}`] ?? 0) + d;
    }
  };
}

const ticks = o.dias * TICKS_PER_DAY;
for (let t = 1; t <= ticks; t++) {
  stepWorld(mundo);
  envolver();
  if (t % cada === 0) {
    process.stdout.write(JSON.stringify({ tick: mundo.tick, poblacion: mundo.people.length, fauna: mundo.animals.length,
      enviados: { ...enviados }, resultado: { ...resultado } }) + '\n');
  }
}
