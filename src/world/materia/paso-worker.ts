/**
 * Reparto de `pasoLote` entre hilos (carril P). Solo el dueño de un lote lo escribe (`ArenaMateria`), así que el
 * despacho no se trocea aquí: quien llama agrupa la lista por dueño y da en `cortes` dónde empieza cada grupo; el hilo h
 * avanza [cortes[h], cortes[h + 1]). La piscina es de M1: de ella solo se espera que llame en cada hilo a la función que
 * devuelve `manejador` con los SAB del despacho, `params` y el índice del hilo. Cómo se abre la arena de A y la química
 * de Q en un hilo lo da `abrir`.
 */
import { FAMILIAS_CATALITICAS, type LoteRef } from './tipos.js';
import { pasoLote, type CtxPaso } from './paso.js';

/** Avanza dt los lotes [desde, hasta) de `lotes`; `kappas` lleva FAMILIAS_CATALITICAS = 4 por lote (`Kappa`: C–O, C–N,
 * C–C/C–H, H–H). Devuelve cuántos avanzó:
 * los que caducaron se saltan, y uno vivo de otro dueño es un error de quien repartió. */
export function pasarLotes(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>,
  desde: number, hasta: number, dt: number): number {
  const kappa: [number, number, number, number] = [0, 0, 0, 0];
  let avanzados = 0;
  for (let i = desde; i < hasta; i++) {
    const l = lotes[i]!;
    if (!c.arena.propio(l)) {
      if (c.arena.vivo(l)) throw new Error(`pasarLotes: el lote ${l} es de otro dueño`);
      continue;
    }
    for (let f = 0; f < FAMILIAS_CATALITICAS; f++) kappa[f] = kappas[FAMILIAS_CATALITICAS * i + f]!;
    pasoLote(c, l, dt, kappa);
    avanzados++;
  }
  return avanzados;
}

/** Lo que lleva un despacho: SAB `lotes` (Float64, n, agrupados por dueño), `kappas` (Float64, 4·n) y `cortes`
 * (Float64, hilos + 1: inicio del grupo de cada hilo y el final); dt. */
export interface TrabajoPaso {
  buffers: { lotes: SharedArrayBuffer; kappas: SharedArrayBuffer; cortes: SharedArrayBuffer } & Record<string, SharedArrayBuffer>;
  params: { dt: number };
  workerIndex: number;
}

/** Función por hilo para la piscina. `abrir` se llama una vez por hilo, con el primer despacho. */
export function manejador(abrir: (t: TrabajoPaso) => CtxPaso): (t: TrabajoPaso) => number {
  let c: CtxPaso | null = null;
  return t => {
    c ??= abrir(t);
    const cortes = new Float64Array(t.buffers.cortes), h = t.workerIndex;
    return pasarLotes(c, new Float64Array(t.buffers.lotes), new Float64Array(t.buffers.kappas), cortes[h]!, cortes[h + 1]!, t.params.dt);
  };
}
