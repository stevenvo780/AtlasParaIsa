/**
 * Reparto de chunks entre dueños por tiempo de pared (carril m7; ARQ-motor §3.8). Las firmas de las cuatro funciones
 * las fijó la preparación de la oleada y las consume m4a (y srv para `hilos: 'auto'`). Son funciones puras: se prueban
 * sin motor, sin hilos y sin reloj. Las medidas (ms de pared) las toma el coordinador; aquí solo se decide.
 *
 * Idea: los chunks, en orden Morton, se cortan en `hilos` tramos contiguos de coste parecido. Un tramo contiguo en
 * Morton es una región compacta del mundo, así que los vecinos casi siempre tienen el mismo dueño y el frente entre
 * dueños es corto. El coste es el medido (EMA de ms de pared por chunk), no el contado: un hilo al que la torre le roba
 * CPU, o cuyo tramo tiene más personas, recibe menos chunks en el reparto siguiente.
 */
import { mortonCode } from '../soa/morton.js';

// ── Parámetros del reparto: viven en shared/naturaleza.ts (integrador) y se reexportan aquí ──
import { PERIODO_REBALANCEO_TICKS, VENTANAS_DESEQUILIBRADAS, UMBRAL_DESEQUILIBRIO, FRACCION_HILOS_MENOS, MARGEN_EMPATE_HZ, PESO_EMA, COTA_RETRASO } from '../../shared/naturaleza.js';
export { PERIODO_REBALANCEO_TICKS, VENTANAS_DESEQUILIBRADAS, UMBRAL_DESEQUILIBRIO, FRACCION_HILOS_MENOS, MARGEN_EMPATE_HZ, PESO_EMA, COTA_RETRASO };

/** Lo que el coordinador mide y m7 lee: por chunk residente, su posición de página y la media móvil de los ms de pared
 * que costó a su dueño; por hilo, los ms de pared de su último tramo de ventanas. */
export interface MedidaReparto {
  chunks: Int32Array;      // ChunkId residentes
  px: Int32Array; py: Int32Array;
  costeMs: Float64Array;   // EMA por chunk, alineada con `chunks`
  dueno: Int16Array;       // dueño vigente de cada uno
  hiloMs: Float64Array;    // por hilo
}

/** Media móvil exponencial del coste de un chunk: `previa` es la EMA vigente y `muestra` los ms de la última ventana.
 * Un chunk sin historia (`previa` 0 o no finita) arranca en la muestra. */
export function mediaMovil(previa: number, muestra: number): number {
  const m = Number.isFinite(muestra) && muestra > 0 ? muestra : 0;
  if (!(previa > 0) || !Number.isFinite(previa)) return m;
  return previa + PESO_EMA * (m - previa);
}

/** Desequilibrio del reparto vigente: máximo de `hiloMs` sobre su media (1 = perfecto). */
export function desequilibrio(m: MedidaReparto): number {
  const n = m.hiloMs.length;
  if (n === 0) return 1;
  let suma = 0, max = 0;
  for (let h = 0; h < n; h++) {
    const v = m.hiloMs[h]!;
    if (!(v > 0) || !Number.isFinite(v)) continue;
    suma += v;
    if (v > max) max = v;
  }
  return suma > 0 ? max / (suma / n) : 1;
}

/** Índices de `m.chunks` en orden Morton de su página; desempata por ChunkId para que el orden sea total y estable. */
function ordenMorton(m: MedidaReparto): Int32Array {
  const n = m.chunks.length;
  const codigos = new BigUint64Array(n);
  for (let i = 0; i < n; i++) codigos[i] = mortonCode(m.px[i]!, m.py[i]!);
  return Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ca = codigos[a]!, cb = codigos[b]!;
    return ca < cb ? -1 : ca > cb ? 1 : m.chunks[a]! - m.chunks[b]!;
  });
}

/** Coste de cada chunk en `orden`: el medido, o la media de los medidos si el chunk es nuevo (0 o no finito). Si
 * ninguno tiene medida, todos cuestan lo mismo. */
function costes(m: MedidaReparto, orden: Int32Array): Float64Array {
  let suma = 0, con = 0;
  for (let i = 0; i < orden.length; i++) {
    const c = m.costeMs[orden[i]!]!;
    if (c > 0 && Number.isFinite(c)) { suma += c; con++; }
  }
  const medio = con > 0 ? suma / con : 1;
  return Float64Array.from(orden, i => {
    const c = m.costeMs[i]!;
    return c > 0 && Number.isFinite(c) ? c : medio;
  });
}

/** Parte del coste total que debe llevar cada hilo, suma 1. Un hilo con más pared que coste asignado (la máquina lo
 * retrasa) pesa menos. Sin medida utilizable, o si cambió el número de hilos, todos pesan igual. */
function cuotas(m: MedidaReparto, hilos: number): Float64Array {
  const peso = new Float64Array(hilos).fill(1);
  if (m.hiloMs.length === hilos) {
    const asignado = new Float64Array(hilos);
    for (let i = 0; i < m.chunks.length; i++) {
      const d = m.dueno[i]!, c = m.costeMs[i]!;
      if (d >= 0 && d < hilos && c > 0 && Number.isFinite(c)) asignado[d]! += c;
    }
    for (let h = 0; h < hilos; h++) {
      const pared = m.hiloMs[h]!;
      if (asignado[h]! > 0 && pared > 0 && Number.isFinite(pared))
        peso[h] = Math.min(1 / COTA_RETRASO, Math.max(COTA_RETRASO, asignado[h]! / pared));
    }
  }
  const total = peso.reduce((a, b) => a + b, 0);
  return peso.map(p => p / total);
}

/** ¿El reparto vigente es completo, válido para `hilos` y cada dueño ocupa un solo tramo seguido en Morton? */
function repartoVigenteValido(m: MedidaReparto, orden: Int32Array, hilos: number): boolean {
  const vistos = new Uint8Array(hilos);
  let previo = -1;
  for (let k = 0; k < orden.length; k++) {
    const d = m.dueno[orden[k]!]!;
    if (d < 0 || d >= hilos) return false;
    if (d !== previo) {
      if (vistos[d]) return false;
      vistos[d] = 1;
      previo = d;
    }
  }
  return true;
}

/** Reparto nuevo: los chunks en orden Morton, cortados en `hilos` tramos contiguos de coste parecido, dando menos a
 * los hilos que la máquina está retrasando (`hiloMs` alto con el mismo coste asignado). Devuelve el dueño de cada chunk
 * de `m.chunks`. Un chunk recién activado (coste 0) cuenta con el coste medio. Si el reparto vigente ya es completo,
 * contiguo y su desequilibrio no pasa del umbral, se devuelve tal cual: no se mueve nada que ya funciona.
 * El laboratorio puede probar un orden espacial alternativo sin el atajo del reparto estable. */
export function repartir(m: MedidaReparto, hilos: number, conservarEstable = true): Int16Array {
  const n = m.chunks.length;
  if (!Number.isInteger(hilos) || hilos < 1) throw new RangeError(`repartir: hilos inválido (${hilos}).`);
  if (n === 0 || hilos === 1) return new Int16Array(n);
  const orden = ordenMorton(m);
  if (conservarEstable && m.dueno.length === n && m.hiloMs.length === hilos && desequilibrio(m) <= UMBRAL_DESEQUILIBRIO
    && repartoVigenteValido(m, orden, hilos)) return Int16Array.from(m.dueno);

  const res = new Int16Array(n);
  const coste = costes(m, orden), cuota = cuotas(m, hilos);
  let total = 0;
  for (let k = 0; k < n; k++) total += coste[k]!;
  // Cada chunk va al hilo en cuyo intervalo de coste acumulado cae su punto medio; la secuencia sale monótona.
  const asignado = new Int32Array(n);
  const limite = new Float64Array(hilos);
  for (let h = 0, acumulado = 0; h < hilos; h++) { acumulado += cuota[h]! * total; limite[h] = acumulado; }
  for (let k = 0, h = 0, antes = 0; k < n; k++) {
    const medio = antes + coste[k]! / 2;
    while (h < hilos - 1 && medio >= limite[h]!) h++;
    asignado[k] = h;
    antes += coste[k]!;
  }
  // Con tantos chunks como hilos, ningún hilo queda sin trabajo: la secuencia sube de uno en uno y toca 0 … hilos-1.
  if (n >= hilos) {
    for (let k = 0; k < n; k++) asignado[k] = Math.min(asignado[k]!, k, k === 0 ? 0 : asignado[k - 1]! + 1);
    asignado[n - 1] = hilos - 1;
    for (let k = n - 2; k >= 0; k--) asignado[k] = Math.max(asignado[k]!, asignado[k + 1]! - 1);
  }
  for (let k = 0; k < n; k++) res[orden[k]!] = asignado[k]!;
  return res;
}

/** Si toca rebalancear en este tick, dado el historial de desequilibrios de las últimas ventanas (la más reciente al
 * final). Se llama una vez por ventana; tras rebalancear, el coordinador vacía el historial. */
export function tocaRebalancear(tick: number, historial: readonly number[]): boolean {
  if (tick > 0 && tick % PERIODO_REBALANCEO_TICKS === 0) return true;
  if (historial.length < VENTANAS_DESEQUILIBRADAS) return false;
  for (let i = historial.length - VENTANAS_DESEQUILIBRADAS; i < historial.length; i++)
    if (!(historial[i]! > UMBRAL_DESEQUILIBRIO)) return false;
  return true;
}

/** Los números de hilos que `hilosAuto` necesita medir a partir de `actual`: T y ¾T (sin repetir, al menos 1). */
export function candidatosAuto(actual: number): number[] {
  const t = Math.max(1, Math.floor(actual));
  const menos = Math.max(1, Math.floor(t * FRACCION_HILOS_MENOS));
  return menos === t ? [t] : [t, menos];
}

/** `hilos: 'auto'`: cuántos dueños usar, dados los Hz medidos con cada número de hilos probado. Gana el de más Hz; si
 * varios quedan a menos de `MARGEN_EMPATE_HZ` del mejor, el menor de ellos (deja CPU a la torre). Sin medidas útiles
 * devuelve `maximo`. */
export function hilosAuto(medidas: ReadonlyMap<number, number>, maximo: number): number {
  const tope = Math.max(1, Math.floor(maximo));
  let mejor = 0;
  for (const [hilos, hz] of medidas)
    if (Number.isInteger(hilos) && hilos >= 1 && hilos <= tope && hz > 0 && Number.isFinite(hz) && hz > mejor) mejor = hz;
  if (mejor === 0) return tope;
  let elegido = tope + 1;
  for (const [hilos, hz] of medidas)
    if (Number.isInteger(hilos) && hilos >= 1 && hilos <= tope && hz >= mejor * (1 - MARGEN_EMPATE_HZ) && hilos < elegido) elegido = hilos;
  return elegido;
}
