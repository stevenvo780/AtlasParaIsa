/**
 * INTERFAZ PUENTE del campo de alarma por celda (carril f; leyes-opus §2 y §3e): una muerte violenta lo sube en su
 * celda y decae solo. Sustituye a `alarmHerd`. Lo leen la fauna (miedo) y act (caza).
 *
 * La alarma no se barre cada tick: cada celda guarda el valor A₀ que tenía en el tick t₀ de su última subida y se lee
 * como A₀·e^(−(t − t₀)/TAU_ALARMA). Así decae sola sin coste por celda quieta.
 *
 * Dónde vive: en dos campos del terreno, `alarma` (f64, A₀) y `alarmaDesde` (f64, t₀), si el motor los registró (pedido
 * al integrador en el informe de f); entonces una celda ajena se lee por `c.terreno` con un tick de retraso, como pide
 * el contrato. Mientras no estén registrados, cada dueño guarda los suyos en un mapa propio y una celda ajena lee 0.
 */
import type { CtxLey } from '../motor/acceso.js';

// ── Constantes físicas (para `shared/naturaleza.ts`) ──────────────────────────────────────────────────────
/** Ticks: vida media (1/e) de la alarma de una celda. El olor de la sangre y el recuerdo de un ataque duran unas horas:
 * 240 ticks ≈ 2,4 h de mundo (2.400 ticks por día); el `lastHunted < 120` de hoy era la mitad. */
export const TAU_ALARMA = 240;
/** Celdas: alcance del aviso de una muerte violenta (olor, gritos). Cae como 1/(1 + d²) con la distancia d. */
export const RADIO_ALARMA = 6;

export const CAMPO_ALARMA = 'alarma';
export const CAMPO_ALARMA_DESDE = 'alarmaDesde';

interface Local { valor: Map<number, number>; desde: Map<number, number> }
const locales = new WeakMap<object, Local>();
const local = (c: CtxLey): Local => {
  let l = locales.get(c.mundo);
  if (!l) locales.set(c.mundo, l = { valor: new Map(), desde: new Map() });
  return l;
};

const decaida = (a0: number, t0: number, tick: number): number => a0 > 0 ? a0 * Math.exp(-Math.max(0, tick - t0) / TAU_ALARMA) : 0;

/** ¿Registró el motor los campos de la alarma en el terreno? */
export const alarmaEnTerreno = (c: CtxLey): boolean =>
  c.terreno.campos.includes(CAMPO_ALARMA) && c.terreno.campos.includes(CAMPO_ALARMA_DESDE);

const propia = (c: CtxLey, celda: number): boolean => {
  const chunk = c.terreno.chunkDe(celda);
  return chunk >= 0 && c.terreno.duenoChunk[chunk] === c.hilo;
};

/** Alarma en [0, ∞) de una celda residente, propia o ajena (lectura por `c.terreno`, un tick atrás si es ajena). */
export function alarmaEn(c: CtxLey, celda: number): number {
  if (celda < 0) return 0;
  if (alarmaEnTerreno(c)) {
    const a0 = c.terreno.campo(CAMPO_ALARMA)[celda] ?? 0, t0 = c.terreno.campo(CAMPO_ALARMA_DESDE)[celda] ?? 0;
    return decaida(a0, t0, c.tick);
  }
  if (!propia(c, celda)) return 0;
  const l = local(c);
  return decaida(l.valor.get(celda) ?? 0, l.desde.get(celda) ?? 0, c.tick);
}

/** Sube la alarma de una celda PROPIA (en una ajena, el dueño la sube al aplicar el `Golpear` que mata). */
export function subirAlarma(c: CtxLey, celda: number, cuanto: number): void {
  if (celda < 0 || !(cuanto > 0) || !Number.isFinite(cuanto)) return;
  if (!propia(c, celda)) return;
  const nuevo = alarmaEn(c, celda) + cuanto;
  if (alarmaEnTerreno(c)) {
    const chunk = c.terreno.chunkDe(celda), i = celda & 255;
    c.propio.escribible(CAMPO_ALARMA, chunk)[i] = nuevo;
    c.propio.escribible(CAMPO_ALARMA_DESDE, chunk)[i] = c.tick;
    c.propio.marcar(chunk, false);
    return;
  }
  const l = local(c);
  l.valor.set(celda, nuevo);
  l.desde.set(celda, c.tick);
}

/** Una muerte violenta (o un ataque) en (x, y): sube `cuanto`/(1 + d²) la alarma de cada celda propia a ≤ RADIO_ALARMA
 * (distancia euclídea). Las celdas ajenas no se tocan: su dueño se entera por la presa que huye y por sus propias muertes. */
export function alarmaPorAtaque(c: CtxLey, x: number, y: number, cuanto: number): void {
  if (!(cuanto > 0)) return;
  const r = RADIO_ALARMA, r2 = r * r;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const celda = c.terreno.celda(x + dx, y + dy);
    if (celda >= 0 && propia(c, celda)) subirAlarma(c, celda, cuanto / (1 + d2));
  }
}

/** Olvida las celdas locales cuya alarma ya es despreciable (< 1e−6): evita que el mapa propio crezca sin fin. */
export function podarAlarmaLocal(c: CtxLey): void {
  const l = locales.get(c.mundo);
  if (!l) return;
  for (const [celda, a0] of l.valor) if (decaida(a0, l.desde.get(celda) ?? 0, c.tick) < 1e-6) {
    l.valor.delete(celda); l.desde.delete(celda);
  }
}
