/**
 * Diagnóstico de disputas (instrumento, hipótesis CONFL 2026-09-22): ¿por qué las disputas del
 * brazo D (`social.disputa*`) costaban vidas? Sigue cada evento `conflict` y a sus dos actores:
 * quién cedió (`actors[0]`, el que cede el intento en `resourceDispute`), la necesidad de cada uno,
 * si eran de la misma comunidad, qué hizo quien cedió después (¿vuelve a la MISMA fuente?, ¿cuántas
 * disputas más encadena?) y si muere en el día siguiente y de qué. Solo lee el mundo.
 * Uso: --seed N --dias D [--params "..."] [--salida fichero.json]
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, stepWorld, TICKS_PER_DAY, type Person } from '../../src/world/index.js';
import { parseParams } from '../../src/world/params.js';
import { Store } from '../../src/server/store.js';

function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; }

interface Disputa {
  tick: number; cede: string; gana: string; accionGanador: string; fuente: { x: number; y: number };
  necesidadCede: number; necesidadGana: number; sedCede: number; sedGana: number; hambreCede: number; hambreGana: number;
  mismaComunidad: boolean; cedeMasNecesitado: boolean;
  vuelveMismaFuente?: boolean; disputasSiguientesCede: number; muereCede?: { tick: number; causa: string };
  muereGana?: { tick: number; causa: string };
}

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 1), dias = Number(arg('--dias') ?? 4), salida = arg('--salida');
  const params = parseParams(arg('--params'));
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-diag-disputa-')); process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    const world = createWorld(seed, params); store.save(world);
    const disputas: Disputa[] = [], muertes: { tick: number; id: string; causa: string; disputoAntes: boolean; x?: number; y?: number }[] = [];
    let ultimoEvento = world.eventCounter;
    for (let tick = 1; tick <= dias * TICKS_PER_DAY; tick++) {
      const antes = new Map<string, { action: string; target: { x: number; y: number }; hunger: number; thirst: number }>(
        world.people.map(p => [p.id, { action: p.action, target: { ...p.target }, hunger: p.hunger, thirst: p.thirst }]));
      stepWorld(world);
      if (tick % params.persistencia.cadaTicks === 0) store.save(world);
      const nuevos = world.events.filter(e => Number(e.id.slice(1)) > ultimoEvento);
      ultimoEvento = world.eventCounter;
      const porId = new Map<string, Person>(world.people.map(p => [p.id, p]));
      for (const e of nuevos) {
        if (e.kind === 'conflict') {
          const [cede, gana] = e.actors as [string, string];
          const a = porId.get(cede), b = porId.get(gana), pa = antes.get(cede), pb = antes.get(gana);
          if (!a || !b || !pa || !pb) continue;
          const na = Math.max(pa.hunger, pa.thirst), nb = Math.max(pb.hunger, pb.thirst);
          disputas.push({ tick: world.tick, cede, gana, accionGanador: b.action, fuente: { ...b.target },
            necesidadCede: na, necesidadGana: nb, sedCede: pa.thirst, sedGana: pb.thirst, hambreCede: pa.hunger, hambreGana: pb.hunger,
            mismaComunidad: !!a.communityId && a.communityId === b.communityId, cedeMasNecesitado: na > nb, disputasSiguientesCede: 0 });
        }
        if (e.kind === 'death' && e.death) {
          const id = e.actors[0]!;
          const previas = disputas.filter(d => (d.cede === id || d.gana === id) && world.tick - d.tick <= TICKS_PER_DAY);
          muertes.push({ tick: world.tick, id, causa: e.death.cause, disputoAntes: previas.length > 0, x: e.death.x, y: e.death.y });
          for (const d of previas) { if (d.cede === id && !d.muereCede) d.muereCede = { tick: world.tick, causa: e.death.cause }; if (d.gana === id && !d.muereGana) d.muereGana = { tick: world.tick, causa: e.death.cause }; }
        }
      }
      // Seguimiento de quien cedió durante 240 pasos: ¿vuelve a la misma fuente?, ¿más disputas?
      for (const d of disputas) {
        if (world.tick - d.tick > 240 || world.tick === d.tick) continue;
        const p = porId.get(d.cede); if (!p) continue;
        if (['drink', 'eat', 'hunt'].includes(p.action) && d.vuelveMismaFuente === undefined) d.vuelveMismaFuente = p.target.x === d.fuente.x && p.target.y === d.fuente.y;
      }
      for (const e of nuevos) if (e.kind === 'conflict') for (const d of disputas) if (d.tick < world.tick && world.tick - d.tick <= TICKS_PER_DAY && e.actors[0] === d.cede) d.disputasSiguientesCede++;
      if (tick % TICKS_PER_DAY === 0) {
        const hoy = disputas.filter(d => d.tick > tick - TICKS_PER_DAY);
        console.log(JSON.stringify({ dia: tick / TICKS_PER_DAY, poblacion: world.people.length, disputas: hoy.length, total: disputas.length,
          muertesTotal: muertes.length, muertesTrasDisputa: muertes.filter(m => m.disputoAntes).length }));
      }
    }
    const n = disputas.length || 1;
    const resumen = {
      seed, dias, disputas: disputas.length,
      porAccion: disputas.reduce<Record<string, number>>((acc, d) => { acc[d.accionGanador] = (acc[d.accionGanador] ?? 0) + 1; return acc; }, {}),
      mismaComunidad: disputas.filter(d => d.mismaComunidad).length,
      cedeElMasNecesitado: disputas.filter(d => d.cedeMasNecesitado).length,
      necesidadMediaCede: disputas.reduce((s, d) => s + d.necesidadCede, 0) / n,
      necesidadMediaGana: disputas.reduce((s, d) => s + d.necesidadGana, 0) / n,
      vuelveMismaFuente: disputas.filter(d => d.vuelveMismaFuente).length,
      encadenan: disputas.filter(d => d.disputasSiguientesCede > 0).length,
      paresDistintos: new Set(disputas.map(d => [d.cede, d.gana].sort().join('|'))).size,
      cedenMuerenEnUnDia: disputas.filter(d => d.muereCede).map(d => d.muereCede!.causa),
      personasQueCedieronYMurieron: new Set(disputas.filter(d => d.muereCede).map(d => d.cede)).size,
      muertes: muertes.length, muertesTrasDisputa: muertes.filter(m => m.disputoAntes).length,
      muertesPorCausa: muertes.reduce<Record<string, number>>((acc, m) => { acc[m.causa] = (acc[m.causa] ?? 0) + 1; return acc; }, {}),
    };
    console.log(JSON.stringify(resumen));
    if (salida) writeFileSync(salida, JSON.stringify({ seed, dias, params, resumen, disputas, muertes }, null, 2) + '\n');
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}
main().catch(e => { console.error((e as Error).stack ?? String(e)); process.exitCode = 1; });
