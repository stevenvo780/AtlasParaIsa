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

export function describirFrenazo(p95: number, presupuestoMs: number, poblacion: number, teselasActivas: number, tick: number, maxMs: number = p95, senal: string = 'p95', valorSenal: number = p95): TechoObservado {
  return { p95, maxMs, poblacion, teselasActivas, teselasPorHabitante: teselasPorHabitante(teselasActivas, poblacion), senal, tick,
    motivo: `frenado por ${senal} = ${valorSenal.toFixed(1)} ms > ${presupuestoMs} ms con ${poblacion} habitantes y ${teselasActivas} teselas activas (paso ${tick})` };
}

// ---------------------------------------------------------------------------------------------
// T162: estados, histéresis de tres ventanas verdes y palancas con prioridad estricta.
// ---------------------------------------------------------------------------------------------

/** Estados del gobernador. `manual` manda siempre sobre cualquier señal automática. */
export type EstadoGobernador = 'verde' | 'amarillo' | 'rojo' | 'manual';
/** Palancas en orden de prioridad estricta: solo una puede estar activa a la vez. */
export type PalancaGobernador = 'area' | 'nacimientos' | 'red' | 'guardado';
/** Señales configurables en `gobernador.senales`. */
export type SenalGobernador = 'p95' | 'max' | 'rss' | 'colaRed' | 'saveMs';

export const SENALES_GOBERNADOR: readonly SenalGobernador[] = ['p95', 'max', 'rss', 'colaRed', 'saveMs'];
/** Ventanas verdes consecutivas que exige salir de rojo en la vía multiseñal (36 s: 3 × 120 pasos a 10 Hz). */
export const VENTANAS_VERDES_PARA_SALIR = 3;
/** Techo de la palanca de red: nunca espacia una suscripción por encima de esto. */
export const SUBSCRIBE_MS_MAXIMO = 5000;
/** Techo de la palanca de guardado: nunca espacia la cadencia por encima de esto. */
export const CADA_TICKS_MAXIMO = 20;
const ORDEN_PALANCAS: readonly PalancaGobernador[] = ['area', 'nacimientos', 'red', 'guardado'];
const PALANCA_DE_SENAL: Readonly<Record<SenalGobernador, PalancaGobernador>> = { rss: 'area', p95: 'nacimientos', max: 'nacimientos', colaRed: 'red', saveMs: 'guardado' };

/** Estado que `gobernar` arrastra entre ventanas. Viaja como argumento y resultado: nunca se muta. */
export interface EstadoGobernacion { techo: EstadoTecho; frenado: boolean; ventanasVerdesConsecutivas: number }
export const ESTADO_GOBERNACION_INICIAL: Readonly<EstadoGobernacion> = Object.freeze({ techo: Object.freeze({ techo: null }), frenado: false, ventanasVerdesConsecutivas: 0 });

export interface EntradaGobernar {
  presupuestoMs: number; politica: 'apagar' | 'techo';
  /** Señales configuradas (`gobernador.senales`); por defecto `['p95']`, la vía compatible. */
  senales?: readonly string[];
  /** Valor vigente de cada señal, en la magnitud comparable con `presupuestoMs` que declare quien mide. */
  valores?: Partial<Record<SenalGobernador, number>>;
  /** Atajo para la señal histórica: equivale a `valores.p95` si este no viene. */
  p95StepMs?: number;
  /** `reproductionEnabled` vigente: lo que la palanca de nacimientos conserva en su banda y las demás no tocan. */
  actual: boolean; poblacion: number;
  /** Orden humana activa (`null`/ausente = sin orden): manda siempre. */
  manualOverride?: boolean | null;
  /** Palanca de área: solo puede ganar si está habilitada y sobran páginas frías (el retiro lo hará T163). */
  areaHabilitada?: boolean; paginasFriasExceso?: number;
  /** Palanca de red: suscripción vigente y su máximo; subirla va antes que descartar mensajes. */
  subscribeMs?: number; subscribeMsMaximo?: number;
  /** Palanca de guardado: cadencia vigente y su máximo. Un gesto en este paso la deja intacta. */
  cadaTicks?: number; cadaTicksMaximo?: number; gestoEnEstePaso?: boolean;
}

export interface DecisionGobernar {
  estado: EstadoGobernador;
  /** Una sola palanca activa a la vez; `null` fuera de rojo (o en rojo sin palanca aplicable). */
  palancaActiva: PalancaGobernador | null;
  senalDisparadora: SenalGobernador | null;
  senalesDisparadas: SenalGobernador[];
  reproductionEnabled: boolean;
  techo: number | null; estadoTecho: EstadoTecho;
  ventanasVerdesConsecutivas: number;
  /** Palanca de área: pide retirar páginas frías; no retira nada por sí misma. */
  solicitarRetiroPaginasFrias: boolean;
  subscribeMsEfectivo: number; cadaTicksEfectivo: number;
  /** Estado para la ventana siguiente; pásalo como `previo` y la cadena sigue siendo pura. */
  siguiente: EstadoGobernacion;
}

function senalesConfiguradas(entrada: EntradaGobernar): SenalGobernador[] {
  const pedidas = (entrada.senales?.length ? entrada.senales : ['p95']).filter((s): s is SenalGobernador => (SENALES_GOBERNADOR as readonly string[]).includes(s));
  return pedidas.length ? [...new Set(pedidas)] : ['p95'];
}

/**
 * Decisión completa del gobernador (T162), función pura como `decideReproduction`:
 * no muta `previo` ni `entrada`, no lee relojes ni el mundo.
 * · Umbrales relativos a `presupuestoMs` (50 ms ⇒ amarillo desde 35 ms, rojo por encima de 50 ms).
 * · `manualOverride !== null` ⇒ estado `manual` y esa orden es el resultado, dispare lo que dispare.
 * · En rojo gana una sola palanca, en el orden área → nacimientos → red → guardado; las demás
 *   palancas quedan intactas (`reproductionEnabled`, `subscribeMs` y `cadaTicks` conservan su valor).
 * · Salir de rojo en la vía multiseñal exige `VENTANAS_VERDES_PARA_SALIR` ventanas verdes
 *   consecutivas (todas las señales bajo el 70 %); una ventana amarilla reinicia la cuenta y
 *   mientras tanto el estado sigue en rojo, con el techo y la reproducción vigentes.
 * · Control obligatorio: con `senales = ['p95']` (el default) no hay espera de tres ventanas y
 *   `reproductionEnabled`/`techo` salen de `decideReproduction`/`decidirConTecho`, como hoy.
 */
export function gobernar(entrada: EntradaGobernar, previo: Readonly<EstadoGobernacion> = ESTADO_GOBERNACION_INICIAL): DecisionGobernar {
  const presupuesto = entrada.presupuestoMs, umbralAmarillo = presupuesto * 0.7;
  const senales = senalesConfiguradas(entrada);
  const soloP95 = senales.length === 1 && senales[0] === 'p95';
  const valores: Partial<Record<SenalGobernador, number>> = { p95: entrada.p95StepMs ?? 0, ...entrada.valores };
  const valor = (s: SenalGobernador): number => valores[s] ?? 0;
  const subscribeBase = entrada.subscribeMs ?? 0, cadaBase = entrada.cadaTicks ?? 1;
  const base = { senalesDisparadas: [] as SenalGobernador[], solicitarRetiroPaginasFrias: false, subscribeMsEfectivo: subscribeBase, cadaTicksEfectivo: cadaBase };
  const cerrar = (parcial: Omit<DecisionGobernar, 'techo' | 'estadoTecho' | 'siguiente'> & { estadoTecho: EstadoTecho; siguiente: EstadoGobernacion }): DecisionGobernar =>
    ({ ...parcial, techo: parcial.estadoTecho.techo });

  if (entrada.manualOverride !== null && entrada.manualOverride !== undefined) {
    const estadoTecho: EstadoTecho = entrada.politica === 'apagar' ? { techo: null } : { techo: previo.techo.techo };
    return cerrar({ ...base, estado: 'manual', palancaActiva: null, senalDisparadora: null,
      reproductionEnabled: entrada.manualOverride, ventanasVerdesConsecutivas: 0, estadoTecho,
      siguiente: { techo: estadoTecho, frenado: previo.frenado, ventanasVerdesConsecutivas: 0 } });
  }

  const disparadas = senales.filter(s => valor(s) > presupuesto);
  const enVerde = senales.every(s => valor(s) < umbralAmarillo);
  const nivel: EstadoGobernador = disparadas.length ? 'rojo' : enVerde ? 'verde' : 'amarillo';
  // La palanca de nacimientos se juzga con su señal de coste disparada (p95, o el máximo si fue él).
  const valorNacimientos = disparadas.includes('p95') ? valor('p95') : disparadas.includes('max') ? valor('max') : senales.includes('p95') ? valor('p95') : valor('max');
  const decidirNacimientos = (estadoTechoPrevio: Readonly<EstadoTecho>): { reproduccion: boolean; estadoTecho: EstadoTecho } =>
    entrada.politica === 'apagar'
      ? { reproduccion: decideReproduction(valorNacimientos, presupuesto, entrada.actual), estadoTecho: { techo: null } }
      : (() => { const d = decidirConTecho(valorNacimientos, presupuesto, entrada.poblacion, estadoTechoPrevio); return { reproduccion: d.reproduccion, estadoTecho: d.estado }; })();

  if (soloP95) {
    const d = decidirNacimientos(previo.techo);
    return cerrar({ ...base, estado: nivel, palancaActiva: nivel === 'rojo' ? 'nacimientos' : null,
      senalDisparadora: nivel === 'rojo' ? 'p95' : null, senalesDisparadas: disparadas,
      reproductionEnabled: d.reproduccion, ventanasVerdesConsecutivas: 0, estadoTecho: d.estadoTecho,
      siguiente: { techo: d.estadoTecho, frenado: nivel === 'rojo', ventanasVerdesConsecutivas: 0 } });
  }

  if (nivel === 'rojo') {
    const candidatas = new Map<PalancaGobernador, SenalGobernador>();
    for (const s of disparadas) { const p = PALANCA_DE_SENAL[s]; if (!candidatas.has(p)) candidatas.set(p, s); }
    // El exceso de páginas frías habilitado también levanta la palanca de área, dispare la señal que dispare.
    if (entrada.areaHabilitada && (entrada.paginasFriasExceso ?? 0) > 0 && !candidatas.has('area')) candidatas.set('area', disparadas[0]!);
    // `area` exige habilitación y exceso; si la levantó `rss` sin exceso, no es aplicable y gana la siguiente.
    const areaAplicable = !!entrada.areaHabilitada && (entrada.paginasFriasExceso ?? 0) > 0;
    const palancaActiva = ORDEN_PALANCAS.find(p => candidatas.has(p) && (p !== 'area' || areaAplicable)) ?? null;
    const estadoTechoPrevio: EstadoTecho = entrada.politica === 'apagar' ? { techo: null } : { techo: previo.techo.techo };
    const senalDisparadora = palancaActiva ? candidatas.get(palancaActiva)! : (disparadas[0] ?? null);
    const comun = { ...base, estado: 'rojo' as EstadoGobernador, palancaActiva, senalDisparadora, senalesDisparadas: disparadas, ventanasVerdesConsecutivas: 0 };
    const siguiente = (estadoTecho: EstadoTecho): EstadoGobernacion => ({ techo: estadoTecho, frenado: true, ventanasVerdesConsecutivas: 0 });
    if (palancaActiva === 'nacimientos') {
      const d = decidirNacimientos(previo.techo);
      return cerrar({ ...comun, reproductionEnabled: d.reproduccion, estadoTecho: d.estadoTecho, siguiente: siguiente(d.estadoTecho) });
    }
    if (palancaActiva === 'area') return cerrar({ ...comun, solicitarRetiroPaginasFrias: true, reproductionEnabled: entrada.actual, estadoTecho: estadoTechoPrevio, siguiente: siguiente(estadoTechoPrevio) });
    if (palancaActiva === 'red') {
      const maximo = entrada.subscribeMsMaximo ?? SUBSCRIBE_MS_MAXIMO;
      const efectivo = subscribeBase > 0 ? Math.min(maximo, subscribeBase * 2) : Math.min(maximo, 1000);
      return cerrar({ ...comun, subscribeMsEfectivo: efectivo, reproductionEnabled: entrada.actual, estadoTecho: estadoTechoPrevio, siguiente: siguiente(estadoTechoPrevio) });
    }
    if (palancaActiva === 'guardado') {
      const maximo = entrada.cadaTicksMaximo ?? CADA_TICKS_MAXIMO;
      // Un gesto fuerza guardado en su propio paso: en ese paso la cadencia no se espacia jamás.
      const efectivo = entrada.gestoEnEstePaso ? cadaBase : Math.min(maximo, Math.max(cadaBase + 1, cadaBase * 2));
      return cerrar({ ...comun, cadaTicksEfectivo: efectivo, reproductionEnabled: entrada.actual, estadoTecho: estadoTechoPrevio, siguiente: siguiente(estadoTechoPrevio) });
    }
    return cerrar({ ...comun, reproductionEnabled: entrada.actual, estadoTecho: estadoTechoPrevio, siguiente: siguiente(estadoTechoPrevio) });
  }

  if (previo.frenado) {
    const estadoTechoPrevio: EstadoTecho = entrada.politica === 'apagar' ? { techo: null } : { techo: previo.techo.techo };
    if (nivel === 'verde') {
      const ventanas = previo.ventanasVerdesConsecutivas + 1;
      if (ventanas >= VENTANAS_VERDES_PARA_SALIR) {
        const d = decidirNacimientos(estadoTechoPrevio);
        return cerrar({ ...base, estado: 'verde', palancaActiva: null, senalDisparadora: null,
          reproductionEnabled: entrada.politica === 'techo' ? true : d.reproduccion, ventanasVerdesConsecutivas: ventanas,
          estadoTecho: entrada.politica === 'techo' ? { techo: null } : d.estadoTecho,
          siguiente: { techo: entrada.politica === 'techo' ? { techo: null } : d.estadoTecho, frenado: false, ventanasVerdesConsecutivas: ventanas } });
      }
      // Aún en rojo por histéresis: se conserva lo vigente, sin tocar ninguna palanca.
      return cerrar({ ...base, estado: 'rojo', palancaActiva: null, senalDisparadora: null,
        reproductionEnabled: entrada.actual, ventanasVerdesConsecutivas: ventanas, estadoTecho: estadoTechoPrevio,
        siguiente: { techo: estadoTechoPrevio, frenado: true, ventanasVerdesConsecutivas: ventanas } });
    }
    // Amarillo tras frenar: tampoco sale de rojo y la cuenta de ventanas verdes se reinicia.
    return cerrar({ ...base, estado: 'rojo', palancaActiva: null, senalDisparadora: null,
      reproductionEnabled: entrada.actual, ventanasVerdesConsecutivas: 0, estadoTecho: estadoTechoPrevio,
      siguiente: { techo: estadoTechoPrevio, frenado: true, ventanasVerdesConsecutivas: 0 } });
  }

  const d = decidirNacimientos(previo.techo);
  return cerrar({ ...base, estado: nivel, palancaActiva: null, senalDisparadora: null,
    reproductionEnabled: d.reproduccion, ventanasVerdesConsecutivas: 0, estadoTecho: d.estadoTecho,
    siguiente: { techo: d.estadoTecho, frenado: false, ventanasVerdesConsecutivas: 0 } });
}

/**
 * Gobernador completo, compartido por el servidor (`app.ts`) y el laboratorio (`scripts/lab/replica.ts`)
 * para que ambos apliquen exactamente la misma política sobre la misma ventana. Guarda solo estado de
 * ejecución (nada entra en el mundo ni en su digesto); `manual` (orden humana) lo administra quien lo usa.
 */
/** Parámetros de una decisión del `Gobernador`: los de `gobernador.*` más el contexto de palancas. */
export type ParamsDecisionGobernador = Omit<EntradaGobernar, 'actual' | 'poblacion' | 'p95StepMs'>;

export class Gobernador {
  readonly medidas = new RollingStepPerformance();
  p95StepMs = 0;
  estado: EstadoTecho = { ...ESTADO_TECHO_INICIAL };
  techoObservado: TechoObservado | null = null;
  /** T162: estado, palanca y señal vigentes tras la última decisión (`verde` antes de decidir). */
  estadoGobernador: EstadoGobernador = 'verde';
  palancaActiva: PalancaGobernador | null = null;
  senalDisparadora: SenalGobernador | null = null;
  ventanasVerdesConsecutivas = 0;
  solicitarRetiroPaginasFrias = false;
  subscribeMsEfectivo = 0;
  cadaTicksEfectivo = 1;
  ultimaDecision: DecisionGobernar | null = null;
  private gobernacion: EstadoGobernacion = { techo: { ...ESTADO_TECHO_INICIAL }, frenado: false, ventanasVerdesConsecutivas: 0 };
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
   * Toda la política vive en la función pura `gobernar`; esta clase solo aporta la ventana medida
   * (p95 y máximo) y guarda su estado. Con `senales = ['p95']` el resultado es el de siempre.
   */
  decidir(params: ParamsDecisionGobernador, actual: boolean, poblacion: number, teselasActivas: number, tick: number): boolean {
    if (params.manualOverride !== null && params.manualOverride !== undefined) {
      this.estadoGobernador = 'manual'; this.palancaActiva = null; this.senalDisparadora = null; this.solicitarRetiroPaginasFrias = false;
      return params.manualOverride;
    }
    if (this.medidas.count === 0) return actual;
    const valores: Partial<Record<SenalGobernador, number>> = { p95: this.p95StepMs, max: this.medidas.maxMs, ...params.valores };
    const decision = gobernar({ ...params, valores, p95StepMs: this.p95StepMs, actual, poblacion }, this.gobernacion);
    this.gobernacion = decision.siguiente;
    this.estado = decision.estadoTecho;
    this.estadoGobernador = decision.estado; this.palancaActiva = decision.palancaActiva;
    this.senalDisparadora = decision.senalDisparadora; this.ventanasVerdesConsecutivas = decision.ventanasVerdesConsecutivas;
    this.solicitarRetiroPaginasFrias = decision.solicitarRetiroPaginasFrias;
    this.subscribeMsEfectivo = decision.subscribeMsEfectivo; this.cadaTicksEfectivo = decision.cadaTicksEfectivo;
    this.ultimaDecision = decision;
    const rojo = decision.estado === 'rojo';
    if (rojo && !this.enRojo) {
      const senal = decision.senalDisparadora ?? 'p95';
      this.techoObservado = describirFrenazo(this.p95StepMs, params.presupuestoMs, poblacion, teselasActivas, tick, this.medidas.maxMs, senal, valores[senal] ?? this.p95StepMs);
    }
    this.enRojo = rojo;
    return decision.reproductionEnabled;
  }

  /** Atajo T162: decide y devuelve la decisión entera (estado, palanca y efectos), no solo el booleano. */
  gobernar(params: ParamsDecisionGobernador, actual: boolean, poblacion: number, teselasActivas: number, tick: number): DecisionGobernar {
    this.decidir(params, actual, poblacion, teselasActivas, tick);
    return this.ultimaDecision ?? gobernar({ ...params, p95StepMs: this.p95StepMs, actual, poblacion }, this.gobernacion);
  }
}
