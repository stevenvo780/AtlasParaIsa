/**
 * scripts/lab/sonda-obra.mts — corre el mundo de `encender` (un hilo, sin comprobar) y cada día cuenta lo que hace la
 * obra de piezas (v23.obra): estructuras con y sin estado material, terminadas, con pieza pendiente, piezas colocadas y su
 * masa, condición, depósitos, quién está en «build», empedrados y contadores. Solo mide: no cambia nada del mundo.
 *
 *   tsx scripts/lab/sonda-obra.mts --semilla 7 --hasta obra --dias 2 [--cada 600]
 */
import { createWorld, stepWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { ctxSi } from '../../src/world/motor/acceso.js';
import { Rol } from '../../src/world/materia/tipos.js';
import { celdaPropia } from '../../src/world/materia/proceso.js';
import { estadoObra, stockObra } from '../../src/world/materia/piezas.js';
import { argumentosEncender, paramsDeEncender } from './encender.mjs';

const args = process.argv.slice(2);
const iCada = args.indexOf('--cada');
const cada = iCada >= 0 ? Number(args.splice(iCada, 2)[1]) : TICKS_PER_DAY;
const o = argumentosEncender(args);
const mundo = createWorld(o.semilla, paramsDeEncender(o));
process.title = 'carta-isa';
const vistas = new Set<string>();
const acciones: Record<string, number> = {};

function contar(): Record<string, unknown> {
  const c = ctxSi(mundo) as any;
  let materiales = 0, terminadas = 0, pendientes = 0, conProceso = 0, trabajoPendiente = 0, piezas = 0, masaPiezas = 0, conCondicion = 0, agua = 0, comida = 0;
  const enObra = new Set<number>();
  for (const s of mundo.structures as any[]) {
    vistas.add(s.id);
    if (s.condition > 0) conCondicion++;
    const obra = estadoObra(s);
    if (!obra) continue;
    materiales++;
    if (obra.terminada) terminadas++;
    if (obra.pendiente) { pendientes++; trabajoPendiente += obra.pendiente.trabajoJ; if (obra.pendiente.proceso) conProceso++; }
    for (const p of obra.piezas) { enObra.add(p.lote); if (c?.materia?.propio(p.lote)) { piezas++; masaPiezas += c.materia.vista(p.lote).masa; } }
    if (c?.materia) { agua += stockObra(c, s, 'agua'); comida += stockObra(c, s, 'comida'); }
  }
  let empedrados = 0, piezasSueltas = 0;
  if (c?.materia) {
    const buf = new Float64Array(64);
    for (const t of mundo.tiles as any[]) {
      const celda = celdaPropia(c, t.x, t.y);
      if (celda < 0) continue;
      const n = c.materia.lotes(celda, Rol.Pieza, buf);
      let suelta = 0;
      for (let i = 0; i < Math.min(n, buf.length); i++) if (!enObra.has(buf[i]!)) suelta++;
      if (suelta) { empedrados++; piezasSueltas += suelta; }
    }
  }
  return { estructuras: mundo.structures.length, estructurasVistas: vistas.size, materiales, terminadas, pendientes, conProceso,
    trabajoPendienteJ: +trabajoPendiente.toFixed(1), piezas, masaPiezas: +masaPiezas.toFixed(3), conCondicion, agua: +agua.toFixed(3), comida: +comida.toFixed(3),
    empedrados, piezasSueltas, asentamientos: mundo.settlementCount, caminos: (mundo.totals as any).roadsPaved ?? 0,
    planos: mundo.blueprints.length, accionesBuild: acciones.build ?? 0 };
}

const fila = (x: Record<string, unknown>) => process.stdout.write(JSON.stringify(x) + '\n');
fila({ tipo: 'inicio', semilla: o.semilla, hasta: o.hasta, personas: mundo.people.length, estructuras: mundo.structures.length });
for (let t = 1; t <= o.dias * TICKS_PER_DAY; t++) {
  stepWorld(mundo);
  for (const p of mundo.people) if (p.role === 'neighbor' && p.action) acciones[p.action] = (acciones[p.action] ?? 0) + 1;
  if (t % cada === 0) fila({ tick: mundo.tick, poblacion: mundo.people.filter(p => p.role === 'neighbor').length,
    nacimientos: mundo.totals.births ?? 0, muertes: mundo.demographyDynamics.deaths, fauna: mundo.animals.length, ...contar() });
}
fila({ tipo: 'acciones', ...acciones });
