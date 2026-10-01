/**
 * Instrumento de laboratorio del cribado DESG-D (rama `sprint/desg-d-lab-20261001`).
 * SOLO LECTURA: observador material A (Codex #2, `src/world/material-observer.ts`, con
 * proyección DESG-D) + censo diario de obras (residentes + pendientes + archivadas en
 * SQLite vía `loadChunk`, sin duplicar por id) con condición PROYECTADA f(ancla,N,R).
 *
 * Cableado en `replica.ts` (solo con `--instrumentos si`): `alEmpezar` tras crear el
 * mundo (antes del primer paso), `trasPaso` tras cada paso aceptado y antes del
 * guardado (ciclo paso/ingest/save del protocolo del observador), `metricasDia` en el
 * cierre (clave `desgD` del JSON diario) y `exportFinal` al terminar (`material.json`).
 * Nada de esto escribe el mundo: la puerta de identidad lo comprueba (ley 0 y 1).
 */
import { BROKEN_CONDITION } from '../../src/world/inventions.js';
import { condicionProyectada, desgasteActivo } from '../../src/world/desgaste.js';
import { createMaterialObserver, type MaterialObserver } from '../../src/world/material-observer.js';
import type { World } from '../../src/world/index.js';
import type { Store } from '../../src/server/store.js';
import type { StructureView } from '../../src/shared/life.js';

export interface DesgDdia {
  ley: 0 | 1; N: number | null; R: number | null;
  mortales: number; maderaCorporal: number;
  obrasConstruidasDia: number; reparacionesDia: number; maderaReparacionDia: number;
  obrasTotales: number; obrasDormidas: number; rotasProyectadas: number;
  fraccionRotasProyectada: number | null;
}

export class InstrumentoCribadoDesgaste {
  private observer: MaterialObserver | null = null;
  /** Claves de chunk vistas pendientes alguna vez: las que ya no están ni residentes ni
   * pendientes viven solo en SQLite y se leen con `loadChunk` (verificado por digesto). */
  private readonly clavesVistas = new Set<string>();
  private reparacionesPrevias = 0;
  private construidasPrevias = 0;
  costeMs = 0;

  alEmpezar(world: World): void {
    const inicio = performance.now();
    this.observer = createMaterialObserver();
    this.observer.ingest(world);
    this.reparacionesPrevias = world.inventionDynamics.repairs;
    this.construidasPrevias = world.settlementCount;
    this.costeMs += performance.now() - inicio;
  }

  /** Tras cada paso aceptado, antes del guardado (que vacía los pendientes). */
  trasPaso(world: World): void {
    const inicio = performance.now();
    this.observer?.ingest(world);
    for (const chunk of world.retiredChunks) this.clavesVistas.add(chunk.key);
    this.costeMs += performance.now() - inicio;
  }

  metricasDia(world: World, store: Store): DesgDdia {
    const inicio = performance.now();
    const ley = desgasteActivo(world) ? 1 : 0;
    const N = world.revisionesObra ?? 0, R = world.revisionesLluvia ?? 0;
    const vistas = new Set<string>();
    let totales = 0, dormidas = 0, rotas = 0;
    const contar = (s: StructureView, dormida: boolean): void => {
      if (vistas.has(s.id)) return;
      vistas.add(s.id); totales++;
      if (dormida) dormidas++;
      const cond = ley === 1 && s.anclaDesgaste
        ? condicionProyectada(s.components, s.anclaDesgaste, N, R) ?? s.condition
        : s.condition;
      if (cond <= BROKEN_CONDITION) rotas++;
    };
    for (const s of world.structures) contar(s, false);
    for (const c of world.retiredChunks) for (const s of c.structures ?? []) contar(s, true);
    const residentes = new Set(Object.keys(world.chunks));
    const pendientes = new Set(world.retiredChunks.map(c => c.key));
    const leer = store.context.loadChunk;
    if (leer) for (const key of this.clavesVistas) {
      if (residentes.has(key) || pendientes.has(key)) continue;
      const chunk = leer(key, world.tick);
      if (chunk) for (const s of chunk.structures ?? []) contar(s, true);
    }
    const reparaciones = world.inventionDynamics.repairs, construidas = world.settlementCount;
    const dia: DesgDdia = {
      ley, N: world.revisionesObra ?? null, R: world.revisionesLluvia ?? null,
      mortales: world.people.filter(p => p.role === 'neighbor').length,
      maderaCorporal: world.people.reduce((suma, p) => suma + p.materials.wood, 0),
      obrasConstruidasDia: construidas - this.construidasPrevias,
      reparacionesDia: reparaciones - this.reparacionesPrevias,
      maderaReparacionDia: reparaciones - this.reparacionesPrevias, // 1 madera exacta por reparación
      obrasTotales: totales, obrasDormidas: dormidas, rotasProyectadas: rotas,
      fraccionRotasProyectada: totales > 0 ? rotas / totales : null,
    };
    this.reparacionesPrevias = reparaciones; this.construidasPrevias = construidas;
    this.costeMs += performance.now() - inicio;
    return dia;
  }

  exportFinal(): { version: 1; observador: ReturnType<MaterialObserver['exportRows']> | null; desg: ReturnType<MaterialObserver['exportDesgaste']> | null } {
    return { version: 1, observador: this.observer?.exportRows() ?? null, desg: this.observer?.exportDesgaste() ?? null };
  }
}
