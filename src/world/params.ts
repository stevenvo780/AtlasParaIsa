/**
 * Parámetros configurables del mundo (T001, fase 0). Las claves y sus valores por
 * defecto fijan el comportamiento ACTUAL del simulador: introducir este módulo no
 * cambia ninguna dinámica. Los 13 workstreams paralelos importan estas claves; nadie
 * más que T001 edita este fichero. Los params viven en un WeakMap por mundo (no se
 * añaden campos a `World`, así se evita migrar snapshots guardados).
 */

export interface WorldParams {
  cuerpo: {
    longevidadBaseDias: number;
    longevidadPorResiliencia: number;
    longevidadPorActividad: number;
    senescenciaInicioFraccion: number;
    riesgoSenescenciaDiario: number;
    riesgoSenescenciaPendiente: number;
    cuidadoReduceRiesgo: number;
  };
  genes: { varianzaFundadores: number; tasaMutacion: number };
  poblacion: { maxima: number; intervaloComprobacionTicks: number; nacimientosPorComprobacion: number };
  recursos: { capacidadBosque: number; capacidadPastizal: number; capacidadOtros: number; velocidadRegeneracion: number; decaimientoFertilidad: number; decaimientoComida: number };
  persistencia: { cadaTicks: number; ventanaEventosTicks: number };
  /** Agua superficial concentrada en cuencas: 1 = generación actual (todas las charcas/manantiales); < 1 conserva solo las de las cuencas más húmedas (T035). */
  agua: { cuencas: number };
  /**
   * Ruling R17: el límite de población lo pone el hardware. `presupuestoMs` es el p95
   * del paso (ms) que el servidor se permite; por encima el gobernador apaga la
   * reproducción, por debajo del 70 % la reenciende. Default 50 ms = constitución V.
   */
  gobernador: { presupuestoMs: number };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const RAW_DEFAULTS: WorldParams = {
  cuerpo: {
    longevidadBaseDias: 11, longevidadPorResiliencia: 4, longevidadPorActividad: 1, senescenciaInicioFraccion: 0.75,
    riesgoSenescenciaDiario: 0.04, riesgoSenescenciaPendiente: 10, cuidadoReduceRiesgo: 0.6,
  },
  genes: { varianzaFundadores: 0.15, tasaMutacion: 1 },
  // Ruling R17: `maxima` ya no es un tope de diseño (era 40); por defecto no limita y el
  // freno lo ponen el entorno y el gobernador. Sigue siendo parámetro para el laboratorio.
  poblacion: { maxima: 1_000_000, intervaloComprobacionTicks: 120, nacimientosPorComprobacion: 2 },
  recursos: { capacidadBosque: 1, capacidadPastizal: 0.7, capacidadOtros: 0.35, velocidadRegeneracion: 1, decaimientoFertilidad: 0.001, decaimientoComida: 0.0001 },
  persistencia: { cadaTicks: 1, ventanaEventosTicks: 0 },
  agua: { cuencas: 0.4 },
  gobernador: { presupuestoMs: 50 },
};

/** Objeto congelado en profundidad: nunca se muta; `parseParams` clona para cada override. */
export const DEFAULT_PARAMS: WorldParams = deepFreeze(RAW_DEFAULTS);

/** Rango [mínimo, máximo] permitido por clave punteada. Usado por `parseParams`. */
export const PARAM_RANGES: Record<string, [number, number]> = {
  'cuerpo.longevidadBaseDias': [1, 60],
  'cuerpo.longevidadPorResiliencia': [0, 20],
  'cuerpo.longevidadPorActividad': [0, 20],
  'cuerpo.senescenciaInicioFraccion': [0, 1],
  'cuerpo.riesgoSenescenciaDiario': [0, 1],
  'cuerpo.riesgoSenescenciaPendiente': [0, 50],
  'cuerpo.cuidadoReduceRiesgo': [0, 1],
  'genes.varianzaFundadores': [0, 1],
  'genes.tasaMutacion': [0, 10],
  'poblacion.maxima': [1, 1_000_000],
  'poblacion.intervaloComprobacionTicks': [1, 10000],
  'poblacion.nacimientosPorComprobacion': [0, 20],
  'recursos.capacidadBosque': [0, 10],
  'recursos.capacidadPastizal': [0, 10],
  'recursos.capacidadOtros': [0, 10],
  'recursos.velocidadRegeneracion': [0, 10],
  'recursos.decaimientoFertilidad': [0, 1],
  'recursos.decaimientoComida': [0, 1],
  'persistencia.cadaTicks': [1, 10000],
  'persistencia.ventanaEventosTicks': [0, 1_000_000],
  'agua.cuencas': [0.05, 1],
  'gobernador.presupuestoMs': [5, 5000],
};

/** Aplana un objeto anidado o ya plano a pares "a.b" → valor (hoja, no objeto). */
function flatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out[prefix] = value;
  }
}

/** "cuerpo.longevidadBaseDias=14,genes.varianzaFundadores=0.15" o un objeto/array JSON (anidado o plano). */
function parseParamString(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed === '') return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) as Record<string, unknown>; }
    catch { throw new Error(`Parámetros en JSON inválido: "${input}".`); }
  }
  const pairs: Record<string, string> = {};
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) throw new Error(`Formato de parámetros inválido: "${piece}" (se esperaba "clave.sub=valor").`);
    pairs[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return pairs;
}

function setPath(target: Record<string, unknown>, dottedKey: string, value: number): void {
  const parts = dottedKey.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]!] as Record<string, unknown>;
  node[parts[parts.length - 1]!] = value;
}

/**
 * Acepta `undefined` (→ `DEFAULT_PARAMS`, por identidad), una cadena "a.b=1,c.d=2" o
 * JSON (anidado o plano), o un `Record<string,string>` de claves punteadas. Devuelve
 * un objeto NUEVO congelado: clon profundo de los defaults con los overrides
 * aplicados. Lanza `Error` con mensaje claro en español si una clave no existe en
 * `PARAM_RANGES`, el valor no es numérico o cae fuera del rango permitido.
 */
export function parseParams(input?: Record<string, string> | string): WorldParams {
  if (input === undefined) return DEFAULT_PARAMS;
  const raw = typeof input === 'string' ? parseParamString(input) : input;
  const overrides: Record<string, unknown> = {};
  flatten(raw, '', overrides);
  const draft = structuredClone(RAW_DEFAULTS) as unknown as Record<string, unknown>;
  for (const [key, rawValue] of Object.entries(overrides)) {
    const range = PARAM_RANGES[key];
    if (!range) throw new Error(`Parámetro desconocido: "${key}". Claves válidas: ${Object.keys(PARAM_RANGES).join(', ')}.`);
    const trimmed = typeof rawValue === 'number' ? null : String(rawValue).trim();
    const value = typeof rawValue === 'number' ? rawValue : trimmed === '' ? NaN : Number(trimmed);
    if (!Number.isFinite(value)) throw new Error(`Valor no numérico para "${key}": "${String(rawValue)}".`);
    const [min, max] = range;
    if (value < min || value > max) throw new Error(`Valor fuera de rango para "${key}": ${value} (rango permitido [${min}, ${max}]).`);
    setPath(draft, key, value);
  }
  return deepFreeze(draft as unknown as WorldParams);
}

const worldParams = new WeakMap<object, WorldParams>();

/** Params efectivos de un mundo, o `DEFAULT_PARAMS` (misma identidad) si nunca se fijaron. */
export function paramsOf(world: object): WorldParams {
  return worldParams.get(world) ?? DEFAULT_PARAMS;
}

/** Fija los params de un mundo (o clon). Lo llaman `createWorld`/`cloneWorld` en `index.ts`. */
export function setParams(world: object, params: WorldParams): void {
  worldParams.set(world, params);
}
