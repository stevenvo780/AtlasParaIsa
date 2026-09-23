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
 *     La lista debe ser de enteros ≥ 0 DISTINTOS (metrics.ts escribe un Set ordenado): se cuenta un Set, y
 *     basura (no lista, no enteros ≥ 0) o repetidas ([2, 2, 2] no son 3 generaciones) ⇒ «desconocido».
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
 *     pero no cuenta como tipo: mezcla dos mecanismos. Solo cuentan los tipos de la lista CERRADA
 *     {teaching, trade, constructionHelp, foodShared} [TIPOS_COOPERACION]: otra clave («Teaching», un
 *     alias del mismo mecanismo) se informa en `clavesNoContadas` y no fabrica un segundo tipo.
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
 *     no un solo día aislado. Coherencia: cada día usosSinAutorResuelto ≤ usosUtiles y usosDeInventorAjeno
 *     ≤ usosUtiles − usosSinAutorResuelto (si no, «desconocido»); sin ningún uso útil en la ventana, falla;
 *     con usos pero < 20 con autor conocido [--usos-con-autor-min], «desconocido» (muestra insuficiente:
 *     5 de 10 usos ajenos no es una fracción medida).
 *  C8 diversidad creciente — PREREGISTRO v2 (orquestador, 2026-09-22 21:45, fijado ANTES de mirar C8 en
 *     los conjuntos de 60 días; ver scripts/lab/README.md §«Preregistro v2 de C8»). Sobre la serie que
 *     decide (abajo), días base..D (base = --dia-base-diversidad [5]: el día de SC-003; antes domina el
 *     asentamiento inicial), cumple si y solo si:
 *       - Mann-Kendall de tendencia CRECIENTE, unilateral, p < 0,05: S = Σ_{i<j} sgn(x_j − x_i), con los
 *         empates (|diferencia| ≤ 1e-9 relativa, clases de enlace simple) corregidos en Var(S) =
 *         [n(n−1)(2n+5) − Σ t(t−1)(2t+5)] / 18 y aproximación normal con corrección de continuidad
 *         (z = (S − 1)/√Var(S)). Con n < 10 días con dato la normal no vale: «desconocido».
 *         Var(S) se multiplica por el MAYOR de dos factores de autocorrelación, ambos ≥ 1
 *         [--correccion-mk hamed-rao-ar1]: Hamed y Rao (1998; autocorrelaciones significativas de los
 *         rangos del residuo sin tendencia) y AR(1) paramétrico con los mismos pesos (ρ_k = r*^k, r* =
 *         (n·r₁ + 1)/(n − 4) del residuo, corrección de sesgo de Yue y Wang). Solo con Hamed-Rao un AR(1)
 *         φ = 0,7 sin tendencia aprobaba el 15-17 % (> 10 %, el tope del preregistro); con los dos, el 7 %;
 *       - Y subida = pendiente de Sen (mediana de las pendientes entre pares) × (D − base) ≥ 0,02
 *         [--subida-min]: un test significativo con una subida despreciable (una serie constante con un
 *         pico el día D) no es «diversidad creciente».
 *     Calibración (scripts/lab/calibrar-c8.mts: 1000 series sintéticas por caso, semilla fija): ruido
 *     estacionario 0,3 ± 0,1 aprueba el 4,0 % (D = 60) y el 3,2 % (D = 30); AR(1) φ = 0,7, el 7,2 % y el
 *     7,4 %; tendencia 0,003/día, el 100 % y el 51 %. La regla v1 aprobaba ese ruido en el 58 %.
 *     Las reglas v1 (pendiente MCO ≥ --pendiente-min «o»/«y» media de los k últimos días > media de los k
 *     primeros, k = min(ventana, ⌊(D−base+1)/2⌋), bloques comparados con tolerancia 1e-9) se calculan y se
 *     informan en `valores.reglasAntiguas`; NO deciden salvo con --diversidad-regla o|y (solo para
 *     reproducir informes antiguos; el informe lo avisa).
 *     Se mantienen de v1:
 *     Serie [--diversidad-campo auto] — PREREGISTRO del orquestador (noche 2026-09-22, decidido ANTES de
 *     ver corridas largas; ver scripts/lab/README.md §«Preregistro del criterio C8»): decide
 *     `diversidadConductaActiva` (el mismo índice con los ticks por acción SIN descansar: la conducta
 *     activa) si algún día del tramo la trae; si no, `diversidadConductaTiempo` (ticks por acción con
 *     descansar, que domina el 20-39 % del tiempo y el oficio dominante de casi todos); si no,
 *     `diversidadConducta` (la antigua: cuenta explorar una vez por celda nueva y lo sobrerrepresenta).
 *     `activa`/`tiempo`/`actividad` fuerzan una. Las otras series que el tramo traiga se evalúan igual y
 *     se informan como SECUNDARIAS (no deciden).
 *     Cobertura: la serie debe tener dato en ≥ 80 % de los días del tramo (días base..D) [COBERTURA_MIN];
 *     si no, «desconocido», nunca «cumple» (vale para todas las series): una serie que solo existe unos
 *     pocos días del tramo no puede aprobar por su cuenta el crecimiento de todo el tramo.
 *     Extremos completos (verificador de INSTR-2): además, la serie debe tener dato el día D y TODOS los
 *     días de los dos bloques de k días (los k primeros desde el día base y los k últimos; con k < 2, al
 *     menos el día base y el día D); si falta alguno, «desconocido».
 *     Huecos en el medio (fuera de los bloques, que ya están completos): un «cumple» debe sostenerse con los
 *     días que faltan en su valor MÁS DESFAVORABLE (cota inferior de S: cada día que falta toma el valor que
 *     minimiza su suma de signos y los pares entre días que faltan cuentan −1; Var(S) con n completo); si
 *     no, «desconocido»: esconder los días bajos del final del medio no puede aprobar. Con la serie
 *     completa (lo normal: replica.ts escribe las tres series todos los días) no actúa.
 *     Coherencia: un índice fuera de [0, 1] o no numérico en el tramo ⇒ «desconocido». Serie constante
 *     (una sola clase de empate: amplitud ≤ 1e-9 relativa) ⇒ falla: S = 0 y Sen = 0, no crece.
 *     Se documentan en `valores`: S, Var(S), z, p (y sin corrección), factores, r₁*, pendiente de Sen,
 *     subida, p pesimista con huecos y las reglas v1.
 *
 * Todo criterio es cumple / falla / desconocido. Un campo ausente o ilegible da «desconocido», NUNCA
 * «cumple»: una semilla solo «cumple todos» si los 8 cumplen. Un acumulado que DECRECE (nacimientos,
 * conflictos, una causa de muerte, un tipo de cooperación) es incoherente: «desconocido».
 *
 * Estados de réplica al día D:
 *   - evaluada: tiene dia-D (aunque siga corriendo: los días 1..D ya no cambian);
 *   - extinguida: algún día ≤ D con 0 vecinos mortales (`vecinosMortales`; si falta, `poblacion` − 2,
 *     porque S e I son inmortales y la población nunca baja de 2; solo los vecinos se reproducen,
 *     family.ts, así que no hay vuelta atrás). Cuenta como evaluada que FALLA los 8 criterios, llegue
 *     o no a escribir dia-D;
 *   - ilegible: un dia-NNN.json intermedio no es JSON válido, su tick falta, no es numérico o no es
 *     NNN·2400 (tick estrictamente creciente con el día), algún contador o población que decide un
 *     criterio (poblacion, nacimientos, vecinosMortales, fundadores*, generacionesVivas,
 *     conflictosAcumulados, usos*, foodShared, cada causa de muertesPorCausa, cada tipo de la lista cerrada
 *     de cooperacionAcumuladaPorTipo) está pero no es un entero ≥ 0, dos directorios del mismo brazo
 *     resuelven a la misma semilla (x-1, x-01, x-001: todos ilegibles, error explícito), o hay ficheros de
 *     día con nombre no canónico: solo vale el nombre que escribe replica.ts, `dia-NNN.json` con 3
 *     dígitos (`padStart(3, '0')`; desde el día 1000, los dígitos que haga falta, sin ceros de más).
 *     `dia-20.json` junto a `dia-020.json` (dos ficheros para el mismo día) es un error explícito que
 *     los nombra, no «el último gana»; un `dia-20.json` suelto también. Cuenta como evaluada con los 8
 *     «desconocido» (nunca aprobada);
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
  usoAjenoMin: number; diasUsoAjenoMin: number; usosConAutorMin: number;
  diaBaseDiversidad: number; pendienteMin: number; diversidadRegla: ReglaDiversidad; diversidadCampo: CampoDiversidad;
  subidaMin: number; correccionMk: CorreccionMk;
  mayoria: number; estancadaHoras: number;
}

/** C8: `mk` = preregistro v2 (Mann-Kendall + subida de Sen), el que decide por defecto; `o`/`y` = reglas
 * v1 (pendiente MCO / bloques), solo para reproducir informes antiguos: aprueban ruido estacionario. */
export type ReglaDiversidad = 'mk' | 'o' | 'y';
/** Corrección de la varianza de S por autocorrelación: `hamed-rao-ar1` (por defecto) = el mayor de los
 * factores de Hamed y Rao (1998, autocorrelaciones empíricas de rangos) y AR(1) (ρ_k = r₁*^k, r₁ del
 * residuo sin tendencia corregido por sesgo); `hamed-rao` = solo el empírico; `ninguna`. Ver calibrar-c8.mts. */
export type CorreccionMk = 'hamed-rao-ar1' | 'hamed-rao' | 'ninguna';

/** Serie de C8: `auto` = la primera de `PRIORIDAD_DIVERSIDAD` que el tramo trae (activa → tiempo → antigua). */
export type CampoDiversidad = 'auto' | 'diversidadConductaVentana' | 'diversidadConductaActiva' | 'diversidadConductaTiempo' | 'diversidadConducta';

/** «durante al menos 60 días simulados»: un corte anterior no puede aprobar ni suspender el criterio. */
export const DIAS_CRITERIO = 60;

export const UMBRALES_POR_DEFECTO: Readonly<Umbrales> = Object.freeze({
  dia: DIAS_CRITERIO, ventana: 10,
  poblacionMin: 16, nacimientosMin: 1, fundadoresMax: 1, generacionesMin: 3,
  coopTiposMin: 2, coopFraccionMin: 0.10, coopActosMin: 5, conflictosMin: 1,
  causasMin: 2, causasConocidas: ['starvation', 'dehydration', 'exposure', 'senescence'],
  usoAjenoMin: 0.15, diasUsoAjenoMin: 0.5, usosConAutorMin: 20,
  diaBaseDiversidad: 5, pendienteMin: 0, diversidadRegla: 'mk' as const, diversidadCampo: 'auto' as const,
  subidaMin: 0.02, correccionMk: 'hamed-rao-ar1' as const,
  mayoria: 0.5, estancadaHoras: 3,
});

/** createWorld: S, I y 14 vecinos fundadores. S e I (roles 'S' | 'I') son inmortales: en los 552
 * dia-NNN.json de r2 (noche 2026-09-22) poblacion − vecinosMortales = 2 siempre. */
const POBLACION_INICIAL = 16, INMORTALES = 2;
/** Mínimos de muestras de C8: una pendiente de 2 puntos o un bloque de 1 día es una comparación de
 * días sueltos de un indicador que salta ±0,1 de un día a otro. */
const PUNTOS_MIN_PENDIENTE = 3, DIAS_MIN_BLOQUE = 2;
/** C8: fracción mínima de días del tramo (base..D) con dato en la serie evaluada; por debajo, «desconocido». */
export const COBERTURA_MIN = 0.8;
/** C8: amplitud o |pendiente| (por día) por debajo de la cual la serie no crece, relativa a su escala
 * (× máx(1, máx |valor|)): no se compara con igualdad exacta (un 1e-15 no es crecimiento). */
export const TOLERANCIA_PLANA = 1e-9;

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

/** Cualquier fichero con forma de día; solo se ACEPTA el nombre canónico (`nombreDia`). */
const PATRON_DIA = /^dia-(\d+)\.json$/;
/** Nombre que escribe replica.ts para el día `dia`: 3 dígitos con ceros a la izquierda (dia-020.json). */
const nombreDia = (dia: number): string => `dia-${String(dia).padStart(3, '0')}.json`;
const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const esContador = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** C4: los ÚNICOS tipos de cooperación que cuentan (world.totals de replica.ts + foodShared de
 * instrumentos.ts). Otra clave de `cooperacionAcumuladaPorTipo` («Teaching», «ayuda»…) se informa y no
 * cuenta: un alias del mismo mecanismo no puede fabricar un segundo tipo. */
export const TIPOS_COOPERACION = ['teaching', 'trade', 'constructionHelp', 'foodShared'] as const;
/** Contadores y poblaciones que deciden algún criterio: si están (no null), enteros ≥ 0. */
const CONTADORES = ['poblacion', 'nacimientos', 'vecinosMortales', 'fundadoresMortalesVivos', 'fundadoresVivos', 'generacionesVivas',
  'conflictosAcumulados', 'usosUtiles', 'usosDeInventorAjeno', 'usosSinAutorResuelto', 'foodShared'] as const;

/** Coherencia de un dia-NNN.json: los contadores (y cada causa de `muertesPorCausa`, y cada tipo de
 * cooperación de la lista cerrada) presentes son enteros ≥ 0. Un campo AUSENTE no es incoherente (el
 * criterio que lo use dirá «desconocido»); uno presente con −5, 2,5 o "7" sí: fichero roto ⇒ ilegible. */
function errorContadores(dia: Dia): string | null {
  const malos: string[] = [];
  const ver = (nombre: string, v: unknown) => { if (v !== undefined && v !== null && !esContador(v)) malos.push(`${nombre} = ${JSON.stringify(v)}`); };
  for (const clave of CONTADORES) ver(clave, dia[clave]);
  for (const [clave, soloTipos] of [['muertesPorCausa', false], ['cooperacionAcumuladaPorTipo', true]] as const) {
    const m = dia[clave];
    if (m === undefined || m === null) continue;
    if (!esObjeto(m)) { malos.push(`${clave} = ${JSON.stringify(m)} (no es un objeto)`); continue; }
    for (const [k, v] of Object.entries(m)) if (!soloTipos || (TIPOS_COOPERACION as readonly string[]).includes(k)) ver(`${clave}.${k}`, v);
  }
  return malos.length ? `${malos.slice(0, 4).join(', ')}${malos.length > 4 ? ` (y ${malos.length - 4} más)` : ''}: contadores y poblaciones deben ser enteros ≥ 0` : null;
}

/** Error explícito si dos ficheros resuelven al mismo día (dia-20.json y dia-020.json) o si alguno no
 * tiene el nombre canónico; `null` si todos son canónicos y distintos. */
function errorNombresDia(nombres: readonly string[]): string | null {
  const porDia = new Map<number, string[]>();
  for (const fichero of nombres) {
    const dia = Number(PATRON_DIA.exec(fichero)![1]);
    porDia.set(dia, [...(porDia.get(dia) ?? []), fichero]);
  }
  const duplicados = [...porDia].filter(([, ficheros]) => ficheros.length > 1).sort((a, b) => a[0] - b[0]);
  if (duplicados.length) return `ficheros duplicados para el mismo día: ${duplicados.map(([dia, ficheros]) => `${[...ficheros].sort().join(' y ')} (día ${dia})`).join('; ')}; no se elige uno`;
  const raros = [...porDia].filter(([dia, [fichero]]) => fichero !== nombreDia(dia)).sort((a, b) => a[0] - b[0]);
  if (raros.length) return `nombre de día no canónico: ${raros.map(([dia, [fichero]]) => `${fichero} (se espera ${nombreDia(dia)})`).join(', ')}; solo se aceptan dia-NNN.json de 3 dígitos, como los escribe replica.ts`;
  return null;
}

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
  // Antes, dia-20.json y dia-020.json entraban los dos y el que se leía después pisaba al otro en silencio.
  const errorNombres = errorNombresDia(nombres);
  if (errorNombres) { r.error = errorNombres; return r; }
  for (const [indice, fichero] of nombres.entries()) {
    const dia = Number(PATRON_DIA.exec(fichero)![1]);
    let cuerpo: unknown;
    try { cuerpo = JSON.parse(readFileSync(join(directorio, fichero), 'utf8')); } catch {
      // replica.ts escribe cada día de una vez; el último de una réplica viva puede estar a medias.
      if (!r.terminada && indice === nombres.length - 1) { avisos.push(`${nombre}/${fichero}: JSON incompleto en una réplica en curso (aún escribiéndose); ignorado.`); continue; }
      r.error = `${fichero} no es JSON válido`; return r;
    }
    if (!esObjeto(cuerpo)) { r.error = `${fichero} no es un objeto JSON`; return r; }
    // El tick ata el fichero a su día: numérico e igual a día·2400 (luego estrictamente creciente con el
    // día). Sin tick, o con tick "x", el orden de los días no se puede comprobar (verificador de INSTR-3).
    if (typeof cuerpo.tick !== 'number' || !Number.isFinite(cuerpo.tick)) { r.error = `${fichero}: tick ${cuerpo.tick === undefined ? 'ausente' : `no numérico (${JSON.stringify(cuerpo.tick)})`}; se espera ${dia}·${TICKS_POR_DIA} = ${dia * TICKS_POR_DIA}`; return r; }
    if (cuerpo.tick !== dia * TICKS_POR_DIA) { r.error = `${fichero}: tick ${cuerpo.tick} ≠ ${dia}·${TICKS_POR_DIA}`; return r; }
    const incoherente = errorContadores(cuerpo);
    if (incoherente) { r.error = `${fichero}: ${incoherente}`; return r; }
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
  // Semillas duplicadas en un brazo (x-1, x-01 y x-001 son la semilla 1): no se elige una ni se cuenta
  // tres veces el mismo experimento; todas ilegibles con error explícito (verificador de INSTR-3).
  const porSemilla = new Map<string, ReplicaLeida[]>();
  for (const r of replicas) porSemilla.set(`${r.brazo}\0${r.semilla}`, [...(porSemilla.get(`${r.brazo}\0${r.semilla}`) ?? []), r]);
  for (const grupo of porSemilla.values()) if (grupo.length > 1) {
    const error = `semilla duplicada en el brazo «${grupo[0]!.brazo}»: ${grupo.map(r => r.nombre).sort().join(', ')} resuelven a la semilla ${grupo[0]!.semilla}; no se elige una`;
    for (const r of grupo) r.error = error;
    avisos.push(error);
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
    generaciones: `generaciones mortales vivas(D) ≥ ${u.generacionesMin} (lista de enteros ≥ 0 distintos; si no, desconocido)`,
    cooperacion: `≥ ${u.coopTiposMin} tipos de {${TIPOS_COOPERACION.join(', ')}} con ≥ ${pct(u.coopFraccionMin)} de los actos tipificados de la ventana y ≥ ${u.coopActosMin} actos (otras claves no cuentan)`,
    conflictos: `conflictos en la ventana ≥ ${u.conflictosMin}`,
    muertes: `0 muertes fuera de {${u.causasConocidas.join(', ')}}, ≥ ${u.causasMin} causas distintas en los días 1..D y balance población = nacimientos − muertes desde el día 0`,
    tecnologia: `usos de inventor ajeno / usos útiles con autor en la ventana ≥ ${u.usoAjenoMin} y uso ajeno en ≥ ${pct(u.diasUsoAjenoMin)} de sus días (con < ${u.usosConAutorMin} usos con autor conocido ⇒ desconocido; ninguno útil ⇒ falla)`,
    diversidad: `${u.diversidadCampo === 'auto' ? 'diversidadConductaVentana [preregistro v3] (si falta, diversidadConductaActiva; si falta, diversidadConductaTiempo; si falta, diversidadConducta)' : u.diversidadCampo} días ${u.diaBaseDiversidad}..D: ${u.diversidadRegla === 'mk'
      ? `Mann-Kendall unilateral creciente p < ${ALFA_MK} (≥ ${N_MIN_MK} días con dato; Var(S) corregida por autocorrelación: ${u.correccionMk}) y subida de Sen (pendiente × (D − ${u.diaBaseDiversidad})) ≥ ${u.subidaMin} [preregistro v2]; con huecos en el medio, «cumple» solo si se sostiene con los días que faltan en su valor más desfavorable; las reglas v1 se informan, no deciden`
      : `REGLA v1 «${u.diversidadRegla}» (no preregistrada: aprueba ruido estacionario) pendiente MCO (≥ ${PUNTOS_MIN_PENDIENTE} días) ≥ ${u.pendienteMin} ${u.diversidadRegla} media de los k últimos días > media de los k primeros (k = min(ventana, mitad del tramo) ≥ ${DIAS_MIN_BLOQUE}, tolerancia ${TOLERANCIA_PLANA}); con huecos, una pendiente favorable no decide`}; índice fuera de [0, 1] ⇒ desconocido; dato en < ${pct(COBERTURA_MIN)} de los días del tramo ⇒ desconocido; sin dato el día D o algún día de los dos bloques extremos ⇒ desconocido; serie constante (amplitud ≤ ${TOLERANCIA_PLANA}, relativa) ⇒ falla`,
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
  if (nacimientos !== null && nacimientos < 0) return { estado: 'desconocido', motivo: `nacimientos acumulados decrecen (${nacB} el día ${base} → ${nacD} el día ${D}): datos incoherentes`, valores: { nacimientosVentana: nacimientos, fundadoresMortalesVivos: fundadores } };
  const partes = [
    nacimientos === null ? `faltan nacimientos (día ${D} o ${base})` : `${nacimientos} nacimientos en la ventana${nacimientos >= u.nacimientosMin ? '' : ` (< ${u.nacimientosMin})`}`,
    fundadores === null ? 'falta fundadoresMortalesVivos (fundadoresVivos incluye a S e I, inmortales: no sirve)' : `${fundadores} fundadores mortales vivos${fundadores <= u.fundadoresMax ? '' : ` (> ${u.fundadoresMax})`}`,
  ];
  return { estado: y(nacimientos === null ? null : nacimientos >= u.nacimientosMin, fundadores === null ? null : fundadores <= u.fundadoresMax),
    motivo: partes.join('; '), valores: { nacimientosVentana: nacimientos, fundadoresMortalesVivos: fundadores } };
}

function generaciones({ dias, D, u }: Contexto): ResultadoCriterio {
  const d = dias.get(D), mortales = d?.generacionesMortalesVivas;
  if (mortales !== undefined && mortales !== null) {
    // Lista de generaciones DISTINTAS (metrics.ts: [...new Set(...)].sort()); se cuenta un Set. Basura
    // (no lista, no enteros ≥ 0) o repetidas ([2, 2, 2] no son 3 generaciones) ⇒ incoherente ⇒ desconocido.
    if (!Array.isArray(mortales)) return { estado: 'desconocido', motivo: `generacionesMortalesVivas no es una lista (${JSON.stringify(mortales)}): datos incoherentes`, valores: { generaciones: null, fuente: 'generacionesMortalesVivas' } };
    const malos = mortales.filter(g => !esContador(g));
    if (malos.length) return { estado: 'desconocido', motivo: `generacionesMortalesVivas con valores que no son enteros ≥ 0 (${malos.slice(0, 3).map(g => JSON.stringify(g)).join(', ')}): datos incoherentes`, valores: { generaciones: null, fuente: 'generacionesMortalesVivas' } };
    const g = new Set(mortales as number[]).size;
    if (g !== mortales.length) return { estado: 'desconocido', motivo: `generacionesMortalesVivas repite generaciones [${mortales.join(', ')}] (${g} distinta(s) de ${mortales.length}): datos incoherentes`, valores: { generaciones: null, generacionesDistintas: g, fuente: 'generacionesMortalesVivas' } };
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

/** Tipos de la lista cerrada presentes en `cooperacionAcumuladaPorTipo` (enteros ≥ 0, validados al leer)
 * y las otras claves, que no cuentan; `null` si el campo falta o no es un objeto. */
function tiposCooperacion(d: Dia | undefined): { tipos: Record<string, number>; otras: string[] } | null {
  const v = d?.cooperacionAcumuladaPorTipo;
  if (!esObjeto(v)) return null;
  const tipos: Record<string, number> = {}, otras: string[] = [];
  for (const [clave, n] of Object.entries(v)) {
    if ((TIPOS_COOPERACION as readonly string[]).includes(clave)) { if (esContador(n)) tipos[clave] = n; }
    else otras.push(clave);
  }
  return { tipos, otras };
}

function cooperacion({ dias, D, base, u }: Contexto): ResultadoCriterio {
  const leidoD = tiposCooperacion(dias.get(D));
  if (!leidoD) return { estado: 'desconocido', motivo: 'falta cooperacionAcumuladaPorTipo en el día D', valores: {} };
  const leidoB = base <= 0 && !dias.has(base) ? { tipos: {}, otras: [] } : tiposCooperacion(dias.get(base));
  if (!leidoB) return { estado: 'desconocido', motivo: `falta cooperacionAcumuladaPorTipo en el día ${base} (inicio de la ventana)`, valores: {} };
  const tiposD = leidoD.tipos, tiposB = leidoB.tipos, clavesNoContadas = leidoD.otras.sort();
  const noContadas = clavesNoContadas.length ? ` (claves fuera de {${TIPOS_COOPERACION.join(', ')}}, no cuentan: ${clavesNoContadas.join(', ')})` : '';
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
  if (total <= 0) return { estado: 'falla', motivo: `ningún acto de cooperación tipificado en la ventana${noContadas}`, valores: { porTipo, total, otras, clavesNoContadas } };
  const fracciones = Object.fromEntries(Object.entries(porTipo).map(([t, n]) => [t, redondear(n / total)]));
  const relevantes = Object.entries(porTipo).filter(([, n]) => n > 0 && n >= u.coopActosMin && n / total >= u.coopFraccionMin).map(([t]) => t);
  const detalle = Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n} (${pct(n / total)})`).join(', ');
  return { estado: relevantes.length >= u.coopTiposMin ? 'cumple' : 'falla',
    motivo: `${relevantes.length} tipo(s) con ≥ ${pct(u.coopFraccionMin)} y ≥ ${u.coopActosMin} de ${total} actos: ${detalle}${noContadas}`,
    valores: { porTipo, fracciones, total, relevantes, otrasNoTipificadas: otras, clavesNoContadas } };
}

function conflictos({ dias, D, base, u }: Contexto): ResultadoCriterio {
  const cD = num(dias.get(D), 'conflictosAcumulados'), cB = acumulado(dias, base, d => num(d, 'conflictosAcumulados'));
  if (cD === null || cB === null) return { estado: 'desconocido', motivo: `falta conflictosAcumulados (día ${cD === null ? D : base})`, valores: { conflictosVentana: null, conflictosAcumulados: cD } };
  const ventana = cD - cB;
  if (ventana < 0) return { estado: 'desconocido', motivo: `conflictosAcumulados decrece (${cB} el día ${base} → ${cD} el día ${D}): datos incoherentes`, valores: { conflictosVentana: ventana, conflictosAcumulados: cD } };
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
  // Acumulados que decrecen desde el día 0 (una causa o los nacimientos): datos incoherentes.
  const decrecen = [...(m0 ? Object.keys({ ...m0, ...mD }).filter(c => (mD[c] ?? 0) < (m0[c] ?? 0)).map(c => `muertesPorCausa.${c}`) : []), ...(n0 !== null && nD !== null && nD < n0 ? ['nacimientos'] : [])];
  if (decrecen.length) return { estado: 'desconocido', motivo: `${decrecen.join(', ')} decrece(n) entre el día 0 y el día ${D}: datos incoherentes`, valores: { muertesPorCausa: mD } };
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
  const faltan: number[] = [], incoherentes: number[] = [];
  let ajenos = 0, conAutor = 0, usosTotales = 0, diasConAjeno = 0;
  for (const dia of diasVentana) {
    const d = dias.get(dia), a = num(d, 'usosDeInventorAjeno'), usos = num(d, 'usosUtiles'), sinAutor = num(d, 'usosSinAutorResuelto');
    if (a === null || usos === null || sinAutor === null) { faltan.push(dia); continue; }
    // Cada día: sin autor ≤ usos útiles y de inventor ajeno ≤ usos con autor conocido (metrics.ts los
    // cuenta sobre los mismos usos). Si no, el cociente no significa nada (verificador de INSTR-3).
    if (sinAutor > usos || a > usos - sinAutor) incoherentes.push(dia);
    ajenos += a; conAutor += usos - sinAutor; usosTotales += usos; if (a > 0) diasConAjeno++;
  }
  if (faltan.length) return { estado: 'desconocido', motivo: `faltan usosDeInventorAjeno/usosUtiles/usosSinAutorResuelto los días ${faltan.join(', ')}`, valores: { diasSinDato: faltan } };
  if (incoherentes.length) return { estado: 'desconocido', motivo: `usosDeInventorAjeno > usosUtiles − usosSinAutorResuelto (o usosSinAutorResuelto > usosUtiles) los días ${rangos(incoherentes)}: datos incoherentes`, valores: { diasIncoherentes: incoherentes } };
  const fraccionDias = diasConAjeno / diasVentana.length;
  // Sin ningún uso útil no hay tecnología que se transmita: falla. Con usos pero < usosConAutorMin de autor
  // conocido, la fracción es de una muestra demasiado pequeña (o el autor no se resolvió): desconocido.
  if (usosTotales === 0) return { estado: 'falla', motivo: 'ningún uso útil en la ventana', valores: { usosDeInventorAjeno: 0, usosConAutor: 0, usosUtiles: 0, fraccionUsoAjeno: null, fraccionDiasConUsoAjeno: fraccionDias } };
  if (conAutor < u.usosConAutorMin) return { estado: 'desconocido', motivo: `solo ${conAutor} usos útiles con autor conocido en la ventana (< ${u.usosConAutorMin}; ${usosTotales} usos útiles): muestra insuficiente para medir la transmisión`, valores: { usosDeInventorAjeno: ajenos, usosConAutor: conAutor, usosUtiles: usosTotales, fraccionUsoAjeno: conAutor > 0 ? ajenos / conAutor : null, fraccionDiasConUsoAjeno: fraccionDias } };
  const fraccion = ajenos / conAutor;
  return { estado: y(fraccion >= u.usoAjenoMin, fraccionDias >= u.diasUsoAjenoMin),
    motivo: `uso ajeno ${redondear(fraccion)} (${ajenos}/${conAutor})${fraccion >= u.usoAjenoMin ? '' : ` < ${u.usoAjenoMin}`}; en ${diasConAjeno}/${diasVentana.length} días${fraccionDias >= u.diasUsoAjenoMin ? '' : ` (< ${pct(u.diasUsoAjenoMin)})`}`,
    valores: { usosDeInventorAjeno: ajenos, usosConAutor: conAutor, fraccionUsoAjeno: fraccion, fraccionDiasConUsoAjeno: fraccionDias } };
}

// ── C8: Mann-Kendall + pendiente de Sen (preregistro v2) ──────────────────────────────────────────

/** Nivel del test de Mann-Kendall (unilateral, tendencia creciente) y n mínimo para la aproximación
 * normal (preregistro v2: con n < 10 la normal no vale y C8 es «desconocido»). */
export const ALFA_MK = 0.05, N_MIN_MK = 10;
/** z_{0,975}: banda de significación de las autocorrelaciones de rangos en Hamed y Rao (±z/√n). */
const Z_975 = 1.959963984540054;

/** erfc con la aproximación de Chebyshev de Numerical Recipes (erfcc): error relativo < 1,2e-7. */
function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807
    + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** P(Z ≥ z) de la normal estándar. */
export const colaNormalSuperior = (z: number): number => 0.5 * erfc(z / Math.SQRT2);

/** Clases de empate: valores ordenados, uno nuevo abre clase si se separa del anterior > `tolerancia`
 * (enlace simple). Mann-Kendall, su varianza y Sen usan las MISMAS clases: un 1e-15 no es subida. */
function clasesDeEmpate(valores: readonly number[], tolerancia: number): { clase: number[]; tamanos: number[] } {
  const orden = valores.map((_, i) => i).sort((a, b) => valores[a]! - valores[b]!);
  const clase = new Array<number>(valores.length), tamanos: number[] = [];
  let previo = 0;
  for (const i of orden) {
    if (!tamanos.length || valores[i]! - previo > tolerancia) tamanos.push(0);
    clase[i] = tamanos.length - 1; tamanos[tamanos.length - 1]!++; previo = valores[i]!;
  }
  return { clase, tamanos };
}

/** Var(S) de Mann-Kendall con corrección por empates: [n(n−1)(2n+5) − Σ t(t−1)(2t+5)] / 18. */
const varianzaS = (n: number, tamanos: readonly number[]): number =>
  (n * (n - 1) * (2 * n + 5) - tamanos.reduce((s, t) => s + t * (t - 1) * (2 * t + 5), 0)) / 18;

/** Pendiente de Sen: mediana de (x_j − x_i)/(t_j − t_i), i < j; un par empatado (misma clase) da 0. */
export function pendienteSen(puntos: readonly (readonly [number, number])[], tolerancia = 0): number | null {
  if (puntos.length < 2) return null;
  const { clase } = clasesDeEmpate(puntos.map(([, v]) => v), tolerancia);
  const pendientes: number[] = [];
  for (let i = 0; i < puntos.length; i++) for (let j = i + 1; j < puntos.length; j++)
    pendientes.push(clase[i] === clase[j] ? 0 : (puntos[j]![1] - puntos[i]![1]) / (puntos[j]![0] - puntos[i]![0]));
  pendientes.sort((a, b) => a - b);
  const m = pendientes.length >> 1;
  return pendientes.length % 2 ? pendientes[m]! : (pendientes[m - 1]! + pendientes[m]!) / 2;
}

/** Rangos 1..n con los empates (clases de `clasesDeEmpate`, misma tolerancia) al rango medio. */
function rangosMedios(valores: readonly number[], tolerancia: number): { rangos: number[]; clases: number } {
  const { clase, tamanos } = clasesDeEmpate(valores, tolerancia), medio: number[] = [];
  let antes = 0;
  for (const t of tamanos) { medio.push(antes + (t + 1) / 2); antes += t; }
  return { rangos: clase.map(c => medio[c]!), clases: tamanos.length };
}

/** Factor de Hamed y Rao (1998) para Var(S) bajo autocorrelación: n/n*_s = 1 + 2/(n(n−1)(n−2)) ·
 * Σ_k (n−k)(n−k−1)(n−k−2) ρ_k, con ρ_k la autocorrelación de los RANGOS de la serie sin tendencia
 * (x − β·t, β = Sen) y solo los retardos significativos (|ρ_k| > z_{0,975}/√n), como pyMannKendall
 * (`hamed_rao_modification_test`, todos los retardos). Los días con dato se toman seguidos (un hueco
 * del medio no rompe la secuencia, como quien descarta los NaN). Acotado a ≥ 1: una autocorrelación
 * negativa espuria no puede ESTRECHAR la varianza y hacer más fácil aprobar. */
function factorHamedRao(puntos: readonly (readonly [number, number])[], sen: number, tolerancia: number): number {
  const n = puntos.length;
  if (n < 4) return 1;
  // Residuos empatados con la misma tolerancia que S: el residuo de una recta exacta es ruido de coma
  // flotante (1e-17), no autocorrelación.
  const { rangos, clases } = rangosMedios(puntos.map(([t, v]) => v - sen * t), tolerancia), media = (n + 1) / 2;
  if (clases < 2) return 1;
  const den = rangos.reduce((s, r) => s + (r - media) ** 2, 0);
  if (den <= 0) return 1;
  const limite = Z_975 / Math.sqrt(n);
  return Math.max(1, pesosHamedRao(n, k => {
    let cov = 0;
    for (let i = 0; i + k < n; i++) cov += (rangos[i]! - media) * (rangos[i + k]! - media);
    const rho = cov / den;
    return Math.abs(rho) > limite ? rho : 0;
  }));
}

/** Suma de pesos de Hamed y Rao con autocorrelaciones `rho(k)`: 1 + 2/(n(n−1)(n−2)) Σ_k (n−k)(n−k−1)(n−k−2) ρ_k. */
function pesosHamedRao(n: number, rho: (k: number) => number): number {
  let suma = 0;
  for (let k = 1; k <= n - 3; k++) suma += (n - k) * (n - k - 1) * (n - k - 2) * rho(k);
  return 1 + 2 * suma / (n * (n - 1) * (n - 2));
}

/** Factor AR(1) paramétrico: el de Hamed y Rao con ρ_k = r^k, r = autocorrelación de retardo 1 del residuo
 * sin tendencia (x − β·t, β = Sen) corregida por sesgo, r* = (n·r₁ + 1)/(n − 4) (Yue et al., 2002; Yue y
 * Wang, 2004), acotada a [0; 0,95]. El estimador empírico de Hamed y Rao subestima la autocorrelación con
 * n ≈ 25-55 (sesgo ≈ −(1 + 4φ)/n y solo cuenta retardos significativos): con AR(1) φ = 0,7 dejaba el falso
 * positivo en el 15-17 %; con este, en el 6-9 % (calibrar-c8.mts). Acotado a ≥ 1. */
function factorAr1(puntos: readonly (readonly [number, number])[], sen: number, tolerancia: number): { factor: number; r1: number } {
  const n = puntos.length;
  const residuos = puntos.map(([t, v]) => v - sen * t), media = residuos.reduce((s, v) => s + v, 0) / n;
  // Sin ruido (residuos dentro de la tolerancia: una recta exacta) no hay autocorrelación que corregir.
  if (n < 5 || Math.max(...residuos) - Math.min(...residuos) <= tolerancia) return { factor: 1, r1: 0 };
  let cov = 0, den = 0;
  for (let i = 0; i < n; i++) { den += (residuos[i]! - media) ** 2; if (i + 1 < n) cov += (residuos[i]! - media) * (residuos[i + 1]! - media); }
  const r1 = den > 0 ? Math.min(0.95, Math.max(0, (n * (cov / den) + 1) / (n - 4))) : 0;
  return { factor: Math.max(1, pesosHamedRao(n, k => r1 ** k)), r1 };
}

/** z con corrección de continuidad y p unilateral (H1: tendencia creciente). */
function zYp(S: number, varS: number): { z: number; p: number } {
  if (!(varS > 0)) return { z: 0, p: 0.5 };
  const z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
  return { z, p: colaNormalSuperior(z) };
}

export interface MannKendall {
  n: number; S: number; clases: number; varS: number; z: number; p: number;
  /** Factor aplicado a Var(S) (1 sin corrección) y sus dos candidatos: Hamed y Rao empírico y AR(1) con r₁*. */
  factor: number; factorHamedRao: number; factorAr1: number; r1: number;
  /** Sin la corrección por autocorrelación (se informa siempre). */
  varSinCorreccion: number; zSinCorreccion: number; pSinCorreccion: number;
  pendienteSen: number | null;
}

/** Mann-Kendall unilateral (tendencia creciente) sobre (día, valor) ordenados por día; empates por
 * `tolerancia` (clases de enlace simple) en S y en Var(S). Aproximación normal con corrección de
 * continuidad; `correccion` = hamed-rao multiplica Var(S) por su factor (≥ 1). */
export function mannKendall(puntos: readonly (readonly [number, number])[], tolerancia = 0, correccion: CorreccionMk = 'hamed-rao-ar1'): MannKendall {
  const n = puntos.length;
  const { clase, tamanos } = clasesDeEmpate(puntos.map(([, v]) => v), tolerancia);
  let S = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S += Math.sign(clase[j]! - clase[i]!);
  const sen = pendienteSen(puntos, tolerancia);
  const varSinCorreccion = varianzaS(n, tamanos);
  const conDatos = sen !== null && tamanos.length > 1;
  const hr = conDatos ? factorHamedRao(puntos, sen, tolerancia) : 1, ar1 = conDatos ? factorAr1(puntos, sen, tolerancia) : { factor: 1, r1: 0 };
  const factor = correccion === 'hamed-rao-ar1' ? Math.max(hr, ar1.factor) : correccion === 'hamed-rao' ? hr : 1;
  const sin = zYp(S, varSinCorreccion), con = zYp(S, varSinCorreccion * factor);
  return { n, S, clases: tamanos.length, varS: varSinCorreccion * factor, z: con.z, p: con.p,
    factor, factorHamedRao: hr, factorAr1: ar1.factor, r1: ar1.r1,
    varSinCorreccion, zSinCorreccion: sin.z, pSinCorreccion: sin.p, pendienteSen: sen };
}

/** Cota inferior de S si los días `faltan` (huecos del medio) tuvieran su valor MÁS desfavorable: cada día
 * que falta toma, por separado, el valor que minimiza su suma de signos con los días con dato, y los
 * pares entre días que faltan cuentan −1. Con esa S, n = días con dato + días que faltan (sin empates
 * nuevos: Var(S) máxima) y el mismo factor de corrección. */
function mannKendallPesimista(puntos: readonly (readonly [number, number])[], faltan: readonly number[], tolerancia: number, mk: MannKendall): { S: number; z: number; p: number } {
  const { clase, tamanos } = clasesDeEmpate(puntos.map(([, v]) => v), tolerancia);
  let S = mk.S;
  for (const t of faltan) {
    let peor = Infinity;
    // En el espacio de clases basta probar cada clase (empate) y cada hueco entre clases, y los dos extremos.
    for (let c2 = -1; c2 <= 2 * tamanos.length - 1; c2++) {
      const c = c2 / 2;
      let s = 0;
      for (let i = 0; i < puntos.length; i++) s += puntos[i]![0] < t ? Math.sign(c - clase[i]!) : Math.sign(clase[i]! - c);
      peor = Math.min(peor, s);
    }
    S += peor;
  }
  S -= faltan.length * (faltan.length - 1) / 2;
  const n = puntos.length + faltan.length;
  return { S, ...zYp(S, varianzaS(n, [...tamanos, ...faltan.map(() => 1)]) * mk.factor) };
}

/** Reglas v1 de C8 (pendiente MCO ≥ pendienteMin «o»/«y» media de los k últimos días > media de los k
 * primeros), sobre una serie ya validada (cobertura y extremos completos). Desde el preregistro v2 solo
 * se informan (`reglasAntiguas`) salvo con --diversidad-regla o|y: aprueban ruido estacionario. */
function reglasV1(puntos: readonly [number, number][], sinDato: readonly number[], b: number, D: number, k: number, tolerancia: number, u: Umbrales) {
  const valores = puntos.map(([, v]) => v), porDia = new Map(puntos);
  const pendiente = puntos.length >= PUNTOS_MIN_PENDIENTE ? pendienteMco(puntos) : null;
  const amplitud = Math.max(...valores) - Math.min(...valores);
  const base = { pendiente, amplitud, pendienteDecide: false, mediaInicio: null as number | null, mediaFinal: null as number | null, diasPorBloque: k };
  // Una serie plana no «crece» aunque su pendiente sea 0 ≥ 0 (tolerancia relativa, no igualdad exacta).
  if (puntos.length >= 2 && amplitud <= tolerancia)
    return { o: 'falla' as Estado, y: 'falla' as Estado, ...base, motivo: `serie constante (${redondear(valores[0]!)}${amplitud > 0 ? `; amplitud ${amplitud.toExponential(1)} ≤ ${tolerancia.toExponential(1)}` : ''}) en ${puntos.length} días: no crece` };
  if (pendiente !== null && Math.abs(pendiente) <= tolerancia)
    return { o: 'falla' as Estado, y: 'falla' as Estado, ...base, motivo: `serie sin tendencia (|pendiente| ${Math.abs(pendiente).toExponential(1)}/día ≤ ${tolerancia.toExponential(1)}) en ${puntos.length} días: no crece` };
  // Los días de los bloques están todos (extremos completos, comprobado antes).
  const media = (desde: number): number | null => {
    if (k < DIAS_MIN_BLOQUE) return null;
    let s = 0;
    for (let dia = desde; dia < desde + k; dia++) s += porDia.get(dia)!;
    return s / k;
  };
  const inicio = media(b), final = media(D - k + 1);
  // Con huecos en el medio, una pendiente FAVORABLE no decide (esconder días bajos la inclina).
  const favorable = pendiente === null ? null : pendiente >= u.pendienteMin;
  const pendienteConHuecos = favorable === true && sinDato.length > 0;
  // Bloques con tolerancia (hallazgo del verificador de INSTR-3): bloques iguales, o el final 1e-12 por
  // encima, no son «crecer»; con ≥ la regla «o» aprobaba una serie con pendiente negativa.
  const s1 = pendienteConHuecos ? null : favorable, s2 = inicio === null || final === null ? null : final - inicio > tolerancia;
  const bloques = k >= DIAS_MIN_BLOQUE ? `media días ${b}..${b + k - 1} ${redondear(inicio!)} → días ${D - k + 1}..${D} ${redondear(final!)}` : `tramo de ${D - b + 1} días: bloques de < ${DIAS_MIN_BLOQUE} días, sin comparar`;
  const motivo = `pendiente ${pendiente === null ? `¿? (${puntos.length} días con dato, < ${PUNTOS_MIN_PENDIENTE})` : `${pendiente.toExponential(2)}/día (${puntos.length} días)`}${pendienteConHuecos ? ` favorable pero con ${sinDato.length} día(s) sin dato (${rangos(sinDato)}): no decide` : ''}; ${bloques}`;
  return { o: o(s1, s2), y: y(s1, s2), ...base, pendienteDecide: s1 !== null, mediaInicio: inicio, mediaFinal: final, motivo };
}

const fmtP = (p: number) => p < 1e-4 ? p.toExponential(1) : String(redondear(p, 4));
/** Número pequeño legible: 4 decimales, o notación exponencial por debajo de 1e-3 (una subida de 1,5e-5 no es «0»). */
const fmtNum = (x: number) => x === 0 || Math.abs(x) >= 1e-3 ? String(redondear(x, 4)) : x.toExponential(2);

/** C8 sobre una serie: `valor(dia)` es el dato del día (undefined/null = sin dato). Exportada para la
 * calibración (scripts/lab/calibrar-c8.mts): la tabla mide ESTA función, no una copia. */
export function evaluarSerieDiversidad(valor: (dia: number) => unknown, D: number, u: Umbrales): ResultadoCriterio {
  const b = u.diaBaseDiversidad;
  const puntos: [number, number][] = [], sinDato: number[] = [], invalidos: string[] = [];
  for (let dia = b; dia <= D; dia++) {
    const v = valor(dia);
    if (v === undefined || v === null) sinDato.push(dia);
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) invalidos.push(`día ${dia} = ${JSON.stringify(v)}`);
    else puntos.push([dia, v]);
  }
  // Coherencia: el índice (src/world/diversidad.ts, resumen.ts) está en [0, 1]; otra cosa es un fichero roto.
  if (invalidos.length)
    return { estado: 'desconocido', motivo: `índice de diversidad fuera de [0, 1] o no numérico (${invalidos.slice(0, 3).join(', ')}${invalidos.length > 3 ? `, … ${invalidos.length} días` : ''}): datos incoherentes`,
      valores: { puntos: puntos.length, diasInvalidos: invalidos.length } };
  // Cobertura: una serie con dato solo en unos pocos días del tramo no representa el tramo (p. ej. un
  // instrumento que empezó a escribirse a mitad de la réplica): «desconocido», nunca «cumple».
  const diasTramo = D - b + 1, cobertura = puntos.length / diasTramo;
  if (cobertura < COBERTURA_MIN)
    return { estado: 'desconocido', motivo: `dato en solo ${puntos.length}/${diasTramo} días del tramo ${b}..${D} (${pct(cobertura)} < ${pct(COBERTURA_MIN)}): no representa el tramo; sin dato: ${rangos(sinDato)}`,
      valores: { pendiente: null, puntos: puntos.length, cobertura, diasSinDato: sinDato } };
  // Extremos completos: el día D y todos los días de los bloques de k días de cada extremo (con k < 2, al
  // menos los días b y D). Sin ellos, las reglas v1 decidían con los días que quedaban (INSTR-2).
  const k = Math.min(u.ventana, Math.floor(diasTramo / 2));
  const kExtremo = Math.max(1, k), finInicio = b + kExtremo - 1, inicioFinal = D - kExtremo + 1;
  const faltanExtremos = sinDato.filter(dia => dia <= finInicio || dia >= inicioFinal);
  if (faltanExtremos.length)
    return { estado: 'desconocido', motivo: `sin dato en ${faltanExtremos.length === 1 ? 'el día' : 'los días'} ${rangos(faltanExtremos)} de los extremos del tramo (bloques días ${b}..${finInicio} y ${inicioFinal}..${D}, que deben estar completos): sin ellos la tendencia se mediría solo con los días que quedan`,
      valores: { pendiente: null, puntos: puntos.length, cobertura, diasPorBloque: k, diasSinDato: sinDato, diasSinDatoEnExtremos: faltanExtremos } };
  const tolerancia = TOLERANCIA_PLANA * Math.max(1, ...puntos.map(([, v]) => Math.abs(v)));
  const v1 = reglasV1(puntos, sinDato, b, D, k, tolerancia, u);
  const reglasAntiguas = { o: v1.o, y: v1.y, pendiente: v1.pendiente, pendienteDecide: v1.pendienteDecide, mediaInicio: v1.mediaInicio, mediaFinal: v1.mediaFinal, diasPorBloque: k, motivo: v1.motivo };
  const comun = { regla: u.diversidadRegla, puntos: puntos.length, cobertura, diasSinDato: sinDato, diasPorBloque: k };
  if (u.diversidadRegla !== 'mk') {
    // Reproducción de la regla v1 (no preregistrada para v2): decide la pedida; se avisa en el informe.
    return { estado: v1[u.diversidadRegla], motivo: `regla v1 «${u.diversidadRegla}»: ${v1.motivo}`,
      valores: { ...comun, pendiente: v1.pendiente, pendienteDecide: v1.pendienteDecide, amplitud: v1.amplitud, mediaInicio: v1.mediaInicio, mediaFinal: v1.mediaFinal, reglasAntiguas } };
  }
  const antiguas = ` · reglas v1 (no deciden): «o» ${v1.o}, «y» ${v1.y}`;
  if (puntos.length < N_MIN_MK)
    return { estado: 'desconocido', motivo: `${puntos.length} días con dato (< ${N_MIN_MK}): Mann-Kendall no se aproxima por la normal${antiguas}`, valores: { ...comun, reglasAntiguas } };
  const mk = mannKendall(puntos, tolerancia, u.correccionMk);
  const valoresMk = { S: mk.S, varS: mk.varS, z: mk.z, p: mk.p, alfa: ALFA_MK, correccion: u.correccionMk, factor: mk.factor, factorHamedRao: mk.factorHamedRao, factorAr1: mk.factorAr1, r1: mk.r1,
    pSinCorreccion: mk.pSinCorreccion, pendienteSen: mk.pendienteSen, subida: mk.pendienteSen === null ? null : mk.pendienteSen * (D - b), subidaMin: u.subidaMin, diasSubida: D - b };
  // Serie constante (una sola clase de empate): S = 0, Var(S) = 0 y Sen = 0; no crece.
  if (mk.clases === 1)
    return { estado: 'falla', motivo: `serie constante (${redondear(puntos[0]![1])}${v1.amplitud > 0 ? `; amplitud ${v1.amplitud.toExponential(1)} ≤ ${tolerancia.toExponential(1)}` : ''}) en ${puntos.length} días: no crece${antiguas}`,
      valores: { ...comun, ...valoresMk, pPesimista: null, reglasAntiguas } };
  const subida = valoresMk.subida!, significativa = mk.p < ALFA_MK, sube = subida >= u.subidaMin;
  let estado: Estado = significativa && sube ? 'cumple' : 'falla', pPesimista: number | null = null, nota = '';
  // Huecos en el medio (los extremos ya están completos): un «cumple» debe sostenerse con los días que
  // faltan en su valor más desfavorable; esconder días bajos del final del medio no puede aprobar.
  if (estado === 'cumple' && sinDato.length) {
    pPesimista = mannKendallPesimista(puntos, sinDato, tolerancia, mk).p;
    if (pPesimista >= ALFA_MK) { estado = 'desconocido'; nota = `; con ${sinDato.length} día(s) sin dato (${rangos(sinDato)}) en su valor más desfavorable p = ${fmtP(pPesimista)} ≥ ${ALFA_MK}: no se sostiene`; }
    else nota = `; se sostiene con los ${sinDato.length} día(s) sin dato (${rangos(sinDato)}) en su valor más desfavorable (p = ${fmtP(pPesimista)})`;
  }
  const correccion = u.correccionMk === 'ninguna' ? '' : `, Var(S) ×${redondear(mk.factor, 2)} por autocorrelación (${u.correccionMk === 'hamed-rao' ? 'Hamed-Rao' : `Hamed-Rao ×${redondear(mk.factorHamedRao, 2)}, AR(1) r₁* = ${redondear(mk.r1, 2)} ×${redondear(mk.factorAr1, 2)}`})`;
  const motivo = `Mann-Kendall S = ${mk.S}, z = ${redondear(mk.z, 2)}, p = ${fmtP(mk.p)} ${significativa ? '<' : '≥'} ${ALFA_MK} (n = ${mk.n}${correccion}); Sen ${mk.pendienteSen!.toExponential(2)}/día × ${D - b} días = subida ${fmtNum(subida)} ${sube ? '≥' : '<'} ${u.subidaMin}${nota}${antiguas}`;
  return { estado, motivo, valores: { ...comun, ...valoresMk, pPesimista, reglasAntiguas } };
}

/** C8 sobre una serie (`campo`) de dia-NNN.json; ver la cabecera. */
function serieDiversidad({ dias, D, u }: Contexto, campo: string): ResultadoCriterio {
  return evaluarSerieDiversidad(dia => dias.get(dia)?.[campo], D, u);
}

/** Días sueltos a texto compacto: [5, 6, 7, 9] → «5-7, 9». */
function rangos(dias: readonly number[]): string {
  const partes: string[] = [];
  for (let i = 0; i < dias.length; i++) {
    let j = i;
    while (j + 1 < dias.length && dias[j + 1] === dias[j]! + 1) j++;
    partes.push(j > i ? `${dias[i]}-${dias[j]}` : `${dias[i]}`);
    i = j;
  }
  return partes.join(', ');
}

/** Series de C8 por orden de preferencia en modo auto (preregistro 2026-09-22; ver la cabecera). */
export const PRIORIDAD_DIVERSIDAD = ['diversidadConductaVentana', 'diversidadConductaActiva', 'diversidadConductaTiempo', 'diversidadConducta'] as const;

function diversidad(contexto: Contexto): ResultadoCriterio {
  const { dias, D, u } = contexto, b = u.diaBaseDiversidad;
  if (D <= b) return { estado: 'desconocido', motivo: `D = ${D} ≤ día base ${b}: no hay tramo que medir`, valores: {} };
  // «Trae la serie» = algún día del tramo tiene el campo (no null), sea o no un número válido: una serie
  // preferida con basura se elige y da «desconocido»; no se cae a otra que apruebe.
  const presente = (campo: string): boolean => { for (let dia = b; dia <= D; dia++) { const v = dias.get(dia)?.[campo]; if (v !== undefined && v !== null) return true; } return false; };
  // auto: la primera serie que el tramo trae algún día. Su cobertura la juzga serieDiversidad: una serie
  // preferida pero incompleta da «desconocido»; no se cae a otra que apruebe (eso sería elegir la medida).
  const campo = u.diversidadCampo === 'auto' ? PRIORIDAD_DIVERSIDAD.find(presente) ?? PRIORIDAD_DIVERSIDAD.at(-1)! : u.diversidadCampo;
  const principal = serieDiversidad(contexto, campo);
  // Las otras series se informan (secundarias, no deciden) solo si el tramo las trae algún día.
  const secundarias = PRIORIDAD_DIVERSIDAD.filter(otro => otro !== campo && presente(otro)).map(otro => ({ campo: otro, ...serieDiversidad(contexto, otro) }));
  return { estado: principal.estado,
    motivo: `${campo}: ${principal.motivo}${secundarias.map(s => ` · secundaria ${s.campo} (no decide): ${s.estado}, ${s.motivo}`).join('')}`,
    valores: { campo, ...principal.valores, secundarias: secundarias.map(s => ({ campo: s.campo, estado: s.estado, ...s.valores })) } };
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
  if (u.diversidadRegla !== 'mk') avisos.unshift(`C8 decidido con la regla v1 «${u.diversidadRegla}», NO la preregistrada (v2: Mann-Kendall + subida de Sen): con ruido estacionario 0,3 ± 0,1 aprueba el ${u.diversidadRegla === 'o' ? '54-58' : '41-43'} % de las series (scripts/lab/calibrar-c8.mts). Solo para reproducir informes antiguos.`);
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
  tecnologia: '--uso-ajeno-min --dias-uso-ajeno-min --usos-con-autor-min', diversidad: '--subida-min --correccion-mk --dia-base-diversidad --diversidad-campo --diversidad-regla (--pendiente-min: v1)',
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
  [--causas-conocidas starvation,dehydration,exposure,senescence] [--uso-ajeno-min 0.15] [--dias-uso-ajeno-min 0.5] [--usos-con-autor-min 20]
  [--dia-base-diversidad 5] [--subida-min 0.02] [--correccion-mk hamed-rao-ar1|hamed-rao|ninguna]
  [--diversidad-regla mk|o|y] [--pendiente-min 0] [--diversidad-campo auto|activa|tiempo|actividad]
  [--mayoria 0.5] [--estancada-horas 3]`;

/** `--diversidad-campo`: alias cortos y nombres de campo de dia-NNN.json. */
const CAMPOS_DIVERSIDAD: Record<string, CampoDiversidad> = {
  auto: 'auto', ventana: 'diversidadConductaVentana', diversidadConductaVentana: 'diversidadConductaVentana', activa: 'diversidadConductaActiva', diversidadConductaActiva: 'diversidadConductaActiva', tiempo: 'diversidadConductaTiempo', diversidadConductaTiempo: 'diversidadConductaTiempo',
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
    '--usos-con-autor-min': v => { u.usosConAutorMin = numero(v, '--usos-con-autor-min', noNegativo); },
    '--subida-min': v => { u.subidaMin = numero(v, '--subida-min'); },
    '--correccion-mk': v => { if (v !== 'hamed-rao-ar1' && v !== 'hamed-rao' && v !== 'ninguna') throw new Error(`--correccion-mk: hamed-rao-ar1, hamed-rao o ninguna, no «${v}».\n${USO}`); u.correccionMk = v; },
    '--diversidad-regla': v => { if (v !== 'mk' && v !== 'o' && v !== 'y') throw new Error(`--diversidad-regla: «mk» (preregistro v2), «o» o «y» (v1), no «${v}».\n${USO}`); u.diversidadRegla = v; },
    '--diversidad-campo': v => { const campo = Object.hasOwn(CAMPOS_DIVERSIDAD, v) ? CAMPOS_DIVERSIDAD[v] : undefined; if (!campo) throw new Error(`--diversidad-campo: auto, activa, tiempo o actividad, no «${v}».\n${USO}`); u.diversidadCampo = campo; },
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
