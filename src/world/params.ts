/**
 * Parámetros configurables del mundo (T001, fase 0). Las claves y sus valores por
 * defecto fijan el comportamiento ACTUAL del simulador: introducir este módulo no
 * cambia ninguna dinámica. Los 13 workstreams paralelos importan estas claves; nadie
 * más que T001 edita este fichero. Los params viven en un WeakMap por mundo (no se
 * añaden campos a `World`, así se evita migrar snapshots guardados).
 */

import { DEMOGRAPHY_TICKS_PER_DAY, longevityAges, type LongevityLaw } from '../shared/demography.js';
import { splitParamList } from '../shared/param-syntax.js';

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
  persistencia: { cadaTicks: number; ventanaEventosTicks: number; paginasSucias: boolean };
  /** Agua superficial concentrada en cuencas: 1 = generación actual (todas las charcas/manantiales); < 1 conserva solo las de las cuencas más húmedas (T035). */
  agua: { cuencas: number };
  /**
   * Ruling R17: el límite de población lo pone el hardware. `presupuestoMs` es el p95
   * del paso (ms) que el servidor se permite; por encima el gobernador apaga la
   * reproducción, por debajo del 70 % la reenciende. Default 50 ms = constitución V.
   */
  gobernador: { presupuestoMs: number; senales: string[] };
  /** T102: configuración reservada; todavía no selecciona otro backend. */
  motor: { clonPorPaso: boolean; hilos: number; soaTerreno: boolean; particionarPersonas: boolean; gpu: number[]; orden: 'natural' | 'inverso' | 'adversarial' };
  red: { deltas: boolean };
  /** T100: admisión de colecciones; no son una política silenciosa de natalidad. */
  limites: { teselasActivas: number; chunks: number; comunidades: number; fauna: number; aplicacion: 'historicos' | 'parametros' };
  /**
   * Leyes candidatas (noche de ciencia, 2026-09-22). `docs/ANALISIS-DINAMICAS-2026-09-21.md`
   * mide tres cierres: la elección refuerza al ganador y se traba en cooperar, las disputas
   * por recursos nunca se disparan y la pertenencia a una comunidad no vuelve a revisarse.
   * Estas claves abren esos tres cerrojos SIN decidir nada: con sus defaults el mundo es el
   * de hoy paso a paso, y sólo un laboratorio que las mueva mide otra cosa.
   */
  conducta: { habituacion: number };
  social: { disputaNecesidad: number; disputaEscasez: number; disputaRadio: number; disputaDestino: number; disputaEspera: number;
    ensenanzaRareza: number; confianzaSalida: number; distanciaAlternativa: number };
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
  persistencia: { cadaTicks: 1, ventanaEventosTicks: 0, paginasSucias: false },
  agua: { cuencas: 0.4 },
  gobernador: { presupuestoMs: 50, senales: ['p95'] },
  motor: { clonPorPaso: true, hilos: 1, soaTerreno: false, particionarPersonas: false, gpu: [], orden: 'natural' },
  red: { deltas: false },
  limites: { teselasActivas: 65536, chunks: 256, comunidades: 8, fauna: 393216, aplicacion: 'parametros' },
  // Leyes candidatas: cada default es la constante que hoy está escrita en el código
  // (`index.ts` no descuenta saciedad; `society.ts` usa 0,65 / ×1 / 2 celdas / 0,5 de
  // destino / 180 ticks de espera / sin rareza / 0,35 de confianza / 0,2 de distancia
  // cultural), así que abrirlas no cambia el mundo.
  conducta: { habituacion: 0 },
  social: { disputaNecesidad: 0.65, disputaEscasez: 1, disputaRadio: 2, disputaDestino: 0.5, disputaEspera: 180,
    ensenanzaRareza: 0, confianzaSalida: 0.35, distanciaAlternativa: 0.2 },
};

/** Objeto congelado en profundidad: nunca se muta; `parseParams` clona para cada override. */
export const DEFAULT_PARAMS: WorldParams = deepFreeze(RAW_DEFAULTS);
export type WorldLimits = Omit<WorldParams['limites'], 'aplicacion'>;
/** Historical admission bounds, independent of the machine reading an old world. */
export const LEGACY_WORLD_LIMITS: Readonly<WorldLimits> = deepFreeze({ teselasActivas: DEFAULT_PARAMS.limites.teselasActivas,
  chunks: DEFAULT_PARAMS.limites.chunks, comunidades: DEFAULT_PARAMS.limites.comunidades, fauna: DEFAULT_PARAMS.limites.fauna });
export const PARAMETER_LIMITS_RULES_VERSION = 9;
export const WORLD_LIMIT_KEYS = ['teselasActivas', 'chunks', 'comunidades', 'fauna'] as const;

export function assertWorldLimits(value: unknown, configured = false): asserts value is WorldLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== WORLD_LIMIT_KEYS.length + Number(configured)
    || configured && (!Object.prototype.propertyIsEnumerable.call(value, 'aplicacion')
      || !['historicos', 'parametros'].includes((value as WorldParams['limites']).aplicacion))
    || WORLD_LIMIT_KEYS.some(key => !Object.prototype.propertyIsEnumerable.call(value, key)
      || !Number.isSafeInteger((value as WorldLimits)[key]) || (value as WorldLimits)[key] < 1))
    throw new Error('Límites de admisión inválidos: se requieren cuatro enteros seguros positivos.');
}

/** A declared historical mode preserves previously inactive T102 numbers verbatim. */
export function effectiveLimits(params: WorldParams): Readonly<WorldLimits> {
  return params.limites.aplicacion === 'historicos' ? LEGACY_WORLD_LIMITS : params.limites;
}

/** Old rules are admitted under their historical bounds before migration. */
export function limitsOf(world: object, version?: number): Readonly<WorldLimits> {
  return version !== undefined && version < PARAMETER_LIMITS_RULES_VERSION ? LEGACY_WORLD_LIMITS : effectiveLimits(paramsOf(world));
}

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
  'motor.hilos': [1, 512],
  'limites.teselasActivas': [1, Number.MAX_SAFE_INTEGER],
  'limites.chunks': [1, Number.MAX_SAFE_INTEGER],
  'limites.comunidades': [1, Number.MAX_SAFE_INTEGER],
  'limites.fauna': [1, Number.MAX_SAFE_INTEGER],
  // Leyes candidatas. El mínimo de `disputaNecesidad` y `disputaEscasez` no es 0 a
  // propósito: con 0 la disputa dejaría de exigir necesidad o escasez y sería un
  // conflicto decretado, no medido. `disputaRadio` parte de 1 celda (contacto real).
  'conducta.habituacion': [0, 2],
  'social.disputaNecesidad': [0.1, 1],
  'social.disputaEscasez': [0.1, 20],
  'social.disputaRadio': [1, 8],
  // `disputaDestino` es la coincidencia de destino, no la distancia entre personas: con
  // 0,5 sólo disputan quienes apuntan A LA MISMA celda. `disputaEspera` son los ticks de
  // calma tras una disputa, en ambos lados; entera, porque se compara con `world.tick`.
  'social.disputaDestino': [0.1, 8],
  'social.disputaEspera': [1, 10000],
  'social.ensenanzaRareza': [0, 5],
  'social.confianzaSalida': [0, 1],
  'social.distanciaAlternativa': [0, 1],
};

type ScalarDescriptor = { kind: 'number'; range: readonly [number, number]; integer?: boolean }
  | { kind: 'boolean' } | { kind: 'enum'; values: readonly string[] };
export type ParamDescriptor = ScalarDescriptor | { kind: 'array'; element: ScalarDescriptor; minLength: number; unique: boolean };
type ParamValue = number | boolean | string | (number | boolean | string)[];

/** PARAM_RANGES conserva sus tuplas numéricas; cada hoja declara además su tipo. */
export const PARAM_DESCRIPTORS: Readonly<Record<string, ParamDescriptor>> = deepFreeze({
  ...Object.fromEntries(Object.entries(PARAM_RANGES).map(([key, range]) => [key,
    { kind: 'number', range, integer: key === 'motor.hilos' || key === 'social.disputaEspera' || key.startsWith('limites.') }])),
  'motor.clonPorPaso': { kind: 'boolean' },
  'motor.soaTerreno': { kind: 'boolean' },
  'motor.particionarPersonas': { kind: 'boolean' },
  'motor.gpu': { kind: 'array', element: { kind: 'number', range: [0, Number.MAX_SAFE_INTEGER], integer: true }, minLength: 0, unique: true },
  'motor.orden': { kind: 'enum', values: ['natural', 'inverso', 'adversarial'] },
  'limites.aplicacion': { kind: 'enum', values: ['historicos', 'parametros'] },
  'persistencia.paginasSucias': { kind: 'boolean' },
  'red.deltas': { kind: 'boolean' },
  'gobernador.senales': { kind: 'array', element: { kind: 'enum', values: ['p95'] }, minLength: 1, unique: true },
});
const PARAM_KEYS = Object.keys(PARAM_DESCRIPTORS);

function unknownParam(key: string): never {
  throw new Error(`Parámetro desconocido: "${key}". Claves válidas: ${PARAM_KEYS.join(', ')}.`);
}

function paramValue(key: string, raw: unknown, descriptor: ParamDescriptor, text = true): ParamValue {
  if (descriptor.kind === 'array') {
    let array = raw;
    if (text && typeof raw === 'string') {
      try { array = JSON.parse(raw); } catch { throw new Error(`Valor inválido para "${key}": se esperaba un array JSON.`); }
    }
    if (!Array.isArray(array) || array.length < descriptor.minLength) throw new Error(`Valor inválido para "${key}": se esperaba un array con al menos ${descriptor.minLength} elementos.`);
    const entries = array;
    const values = Array.from({ length: entries.length }, (_, index) => paramValue(`${key}[${index}]`, entries[index], descriptor.element, false) as number | boolean | string);
    if (descriptor.unique && new Set(values).size !== values.length) throw new Error(`Valor inválido para "${key}": elementos duplicados.`);
    return values;
  }
  if (descriptor.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (text && typeof raw === 'string' && ['true', 'false'].includes(raw.trim())) return raw.trim() === 'true';
    throw new Error(`Valor inválido para "${key}": se esperaba true o false.`);
  }
  if (descriptor.kind === 'enum') {
    if (typeof raw === 'string' && descriptor.values.includes(raw)) return raw;
    throw new Error(`Valor inválido para "${key}": valores permitidos ${descriptor.values.join(', ')}.`
      + (key.startsWith('gobernador.senales') ? ' Las demás señales requieren T161.' : ''));
  }
  const value = typeof raw === 'number' ? raw : text && typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(value)) throw new Error(`Valor no numérico para "${key}": "${typeof raw === 'string' || typeof raw === 'number' ? String(raw) : typeof raw}".`);
  const [min, max] = descriptor.range;
  if (value < min || value > max) throw new Error(`Valor fuera de rango para "${key}": ${value} (rango permitido [${min}, ${max}]).`);
  if (descriptor.integer && !Number.isSafeInteger(value)) throw new Error(`Valor inválido para "${key}": se esperaba un entero seguro.`);
  return value;
}

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
  if (prefix && Object.hasOwn(PARAM_DESCRIPTORS, prefix)) { out[prefix] = value; return; }
  if (prefix && !PARAM_KEYS.some(key => key.startsWith(`${prefix}.`))) unknownParam(prefix);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Formato de parámetros inválido: se esperaba un objeto JSON.');
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!key) unknownParam(key);
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    throw new Error(`Formato de parámetros inválido: "${prefix || 'raíz'}" debe ser un objeto de claves conocidas.`);
  }
}

/** Asignaciones separadas por comas externas a JSON, o un objeto JSON anidado/plano. */
function parseParamString(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed === '') return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) as Record<string, unknown>; }
    catch { throw new Error(`Parámetros en JSON inválido: "${input}".`); }
  }
  const pairs: Record<string, unknown> = Object.create(null);
  for (const piece of splitParamList(trimmed)) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) throw new Error(`Formato de parámetros inválido: "${piece}" (se esperaba "clave.sub=valor").`);
    const value = piece.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      try { pairs[piece.slice(0, eq).trim()] = JSON.parse(value); }
      catch { throw new Error(`Parámetros en JSON inválido: "${piece}".`); }
    } else pairs[piece.slice(0, eq).trim()] = value;
  }
  return pairs;
}

function setPath(target: Record<string, unknown>, dottedKey: string, value: ParamValue): void {
  const parts = dottedKey.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]!] as Record<string, unknown>;
  node[parts[parts.length - 1]!] = value;
}

/**
 * Acepta `undefined` (→ `base`, por identidad), una cadena "a.b=1,c.d=2" o
 * JSON (anidado o plano), o un diccionario con valores tipados o de texto. Devuelve
 * un objeto NUEVO congelado: clon profundo de `base` con los overrides
 * aplicados. Lanza `Error` con mensaje claro en español si una clave no existe en
 * `PARAM_DESCRIPTORS`, o el valor incumple su tipo o rango.
 *
 * `base` es el escalón inferior de la precedencia y por defecto son los `DEFAULT_PARAMS`
 * (comportamiento de siempre). Existe porque los overrides explícitos de un despliegue
 * se aplican ENCIMA de lo que ya rige —los params que un mundo trae en su instantánea—
 * y reemplazar el objeto entero borraba en silencio lo que el override no nombra
 * (ronda de corrección R2). La validación no cambia con la base: cada override se sigue
 * midiendo contra `PARAM_RANGES`, y la base llegó por este mismo camino.
 */
export function parseParams(input?: Record<string, unknown> | string, base: WorldParams = DEFAULT_PARAMS): WorldParams {
  if (input === undefined) return base;
  const raw = typeof input === 'string' ? parseParamString(input) : input;
  const overrides: Record<string, unknown> = Object.create(null);
  flatten(raw, '', overrides);
  const draft = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, rawValue] of Object.entries(overrides)) {
    setPath(draft, key, paramValue(key, rawValue, PARAM_DESCRIPTORS[key]!));
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
  assertWorldLimits(params.limites, true);
  worldParams.set(world, params);
}
