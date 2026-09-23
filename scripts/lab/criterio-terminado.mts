/**
 * scripts/lab/criterio-terminado.mts — CRITERIO DE TERMINADO del laboratorio (Steven, 2026-09-22).
 *
 *   «En el laboratorio, la mayoría de semillas mantiene población y recambio durante al menos 60 días
 *    simulados con varias generaciones vivas, más de un tipo de cooperación relevante, conflictos y
 *    muertes con causa legible, tecnología que se transmite y diversidad de conducta creciente.»
 *
 * Uso (solo LEE ficheros ya producidos; no simula nada):
 *
 *   npx tsx scripts/lab/criterio-terminado.mts --entrada <conjunto> [--dia 60|comun] [--salida informe.json] [umbrales…]
 *
 * `<conjunto>` contiene un subdirectorio `<brazo>-<semilla>` por réplica (la semilla es el entero final
 * del nombre; el brazo, todo lo anterior), cada uno con `dia-NNN.json` y, al terminar, `replica.json`:
 * el formato de `scripts/lab/replica.ts` (`dailyMetrics` + `durableActivityMetrics` de
 * `scripts/lab/metrics.ts`). Otros ficheros del conjunto (`*.log`, `jobs.txt`…) se ignoran.
 *
 * ── OPERACIONALIZACIÓN (por semilla, al día D; [valor por defecto] --bandera para ajustarlo) ─────────
 *
 * D = `--dia` [60]; `--dia comun` = último día que TODAS las réplicas no extinguidas ya escribieron.
 * Ventana = los `--ventana` [10] días que terminan en D (días D−9..D). Para los campos ACUMULADOS
 * desde el inicio (nacimientos, muertesPorCausa, cooperacionAcumuladaPorTipo, conflictosAcumulados)
 * lo ocurrido en la ventana es valor(D) − valor(D−10), con valor(día ≤ 0) = 0 si no hay dia-000.json.
 * Los campos de uso de tecnología (usosUtiles, usosDeInventorAjeno…) son POR DÍA (metrics.ts los
 * cuenta en (tick−2400, tick]) y se suman sobre los días de la ventana.
 *
 *  C1 supervivencia — poblacion ≥ 16 [--poblacion-min] TODOS los días de la ventana (no solo el día
 *     D: «mantiene población durante» no se prueba con una foto de un día). El mundo nace con 16 (14
 *     vecinos mortales fundadores + S e I, inmortales; createWorld): ≥ 16 equivale a que los mortales
 *     vivos sean al menos tantos como los fundadores mortales, i.e. la población se ha repuesto.
 *  C2 recambio — nacimientos en la ventana ≥ 1 [--nacimientos-min] Y fundadoresMortalesVivos(D) ≤ 1
 *     [--fundadores-max]. «La población ya no es la fundadora»: de los 14 fundadores mortales quedan
 *     0 o casi (≤ 1), y aún nace gente al final (no es un pico de natalidad de los primeros días).
 *     No se usa `fundadoresVivos` como sustituto: cuenta a S e I (generación 0, inmortales) y nunca
 *     baja de 2; si falta `fundadoresMortalesVivos` el criterio es «desconocido».
 *  C3 varias generaciones — generaciones mortales vivas(D) ≥ 3 [--generaciones-min] (abuelos, padres
 *     e hijos a la vez). Se cuenta `generacionesMortalesVivas` y no `generacionesVivas`, que incluye a
 *     S e I y mantiene «viva» la generación 0 para siempre (inflaría en 1 el recuento una vez muertos
 *     los fundadores). Si falta la primera se usa la segunda como COTA: generacionesVivas − 1 ≤
 *     mortales ≤ generacionesVivas, así que cumple solo si generacionesVivas − 1 ≥ el mínimo, falla si
 *     generacionesVivas < el mínimo y, entre medias, «desconocido» (nunca aprobado por la inflación).
 *  C4 cooperación variada — ≥ 2 tipos [--coop-tipos-min], cada uno con ≥ 10 % [--coop-fraccion-min]
 *     de los actos tipificados de la ventana Y ≥ 5 actos en ella [--coop-actos-min]. Tipos = claves de
 *     `cooperacionAcumuladaPorTipo` (teaching, trade, constructionHelp y, con los instrumentos de
 *     replica.ts desde 2026-09-22, foodShared = actos de compartir comida, ver scripts/lab/instrumentos.ts)
 *     + un `foodShared` de nivel superior si algún día aparece en el fichero (formato alternativo; si
 *     está, manda sobre el anidado). Un tipo presente el día D y ausente en el fichero del día base
 *     (formatos mezclados) da «desconocido»: restar 0 contaría todo su acumulado como de la ventana.
 *     El 10 % evita que un tipo residual (un trueque entre cientos de
 *     enseñanzas) cuente como «relevante»; el mínimo absoluto evita lo contrario, que con pocos actos
 *     (2 trueques entre 12 actos = 17 %) un tipo casi ausente pase por la fracción (~1 acto cada 2 días).
 *     `otrasCooperacionesAcumuladas` (aporte de material y turnos ante escasez, mezclados) se informa
 *     pero no cuenta como tipo: mezcla dos mecanismos.
 *  C5 conflictos — conflictos en la ventana ≥ 1 [--conflictos-min]: el conflicto sigue existiendo al
 *     final. Si `conflictosAcumulados` es 0 en D, el criterio falla y lo dice («ningún conflicto en
 *     toda la réplica»), distinto de «hubo conflictos pero ninguno en la ventana».
 *  C6 muertes con causa legible — sobre los días 1..D: 0 muertes con causa fuera del vocabulario
 *     [--causas-conocidas starvation,dehydration,exposure,senescence: `DemographicDeathCause` de
 *     src/shared/demography.ts], ≥ 2 causas distintas con alguna muerte [--causas-min] (un mundo que
 *     solo mata de vejez, o solo de hambre, no tiene muertes variadas ni legibles como historia) Y el
 *     balance cierra: poblacion(D) − poblacion(0) = nacimientos(D) − muertes(D) desde el estado
 *     inicial (dia-000.json si existe; si no, 16 habitantes, 0 nacimientos y 0 muertes, o
 *     `resumen.poblacionInicial` de replica.json): una baja sin muerte registrada sería una muerte sin
 *     causa legible. OJO: replica.ts solo escribe las 4 causas conocidas en `muertesPorCausa`, así que
 *     «0 muertes fuera del vocabulario» no puede fallar con sus ficheros; el balance es la comprobación
 *     que de verdad detecta una muerte sin causa.
 *  C7 tecnología que se transmite — en la ventana, Σ usosDeInventorAjeno / Σ (usosUtiles −
 *     usosSinAutorResuelto) ≥ 0,15 [--uso-ajeno-min] (al menos ~1 de cada 7 usos útiles con autor
 *     conocido es de un invento de OTRA persona; las réplicas de la noche 2026-09-22 dan 0,05–0,40
 *     por día) Y hay uso ajeno en ≥ 50 % de los días de la ventana [--dias-uso-ajeno-min]: como el
 *     campo es diario, «usosDeInventorAjeno crece» se lee como «su acumulado crece de forma sostenida»,
 *     no un solo día aislado.
 *  C8 diversidad creciente — pendiente por mínimos cuadrados del índice de diversidad de conducta
 *     sobre los días 5..D ≥ 0 [--pendiente-min, --dia-base-diversidad] O media de los k últimos días ≥
 *     media de los k primeros (desde el día 5), con k = min(ventana, ⌊(D−5+1)/2⌋). Día 5 como base
 *     porque antes domina el asentamiento inicial (y es el día de SC-003). `--diversidad-regla y` exige
 *     las dos. El indicador diario es ruidoso (saltos de ±0,1 de un día a otro en r2), así que no se
 *     compara un día suelto con otro: la pendiente exige ≥ 3 días con dato y cada bloque ≥ 2 días
 *     completos (si no, esa parte es «desconocido»), y una serie constante FALLA (no crece, aunque su
 *     pendiente sea 0 ≥ 0).
 *     Serie [--diversidad-campo auto]: `diversidadConductaTiempo` (el mismo índice con la actividad
 *     medida en TIEMPO por acción, instrumento de 2026-09-22) si algún día del tramo la trae; si no,
 *     `diversidadConducta` (la antigua: cuenta explorar una vez por celda nueva y lo sobrerrepresenta,
 *     ver scripts/lab/README.md §Instrumentos). `tiempo`/`actividad` fuerzan una u otra. La otra serie
 *     se evalúa igual y se informa como SECUNDARIA (no decide). La serie por tiempo tiene su propio
 *     sesgo: descansar domina el tiempo (y el «oficio dominante») de casi todos; ver el README.
 *
 * Todo criterio es cumple / falla / desconocido. Un campo ausente o ilegible da «desconocido», NUNCA
 * «cumple»: una semilla solo «cumple todos» si los 8 cumplen.
 *
 * Estados de réplica al día D:
 *   - evaluada: tiene dia-D (aunque siga corriendo: los días 1..D ya no cambian);
 *   - extinguida: algún día ≤ D con 0 vecinos mortales (`vecinosMortales`; si falta, `poblacion` − 2,
 *     porque S e I son inmortales y la población nunca baja de 2; solo los vecinos se reproducen,
 *     family.ts, así que no hay vuelta atrás). Cuenta como evaluada que FALLA los 8 criterios, llegue
 *     o no a escribir dia-D;
 *   - ilegible: un dia-NNN.json intermedio no es JSON válido o su tick no es NNN·2400. Cuenta como
 *     evaluada con los 8 «desconocido» (nunca aprobada);
 *   - en curso: sin replica.json y aún sin dia-D → EXCLUIDA (se dice cuántas y por qué día van).
 *     Un último dia-NNN.json a medio escribir de una réplica en curso se ignora con aviso. Si lleva
 *     más de 3 h [--estancada-horas] sin escribir nada se avisa de que el proceso puede haber muerto
 *     sin dejar replica.json (sigue excluida: el script no puede saberlo; revisar su .log);
 *   - corta: tiene replica.json (o el barrido la marcó abortada) pero terminó antes de D sin
 *     extinguirse (se corrió con --dias < D) → EXCLUIDA: falta horizonte, no es un fallo.
 *
 * Veredicto por brazo, con n = semillas del brazo (evaluadas + excluidas) y umbral 50 % [--mayoria]:
 *   - «mayoría»: las que cumplen los 8 son ≥ 50 % de n (aunque todas las excluidas fallaran);
 *   - «no mayoría»: ni sumando como aprobadas las excluidas y las «desconocido» se llega al 50 % de n;
 *   - «indeterminado»: depende de las excluidas o de las desconocidas;
 *   - «sin datos»: ninguna evaluada.
 * También se da la fracción literal «cumplen todos / evaluadas».
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// TICKS_PER_DAY de src/world; como en resumen.ts, no se importa el mundo entero para leer JSON.
const TICKS_POR_DIA = 2400;

export const CRITERIO_STEVEN = 'En el laboratorio, la mayoría de semillas mantiene población y recambio durante al menos 60 días simulados con varias generaciones vivas, más de un tipo de cooperación relevante, conflictos y muertes con causa legible, tecnología que se transmite y diversidad de conducta creciente.';

export type Estado = 'cumple' | 'falla' | 'desconocido';
export type IdCriterio = 'supervivencia' | 'recambio' | 'generaciones' | 'cooperacion' | 'conflictos' | 'muertes' | 'tecnologia' | 'diversidad';
export const CRITERIOS: readonly IdCriterio[] = ['supervivencia', 'recambio', 'generaciones', 'cooperacion', 'conflictos', 'muertes', 'tecnologia', 'diversidad'];

export interface Umbrales {
  dia: number | 'comun'; ventana: number;
  poblacionMin: number; nacimientosMin: number; fundadoresMax: number; generacionesMin: number;
  coopTiposMin: number; coopFraccionMin: number; coopActosMin: number; conflictosMin: number;
  causasMin: number; causasConocidas: string[];
  usoAjenoMin: number; diasUsoAjenoMin: number;
  diaBaseDiversidad: number; pendienteMin: number; diversidadRegla: 'o' | 'y'; diversidadCampo: CampoDiversidad;
  mayoria: number; estancadaHoras: number;
}

/** Serie de C8: `auto` = `diversidadConductaTiempo` si el tramo la trae, si no `diversidadConducta`. */
export type CampoDiversidad = 'auto' | 'diversidadConductaTiempo' | 'diversidadConducta';

/** «durante al menos 60 días simulados»: un corte anterior no puede aprobar ni suspender el criterio. */
export const DIAS_CRITERIO = 60;

export const UMBRALES_POR_DEFECTO: Readonly<Umbrales> = Object.freeze({
  dia: DIAS_CRITERIO, ventana: 10,
  poblacionMin: 16, nacimientosMin: 1, fundadoresMax: 1, generacionesMin: 3,
  coopTiposMin: 2, coopFraccionMin: 0.10, coopActosMin: 5, conflictosMin: 1,
  causasMin: 2, causasConocidas: ['starvation', 'dehydration', 'exposure', 'senescence'],
  usoAjenoMin: 0.15, diasUsoAjenoMin: 0.5,
  diaBaseDiversidad: 5, pendienteMin: 0, diversidadRegla: 'o' as const, diversidadCampo: 'auto' as const,
  mayoria: 0.5, estancadaHoras: 3,
});

/** createWorld: S, I y 14 vecinos fundadores. S e I (roles 'S' | 'I') son inmortales: en los 552
 * dia-NNN.json de r2 (noche 2026-09-22) poblacion − vecinosMortales = 2 siempre. */
const POBLACION_INICIAL = 16, INMORTALES = 2;
/** Mínimos de muestras de C8: una pendiente de 2 puntos o un bloque de 1 día es una comparación de
 * días sueltos de un indicador que salta ±0,1 de un día a otro. */
const PUNTOS_MIN_PENDIENTE = 3, DIAS_MIN_BLOQUE = 2;

export interface ResultadoCriterio { estado: Estado; motivo: string; valores: Record<string, unknown> }
export type EstadoReplica = 'evaluada' | 'extinguida' | 'ilegible' | 'en-curso' | 'corta';

export interface EvaluacionReplica {
  nombre: string; brazo: string; semilla: number; directorio: string;
  estado: EstadoReplica; terminada: boolean; ultimoDia: number | null; diaExtincion: number | null;
  ultimaEscritura: string | null; nota: string | null;
  /** `null` solo en las excluidas (en curso / corta). */
  todos: Estado | null; criterios: Record<IdCriterio, ResultadoCriterio> | null;
}

export type Veredicto = 'mayoría' | 'no mayoría' | 'indeterminado' | 'sin datos';
export interface ResumenBrazo {
  brazo: string; semillas: number; evaluadas: number; extinguidas: number; ilegibles: number;
  enCurso: number; cortas: number; evaluadasAunCorriendo: number;
  porCriterio: Record<IdCriterio, Record<Estado, number>>;
  cumplenTodos: number; todosDesconocido: number; fraccionSobreEvaluadas: number | null;
  veredicto: Veredicto; explicacion: string;
}

export interface Informe {
  criterio: string; conjunto: string; diaPedido: number | 'comun'; dia: number;
  ventana: { desde: number; hasta: number; dias: number };
  umbrales: Umbrales; descripcionCriterios: Record<IdCriterio, string>;
  brazos: ResumenBrazo[]; replicas: EvaluacionReplica[]; ignorados: string[]; avisos: string[];
}

type Dia = Record<string, unknown>;
interface ReplicaLeida {
  nombre: string; brazo: string; semilla: number; directorio: string;
  terminada: boolean; abortada: boolean; dias: Map<number, Dia>; error: string | null; ultimaEscritura: string | null;
  /** `resumen.poblacionInicial` de replica.json, si está. */
  poblacionInicial: number | null;
}

// ── lectura ─────────────────────────────────────────────────────────────────────────────────────

const PATRON_DIA = /^dia-(\d+)\.json$/;
const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function leerReplica(directorio: string, nombre: string, brazo: string, semilla: number, avisos: string[]): ReplicaLeida {
  const r: ReplicaLeida = { nombre, brazo, semilla, directorio, terminada: false, abortada: false, dias: new Map(), error: null, ultimaEscritura: null, poblacionInicial: null };
  const metaRuta = join(directorio, 'replica.json');
  if (existsSync(metaRuta)) {
    r.terminada = true;
    try {
      const meta: unknown = JSON.parse(readFileSync(metaRuta, 'utf8'));
      r.abortada = esObjeto(meta) && meta.abortada === true;
      const inicial = esObjeto(meta) && esObjeto(meta.resumen) ? meta.resumen.poblacionInicial : undefined;
      if (typeof inicial === 'number' && Number.isInteger(inicial) && inicial >= 0) r.poblacionInicial = inicial;
    } catch { r.error = 'replica.json no es JSON válido'; return r; }
  }
  const nombres = readdirSync(directorio).filter(n => PATRON_DIA.test(n))
    .sort((a, b) => Number(PATRON_DIA.exec(a)![1]) - Number(PATRON_DIA.exec(b)![1]));
  for (const [indice, fichero] of nombres.entries()) {
    const dia = Number(PATRON_DIA.exec(fichero)![1]);
    let cuerpo: unknown;
    try { cuerpo = JSON.parse(readFileSync(join(directorio, fichero), 'utf8')); } catch {
      // replica.ts escribe cada día de una vez; el último de una réplica viva puede estar a medias.
      if (!r.terminada && indice === nombres.length - 1) { avisos.push(`${nombre}/${fichero}: JSON incompleto en una réplica en curso (aún escribiéndose); ignorado.`); continue; }
      r.error = `${fichero} no es JSON válido`; return r;
    }
    if (!esObjeto(cuerpo)) { r.error = `${fichero} no es un objeto JSON`; return r; }
    if (typeof cuerpo.tick === 'number' && cuerpo.tick !== dia * TICKS_POR_DIA) { r.error = `${fichero}: tick ${cuerpo.tick} ≠ ${dia}·${TICKS_POR_DIA}`; return r; }
    r.dias.set(dia, cuerpo);
  }
  // Sin ningún dia-NNN.json, la «última escritura» es la del directorio (creado al lanzar la réplica).
  const ultimo = nombres.at(-1);
  r.ultimaEscritura = statSync(ultimo ? join(directorio, ultimo) : directorio).mtime.toISOString();
  return r;
}

function descubrir(conjunto: string, avisos: string[]): { replicas: ReplicaLeida[]; ignorados: string[] } {
  if (!existsSync(conjunto) || !statSync(conjunto).isDirectory()) throw new Error(`El conjunto no existe o no es un directorio: ${conjunto}`);
  const replicas: ReplicaLeida[] = [], ignorados: string[] = [];
  const entradas = readdirSync(conjunto, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const nombre of entradas) {
    const m = /^(.+)-(\d+)$/.exec(nombre);
    if (!m) { ignorados.push(`${nombre} (el nombre no es <brazo>-<semilla>)`); continue; }
    replicas.push(leerReplica(join(conjunto, nombre), nombre, m[1]!, Number(m[2]), avisos));
  }
  return { replicas, ignorados };
}

// ── utilidades de evaluación ────────────────────────────────────────────────────────────────────

const num = (d: Dia | undefined, clave: string): number | null => {
  const v = d?.[clave];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** Objeto plano de números finitos (p. ej. muertesPorCausa); `null` si falta o no lo es. */
const mapa = (d: Dia | undefined, clave: string): Record<string, number> | null => {
  const v = d?.[clave];
  if (!esObjeto(v) || Object.values(v).some(n => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return v as Record<string, number>;
};

/** Valor de un campo ACUMULADO el día `dia`; el día ≤ 0 sin fichero vale 0 (aún no pasó nada). */
function acumulado(dias: Map<number, Dia>, dia: number, lector: (d: Dia) => number | null): number | null {
  if (dia <= 0 && !dias.has(dia)) return 0;
  const d = dias.get(dia);
  return d ? lector(d) : null;
}

/** Y / O de tres valores: `null` = desconocido. */
function y(...xs: (boolean | null)[]): Estado {
  if (xs.some(x => x === false)) return 'falla';
  return xs.every(x => x === true) ? 'cumple' : 'desconocido';
}
function o(...xs: (boolean | null)[]): Estado {
  if (xs.some(x => x === true)) return 'cumple';
  return xs.every(x => x === false) ? 'falla' : 'desconocido';
}

const redondear = (x: number, decimales = 3) => Math.round(x * 10 ** decimales) / 10 ** decimales;
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Pendiente por mínimos cuadrados ordinarios de y sobre x. */
function pendienteMco(puntos: readonly (readonly [number, number])[]): number | null {
  if (puntos.length < 2) return null;
  const mx = puntos.reduce((s, [x]) => s + x, 0) / puntos.length, my = puntos.reduce((s, [, v]) => s + v, 0) / puntos.length;
  let sxy = 0, sxx = 0;
  for (const [x, v] of puntos) { sxy += (x - mx) * (v - my); sxx += (x - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : null;
}

export function describirCriterios(u: Umbrales): Record<IdCriterio, string> {
  return {
    supervivencia: `poblacion ≥ ${u.poblacionMin} todos los días de la ventana`,
    recambio: `nacimientos en la ventana ≥ ${u.nacimientosMin} y fundadoresMortalesVivos(D) ≤ ${u.fundadoresMax}`,
    generaciones: `generaciones mortales vivas(D) ≥ ${u.generacionesMin}`,
    cooperacion: `≥ ${u.coopTiposMin} tipos de cooperación con ≥ ${pct(u.coopFraccionMin)} de los actos tipificados de la ventana y ≥ ${u.coopActosMin} actos`,
    conflictos: `conflictos en la ventana ≥ ${u.conflictosMin}`,
    muertes: `0 muertes fuera de {${u.causasConocidas.join(', ')}}, ≥ ${u.causasMin} causas distintas en los días 1..D y balance población = nacimientos − muertes desde el día 0`,
    tecnologia: `usos de inventor ajeno / usos útiles con autor en la ventana ≥ ${u.usoAjenoMin} y uso ajeno en ≥ ${pct(u.diasUsoAjenoMin)} de sus días`,
    diversidad: `pendiente MCO de ${u.diversidadCampo === 'auto' ? 'diversidadConductaTiempo (si falta, diversidadConducta)' : u.diversidadCampo} días ${u.diaBaseDiversidad}..D (≥ ${PUNTOS_MIN_PENDIENTE} días) ≥ ${u.pendienteMin} ${u.diversidadRegla === 'o' ? 'o' : 'y'} media de los k últimos días ≥ media de los k primeros (k = min(ventana, mitad del tramo) ≥ ${DIAS_MIN_BLOQUE}); constante ⇒ falla`,
  };
}

// ── los 8 criterios ─────────────────────────────────────────────────────────────────────────────

interface Contexto { dias: Map<number, Dia>; D: number; base: number; diasVentana: number[]; u: Umbrales; poblacionInicial: number }

function supervivencia({ dias, D, diasVentana, u }: Contexto): ResultadoCriterio {
  const serie = diasVentana.map(dia => [dia, num(dias.get(dia), 'poblacion')] as const);
  const conocidos = serie.filter((x): x is readonly [number, number] => x[1] !== null), faltan = serie.filter(([, p]) => p === null).map(([dia]) => dia);
  const p = num(dias.get(D), 'poblacion');
  if (!conocidos.length) return { estado: 'desconocido', motivo: 'falta poblacion en la ventana', valores: { poblacion: p, poblacionMinima: null, diasSinDato: faltan } };
  const [diaMin, minima] = conocidos.reduce((m, x) => x[1] < m[1] ? x : m);
  const estado = y(...serie.map(([, v]) => v === null ? null : v >= u.poblacionMin));
  const motivo = `población mínima ${minima} (día ${diaMin}) ${minima >= u.poblacionMin ? '≥' : '<'} ${u.poblacionMin}; día D: ${p ?? '¿?'}${faltan.length ? `; sin dato los días ${faltan.join(', ')}` : ''}`;
  return { estado, motivo, valores: { poblacion: p, poblacionMinima: minima, diaPoblacionMinima: diaMin, diasSinDato: faltan } };
}

function recambio({ dias, D, base, u }: Contexto): ResultadoCriterio {
  const nacD = num(dias.get(D), 'nacimientos'), nacB = acumulado(dias, base, d => num(d, 'nacimientos'));
  const nacimientos = nacD !== null && nacB !== null ? nacD - nacB : null;
  const fundadores = num(dias.get(D), 'fundadoresMortalesVivos');
  const partes = [
    nacimientos === null ? `faltan nacimientos (día ${D} o ${base})` : `${nacimientos} nacimientos en la ventana${nacimientos >= u.nacimientosMin ? '' : ` (< ${u.nacimientosMin})`}`,
    fundadores === null ? 'falta fundadoresMortalesVivos (fundadoresVivos incluye a S e I, inmortales: no sirve)' : `${fundadores} fundadores mortales vivos${fundadores <= u.fundadoresMax ? '' : ` (> ${u.fundadoresMax})`}`,
  ];
  return { estado: y(nacimientos === null ? null : nacimientos >= u.nacimientosMin, fundadores === null ? null : fundadores <= u.fundadoresMax),
    motivo: partes.join('; '), valores: { nacimientosVentana: nacimientos, fundadoresMortalesVivos: fundadores } };
}

function generaciones({ dias, D, u }: Contexto): ResultadoCriterio {
  const d = dias.get(D), mortales = d?.generacionesMortalesVivas;
  if (Array.isArray(mortales)) {
    const g = mortales.length;
    return { estado: g >= u.generacionesMin ? 'cumple' : 'falla', motivo: `${g} generaciones vivas [${mortales.join(', ')}]`, valores: { generaciones: g, fuente: 'generacionesMortalesVivas' } };
  }
  // generacionesVivas = generaciones mortales ∪ {0}: S e I son la generación 0 y no mueren. Sin saber si
  // queda algún fundador mortal, las mortales son generacionesVivas − 1 o generacionesVivas.
  const todas = num(d, 'generacionesVivas');
  if (todas === null) return { estado: 'desconocido', motivo: 'faltan generacionesMortalesVivas y generacionesVivas', valores: { generaciones: null, fuente: null } };
  const estado: Estado = todas < u.generacionesMin ? 'falla' : todas - 1 >= u.generacionesMin ? 'cumple' : 'desconocido';
  return { estado, motivo: `entre ${Math.max(0, todas - 1)} y ${todas} generaciones mortales vivas (falta generacionesMortalesVivas; generacionesVivas = ${todas} incluye la generación 0 de S e I)`,
    valores: { generaciones: null, cotaInferior: Math.max(0, todas - 1), cotaSuperior: todas, fuente: 'generacionesVivas' } };
}

function cooperacion({ dias, D, base, u }: Contexto): ResultadoCriterio {
  const tiposD = mapa(dias.get(D), 'cooperacionAcumuladaPorTipo');
  if (!tiposD) return { estado: 'desconocido', motivo: 'falta cooperacionAcumuladaPorTipo en el día D', valores: {} };
  const tiposB = base <= 0 && !dias.has(base) ? {} : mapa(dias.get(base), 'cooperacionAcumuladaPorTipo');
  if (!tiposB) return { estado: 'desconocido', motivo: `falta cooperacionAcumuladaPorTipo en el día ${base} (inicio de la ventana)`, valores: {} };
  const actual: Record<string, number> = { ...tiposD }, previo: Record<string, number> = { ...tiposB };
  const comidaD = num(dias.get(D), 'foodShared');
  if (comidaD !== null) {
    const comidaB = acumulado(dias, base, d => num(d, 'foodShared'));
    if (comidaB === null) return { estado: 'desconocido', motivo: `falta foodShared en el día ${base}`, valores: {} };
    actual.foodShared = comidaD; previo.foodShared = comidaB;
  }
  // Día base con fichero pero sin un tipo que el día D sí trae (formatos mezclados): restar 0 contaría
  // todo su acumulado desde el inicio como de la ventana.
  if (dias.has(base)) {
    const sinBase = Object.keys(actual).filter(tipo => !(tipo in previo));
    if (sinBase.length) return { estado: 'desconocido', motivo: `falta ${sinBase.join(', ')} en el día ${base} (inicio de la ventana)`, valores: {} };
  }
  const porTipo: Record<string, number> = {};
  for (const [tipo, n] of Object.entries(actual)) porTipo[tipo] = n - (previo[tipo] ?? 0);
  if (Object.values(porTipo).some(n => n < 0)) return { estado: 'desconocido', motivo: 'un acumulado de cooperación decrece: datos incoherentes', valores: { porTipo } };
  const otrasD = num(dias.get(D), 'otrasCooperacionesAcumuladas'), otrasB = acumulado(dias, base, d => num(d, 'otrasCooperacionesAcumuladas'));
  const otras = otrasD !== null && otrasB !== null ? otrasD - otrasB : null;
  const total = Object.values(porTipo).reduce((s, n) => s + n, 0);
  if (total <= 0) return { estado: 'falla', motivo: 'ningún acto de cooperación tipificado en la ventana', valores: { porTipo, total, otras } };
  const fracciones = Object.fromEntries(Object.entries(porTipo).map(([t, n]) => [t, redondear(n / total)]));
  const relevantes = Object.entries(porTipo).filter(([, n]) => n > 0 && n >= u.coopActosMin && n / total >= u.coopFraccionMin).map(([t]) => t);
  const detalle = Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n} (${pct(n / total)})`).join(', ');
  return { estado: relevantes.length >= u.coopTiposMin ? 'cumple' : 'falla',
    motivo: `${relevantes.length} tipo(s) con ≥ ${pct(u.coopFraccionMin)} y ≥ ${u.coopActosMin} de ${total} actos: ${detalle}`,
    valores: { porTipo, fracciones, total, relevantes, otrasNoTipificadas: otras } };
}

function conflictos({ dias, D, base, u }: Contexto): ResultadoCriterio {
  const cD = num(dias.get(D), 'conflictosAcumulados'), cB = acumulado(dias, base, d => num(d, 'conflictosAcumulados'));
  if (cD === null || cB === null) return { estado: 'desconocido', motivo: `falta conflictosAcumulados (día ${cD === null ? D : base})`, valores: { conflictosVentana: null, conflictosAcumulados: cD } };
  const ventana = cD - cB;
  const motivo = cD === 0 ? 'ningún conflicto en toda la réplica (conflictosAcumulados = 0)'
    : ventana >= u.conflictosMin ? `${ventana} conflictos en la ventana (${cD} acumulados)` : `${cD} conflictos acumulados pero ${ventana} en la ventana`;
  return { estado: ventana >= u.conflictosMin ? 'cumple' : 'falla', motivo, valores: { conflictosVentana: ventana, conflictosAcumulados: cD } };
}

function muertes({ dias, D, u, poblacionInicial }: Contexto): ResultadoCriterio {
  const mD = mapa(dias.get(D), 'muertesPorCausa');
  if (!mD) return { estado: 'desconocido', motivo: 'falta muertesPorCausa en el día D', valores: {} };
  const desconocidas = Object.entries(mD).filter(([causa, n]) => !u.causasConocidas.includes(causa) && n > 0);
  const causas = u.causasConocidas.filter(causa => (mD[causa] ?? 0) > 0);
  // Balance demográfico desde el estado inicial (día 0) hasta D: una baja sin muerte registrada no es
  // legible. Nunca «no aplica»: con un solo día leído también hay un par (día 0, día D).
  const d0: Dia = dias.get(0) ?? { poblacion: poblacionInicial, nacimientos: 0, muertesPorCausa: {} }, dD = dias.get(D)!;
  const m0 = mapa(d0, 'muertesPorCausa'), p0 = num(d0, 'poblacion'), n0 = num(d0, 'nacimientos'), pD = num(dD, 'poblacion'), nD = num(dD, 'nacimientos');
  const suma = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0);
  const residuo = m0 && p0 !== null && n0 !== null && pD !== null && nD !== null ? (pD - p0) - ((nD - n0) - (suma(mD) - suma(m0))) : null;
  const partes = [
    causas.length ? `causas: ${causas.map(c => `${c} ${mD[c]}`).join(', ')}${causas.length >= u.causasMin ? '' : ` (< ${u.causasMin} distintas)`}` : 'ninguna muerte registrada',
    ...(desconocidas.length ? [`${desconocidas.reduce((s, [, n]) => s + n, 0)} muertes de causa desconocida (${desconocidas.map(([c]) => c).join(', ')})`] : []),
    ...(residuo === null ? ['balance población/nacimientos/muertes no calculable (faltan campos)'] : residuo !== 0 ? [`el balance no cierra: residuo ${residuo} habitantes sin nacimiento o muerte registrada (días 0..${D}, población inicial ${p0})`] : []),
  ];
  return { estado: y(desconocidas.length === 0, causas.length >= u.causasMin, residuo === null ? null : residuo === 0),
    motivo: partes.join('; '), valores: { muertesPorCausa: mD, causasDistintas: causas.length, muertesDesconocidas: Object.fromEntries(desconocidas), residuoBalance: residuo, poblacionInicial: p0 } };
}

function tecnologia({ dias, diasVentana, u }: Contexto): ResultadoCriterio {
  const faltan: number[] = [];
  let ajenos = 0, conAutor = 0, diasConAjeno = 0;
  for (const dia of diasVentana) {
    const d = dias.get(dia), a = num(d, 'usosDeInventorAjeno'), usos = num(d, 'usosUtiles'), sinAutor = num(d, 'usosSinAutorResuelto');
    if (a === null || usos === null || sinAutor === null) { faltan.push(dia); continue; }
    ajenos += a; conAutor += usos - sinAutor; if (a > 0) diasConAjeno++;
  }
  if (faltan.length) return { estado: 'desconocido', motivo: `faltan usosDeInventorAjeno/usosUtiles/usosSinAutorResuelto los días ${faltan.join(', ')}`, valores: { diasSinDato: faltan } };
  const fraccion = conAutor > 0 ? ajenos / conAutor : null, fraccionDias = diasConAjeno / diasVentana.length;
  if (fraccion === null) return { estado: 'falla', motivo: 'ningún uso útil con autor conocido en la ventana', valores: { usosDeInventorAjeno: ajenos, usosConAutor: 0, fraccionUsoAjeno: null, fraccionDiasConUsoAjeno: fraccionDias } };
  return { estado: y(fraccion >= u.usoAjenoMin, fraccionDias >= u.diasUsoAjenoMin),
    motivo: `uso ajeno ${redondear(fraccion)} (${ajenos}/${conAutor})${fraccion >= u.usoAjenoMin ? '' : ` < ${u.usoAjenoMin}`}; en ${diasConAjeno}/${diasVentana.length} días${fraccionDias >= u.diasUsoAjenoMin ? '' : ` (< ${pct(u.diasUsoAjenoMin)})`}`,
    valores: { usosDeInventorAjeno: ajenos, usosConAutor: conAutor, fraccionUsoAjeno: fraccion, fraccionDiasConUsoAjeno: fraccionDias } };
}

/** C8 sobre una serie (`campo`) de dia-NNN.json; ver la cabecera. */
function serieDiversidad({ dias, D, u }: Contexto, campo: string): ResultadoCriterio {
  const b = u.diaBaseDiversidad;
  const puntos: [number, number][] = [];
  for (let dia = b; dia <= D; dia++) { const v = num(dias.get(dia), campo); if (v !== null) puntos.push([dia, v]); }
  const valores = puntos.map(([, v]) => v);
  // Una serie plana no «crece» aunque su pendiente sea 0 ≥ 0 (p. ej. un indicador atascado en 0).
  if (puntos.length >= 2 && Math.max(...valores) === Math.min(...valores))
    return { estado: 'falla', motivo: `${campo} constante (${redondear(valores[0]!)}) en ${puntos.length} días: no crece`, valores: { pendiente: 0, puntos: puntos.length } };
  const pendiente = puntos.length >= PUNTOS_MIN_PENDIENTE ? pendienteMco(puntos) : null;
  // Bloques de k días en cada extremo, no un día suelto contra otro: el indicador diario es ruidoso.
  const k = Math.min(u.ventana, Math.floor((D - b + 1) / 2));
  const media = (desde: number): number | null => {
    if (k < DIAS_MIN_BLOQUE) return null;
    let s = 0;
    for (let dia = desde; dia < desde + k; dia++) { const v = num(dias.get(dia), campo); if (v === null) return null; s += v; }
    return s / k;
  };
  const inicio = media(b), final = media(D - k + 1);
  const s1 = pendiente === null ? null : pendiente >= u.pendienteMin, s2 = inicio === null || final === null ? null : final >= inicio;
  const estado = u.diversidadRegla === 'o' ? o(s1, s2) : y(s1, s2);
  const bloques = k >= DIAS_MIN_BLOQUE ? `media días ${b}..${b + k - 1} ${inicio === null ? '¿?' : redondear(inicio)} → días ${D - k + 1}..${D} ${final === null ? '¿?' : redondear(final)}` : `tramo de ${D - b + 1} días: bloques de < ${DIAS_MIN_BLOQUE} días, sin comparar`;
  const motivo = `pendiente ${pendiente === null ? `¿? (${puntos.length} días con dato, < ${PUNTOS_MIN_PENDIENTE})` : `${pendiente.toExponential(2)}/día (${puntos.length} días)`}; ${bloques}`;
  return { estado, motivo, valores: { pendiente, puntos: puntos.length, diasPorBloque: k, mediaInicio: inicio, mediaFinal: final } };
}

const DIVERSIDAD_TIEMPO = 'diversidadConductaTiempo', DIVERSIDAD_ACTIVIDAD = 'diversidadConducta';

function diversidad(contexto: Contexto): ResultadoCriterio {
  const { dias, D, u } = contexto, b = u.diaBaseDiversidad;
  if (D <= b) return { estado: 'desconocido', motivo: `D = ${D} ≤ día base ${b}: no hay tramo que medir`, valores: {} };
  let conTiempo = false;
  for (let dia = b; dia <= D && !conTiempo; dia++) conTiempo = num(dias.get(dia), DIVERSIDAD_TIEMPO) !== null;
  const campo = u.diversidadCampo === 'auto' ? (conTiempo ? DIVERSIDAD_TIEMPO : DIVERSIDAD_ACTIVIDAD) : u.diversidadCampo;
  const otro = campo === DIVERSIDAD_TIEMPO ? DIVERSIDAD_ACTIVIDAD : DIVERSIDAD_TIEMPO;
  const principal = serieDiversidad(contexto, campo);
  // La otra serie se informa (secundaria, no decide) solo si el tramo la trae algún día.
  let otroConDato = false;
  for (let dia = b; dia <= D && !otroConDato; dia++) otroConDato = num(dias.get(dia), otro) !== null;
  const secundaria = otroConDato ? serieDiversidad(contexto, otro) : null;
  return { estado: principal.estado,
    motivo: `${campo}: ${principal.motivo}${secundaria ? ` · secundaria ${otro} (no decide): ${secundaria.estado}, ${secundaria.motivo}` : ''}`,
    valores: { campo, ...principal.valores, secundaria: secundaria ? { campo: otro, estado: secundaria.estado, ...secundaria.valores } : null } };
}

const EVALUADORES: Record<IdCriterio, (c: Contexto) => ResultadoCriterio> = { supervivencia, recambio, generaciones, cooperacion, conflictos, muertes, tecnologia, diversidad };

// ── réplica, brazo, conjunto ────────────────────────────────────────────────────────────────────

/** 0 vecinos mortales ⇒ extinguida para siempre: solo los vecinos se reproducen (family.ts). Sin
 * `vecinosMortales` (métricas antiguas), poblacion − 2: S e I son inmortales y nunca faltan, así que
 * `poblacion` nunca llega a 0 y no sirve como señal de extinción. */
function mortales(d: Dia): number | null {
  const v = num(d, 'vecinosMortales');
  if (v !== null) return v;
  const p = num(d, 'poblacion');
  return p === null ? null : Math.max(0, p - INMORTALES);
}

function diaDeExtincion(r: ReplicaLeida, hasta: number): number | null {
  for (const dia of [...r.dias.keys()].sort((a, b) => a - b)) if (dia <= hasta && mortales(r.dias.get(dia)!) === 0) return dia;
  return null;
}

const ultimoDia = (r: ReplicaLeida): number | null => r.dias.size ? Math.max(...r.dias.keys()) : null;

function todosIguales(estado: Estado, motivo: string): Record<IdCriterio, ResultadoCriterio> {
  return Object.fromEntries(CRITERIOS.map(id => [id, { estado, motivo, valores: {} }])) as Record<IdCriterio, ResultadoCriterio>;
}

function evaluarReplica(r: ReplicaLeida, D: number, u: Umbrales, avisos: string[], ahora: number): EvaluacionReplica {
  const comun = { nombre: r.nombre, brazo: r.brazo, semilla: r.semilla, directorio: r.directorio, terminada: r.terminada, ultimoDia: ultimoDia(r), ultimaEscritura: r.ultimaEscritura };
  if (r.error) return { ...comun, estado: 'ilegible', diaExtincion: null, nota: r.error, todos: 'desconocido', criterios: todosIguales('desconocido', `réplica ilegible: ${r.error}`) };
  const extincion = diaDeExtincion(r, D);
  if (extincion !== null) return { ...comun, estado: 'extinguida', diaExtincion: extincion, nota: `extinguida el día ${extincion} (0 vecinos mortales)`, todos: 'falla', criterios: todosIguales('falla', `extinguida el día ${extincion}`) };
  if (!r.dias.has(D)) {
    if (r.terminada) return { ...comun, estado: 'corta', diaExtincion: null, todos: null, criterios: null,
      nota: r.abortada ? `abortada por el barrido en el día ${comun.ultimoDia ?? 0} < ${D}, sin extinguirse` : `terminó en el día ${comun.ultimoDia ?? 0} < ${D} sin extinguirse (corrida con --dias menor)` };
    const horas = r.ultimaEscritura ? (ahora - Date.parse(r.ultimaEscritura)) / 3.6e6 : null;
    const estancada = horas !== null && horas > u.estancadaHoras;
    if (estancada) avisos.push(`${r.nombre}: sin replica.json y sin escribir desde hace ${horas.toFixed(1)} h (> ${u.estancadaHoras} h): ¿proceso muerto? Sigue excluida como «en curso»; revisar su .log.`);
    return { ...comun, estado: 'en-curso', diaExtincion: null, todos: null, criterios: null,
      nota: `en curso: va por el día ${comun.ultimoDia ?? 0}${horas === null ? '' : `, última escritura hace ${horas < 1 ? `${Math.round(horas * 60)} min` : `${horas.toFixed(1)} h`}`}${estancada ? ' (¿muerta?)' : ''}` };
  }
  const base = D - u.ventana, diasVentana: number[] = [];
  for (let dia = Math.max(1, base + 1); dia <= D; dia++) diasVentana.push(dia);
  const contexto: Contexto = { dias: r.dias, D, base, diasVentana, u, poblacionInicial: r.poblacionInicial ?? POBLACION_INICIAL };
  const criterios = Object.fromEntries(CRITERIOS.map(id => [id, EVALUADORES[id](contexto)])) as Record<IdCriterio, ResultadoCriterio>;
  return { ...comun, estado: 'evaluada', diaExtincion: null, nota: r.terminada ? null : 'aún corriendo (días 1..D ya escritos)',
    todos: y(...CRITERIOS.map(id => criterios[id].estado === 'desconocido' ? null : criterios[id].estado === 'cumple')), criterios };
}

function resumirBrazo(brazo: string, replicas: EvaluacionReplica[], u: Umbrales): ResumenBrazo {
  const evaluadas = replicas.filter(r => r.criterios !== null);
  const porCriterio = Object.fromEntries(CRITERIOS.map(id => [id, { cumple: 0, falla: 0, desconocido: 0 }])) as Record<IdCriterio, Record<Estado, number>>;
  for (const r of evaluadas) for (const id of CRITERIOS) porCriterio[id][r.criterios![id].estado]++;
  const cumplenTodos = evaluadas.filter(r => r.todos === 'cumple').length, todosDesconocido = evaluadas.filter(r => r.todos === 'desconocido').length;
  const enCurso = replicas.filter(r => r.estado === 'en-curso').length, cortas = replicas.filter(r => r.estado === 'corta').length;
  const excluidas = enCurso + cortas, n = replicas.length, necesarias = u.mayoria * n - 1e-9;
  let veredicto: Veredicto, explicacion: string;
  if (evaluadas.length === 0) { veredicto = 'sin datos'; explicacion = `ninguna de las ${n} semillas se puede evaluar aún en el día D`; }
  else if (cumplenTodos >= necesarias) { veredicto = 'mayoría'; explicacion = `${cumplenTodos}/${n} semillas cumplen los 8 (≥ ${pct(u.mayoria)} aunque las ${excluidas} excluidas fallaran)`; }
  else if (cumplenTodos + excluidas + todosDesconocido < necesarias) { veredicto = 'no mayoría'; explicacion = `como mucho ${cumplenTodos + excluidas + todosDesconocido}/${n} podrían cumplir (< ${pct(u.mayoria)})`; }
  else { veredicto = 'indeterminado'; explicacion = `${cumplenTodos}/${n} cumplen; lo decidirán ${excluidas} excluida(s)${todosDesconocido ? ` y ${todosDesconocido} con algún criterio desconocido` : ''}`; }
  return { brazo, semillas: n, evaluadas: evaluadas.length, extinguidas: replicas.filter(r => r.estado === 'extinguida').length,
    ilegibles: replicas.filter(r => r.estado === 'ilegible').length, enCurso, cortas,
    evaluadasAunCorriendo: evaluadas.filter(r => r.estado === 'evaluada' && !r.terminada).length,
    porCriterio, cumplenTodos, todosDesconocido, fraccionSobreEvaluadas: evaluadas.length ? cumplenTodos / evaluadas.length : null, veredicto, explicacion };
}

function resolverDia(replicas: ReplicaLeida[], u: Umbrales): number {
  if (u.dia !== 'comun') return u.dia;
  const legibles = replicas.filter(r => !r.error && r.dias.size > 0);
  const vivas = legibles.filter(r => diaDeExtincion(r, Infinity) === null);
  const candidatas = (vivas.length ? vivas : legibles).map(r => ultimoDia(r)!);
  if (!candidatas.length) throw new Error('--dia comun: ninguna réplica tiene aún un dia-NNN.json legible.');
  return Math.min(...candidatas);
}

/** Evalúa el criterio de terminado sobre un conjunto de réplicas ya producidas. Solo lee ficheros. */
export function evaluarConjunto(conjunto: string, parcial: Partial<Umbrales> = {}): Informe {
  const u: Umbrales = { ...UMBRALES_POR_DEFECTO, causasConocidas: [...UMBRALES_POR_DEFECTO.causasConocidas], ...parcial };
  const avisos: string[] = [];
  const { replicas: leidas, ignorados } = descubrir(resolve(conjunto), avisos);
  const D = resolverDia(leidas, u);
  const ahora = Date.now();
  const replicas = leidas.map(r => evaluarReplica(r, D, u, avisos, ahora))
    .sort((a, b) => a.brazo.localeCompare(b.brazo) || a.semilla - b.semilla);
  const brazos = [...new Set(replicas.map(r => r.brazo))].map(brazo => resumirBrazo(brazo, replicas.filter(r => r.brazo === brazo), u));
  const desde = Math.max(1, D - u.ventana + 1);
  if (D < DIAS_CRITERIO) avisos.unshift(`D = ${D} < ${DIAS_CRITERIO}: el criterio exige al menos ${DIAS_CRITERIO} días simulados; los veredictos son del corte en el día ${D} (provisionales), no del criterio.`);
  return { criterio: CRITERIO_STEVEN, conjunto: resolve(conjunto), diaPedido: u.dia, dia: D, ventana: { desde, hasta: D, dias: D - desde + 1 },
    umbrales: { ...u, dia: D }, descripcionCriterios: describirCriterios(u), brazos, replicas, ignorados, avisos };
}

// ── salida de texto ─────────────────────────────────────────────────────────────────────────────

const ETIQUETA: Record<IdCriterio, string> = { supervivencia: 'supervivencia', recambio: 'recambio', generaciones: 'generaciones', cooperacion: 'cooperación',
  conflictos: 'conflictos', muertes: 'muertes', tecnologia: 'tecnología', diversidad: 'diversidad' };
const BANDERAS: Record<IdCriterio, string> = {
  supervivencia: '--poblacion-min', recambio: '--nacimientos-min --fundadores-max', generaciones: '--generaciones-min',
  cooperacion: '--coop-tipos-min --coop-fraccion-min --coop-actos-min', conflictos: '--conflictos-min', muertes: '--causas-min --causas-conocidas',
  tecnologia: '--uso-ajeno-min --dias-uso-ajeno-min', diversidad: '--pendiente-min --dia-base-diversidad --diversidad-regla --diversidad-campo',
};
const MARCA: Record<Estado, string> = { cumple: '✓', falla: '✗', desconocido: '?' };
const col = (texto: string | number, ancho: number, derecha = false) => { const t = String(texto); return derecha ? t.padStart(ancho) : t.padEnd(ancho); };

export function informeTexto(inf: Informe): string {
  const l: string[] = [];
  l.push(`CRITERIO DE TERMINADO — «${inf.criterio}»`);
  l.push(`Conjunto: ${inf.conjunto}`);
  if (inf.dia < DIAS_CRITERIO) l.push(`AVISO: corte PROVISIONAL en el día ${inf.dia} < ${DIAS_CRITERIO}; ningún veredicto de abajo es el del criterio (exige ≥ ${DIAS_CRITERIO} días).`);
  l.push(`Día evaluado D = ${inf.dia}${inf.diaPedido === 'comun' ? ' (último día común)' : ''} · ventana: días ${inf.ventana.desde}..${inf.ventana.hasta} (${inf.ventana.dias} días; acumulados = valor(D) − valor(D−${inf.umbrales.ventana}))`);
  l.push('Umbrales (ajustables):');
  CRITERIOS.forEach((id, i) => l.push(`  C${i + 1} ${col(ETIQUETA[id], 13)} ${inf.descripcionCriterios[id]}   [${BANDERAS[id]}]`));
  l.push(`  Veredicto «mayoría»: cumplen los 8 ≥ ${pct(inf.umbrales.mayoria)} de las semillas del brazo [--mayoria]; campo ausente ⇒ «desconocido», nunca aprobado.`);
  l.push('');
  const cab = `${col('brazo', 14)} ${col('sem', 3, true)} ${col('eval', 4, true)} ${col('ext', 3, true)} ${col('curso', 5, true)} ${col('corta', 5, true)} │ ${CRITERIOS.map((_, i) => col(`C${i + 1}`, 6)).join(' ')} │ ${col('8/8', 6)} ${col('s/eval', 6)} veredicto`;
  l.push(cab); l.push('─'.repeat(cab.length + 12));
  for (const b of inf.brazos) {
    const celda = (c: Record<Estado, number>) => col(`${c.cumple}/${b.evaluadas}${c.desconocido ? `?${c.desconocido}` : ''}`, 6);
    l.push(`${col(b.brazo, 14)} ${col(b.semillas, 3, true)} ${col(b.evaluadas, 4, true)} ${col(b.extinguidas, 3, true)} ${col(b.enCurso, 5, true)} ${col(b.cortas, 5, true)} │ ${CRITERIOS.map(id => celda(b.porCriterio[id])).join(' ')} │ ${col(`${b.cumplenTodos}/${b.evaluadas}${b.todosDesconocido ? `?${b.todosDesconocido}` : ''}`, 6)} ${col(b.fraccionSobreEvaluadas === null ? '—' : pct(b.fraccionSobreEvaluadas), 6)} ${b.veredicto.toUpperCase()} — ${b.explicacion}`);
  }
  l.push('Celdas: cumplen/evaluadas (?n = desconocidos). eval = con dia-D + extinguidas + ilegibles; las extinguidas fallan los 8. curso/corta = excluidas.');
  l.push('');
  l.push('Réplicas evaluadas (C1..C8: ✓ cumple, ✗ falla, ? desconocido):');
  for (const r of inf.replicas.filter(x => x.criterios)) {
    const marcas = CRITERIOS.map(id => MARCA[r.criterios![id].estado]).join('');
    const detalle = r.estado === 'evaluada'
      ? CRITERIOS.map((id, i) => r.criterios![id].estado === 'cumple' ? null : `C${i + 1} ${r.criterios![id].motivo}`).filter(Boolean).join(' · ')
      : r.nota ?? '';
    l.push(`  ${col(r.nombre, 22)} ${marcas} ${r.todos === 'cumple' ? 'TODOS' : '     '}${r.estado === 'evaluada' && !r.terminada ? ' (aún corriendo)' : ''} ${detalle}`);
  }
  const excluidas = inf.replicas.filter(r => !r.criterios);
  if (excluidas.length) {
    l.push('');
    l.push(`Excluidas (${excluidas.length}: ${excluidas.filter(r => r.estado === 'en-curso').length} en curso, ${excluidas.filter(r => r.estado === 'corta').length} cortas):`);
    for (const b of inf.brazos) {
      const deBrazo = excluidas.filter(r => r.brazo === b.brazo);
      if (deBrazo.length) l.push(`  ${col(b.brazo, 14)} ${deBrazo.map(r => `${r.semilla}${r.estado === 'corta' ? ' (corta' : ' (día'} ${r.ultimoDia ?? 0}${r.nota?.endsWith('(¿muerta?)') ? ', ¿muerta?' : ''})`).join(', ')}`);
    }
  }
  if (inf.ignorados.length) l.push('', `Directorios ignorados: ${inf.ignorados.join('; ')}`);
  if (inf.avisos.length) l.push('', 'Avisos:', ...inf.avisos.map(a => `  ${a}`));
  return l.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const USO = `Uso: npx tsx scripts/lab/criterio-terminado.mts --entrada <conjunto> [--dia N|comun] [--ventana 10] [--salida informe.json]
  [--poblacion-min 16] [--nacimientos-min 1] [--fundadores-max 1] [--generaciones-min 3]
  [--coop-tipos-min 2] [--coop-fraccion-min 0.1] [--coop-actos-min 5] [--conflictos-min 1] [--causas-min 2]
  [--causas-conocidas starvation,dehydration,exposure,senescence] [--uso-ajeno-min 0.15] [--dias-uso-ajeno-min 0.5]
  [--dia-base-diversidad 5] [--pendiente-min 0] [--diversidad-regla o|y] [--diversidad-campo auto|tiempo|actividad]
  [--mayoria 0.5] [--estancada-horas 3]`;

/** `--diversidad-campo`: alias cortos y nombres de campo de dia-NNN.json. */
const CAMPOS_DIVERSIDAD: Record<string, CampoDiversidad> = {
  auto: 'auto', tiempo: 'diversidadConductaTiempo', diversidadConductaTiempo: 'diversidadConductaTiempo',
  actividad: 'diversidadConducta', antigua: 'diversidadConducta', diversidadConducta: 'diversidadConducta',
};

function numero(valor: string, bandera: string, { entero = false, min = -Infinity, max = Infinity } = {}): number {
  const n = Number(valor);
  if (valor.trim() === '' || !Number.isFinite(n) || (entero && !Number.isInteger(n)) || n < min || n > max) throw new Error(`${bandera}: valor inválido «${valor}».\n${USO}`);
  return n;
}

export function parsearArgumentos(argv: readonly string[]): { entrada: string; salida: string | null; umbrales: Partial<Umbrales> } {
  const u: Partial<Umbrales> = {};
  let entrada: string | null = null, salida: string | null = null;
  const fraccion = { min: 0, max: 1 }, noNegativo = { min: 0 };
  const opciones: Record<string, (v: string) => void> = {
    '--entrada': v => { entrada = v; }, '--salida': v => { salida = v; },
    '--dia': v => { u.dia = v === 'comun' || v === 'común' ? 'comun' : numero(v, '--dia', { entero: true, min: 1 }); },
    '--ventana': v => { u.ventana = numero(v, '--ventana', { entero: true, min: 1 }); },
    '--poblacion-min': v => { u.poblacionMin = numero(v, '--poblacion-min', noNegativo); },
    '--nacimientos-min': v => { u.nacimientosMin = numero(v, '--nacimientos-min', noNegativo); },
    '--fundadores-max': v => { u.fundadoresMax = numero(v, '--fundadores-max', noNegativo); },
    '--generaciones-min': v => { u.generacionesMin = numero(v, '--generaciones-min', noNegativo); },
    '--coop-tipos-min': v => { u.coopTiposMin = numero(v, '--coop-tipos-min', { entero: true, min: 1 }); },
    '--coop-fraccion-min': v => { u.coopFraccionMin = numero(v, '--coop-fraccion-min', fraccion); },
    '--coop-actos-min': v => { u.coopActosMin = numero(v, '--coop-actos-min', noNegativo); },
    '--conflictos-min': v => { u.conflictosMin = numero(v, '--conflictos-min', noNegativo); },
    '--causas-min': v => { u.causasMin = numero(v, '--causas-min', { entero: true, min: 0 }); },
    '--causas-conocidas': v => { u.causasConocidas = v.split(',').map(s => s.trim()).filter(Boolean); },
    '--uso-ajeno-min': v => { u.usoAjenoMin = numero(v, '--uso-ajeno-min', fraccion); },
    '--dias-uso-ajeno-min': v => { u.diasUsoAjenoMin = numero(v, '--dias-uso-ajeno-min', fraccion); },
    '--dia-base-diversidad': v => { u.diaBaseDiversidad = numero(v, '--dia-base-diversidad', { entero: true, min: 0 }); },
    '--pendiente-min': v => { u.pendienteMin = numero(v, '--pendiente-min'); },
    '--diversidad-regla': v => { if (v !== 'o' && v !== 'y') throw new Error(`--diversidad-regla: «o» o «y», no «${v}».\n${USO}`); u.diversidadRegla = v; },
    '--diversidad-campo': v => { const campo = Object.hasOwn(CAMPOS_DIVERSIDAD, v) ? CAMPOS_DIVERSIDAD[v] : undefined; if (!campo) throw new Error(`--diversidad-campo: auto, tiempo o actividad, no «${v}».\n${USO}`); u.diversidadCampo = campo; },
    '--mayoria': v => { u.mayoria = numero(v, '--mayoria', { min: 0, max: 1 }); },
    '--estancada-horas': v => { u.estancadaHoras = numero(v, '--estancada-horas', { min: 0 }); },
  };
  for (let i = 0; i < argv.length; i++) {
    const bandera = argv[i]!;
    const aplicar = opciones[bandera];
    if (!aplicar) {
      if (!bandera.startsWith('-') && entrada === null) { entrada = bandera; continue; }
      throw new Error(`Argumento desconocido: ${bandera}\n${USO}`);
    }
    const valor = argv[++i];
    if (valor === undefined) throw new Error(`${bandera} necesita un valor.\n${USO}`);
    aplicar(valor);
  }
  if (entrada === null) throw new Error(`Falta --entrada <conjunto>.\n${USO}`);
  return { entrada, salida, umbrales: u };
}

function main(): void {
  if (process.argv.slice(2).some(a => a === '--ayuda' || a === '--help' || a === '-h')) { console.log(USO); return; }
  const { entrada, salida, umbrales } = parsearArgumentos(process.argv.slice(2));
  const informe = evaluarConjunto(entrada, umbrales);
  console.log(informeTexto(informe));
  if (salida) {
    mkdirSync(dirname(resolve(salida)), { recursive: true });
    writeFileSync(salida, JSON.stringify(informe, null, 2) + '\n');
    console.log(`\nJSON: ${resolve(salida)}`);
  }
}

// Guarda de «ejecutado directamente» (mismo patrón que scripts/curva-techo.mts): importar el módulo
// desde tests/criterio-terminado.test.ts no debe ejecutar main() con el argv del proceso de test.
const invocadoDirectamente = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invocadoDirectamente) {
  try { main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
