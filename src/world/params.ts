/**
 * Parámetros configurables del mundo (T001, fase 0). Las claves y sus valores por
 * defecto fijan el comportamiento ACTUAL del simulador: introducir este módulo no
 * cambia ninguna dinámica. Los 13 workstreams paralelos importan estas claves; nadie
 * más que T001 edita este fichero. Los params viven en un WeakMap por mundo (no se
 * añaden campos a `World`, así se evita migrar snapshots guardados).
 *
 * Reglas 10, etapa 1 (2026-09-22): por primera vez un default CAMBIA la dinámica. Los mundos nuevos
 * nacen con `DEFAULT_PARAMS` (paquete de natalidad adoptado, `RULES_10_ADOPTED`); los mundos
 * anteriores conservan su conducta porque sus claves ausentes se completan con `HISTORICAL_PARAMS`.
 * Reglas 11 (2026-09-23): los mundos nuevos adoptan además el paquete B de conflicto legible;
 * `agua.memoria` permanece en 1. Los params históricos de instantáneas no cambian.
 */

import { DEMOGRAPHY_TICKS_PER_DAY, longevityAges, type LongevityLaw } from '../shared/demography.js';
import { splitParamList } from '../shared/param-syntax.js';
import { INTERRUPTORES, INTERRUPTORES_APAGADOS, exigirCoherentes, type Interruptor, type InterruptoresV23 } from '../shared/interruptores.js';

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
  /**
   * `edadFundadoresMinDias`/`edadFundadoresMaxDias` (hipótesis cohorte, 2026-09-22) son una CONDICIÓN
   * INICIAL, no una ley: la edad con que arranca cada fundador mortal (vecinos; S e I no cambian) se
   * reparte de forma determinista en `[min, max]` días con `localRandom(seed, 'edad-fundador:'+id)`,
   * acotada por debajo del inicio de su propia vejez. Default 2 y 2 = los 4800 ticks de siempre.
   */
  genes: { varianzaFundadores: number; tasaMutacion: number; edadFundadoresMinDias: number; edadFundadoresMaxDias: number };
  /**
   * `exigeComunidad`, `radioPareja`, `radioLugar` y `comprobacionContinua` son leyes
   * del embudo de natalidad (diagnóstico 2026-09-22, `scripts/lab/diagnostico-natalidad.ts`):
   * con sus valores HISTÓRICOS (`true`, 3, 4, `false`) `reproduce()` es la de antes de reglas 10; reglas
   * 10 adopta `exigeComunidad=false` y `comprobacionContinua=true` para mundos nuevos. Ninguna levanta el techo de nacimientos:
   * el calendario máximo sigue siendo `nacimientosPorComprobacion` por ventana de
   * `intervaloComprobacionTicks` pasos.
   * V23 (`v23.natalidad`, `world/natalidad.ts`): con la ley encendida, `radioPareja` es el alcance de la concepción y
   * `radioCortejo` el del cortejo; `cortejo`, `exigeComunidad`, `radioLugar`, `nacimientosPorComprobacion`,
   * `intervaloComprobacionTicks`, `natalidadVecindad` y `maxima` no actúan.
   */
  poblacion: { maxima: number; intervaloComprobacionTicks: number; nacimientosPorComprobacion: number;
    exigeComunidad: boolean; radioPareja: number; radioLugar: number; comprobacionContinua: boolean;
    /** Cortejo (2026-09-22): peso con que una persona fértil busca a otra fértil, no emparentada y con
     * vínculo mutuo ≥ 0,3 que está fuera de `radioPareja` pero dentro de `radioCortejo`. Histórico 0 / 24
     * (apagado); reglas 10 adopta 2 / 128 para mundos nuevos. */
    cortejo: number; radioCortejo: number;
    /** V12/D2: natalidad estrictamente local por vecindad (`radioVecindadNatalidad`), sin cupo global
     * planetario de 40 nacimientos/día; con `false` (histórico/V11) conserva el cupo global anterior. */
    natalidadVecindad: boolean; radioVecindadNatalidad: number };
  recursos: { capacidadBosque: number; capacidadPastizal: number; capacidadOtros: number; velocidadRegeneracion: number; decaimientoFertilidad: number; decaimientoComida: number };
  persistencia: { cadaTicks: number; ventanaEventosTicks: number; paginasSucias: boolean };
  /** Agua superficial concentrada en cuencas: 1 = generación actual (todas las charcas/manantiales); < 1 conserva solo las de las cuencas más húmedas (T035).
   * `memoria` (2026-09-22, ley candidata SED): quien no percibe agua vuelve hacia la última celda con agua que vio
   * (o donde bebió) cuando la sed prevista AL LLEGAR —sed actual − agua que lleva + sed del camino— supera este
   * umbral, en vez de explorar al azar; el recuerdo se olvida al verlo seco. 1 = nunca (hoy: ni recuerda ni vuelve). */
  agua: { cuencas: number; memoria: number };
  /** T102: configuración reservada; todavía no selecciona otro backend. T148: `depuracion` activa las
   * comprobaciones de la tabla de organismos (`soa/organismos.ts`: qué hilo escribió cada fila y el sello del frente
   * publicado). Es diagnóstico: no cambia la dinámica y no entra en el digesto canónico. `particionarPersonas` no tiene
   * efecto desde V23 (el motor de personas por particiones se retiró): se conserva porque está en el digesto canónico
   * de los mundos guardados y de los digestos dorados, con su valor (true en los mundos abiertos). */
  motor: { clonPorPaso: boolean; hilos: number; soaTerreno: boolean; particionarPersonas: boolean; gpu: number[]; orden: 'natural' | 'inverso' | 'adversarial'; depuracion: boolean };
  red: { deltas: boolean };
  /** T100: admisión de colecciones; no son una política silenciosa de natalidad. */
  limites: { teselasActivas: number; chunks: number; comunidades: number; fauna: number; aplicacion: 'historicos' | 'parametros' };
  /**
   * Leyes candidatas (noche de ciencia, 2026-09-22). `docs/ANALISIS-DINAMICAS-2026-09-21.md`
   * mide tres cierres: la elección refuerza al ganador y se traba en cooperar, las disputas
   * por recursos nunca se disparan y la pertenencia a una comunidad no vuelve a revisarse.
   * Estas claves abren esos tres cerrojos SIN decidir nada: con sus valores HISTÓRICOS el mundo es
   * el de antes paso a paso. Reglas 10 adopta `habituacion=0,35` para mundos nuevos; las demás
   * siguen con su valor histórico como default.
   */
  conducta: { habituacion: number;
    /** Ventaja comparativa heredable (DIV, 2026-09-22), `index.ts` → `choose`: sin urgencias
     * corporales (sed, hambre y cansancio ≤ 0,5), cada OFICIO suma `aptitud · (rasgo del oficio −
     * media de los cinco rasgos de la persona)`. 0 = hoy. */
    aptitud: number;
    /** V12: peso de la política neuronal local evolutiva + plasticidad vitalicia (`src/world/politica.ts`).
     * 0 = apagada (conducta V11 exacta); > 0 suma `politicaPeso · softSign(z + bias)` fuera de emergencias. */
    politicaPeso: number;
    /** V16: autonomía de la política neuronal frente a las heurísticas fijas fuera de emergencias corporales.
     * 0 = heurísticas intactas (V12/V15); (0, 1] atenúa los sesgos fijos no urgentes para que la red
     * 12→8→12 y su plasticidad de Baldwin conduzcan de verdad la estrategia del habitante. */
    politicaAutonomia: number;
    /** V19/L: aprendizaje causal contextual. `false` = V18 exacto (recompensa de descanso periódica, sesgo de acción
     * independiente del estado). `true`: sin recompensa recurrente de `rest`, error de predicción acotado con línea
     * base contextual y elegibilidad que decae por ticks transcurridos, y la contribución neuronal de `rest` escalada
     * por la demanda corporal de recuperación. */
    aprendizajeCausal: boolean;
    /** V19/L: constante de tiempo (ticks, entero positivo) de la memoria local de resultados; inactiva con L apagada. */
    memoriaResultadoTicks: number };
  /** `social.maxComunidades`: tope de FUNDACIÓN de comunidades (`society.ts`), regla de conducta separada
   * de la admisión `limites.comunidades` (revisión de T100, 2026-09-22). */
  social: { maxComunidades: number; disputaNecesidad: number; disputaEscasez: number; disputaRadio: number; disputaDestino: number; disputaEspera: number;
    ensenanzaRareza: number; confianzaSalida: number; distanciaAlternativa: number;
    /** Convivencia (hipótesis cohorte, 2026-09-22): vínculo mutuo que ganan por paso dos personas a
     * ≤ 2 celdas, `vinculoConvivencia · sociabilidad media`, sin superar `TECHO_CONVIVENCIA`. 0 = hoy. */
    vinculoConvivencia: number;
    /** Comunidades vivas (hipótesis COM, 2026-09-22): radio, en celdas alrededor del centro de su comunidad,
     * dentro del cual un miembro convive con ella. Con > 0 la pertenencia se revisa por convivencia y confianza
     * (se une a la comunidad de la mayoría de sus vecinos de confianza; un núcleo que vive a más de este radio
     * del centro funda la suya). 0 = hoy (la pertenencia sólo cambia por `confianzaSalida`). */
    radioConvivencia: number;
    /** Conflicto legible (hipótesis CONFL, 2026-09-22), `society.ts` → `resourceDispute` e `index.ts` → `choose`.
     * Con > 0, en una disputa (o un turno) cede quien MENOS lo necesita —máximo de hambre y sed; empate, el de id
     * mayor— y no queda inmóvil treinta pasos: vuelve a elegir al paso siguiente. Quien cede recuerda un día la
     * fuente disputada (la celda y las que la disputa llama «el mismo destino»), que al elegir dónde comer, beber
     * o cazar le parece `memoriaDisputa` celdas más lejos: prefiere otra que perciba, y si no hay otra vuelve.
     * 0 = conducta histórica (cede quien llega a la comprobación, espera treinta pasos inmóvil y no
     * recuerda nada); reglas 11 adopta 8 para mundos nuevos. */
    memoriaDisputa: number;
    /** Hogar por rendimiento marginal (H-B, 2026-09-23): reduce la provisión percibida de cada
     * lugar según la madera, piedra y fauna a ≤ 4 celdas. 0 conserva la elección histórica;
     * 1 aplica toda la reducción cuando ya no quedan insumos locales. */
    hogarTrabajo: number;
    /**
     * COM-D′ (crítica de COM-D, 2026-09-28), sólo actúa con `radioConvivencia > 0`. 0 (default) = hoy,
     * bit a bit igual incluso con `radioConvivencia > 0`. Con 1:
     * · R0: S e I nunca cuentan para fundar, fisionar ni disolver (sólo mortales, `role === 'neighbor'`);
     *   siguen la regla de mayoría como cualquiera.
     * · R1: una fisión exige ≥ 3 mortales en el grupo NUEVO y que el de ORIGEN conserve ≥ 3 mortales
     *   (antes sólo pedía que el origen conservara a alguien, `society.ts:398`, lo que fabricaba restos).
     * · R2: histéresis sin estado — fundar exige 3 mortales, disolver ocurre con ≤ 1; con 2 no pasa nada,
     *   así que evita el bucle fundar↔disolver↔refundar de la crítica.
     * · R3: los miembros de una comunidad disuelta (mortales, S e I por igual) se unen a la mayoría de sus
     *   vecinos de confianza ENTRE LAS COMUNIDADES QUE NO SE DISUELVEN esta misma revisión, o quedan sin
     *   comunidad.
     * · R4: orden fisión → mayoría → disolución → reagrupar → fundación; una comunidad no se disuelve en
     *   la revisión en que nace (`formedAt === tick`).
     */
    disolucion: number;
    /** V16: deriva cultural bidireccional (`sharing`, `stewardship`, `openness`) ligada a escasez,
     * intercambio exogrupal, disputas y variación vertical. 0 = conducta histórica (monotónica); > 0 activa. */
    derivaCultural: number;
    /** V16: vínculo y memoria local de reencuentro de S e I + rescate del bloqueo de subsistencia con
     * energía cero ante alimento/agua adyacentes. 0 = conducta histórica; > 0 activa. */
    vinculoEncuentro: number;
    /** V19/S: acuerdos materiales. `false` = V18 exacto (el turno por confianza/apertura se firma sin comprobar el
     * stock y premia +0,018 de apertura al firmar). `true`: el turno se evalúa con el stock localmente factible y la
     * urgencia; el acuerdo no da recursos ni apertura al firmarse, sólo su cumplimiento (o incumplimiento) observado
     * actualiza confianza y apertura con `o ← o + α(y − o)`. */
    acuerdosMateriales: boolean;
    /** V19/S: memoria finita (días, entero positivo) de los resultados de acuerdos observados personalmente. */
    memoriaResultadosDias: number };
  /**
   * V19/F+R+M: reparaciones biológicas independientes de la fauna depredadora. Todas `false` = V18 exacto.
   * · `contactoContinuo` (F): la preparación del ataque decae poco a poco al separarse y el alcance resuelve el
   *   contacto cruzado/adyacente (≤ 1 celda) con esfuerzo pagado.
   * · `reservaReproductiva` (R): una fracción de la comida realmente adquirida se debita a `reproReserve` (no baja el
   *   hambre) y financia la biomasa de la cría (0,03 de cada progenitor) en lugar de la biomasa vegetal de la celda.
   * · `encuentroFertil` (M): un animal reproductivamente listo se acerca, con movimiento pagado, a una pareja
   *   compatible percibida localmente.
   */
  fauna: { contactoContinuo: boolean; reservaReproductiva: boolean; fraccionReservaCria: number; encuentroFertil: boolean };
  /** V19/B: obras modulares por módulos físicos y sitios compartidos; V20: poliominós contiguos y sinergia local. */
  construccion: { modular: boolean; poliminosYSinergia: boolean };
  /** V20: caminos físicos estigmérgicos (`traffic` reduce esfuerzo/carga, desempate local, empedrado con piedra). */
  terreno: { caminosFisicos: boolean };
  /** V20: química algebraica conservada de 6 elementos (`C/Si/Ca/Fe/S/H`) + operadores físicos `grind/wash/heat/bind`. */
  quimica: { emergente: boolean };
  /** V19/E: estacionalidad hidrológica regional (Fase 2). `amplitudEstacional` 0 = V18 exacto. */
  ecologia: { amplitudEstacional: number; periodoEstacionalDias: number; escalaClimaticaCeldas: number };
  /**
   * Leyes locales de estabilidad tecnológica (Fase B, `docs/PLAN-ESTABILIDAD-2026-11-18.md`,
   * `docs/preregistros/2026-11-18-estabilidad-tecnologia.md`). Constitución II: nacen en sus valores
   * históricos tanto en `HISTORICAL_PARAMS` como en `DEFAULT_PARAMS` hasta evaluar el panel de 8×60 días.
   * · `dosisCuanto`: cuantización entera de dosis propuestas de `residue` y `product` en `localInputs`
   *   (0 = sin cuantizar, histórico; candidato 250).
   * · `mejoraLocal`: puerta local de novedad o mejora/dominancia Pareto por trabajo en `finishProject`;
   *   conserva intacto el redescubrimiento pagado de firmas existentes (0 = registra todo, histórico;
   *   candidato 0,05).
   * · `enfriamiento`: ticks mínimos entre intentos autónomos en `technologyOpportunity` (45 = histórico;
   *   candidato 300). Con `mejoraLocal > 0 || enfriamiento > 45` no salta `craft` por `attempts % 3 !== 0`
   *   y atenúa `research` con inventario lleno de herramientas útiles.
   * · `evitarNoOp`: evita emitir pasos localmente no-op obvios en `proposeTechnologyProgram` (`false` =
   *   histórico; candidato `true`).
   */
  tecnologia: {
    dosisCuanto: number;
    mejoraLocal: number;
    enfriamiento: number;
    evitarNoOp: boolean;
    /** V16: efectos físicos cualitativos de todas las capacidades (`insulation`, `binding`, `cutting` en caza/obra,
     * `abrasion` en obra/reparación) con desgaste material real (`useTool`). `false` = histórico. */
    efectosHerramientas: boolean;
    /** V19/T: instalaciones derivadas de las propiedades materiales de los productos (Fase 2). `false` = V18 exacto. */
    obrasPorPropiedades: boolean;
  };
  /** V23: interruptores de las leyes y piezas nuevas, declarados en `shared/interruptores.ts` (apagados por defecto).
   * Nadie añade claves aquí: se piden al integrador. Las leyes los leen con `ley(world, 'materia')`. */
  v23: InterruptoresV23;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Params HISTÓRICOS: los que reproducen la conducta del mundo ANTES de reglas 10, etapa 1. Es el
 * literal de abajo tal cual; `DEFAULT_PARAMS` (mundos NUEVOS) se deriva de él aplicando
 * `RULES_10_ADOPTED` y después `RULES_11_ADOPTED`.
 */
const RAW_HISTORICAL: WorldParams = {
  cuerpo: {
    longevidadBaseDias: 11, longevidadPorResiliencia: 4, longevidadPorActividad: 1, senescenciaInicioFraccion: 0.75,
    riesgoSenescenciaDiario: 0.04, riesgoSenescenciaPendiente: 10, cuidadoReduceRiesgo: 0.6,
  },
  genes: { varianzaFundadores: 0.15, tasaMutacion: 1, edadFundadoresMinDias: 2, edadFundadoresMaxDias: 2 },
  // Ruling R17: `maxima` coincide por defecto con la cota anticorrupción. El laboratorio
  // puede fijar un valor menor para acotar un experimento.
  poblacion: { maxima: 1_000_000, intervaloComprobacionTicks: 120, nacimientosPorComprobacion: 2,
    exigeComunidad: true, radioPareja: 3, radioLugar: 4, comprobacionContinua: false, cortejo: 0, radioCortejo: 24,
    natalidadVecindad: false, radioVecindadNatalidad: 16 },
  recursos: { capacidadBosque: 1, capacidadPastizal: 0.7, capacidadOtros: 0.35, velocidadRegeneracion: 1, decaimientoFertilidad: 0.001, decaimientoComida: 0.0001 },
  persistencia: { cadaTicks: 1, ventanaEventosTicks: 0, paginasSucias: false },
  agua: { cuencas: 0.4, memoria: 1 },
  motor: { clonPorPaso: true, hilos: 1, soaTerreno: false, particionarPersonas: false, gpu: [], orden: 'natural', depuracion: false },
  red: { deltas: false },
  limites: { teselasActivas: 65536, chunks: 256, comunidades: 8, fauna: 393216, aplicacion: 'parametros' },
  // Leyes candidatas: cada default es la constante que hoy está escrita en el código
  // (`index.ts` no descuenta saciedad; `society.ts` usa 0,65 / ×1 / 2 celdas / 0,5 de
  // destino / 180 ticks de espera / sin rareza / 0,35 de confianza / 0,2 de distancia
  // cultural), así que abrirlas no cambia el mundo.
  conducta: { habituacion: 0, aptitud: 0, politicaPeso: 0, politicaAutonomia: 0, aprendizajeCausal: false, memoriaResultadoTicks: 2400 },
  social: { maxComunidades: 8, disputaNecesidad: 0.65, disputaEscasez: 1, disputaRadio: 2, disputaDestino: 0.5, disputaEspera: 180,
    ensenanzaRareza: 0, confianzaSalida: 0.35, distanciaAlternativa: 0.2, vinculoConvivencia: 0, radioConvivencia: 0, memoriaDisputa: 0, hogarTrabajo: 0, disolucion: 0, derivaCultural: 0, vinculoEncuentro: 0, acuerdosMateriales: false, memoriaResultadosDias: 10 },
  fauna: { contactoContinuo: false, reservaReproductiva: false, fraccionReservaCria: 0.15, encuentroFertil: false },
  construccion: { modular: false, poliminosYSinergia: false },
  terreno: { caminosFisicos: false },
  quimica: { emergente: false },
  ecologia: { amplitudEstacional: 0, periodoEstacionalDias: 20, escalaClimaticaCeldas: 64 },
  tecnologia: { dosisCuanto: 0, mejoraLocal: 0, enfriamiento: 45, evitarNoOp: false, efectosHerramientas: false, obrasPorPropiedades: false },
  v23: { ...INTERRUPTORES_APAGADOS },
};

/**
 * Reglas 10, etapa 1 (2026-09-22): el paquete de natalidad medido la noche del 2026-09-22
 * (`docs/REGLAS.md` § «Reglas 10», `docs/ops/noche-20260922-bitacora.md`) pasa a ser el default
 * de los mundos NUEVOS. Con él, al día 10 el 93 % de 15 semillas sostiene ≥ 16 habitantes
 * (mediana 63), frente al 82 % (mediana 21) con los params históricos. `agua.memoria` quedó
 * refutada fuera de muestra y NO se adopta (sigue en 1 = apagada).
 */
export const RULES_10_ADOPTED = deepFreeze({
  poblacion: { cortejo: 2, radioCortejo: 128, exigeComunidad: false, comprobacionContinua: true },
  conducta: { habituacion: 0.35 },
} as const);

/**
 * Reglas 11 (2026-09-23): el paquete B de conflicto legible pasa a ser el default de mundos
 * NUEVOS. En el laboratorio, C1–C7 se cumplió en 8/12 semillas a 60 días frente a 4/10 con
 * reglas 10 (`docs/preregistros/2026-09-23-vocacion-banda.md` y
 * `docs/ops/noche-20260922-bitacora.md`). `agua.memoria` sigue en 1, como en B.
 */
export const RULES_11_ADOPTED = deepFreeze({
  social: { disputaNecesidad: 0.45, disputaEscasez: 3, disputaRadio: 3, memoriaDisputa: 8 },
} as const);

const RAW_DEFAULTS: WorldParams = structuredClone(RAW_HISTORICAL);
Object.assign(RAW_DEFAULTS.poblacion, RULES_10_ADOPTED.poblacion);
Object.assign(RAW_DEFAULTS.conducta, RULES_10_ADOPTED.conducta);
Object.assign(RAW_DEFAULTS.social, RULES_11_ADOPTED.social);

/**
 * Defaults de un mundo NUEVO (`createWorld` sin params, `parseParams` sin base, laboratorio sin
 * `--params`, servidor que genera un mundo). Objeto congelado en profundidad: nunca se muta;
 * `parseParams` clona para cada override.
 */
export const DEFAULT_PARAMS: WorldParams = deepFreeze(RAW_DEFAULTS);

/**
 * Params HISTÓRICOS (reglas 10 y 11): la BASE con que se completan las claves AUSENTES de una
 * instantánea (`readSnapshotParams` en `src/server/snapshot.ts`). Un mundo anterior —reglas < 11, o
 * cualquiera cuyos params persistidos no nombren una clave— nunca recibe un default nuevo: recibe el
 * valor que reproduce su conducta de siempre. Difiere de `DEFAULT_PARAMS` sólo en las leyes adoptadas:
 * `poblacion.cortejo` 0, `poblacion.radioCortejo` 24, `poblacion.exigeComunidad` true,
 * `poblacion.comprobacionContinua` false y `conducta.habituacion` 0; además las cuatro de
 * `RULES_11_ADOPTED` conservan aquí 0,65/1/2/0. Las demás claves añadidas la
 * noche del 2026-09-22 mantienen su valor histórico:
 * `genes.edadFundadoresMin/MaxDias` 2/2, `poblacion.radioPareja` 3, `poblacion.radioLugar` 4,
 * `agua.memoria` 1, `conducta.aptitud` 0, `social.*`
 * (disputas 0,65/×1/2/0,5/180, rareza 0, confianza
 * 0,35, distancia 0,2, `maxComunidades` 8, `vinculoConvivencia` 0, `radioConvivencia` 0, `hogarTrabajo` 0,
 * `disolucion` 0 (COM-D′, 2026-09-28)).
 * La poda de leyes refutadas (ola 1, 2026-09-27) retiró `poblacion.natalidadLocal`,
 * `poblacion.radioProvision`, `conducta.vocacion` y `conducta.vocacionTope`: una instantánea
 * antigua que las nombre con valores inertes se carga soltándolas (`snapshot.ts`); con otros
 * valores usó la ley de verdad y se rechaza (`Invalid snapshot parameters`).
 *
 * `limites.aplicacion` coincide con el default: el modo histórico de admisión lo declara
 * aparte `readSnapshotParams` para las instantáneas sin perfil de límites.
 */
export const HISTORICAL_PARAMS: WorldParams = deepFreeze(RAW_HISTORICAL);
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

export const OPEN_WORLD_MAX_BLUEPRINTS = 4096;

/** Modo abierto V15 (`CARTA_OPEN_WORLD=1`): sin topes ficticios de estructuras, planos, lugares ni
 * ventanas rotatorias de fauna; manda el límite de admisión derivado del hardware (`limitsOf`). */
export function openWorldCaps(world: object): boolean {
  const params = paramsOf(world);
  return params.poblacion.natalidadVecindad && params.social.maxComunidades === 0 && params.limites.aplicacion === 'parametros';
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
  // Condición inicial de la cohorte fundadora (días). El mínimo 0,5 deja a todo fundador fuera de la
  // ventana de nacimientos recientes de `comprobacionContinua` con el intervalo por defecto (120
  // ticks); el máximo 30 es la cota anticorrupción de `bornAt` en `assertWorld`. min ≤ max lo
  // comprueba `assertFounderAges`, porque un rango por clave no puede verlo.
  'genes.edadFundadoresMinDias': [0.5, 30],
  'genes.edadFundadoresMaxDias': [0.5, 30],
  'poblacion.maxima': [1, 1_000_000],
  'poblacion.intervaloComprobacionTicks': [1, 10000],
  'poblacion.nacimientosPorComprobacion': [0, 20],
  // Embudo de natalidad: el radio de pareja entra además en `pairAffinity` (family.ts),
  // así que mover uno mueve también cómo se ordenan las parejas candidatas.
  'poblacion.radioPareja': [1, 32],
  'poblacion.radioLugar': [1, 64],
  'poblacion.cortejo': [0, 5],
  'poblacion.radioCortejo': [1, 128],
  'poblacion.radioVecindadNatalidad': [4, 64],
  'recursos.capacidadBosque': [0, 10],
  'recursos.capacidadPastizal': [0, 10],
  'recursos.capacidadOtros': [0, 10],
  'recursos.velocidadRegeneracion': [0, 10],
  'recursos.decaimientoFertilidad': [0, 1],
  'recursos.decaimientoComida': [0, 1],
  'persistencia.cadaTicks': [1, 10000],
  'persistencia.ventanaEventosTicks': [0, 1_000_000],
  'agua.cuencas': [0.05, 1],
  // Umbral de sed prevista al llegar; 1 apaga la ley (el bloque entero se salta con 1, no sólo el disparo).
  'agua.memoria': [0, 1],
  'motor.hilos': [1, 512],
  'limites.teselasActivas': [1, Number.MAX_SAFE_INTEGER],
  'limites.chunks': [1, Number.MAX_SAFE_INTEGER],
  'limites.comunidades': [1, Number.MAX_SAFE_INTEGER],
  'limites.fauna': [1, Number.MAX_SAFE_INTEGER],
  'social.maxComunidades': [0, Number.MAX_SAFE_INTEGER],
  // Leyes candidatas. El mínimo de `disputaNecesidad` y `disputaEscasez` no es 0 a
  // propósito: con 0 la disputa dejaría de exigir necesidad o escasez y sería un
  // conflicto decretado, no medido. `disputaRadio` parte de 1 celda (contacto real).
  'conducta.habituacion': [0, 2],
  // Ventaja comparativa: sumando de la puntuación de un OFICIO (nunca de comer, beber, descansar
  // ni de los actos de vínculo). Rasgo menos media de los cinco cae en [−0,8, 0,8], así que con
  // el máximo 2 la ley mueve un oficio a lo sumo ±1,6, la escala de `habituacion`.
  'conducta.aptitud': [0, 2],
  'conducta.politicaPeso': [0, 2],
  'conducta.politicaAutonomia': [0, 1],
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
  // Ganancia de vínculo por paso compartido a ≤ 2 celdas. Con 0,01 dos personas de sociabilidad
  // media pasan de 0,2 a 0,3 en ~20 pasos: el tope del rango ya es «casi instantáneo».
  'social.vinculoConvivencia': [0, 0.01],
  // 0 apaga la ley (conducta de hoy); en celdas, como el radio de contacto (6) de `updateCommunities`.
  'social.radioConvivencia': [0, 64],
  // Penalización, en celdas, de la fuente donde se cedió una disputa. La percepción llega a 7 celdas:
  // con ≥ 8 cualquier otra fuente percibida va antes; el máximo 32 es «nunca, si hay otra». 0 apaga la ley.
  'social.memoriaDisputa': [0, 32],
  // 0 conserva la provisión histórica; 1 deja que la falta de trabajo local la reduzca por completo.
  'social.hogarTrabajo': [0, 1],
  // COM-D′: 0 (default) = hoy; 1 activa R0–R4 (sólo con `radioConvivencia > 0`). Entero: es un
  // interruptor, no una magnitud continua.
  'social.disolucion': [0, 1],
  'social.derivaCultural': [0, 2],
  'social.vinculoEncuentro': [0, 2],
  // Fase B — estabilidad tecnológica (`docs/preregistros/2026-11-18-estabilidad-tecnologia.md`):
  // nacen con sus valores históricos (0, 0, 45, false) en HISTORICAL_PARAMS y DEFAULT_PARAMS.
  'tecnologia.dosisCuanto': [0, 1000],
  'tecnologia.mejoraLocal': [0, 1],
  'tecnologia.enfriamiento': [1, 2400],
  // V19 (`docs/DISENO-V19.md`): valores históricos/neutros por defecto; los candidatos abiertos los fija el anfitrión.
  'conducta.memoriaResultadoTicks': [1, 1_000_000],
  'social.memoriaResultadosDias': [1, 365],
  'fauna.fraccionReservaCria': [0, 1],
  'ecologia.amplitudEstacional': [0, 1],
  'ecologia.periodoEstacionalDias': [1, 365],
  'ecologia.escalaClimaticaCeldas': [1, 4096],
  'v23.cadenciaMateria': [1, 2400],
};
const INTEGER_V19_KEYS: readonly string[] = ['v23.cadenciaMateria', 'conducta.memoriaResultadoTicks', 'social.memoriaResultadosDias',
  'ecologia.periodoEstacionalDias', 'ecologia.escalaClimaticaCeldas'];

type ScalarDescriptor = { kind: 'number'; range: readonly [number, number]; integer?: boolean }
  | { kind: 'boolean' } | { kind: 'enum'; values: readonly string[] };
export type ParamDescriptor = ScalarDescriptor | { kind: 'array'; element: ScalarDescriptor; minLength: number; unique: boolean };
type ParamValue = number | boolean | string | (number | boolean | string)[];

/** PARAM_RANGES conserva sus tuplas numéricas; cada hoja declara además su tipo. */
export const PARAM_DESCRIPTORS: Readonly<Record<string, ParamDescriptor>> = deepFreeze({
  ...Object.fromEntries(Object.entries(PARAM_RANGES).map(([key, range]) => [key,
    { kind: 'number', range, integer: key === 'motor.hilos' || key === 'poblacion.radioVecindadNatalidad' || key === 'social.disputaEspera' || key === 'social.maxComunidades' || key === 'social.disolucion' || key === 'tecnologia.dosisCuanto' || key === 'tecnologia.enfriamiento' || INTEGER_V19_KEYS.includes(key) || key.startsWith('limites.') }])),
  'poblacion.exigeComunidad': { kind: 'boolean' },
  'poblacion.comprobacionContinua': { kind: 'boolean' },
  'poblacion.natalidadVecindad': { kind: 'boolean' },
  'motor.clonPorPaso': { kind: 'boolean' },
  'motor.soaTerreno': { kind: 'boolean' },
  'motor.particionarPersonas': { kind: 'boolean' },
  'motor.depuracion': { kind: 'boolean' },
  'motor.gpu': { kind: 'array', element: { kind: 'number', range: [0, Number.MAX_SAFE_INTEGER], integer: true }, minLength: 0, unique: true },
  'motor.orden': { kind: 'enum', values: ['natural', 'inverso', 'adversarial'] },
  'limites.aplicacion': { kind: 'enum', values: ['historicos', 'parametros'] },
  'persistencia.paginasSucias': { kind: 'boolean' },
  'red.deltas': { kind: 'boolean' },
  'tecnologia.evitarNoOp': { kind: 'boolean' },
  'tecnologia.efectosHerramientas': { kind: 'boolean' },
  'tecnologia.obrasPorPropiedades': { kind: 'boolean' },
  'conducta.aprendizajeCausal': { kind: 'boolean' },
  'social.acuerdosMateriales': { kind: 'boolean' },
  'fauna.contactoContinuo': { kind: 'boolean' },
  'fauna.reservaReproductiva': { kind: 'boolean' },
  'fauna.encuentroFertil': { kind: 'boolean' },
  'construccion.modular': { kind: 'boolean' },
  'construccion.poliminosYSinergia': { kind: 'boolean' },
  'terreno.caminosFisicos': { kind: 'boolean' },
  'quimica.emergente': { kind: 'boolean' },
  ...Object.fromEntries(INTERRUPTORES.map(k => [`v23.${k}`, { kind: 'boolean' }])),
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
    throw new Error(`Valor inválido para "${key}": valores permitidos ${descriptor.values.join(', ')}.`);
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

/** Edad máxima, en ticks, que puede tener un fundador al crear el mundo: cota anticorrupción de
 * `bornAt` en `assertWorld` (antes el literal −4800 de los 2 días fijos). */
export const MAX_FOUNDER_AGE_TICKS = PARAM_RANGES['genes.edadFundadoresMaxDias']![1] * DEMOGRAPHY_TICKS_PER_DAY;

/** Cruce de claves de la cohorte fundadora: el mínimo no puede superar al máximo. */
export function assertFounderAges(genes: Readonly<WorldParams['genes']>): void {
  if (!(genes.edadFundadoresMinDias <= genes.edadFundadoresMaxDias)) {
    throw new Error(`Edad de fundadores imposible: genes.edadFundadoresMinDias=${genes.edadFundadoresMinDias} supera a `
      + `genes.edadFundadoresMaxDias=${genes.edadFundadoresMaxDias}.`);
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
  assertFounderAges(params.genes);
  exigirCoherentes(params.v23);
  return deepFreeze(params);
}

const worldParams = new WeakMap<object, WorldParams>();

/** Params efectivos de un mundo, o `DEFAULT_PARAMS` (misma identidad) si nunca se fijaron. */
export function paramsOf(world: object): WorldParams {
  return worldParams.get(world) ?? DEFAULT_PARAMS;
}

/** V23: ¿está encendida en este mundo la ley o pieza `k`? (`shared/interruptores.ts`). */
export function ley(world: object, k: Interruptor): boolean {
  return (worldParams.get(world) ?? DEFAULT_PARAMS).v23[k];
}

/** Params fijados explícitamente en `world` (`setParams`), o `undefined` si no está en el WeakMap. */
export function boundParamsOf(world: object): WorldParams | undefined {
  return worldParams.get(world);
}

/** Fija los params de un mundo (o clon). Lo llaman `createWorld`/`cloneWorld` en `index.ts` y
 * `main.ts`, que aplica CARTA_PARAMS sobre un mundo ya creado: por eso la ley se valida también
 * aquí y no sólo en `parseParams`. */
export function setParams(world: object, params: WorldParams): void {
  assertLongevityLaw(params.cuerpo);
  assertWorldLimits(params.limites, true);
  worldParams.set(world, params);
}
