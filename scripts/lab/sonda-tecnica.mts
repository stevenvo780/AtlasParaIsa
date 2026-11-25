/**
 * scripts/lab/sonda-tecnica.mts — corre el mundo de `encender` (un hilo, sin comprobar) y cada día cuenta lo que hace la
 * técnica de lotes (v23.tecnica): personas con estado técnico, intentos, procesos en curso por paso, recetas recordadas,
 * entradas T1R del registro, lotes Objeto por celda y masa a cuestas. Solo mide: no cambia nada del mundo.
 *
 *   tsx scripts/lab/sonda-tecnica.mts --semilla 7 --hasta tecnica --dias 2 [--cada 600]
 */
import { createWorld, stepWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { ctxSi } from '../../src/world/motor/acceso.js';
import { Rol } from '../../src/world/materia/tipos.js';
import { celdaPropia } from '../../src/world/materia/proceso.js';
import { argumentosEncender, paramsDeEncender } from './encender.mjs';

const args = process.argv.slice(2);
const iCada = args.indexOf('--cada');
const cada = iCada >= 0 ? Number(args.splice(iCada, 2)[1]) : TICKS_PER_DAY;
const o = argumentosEncender(args);
const mundo = createWorld(o.semilla, paramsDeEncender(o));
process.title = 'carta-isa';

function contar(): Record<string, unknown> {
  const c = ctxSi(mundo) as any;
  let conTecnica = 0, intentos = 0, recetas = 0, maxRecetas = 0, cargaLotes = 0, cargaVacios = 0, cargaUnicos = 0, cargaMasaMax = 0;
  const pasos: Record<string, number> = {}, tipos: Record<string, number> = {}, ids = new Set<number>();
  for (const p of mundo.people as any[]) {
    const t = p.technology?.tecnica;
    if (t) {
      conTecnica++; for (const r of t.recetas) ids.add(r.id); intentos += t.intentos; recetas += t.recetas.length; maxRecetas = Math.max(maxRecetas, t.recetas.length);
      const pe = t.proceso;
      if (pe) {
        tipos[pe.tipo] = (tipos[pe.tipo] ?? 0) + 1;
        const paso = pe.proceso.pasos[pe.proceso.i];
        const k = `${paso?.op ?? 'fin'}#${pe.proceso.i}/${pe.proceso.pasos.length}`;
        pasos[k] = (pasos[k] ?? 0) + 1;
        if (process.env.SONDA_DETALLE) process.stdout.write(`  ${p.id} rol=${p.role} acción=${p.action} en ${p.x.toFixed(1)},${p.y.toFixed(1)} `
          + `objetivo ${p.target?.x?.toFixed?.(1)},${p.target?.y?.toFixed?.(1)} proceso en ${pe.proceso.x},${pe.proceso.y} ${k} desde=${pe.proceso.desde} `
          + `avanzadoEn=${t.avanzadoEn} vivo=${p.alive ?? '?'} salud=${p.demography?.health?.toFixed?.(2)}\n`);
      }
    }
    if (c?.materia && p.carga?.length) {
      let m = 0;
      cargaUnicos += new Set(p.carga).size;
      for (const l of p.carga) if (c.materia.vivo(l)) { cargaLotes++; const kg = c.materia.vista(l).masa; m += kg; if (!(kg > 0)) cargaVacios++; }
      const cuerpo = p.cuerpo ? c.materia.vista(p.cuerpo.tejido).masa : 0;
      if (cuerpo > 0) cargaMasaMax = Math.max(cargaMasaMax, m / cuerpo);
    }
  }
  let objetos = 0, objetosConForma = 0, masaObjetos = 0, T1R = 0;
  if (c?.materia) {
    const buf = new Float64Array(4096);
    for (const t of mundo.tiles as any[]) {
      const celda = celdaPropia(c, t.x, t.y);
      if (celda < 0) continue;
      const n = c.materia.lotes(celda, Rol.Objeto, buf);
      for (let i = 0; i < Math.min(n, buf.length); i++) {
        const v = c.materia.vista(buf[i]!);
        if (v.masa > 0) { objetos++; masaObjetos += v.masa; if (v.forma) objetosConForma++; }
      }
    }
    const reg = c.globales?.registro;
    const cab = new TextEncoder().encode('T1R');
    if (reg) for (let id = 0; id < reg.n; id++) { const b = reg.leer(id); if (b && b[0] === cab[0] && b[1] === cab[1] && b[2] === cab[2]) T1R++; }
  }
  return { conTecnica, intentos, recetas, recetasDistintas: ids.size, maxRecetas, procesos: tipos, pasos, cargaLotes, cargaVacios, cargaUnicos, cargaMasaMax: +cargaMasaMax.toFixed(3),
    objetos, objetosConForma, masaObjetos: +masaObjetos.toFixed(3), T1R };
}

const fila = (x: Record<string, unknown>) => process.stdout.write(JSON.stringify(x) + '\n');
fila({ tipo: 'inicio', semilla: o.semilla, hasta: o.hasta, personas: mundo.people.length });
for (let t = 1; t <= o.dias * TICKS_PER_DAY; t++) {
  stepWorld(mundo);
  if (t % cada === 0) fila({ tick: mundo.tick, poblacion: mundo.people.filter(p => p.role === 'neighbor').length,
    nacimientos: mundo.totals.births ?? 0, muertes: mundo.demographyDynamics.deaths, fauna: mundo.animals.length, ensenanzas: mundo.totals.teaching ?? 0, ...contar() });
}
