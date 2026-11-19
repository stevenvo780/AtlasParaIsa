import type { FaseNombre } from '../shared/types.js';

/** Recent completed steps, including persistence. This is not a lifetime percentile. */
export const GOVERNOR_WINDOW_STEPS = 120;

function percentil(valores: readonly number[], q: number): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * q))]!;
}

/** Teselas activas por habitante; 0 habitantes no es un error, es un mundo vacío. */
export function teselasPorHabitante(teselasActivas: number, poblacion: number): number {
  return poblacion > 0 ? teselasActivas / poblacion : 0;
}

/** Señales de la ventana móvil (T161): percentiles, máximo y su fase, y p95 por fase. */
export interface SenalesVentana {
  p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number;
  faseMax: FaseNombre | null; fasesP95: Partial<Record<FaseNombre, number>>;
}

interface Muestra { ms: number; fases: Partial<Record<FaseNombre, number>> }

/** Shared by the server and experiments so both use the same window and percentile. */
export class RollingStepPerformance {
  private readonly measurements: Muestra[] = [];

  get count(): number { return this.measurements.length; }

  record(stepMs: number, fases?: Partial<Record<FaseNombre, number>>): number {
    this.measurements.push({ ms: stepMs, fases: { ...fases } });
    if (this.measurements.length > GOVERNOR_WINDOW_STEPS) this.measurements.shift();
    return this.p95Ms;
  }

  /** Anota una fase medida tras registrar el paso (p. ej. `broadcast` en `app.ts`). */
  anotarUltimaFase(fase: FaseNombre, ms: number): void {
    const ultima = this.measurements[this.measurements.length - 1];
    if (ultima) ultima.fases[fase] = ms;
  }

  get p50Ms(): number { return percentil(this.measurements.map(m => m.ms), 0.5); }
  get p95Ms(): number { return percentil(this.measurements.map(m => m.ms), 0.95); }
  get p99Ms(): number { return percentil(this.measurements.map(m => m.ms), 0.99); }
  get maxMs(): number { return this.measurements.reduce((max, m) => Math.max(max, m.ms), 0); }

  /** Fase de mayor tiempo dentro del paso con `maxMs`; si ese paso no midió fases, la de mayor pico en la ventana. */
  get faseMax(): FaseNombre | null {
    if (this.measurements.length === 0) return null;
    const pico = this.measurements.reduce((a, b) => (b.ms > a.ms ? b : a));
    let mejor: FaseNombre | null = null, mejorMs = -1;
    for (const [fase, ms] of Object.entries(pico.fases) as [FaseNombre, number][]) if (ms > mejorMs) { mejor = fase; mejorMs = ms; }
    if (mejor !== null) return mejor;
    for (const muestra of this.measurements)
      for (const [fase, ms] of Object.entries(muestra.fases) as [FaseNombre, number][]) if (ms > mejorMs) { mejor = fase; mejorMs = ms; }
    return mejor;
  }

  get fasesP95(): Partial<Record<FaseNombre, number>> {
    const porFase = new Map<FaseNombre, number[]>();
    for (const muestra of this.measurements)
      for (const [fase, ms] of Object.entries(muestra.fases) as [FaseNombre, number][]) {
        const lista = porFase.get(fase) ?? []; lista.push(ms); porFase.set(fase, lista);
      }
    return Object.fromEntries([...porFase].map(([fase, valores]) => [fase, percentil(valores, 0.95)]));
  }

  senales(): SenalesVentana {
    return { p50Ms: this.p50Ms, p95Ms: this.p95Ms, p99Ms: this.p99Ms, maxMs: this.maxMs, faseMax: this.faseMax, fasesP95: this.fasesP95 };
  }
}

/**
 * R17: preserve the hardware budget and its hysteresis. Load in [70 %, 100 %]
 * keeps the current state; falling below 70 % permits births again, never forces them.
 * Política `gobernador.politica = 'apagar'` (la de 2026-09-19).
 */
export function decideReproduction(p95StepMs: number, presupuestoMs: number, actual: boolean): boolean {
  if (p95StepMs > presupuestoMs) return false;
  if (p95StepMs < presupuestoMs * 0.7) return true;
  return actual;
}

/** Estado de la política `techo`: el techo vigente (null = sin freno). */
export interface EstadoTecho { techo: number | null }
export const ESTADO_TECHO_INICIAL: Readonly<EstadoTecho> = Object.freeze({ techo: null });

/**
 * Política `gobernador.politica = 'techo'` (revisión 2026-09-22; T162/T164 parciales de la feature 002).
 * El hardware limita el CRECIMIENTO, no el reemplazo:
 * · Verde (p95 < 70 % del presupuesto): sin techo, la reproducción queda permitida.
 * · Rojo (p95 > presupuesto): si no había techo se fija en la población actual; solo se permiten
 *   nacimientos mientras la población esté por debajo del techo (reponer muertes, no crecer).
 * · Banda muerta [70 %, 100 %]: el techo vigente se conserva tal cual (histéresis de R17).
 * El techo nunca baja: el gobernador detiene el crecimiento, jamás reduce una población. Una bajada
 * automática bajo rojo grave se probó y se descartó el 2026-09-22: con carga EXTERNA sostenida (una
 * barrida de laboratorio en la misma torre) habría dejado días simulados sin nacimientos y reproducido
 * la extinción por senescencia que esta política corrige. Si el rojo es por carga externa, la población
 * se mantiene y el servidor corre más lento hasta que la carga se retire.
 * Función pura: no toca el mundo ni relojes; el estado viaja como argumento y como resultado.
 */
export function decidirConTecho(p95StepMs: number, presupuestoMs: number, poblacion: number, estado: Readonly<EstadoTecho>): { reproduccion: boolean; estado: EstadoTecho } {
  if (p95StepMs < presupuestoMs * 0.7) return { reproduccion: true, estado: { techo: null } };
  const techo = estado.techo === null && p95StepMs > presupuestoMs ? poblacion : estado.techo;
  return { reproduccion: techo === null || poblacion < techo, estado: { techo } };
}

/** T164: registro del último frenazo (no se borra al volver a verde). Es publicación, no regla. */
export interface TechoObservado { p95: number; maxMs: number; poblacion: number; teselasActivas: number; teselasPorHabitante: number; senal: string; tick: number; motivo: string }

export function describirFrenazo(p95: number, presupuestoMs: number, poblacion: number, teselasActivas: number, tick: number, maxMs: number = p95): TechoObservado {
  return { p95, maxMs, poblacion, teselasActivas, teselasPorHabitante: teselasPorHabitante(teselasActivas, poblacion), senal: 'p95', tick,
    motivo: `frenado por p95 = ${p95.toFixed(1)} ms > ${presupuestoMs} ms con ${poblacion} habitantes y ${teselasActivas} teselas activas (paso ${tick})` };
}

/**
 * Gobernador completo, compartido por el servidor (`app.ts`) y el laboratorio (`scripts/lab/replica.ts`)
 * para que ambos apliquen exactamente la misma política sobre la misma ventana. Guarda solo estado de
 * ejecución (nada entra en el mundo ni en su digesto); `manual` (orden humana) lo administra quien lo usa.
 */
export class Gobernador {
  readonly medidas = new RollingStepPerformance();
  p95StepMs = 0;
  estado: EstadoTecho = { ...ESTADO_TECHO_INICIAL };
  techoObservado: TechoObservado | null = null;
  private enRojo = false;

  registrar(stepMs: number, fases?: Partial<Record<FaseNombre, number>>): number { this.p95StepMs = this.medidas.record(stepMs, fases); return this.p95StepMs; }

  senales(): SenalesVentana { return this.medidas.senales(); }
  get p50Ms(): number { return this.medidas.p50Ms; }
  get p99Ms(): number { return this.medidas.p99Ms; }
  get maxMs(): number { return this.medidas.maxMs; }
  get faseMax(): FaseNombre | null { return this.medidas.faseMax; }
  get fasesP95(): Partial<Record<FaseNombre, number>> { return this.medidas.fasesP95; }

  /**
   * Decide `reproductionEnabled` para el paso siguiente. `actual` es el valor vigente del mundo.
   * Sin mediciones todavía (primer paso) no se afirma nada sobre el hardware y se devuelve `actual`.
   */
  decidir(params: { presupuestoMs: number; politica: 'apagar' | 'techo' }, actual: boolean, poblacion: number, teselasActivas: number, tick: number): boolean {
    if (this.medidas.count === 0) return actual;
    const rojo = this.p95StepMs > params.presupuestoMs;
    if (rojo && !this.enRojo) this.techoObservado = describirFrenazo(this.p95StepMs, params.presupuestoMs, poblacion, teselasActivas, tick, this.medidas.maxMs);
    this.enRojo = rojo;
    if (params.politica === 'apagar') { this.estado = { ...ESTADO_TECHO_INICIAL }; return decideReproduction(this.p95StepMs, params.presupuestoMs, actual); }
    const decision = decidirConTecho(this.p95StepMs, params.presupuestoMs, poblacion, this.estado);
    this.estado = decision.estado;
    return decision.reproduccion;
  }
}
