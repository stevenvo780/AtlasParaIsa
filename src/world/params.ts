/**
 * Parámetros configurables del mundo (T001, fase 0). Las claves y sus valores por
 * defecto fijan el comportamiento ACTUAL del simulador: introducir este módulo no
 * cambia ninguna dinámica. Los 13 workstreams paralelos importan estas claves; nadie
 * más que T001 edita este fichero. Los params viven en un WeakMap por mundo (no se
 * añaden campos a `World`, así se evita migrar snapshots guardados).
 */

import { DEMOGRAPHY_TICKS_PER_DAY, longevityAges, type LongevityLaw } from '../shared/demography.js';

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
  poblacion: { maxima: 40, intervaloComprobacionTicks: 120, nacimientosPorComprobacion: 2 },
  recursos: { capacidadBosque: 1, capacidadPastizal: 0.7, capacidadOtros: 0.35, velocidadRegeneracion: 1, decaimientoFertilidad: 0.001, decaimientoComida: 0.0001 },
  persistencia: { cadaTicks: 1, ventanaEventosTicks: 0 },
  agua: { cuencas: 0.4 },
};

/** Objeto congelado en profundidad: nunca se muta; `parseParams` clona para cada override. */
export const DEFAULT_PARAMS: WorldParams = deepFreeze(RAW_DEFAULTS);

/** Rango [mínimo, máximo] permitido por clave punteada. Usado por `parseParams`. */
export const PARAM_RANGES: Record<string, [number, number]> = {
  // Longevidad (revisión de R3): los mínimos/máximos son los que, CON EL RESTO DE LA LEY EN SUS
  // DEFAULTS, dan un mundo corrible para CUALQUIER genoma. Medido con 2000 genomas uniformes
  // (`localRandom`, sal «probe-r3»): base 1 rompe el 57 %, base 2 el 16 %, base 3 el 0,5 % y base 4
  // ninguno; con `porActividad` 20 la edad máxima de un cuerpo poco resiliente es negativa, y la
  // fracción 0 o 1 colapsa la vejez. Los rangos anteriores ([1,60], [0,20], [0,1]) declaraban legal
  // todo eso y la rotura no se oía al parsear, sino al nacer el primer cuerpo desafortunado.
  // Las combinaciones CRUZADAS no caben en un rango por clave: las comprueba `assertLongevityLaw`.
  'cuerpo.longevidadBaseDias': [4, 60],
  'cuerpo.longevidadPorResiliencia': [0, 20],
  'cuerpo.longevidadPorActividad': [0, 8],
  'cuerpo.senescenciaInicioFraccion': [0.25, 0.99],
  'cuerpo.riesgoSenescenciaDiario': [0, 1],
  'cuerpo.riesgoSenescenciaPendiente': [0, 50],
  'cuerpo.cuidadoReduceRiesgo': [0, 1],
  'genes.varianzaFundadores': [0, 1],
  'genes.tasaMutacion': [0, 10],
  'poblacion.maxima': [1, 128],
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
};

/** Holgura mínima, en ticks, entre madurez, vejez y edad máxima en las cuatro esquinas. Absorbe el
 * redondeo: `longevityAges` redondea tres veces, así que una diferencia continua puede moverse hasta
 * ~1,5 ticks al redondear. Exigir 4 en las esquinas garantiza el orden estricto en todo el interior. */
const LONGEVITY_SLACK_TICKS = 4;
const LONGEVITY_CORNERS: readonly (readonly [number, number])[] = [[0, 0], [0, 1], [1, 0], [1, 1]];
const days = (ticks: number) => (ticks / DEMOGRAPHY_TICKS_PER_DAY).toFixed(2);

/**
 * La ley de longevidad tiene que dar un mundo corrible ANTES del primer paso (revisión de R3).
 * `PARAM_RANGES` acota cada clave por separado, pero «madurez < vejez < edad máxima» es una
 * condición CRUZADA entre las cuatro y ningún rango por clave puede expresarla: `base 4` es legal y
 * `porActividad 8` también, y juntas dan una edad máxima negativa. Antes esto se oía en
 * `demographicTraits`, es decir DENTRO del tick y sólo cuando nacía un genoma desafortunado: una
 * réplica de laboratorio moría tras horas y el servidor público perdía el bucle de simulación. Aquí
 * cuesta cuatro multiplicaciones y se paga una vez, al fijar los params.
 *
 * Basta con las cuatro esquinas de (resiliencia, actividad) ∈ {0,1}²: las tres edades son afines en
 * ese par antes de redondear, así que su mínimo sobre el cuadrado está en una esquina.
 */
export function assertLongevityLaw(law: Readonly<LongevityLaw>): void {
  // El mensaje se arma sólo al fallar: `cloneWorld` llama a `setParams` en CADA paso (app.ts:183),
  // así que el camino feliz no debe convertir cuatro números a texto por tick.
  const claves = () => `cuerpo.longevidadBaseDias=${law.longevidadBaseDias}, cuerpo.longevidadPorResiliencia=${law.longevidadPorResiliencia}, `
    + `cuerpo.longevidadPorActividad=${law.longevidadPorActividad}, cuerpo.senescenciaInicioFraccion=${law.senescenciaInicioFraccion}`;
  if (![law.longevidadBaseDias, law.longevidadPorResiliencia, law.longevidadPorActividad, law.senescenciaInicioFraccion]
    .every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error(`Ley de longevidad inválida (${claves()}): los cuatro valores deben ser números finitos y no negativos.`);
  }
  for (const [resilience, activity] of LONGEVITY_CORNERS) {
    const { maturityAge, senescenceStart, maximumAge } = longevityAges(resilience, activity, law);
    if (maturityAge + LONGEVITY_SLACK_TICKS <= senescenceStart && senescenceStart + LONGEVITY_SLACK_TICKS <= maximumAge) continue;
    throw new Error(`Ley de longevidad imposible (${claves()}): un cuerpo de resiliencia ${resilience} y actividad ${activity} `
      + `maduraría a los ${days(maturityAge)} días, envejecería a los ${days(senescenceStart)} y moriría de viejo a los ${days(maximumAge)}. `
      + 'Hace falta madurez < vejez < edad máxima para cualquier genoma: sube cuerpo.longevidadBaseDias, '
      + 'baja cuerpo.longevidadPorActividad o sube cuerpo.senescenciaInicioFraccion.');
  }
}

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
  const params = draft as unknown as WorldParams;
  // Cruce de claves: el rango por clave no puede verlo, y el tick es demasiado tarde.
  assertLongevityLaw(params.cuerpo);
  return deepFreeze(params);
}

const worldParams = new WeakMap<object, WorldParams>();

/** Params efectivos de un mundo, o `DEFAULT_PARAMS` (misma identidad) si nunca se fijaron. */
export function paramsOf(world: object): WorldParams {
  return worldParams.get(world) ?? DEFAULT_PARAMS;
}

/** Fija los params de un mundo (o clon). Lo llaman `createWorld`/`cloneWorld` en `index.ts` y
 * `main.ts`, que aplica CARTA_PARAMS sobre un mundo ya creado: por eso la ley se valida también
 * aquí y no sólo en `parseParams`. */
export function setParams(world: object, params: WorldParams): void {
  assertLongevityLaw(params.cuerpo);
  worldParams.set(world, params);
}
