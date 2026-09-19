/**
 * scripts/lab/resumen.ts — T018. Agrega un directorio de barrido (T017: `scripts/lab/barrido.ts`,
 * que encola réplicas de T016: `scripts/lab/replica.ts`) en `resumen.json` + `resumen.md`.
 *
 * CONTRATO DE ENTRADA ASUMIDO — T016/T017 no estaban implementados en este worktree al escribir
 * T018 (tareas [P] en paralelo); si sus nombres de campo difieren en la integración, el único
 * ajuste necesario es `leerReplica`/`leerDia` más abajo. Documentado también en el informe T018.
 *   - Cada réplica vive en un subdirectorio (a cualquier profundidad) de `--entrada` que contiene
 *     un fichero `replica.json`: `{ seed, params, sha, digest, dias, resumen?, abortada? }`
 *     (`digest` = sha256 de los ficheros de `src/world`, ya calculado por `replica.ts`).
 *   - Ese mismo subdirectorio contiene `dia-NNN.json`, uno por día simulado 0..dias-1:
 *     `{ tick, poblacion, nacimientos, muertes: Record<causa, n>, fundadoresVivos,
 *        generacionesVivas, diversidadOficios, recetasDistintasEnUso, cooperaciones,
 *        gini, fraccionComida, distanciaAgua, p50Ms, p95Ms, rss }`; `gini`/`fraccionComida`/
 *        `distanciaAgua` son `null` si T013 (`worldStatistics`) todavía no existía al correr.
 *   - `--control <dir>`: mismo formato que `--entrada`; si se omite, el grupo cuyos `params`
 *     sean `{}` (si lo hay) actúa de control.
 *
 * Semáforo: solo las 4 métricas con umbral explícito en SC-002..005 de `spec.md` llevan
 * 🟢🟡🔴 (verde = cumple el umbral; rojo = por debajo de la mitad del umbral o incumplimiento
 * duro tipo SC-005; ámbar = zona intermedia — banda no fijada en `spec.md`, es una interpolación
 * documentada aquí, no una cifra oficial). El resto de métricas (población, p95 ms, muertes por
 * causa) se reporta y se compara con el control, pero sin semáforo.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// Causas de muerte reconocidas hoy por `src/shared/demography.ts` (`DemographicDeathCause`, no
// exportado como valor en tiempo de ejecución). SC-005 exige 0 muertes fuera de este vocabulario
// ("desconocida"); si T015 añade causas (p.ej. ahogamiento), esta lista debe ampliarse.
// TODO params: no hay clave en params.ts para el vocabulario de causas; se mantiene aquí.
const CAUSAS_CONOCIDAS = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;

type Semaforo = '🟢' | '🟡' | '🔴';
type Params = Record<string, unknown>;

interface DiaMetrica {
  tick: number; poblacion: number; nacimientos: number; muertes: Record<string, number>;
  fundadoresVivos: number; generacionesVivas: number; diversidadOficios: number;
  recetasDistintasEnUso: number; cooperaciones: number;
  gini: number | null; fraccionComida: number | null; distanciaAgua: number | null;
  p50Ms: number; p95Ms: number; rss: number;
}

interface ReplicaLeida {
  directorio: string; seed: number; params: Params; sha: string; digest: string;
  diasDeclarados: number; abortada: boolean; dias: DiaMetrica[];
}

// Réplica ya etiquetada con su procedencia (`--entrada` o `--control`). Necesario para que dos
// grupos con la MISMA firma de parámetros pero de fuentes distintas (p.ej. control con reglas
// viejas vs un grupo de defaults del barrido, T030→T031) NO se fusionen en uno solo.
interface ReplicaConOrigen extends ReplicaLeida { esDelControl: boolean }

interface Agregado { mediana: number; p10: number; p90: number; n: number }

interface MetricasReplica {
  supervivenciaFundadores: number | null; poblacionFinalSobreInicial: number | null;
  diversidadFinal: number | null; diaDiversidadUsado: number | null;
  giniFinal: number | null; fraccionComidaFinal: number | null;
  distanciaAguaFinal: number | null; p95Ms: number | null;
  muertesPorCausa: Record<string, number>; muertesDesconocidas: number;
  colapsoTemprano: boolean;
}

// SC-003 (spec.md): "diversidad ≥ 0,6 en la mediana de réplicas AL DÍA 5", no en el último día del
// barrido (que en T031/T032 es el día 10 o 25). Si la réplica tiene menos de 6 días registrados
// (día 0..5), se cae al último día disponible y se documenta cuál se usó realmente.
const INDICE_DIA_DIVERSIDAD_SC003 = 5;

interface ConflictoDeterminismo { firma: string; seed: number; digest: string; replicas: string[]; primeraDiferencia: string }

/** Lee y valida un JSON; error legible con la ruta si falta o está mal formado. */
function leerJson<T>(ruta: string): T {
  let texto: string;
  try { texto = readFileSync(ruta, 'utf8'); } catch { throw new Error(`No se pudo leer ${ruta}.`); }
  try { return JSON.parse(texto) as T; } catch { throw new Error(`JSON inválido en ${ruta}.`); }
}

/** `JSON.stringify` con claves ordenadas recursivamente: agrupa réplicas por parámetros sin
 * depender del orden de inserción del objeto `params` que haya escrito `replica.ts`. */
function firmaEstable(valor: unknown): string {
  const ordenar = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordenar);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, ordenar((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(ordenar(valor));
}

/** Percentil por rango más cercano (`sorted[floor(n·p)]`), igual convención que
 * `scripts/benchmark-simulation.ts:distribution()`. No interpola. */
function agregar(valores: (number | null)[]): Agregado | null {
  const finitos = valores.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (finitos.length === 0) return null;
  const indice = (p: number) => finitos[Math.min(finitos.length - 1, Math.floor(finitos.length * p))]!;
  return { mediana: indice(0.5), p10: indice(0.1), p90: indice(0.9), n: finitos.length };
}

function leerDia(ruta: string): DiaMetrica {
  const dia = leerJson<Partial<DiaMetrica>>(ruta);
  if (typeof dia.tick !== 'number' || typeof dia.poblacion !== 'number' || typeof dia.muertes !== 'object' || dia.muertes === null) {
    throw new Error(`${ruta}: faltan campos mínimos (tick, poblacion, muertes).`);
  }
  return {
    tick: dia.tick, poblacion: dia.poblacion, nacimientos: dia.nacimientos ?? 0, muertes: dia.muertes as Record<string, number>,
    fundadoresVivos: dia.fundadoresVivos ?? 0, generacionesVivas: dia.generacionesVivas ?? 0,
    diversidadOficios: dia.diversidadOficios ?? 0, recetasDistintasEnUso: dia.recetasDistintasEnUso ?? 0,
    cooperaciones: dia.cooperaciones ?? 0, gini: dia.gini ?? null, fraccionComida: dia.fraccionComida ?? null,
    distanciaAgua: dia.distanciaAgua ?? null, p50Ms: dia.p50Ms ?? 0, p95Ms: dia.p95Ms ?? 0, rss: dia.rss ?? 0,
  };
}

function leerReplica(directorio: string): ReplicaLeida {
  const meta = leerJson<Partial<ReplicaLeida> & { seed?: number; params?: Params; sha?: string; digest?: string; dias?: number; abortada?: boolean }>(
    join(directorio, 'replica.json'));
  if (typeof meta.seed !== 'number' || typeof meta.digest !== 'string' || typeof meta.sha !== 'string') {
    throw new Error(`${directorio}/replica.json: faltan campos mínimos (seed, sha, digest).`);
  }
  const nombresDia = readdirSync(directorio, { withFileTypes: true })
    .filter(e => e.isFile() && /^dia-\d+\.json$/.test(e.name)).map(e => e.name).sort();
  const dias = nombresDia.map(nombre => leerDia(join(directorio, nombre)));
  return { directorio, seed: meta.seed, params: meta.params ?? {}, sha: meta.sha, digest: meta.digest,
    diasDeclarados: meta.dias ?? dias.length, abortada: meta.abortada === true, dias };
}

/** Recorre `raiz` a cualquier profundidad y devuelve una réplica por cada `replica.json` hallado. */
function descubrirReplicas(raiz: string): ReplicaLeida[] {
  if (!existsSync(raiz)) throw new Error(`El directorio de entrada no existe: ${raiz}.`);
  const entradas = readdirSync(raiz, { recursive: true, withFileTypes: true }) as Dirent[];
  const directorios = entradas.filter(e => e.isFile() && e.name === 'replica.json')
    .map(e => (e.parentPath ?? (e as unknown as { path: string }).path));
  return directorios.sort().map(directorio => leerReplica(directorio));
}

function metricasReplica(replica: ReplicaLeida): MetricasReplica {
  const { dias } = replica;
  if (dias.length === 0) {
    return { supervivenciaFundadores: null, poblacionFinalSobreInicial: null, diversidadFinal: null,
      diaDiversidadUsado: null, giniFinal: null, fraccionComidaFinal: null, distanciaAguaFinal: null, p95Ms: null,
      muertesPorCausa: {}, muertesDesconocidas: 0, colapsoTemprano: false };
  }
  const primero = dias[0]!, ultimo = dias.at(-1)!;
  const muertesPorCausa: Record<string, number> = {};
  let muertesDesconocidas = 0;
  for (const dia of dias) for (const [causa, n] of Object.entries(dia.muertes)) {
    muertesPorCausa[causa] = (muertesPorCausa[causa] ?? 0) + n;
    if (!(CAUSAS_CONOCIDAS as readonly string[]).includes(causa)) muertesDesconocidas += n;
  }
  // SC-002 (segunda cláusula): colapso > 50 % en los 2 primeros días simulados (día 0, 1 o 2).
  const primerosDias = dias.slice(0, 3);
  const colapsoTemprano = primero.poblacion > 0 && primerosDias.some(d => d.poblacion < primero.poblacion * 0.5);
  const p95Serie = agregar(dias.map(d => d.p95Ms));
  // SC-003: diversidad AL DÍA 5, no en el último día del barrido; con < 6 días registrados se cae
  // al último disponible y se reporta el índice realmente usado.
  const indiceDiversidad = Math.min(INDICE_DIA_DIVERSIDAD_SC003, dias.length - 1);
  const diaDiversidad = dias[indiceDiversidad]!;
  return {
    supervivenciaFundadores: primero.fundadoresVivos > 0 ? ultimo.fundadoresVivos / primero.fundadoresVivos : null,
    poblacionFinalSobreInicial: primero.poblacion > 0 ? ultimo.poblacion / primero.poblacion : null,
    diversidadFinal: diaDiversidad.diversidadOficios, diaDiversidadUsado: indiceDiversidad,
    giniFinal: ultimo.gini, fraccionComidaFinal: ultimo.fraccionComida,
    distanciaAguaFinal: ultimo.distanciaAgua, p95Ms: p95Serie?.mediana ?? null,
    muertesPorCausa, muertesDesconocidas, colapsoTemprano,
  };
}

// Campos de DiaMetrica excluidos de la comparación de determinismo por depender del reloj de
// pared (tiempos de paso y memoria), no del estado del mundo. Todo lo demás se compara: misma
// semilla + mismo digest de `src/world` debe dar EXACTAMENTE la misma serie de estado del mundo.
const CAMPOS_NO_DETERMINISTAS = new Set<keyof DiaMetrica>(['p50Ms', 'p95Ms', 'rss']);

/** Compara dos series de días recorriendo TODAS las claves de `DiaMetrica` (salvo las de reloj de
 * pared) en vez de una lista literal, para no volver a omitir un campo al ampliar el contrato.
 * Devuelve la primera diferencia como texto, o `null`. */
function primeraDiferenciaDias(a: DiaMetrica[], b: DiaMetrica[]): string | null {
  if (a.length !== b.length) return `número de días distinto (${a.length} vs ${b.length})`;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]!, db = b[i]!;
    for (const campo of Object.keys(da) as (keyof DiaMetrica)[]) {
      if (CAMPOS_NO_DETERMINISTAS.has(campo)) continue;
      const va = da[campo], vb = db[campo];
      const iguales = typeof va === 'object' ? JSON.stringify(va) === JSON.stringify(vb) : va === vb;
      if (!iguales) return `día ${i}, campo "${campo}": ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`;
    }
  }
  return null;
}

/** Misma firma de parámetros + misma semilla + mismo digest de `src/world` debería dar la MISMA
 * serie de métricas de mundo (determinismo, principio I). Si no, rotura → 🔴. */
function detectarRoturaDeterminismo(replicas: ReplicaLeida[]): ConflictoDeterminismo[] {
  const grupos = new Map<string, ReplicaLeida[]>();
  for (const replica of replicas) {
    if (replica.abortada || replica.dias.length === 0) continue;
    const clave = `${firmaEstable(replica.params)}::${replica.seed}::${replica.digest}`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), replica]);
  }
  const conflictos: ConflictoDeterminismo[] = [];
  for (const [clave, grupo] of grupos) {
    if (grupo.length < 2) continue;
    const base = grupo[0]!;
    for (const otra of grupo.slice(1)) {
      const diferencia = primeraDiferenciaDias(base.dias, otra.dias);
      if (diferencia) {
        conflictos.push({ firma: clave, seed: base.seed, digest: base.digest,
          replicas: [base.directorio, otra.directorio], primeraDiferencia: diferencia });
      }
    }
  }
  return conflictos;
}

// Umbrales SC-002..005 de spec.md. Solo el valor "verde" es una cifra oficial del spec; el
// "rojo" (mitad del umbral) y el ámbar intermedio son una interpolación de este script, no
// están en spec.md — documentado en la cabecera del fichero.
function semaforoUmbral(valor: number | null, verdeDesde: number): Semaforo | null {
  if (valor === null) return null;
  if (valor >= verdeDesde) return '🟢';
  if (valor >= verdeDesde / 2) return '🟡';
  return '🔴';
}
const peor = (...s: (Semaforo | null)[]): Semaforo => {
  const presentes = s.filter((v): v is Semaforo => v !== null);
  if (presentes.includes('🔴')) return '🔴'; if (presentes.includes('🟡')) return '🟡'; return '🟢';
};

interface GrupoResumen {
  params: Params; firma: string; esControl: boolean; replicas: number; abortadas: number;
  // Índice del día realmente usado para `diversidadFinal` (SC-003 pide el día 5; con réplicas más
  // cortas se cae al último día disponible). `null` si el grupo no tiene ninguna réplica válida.
  diaDiversidadUsado: number | null;
  metricas: { supervivenciaFundadores: Agregado | null; poblacionFinalSobreInicial: Agregado | null;
    diversidadFinal: Agregado | null; giniFinal: Agregado | null; fraccionComidaFinal: Agregado | null;
    distanciaAguaFinal: Agregado | null; p95Ms: Agregado | null; muertesPorCausa: Record<string, Agregado | null> };
  colapsoTemprano: { detectado: boolean; replicas: string[] };
  muertesDesconocidas: number;
  comparacionControl: Record<string, { delta: number; semaforo: Semaforo | null } | null> | null;
  semaforo: Semaforo; motivos: string[];
}

function agregarGrupo(replicas: ReplicaLeida[], causas: string[]): GrupoResumen['metricas'] {
  const metricas = replicas.map(metricasReplica);
  return {
    supervivenciaFundadores: agregar(metricas.map(m => m.supervivenciaFundadores)),
    poblacionFinalSobreInicial: agregar(metricas.map(m => m.poblacionFinalSobreInicial)),
    diversidadFinal: agregar(metricas.map(m => m.diversidadFinal)),
    giniFinal: agregar(metricas.map(m => m.giniFinal)),
    fraccionComidaFinal: agregar(metricas.map(m => m.fraccionComidaFinal)),
    distanciaAguaFinal: agregar(metricas.map(m => m.distanciaAguaFinal)),
    p95Ms: agregar(metricas.map(m => m.p95Ms)),
    muertesPorCausa: Object.fromEntries(causas.map(causa => [causa, agregar(metricas.map(m => m.muertesPorCausa[causa] ?? 0))])),
  };
}

// Clave de agrupación: procedencia + firma de parámetros. Con `--control` explícito, un grupo de
// `--entrada` NUNCA comparte clave con el grupo de `--control` aunque tengan los mismos `params`
// (pueden venir de digests/reglas distintas: T030 vs T031). Sin `--control` explícito, todas las
// réplicas vienen de `--entrada` y el comportamiento de "control automático" (`params: {}`) es el
// de siempre.
function claveGrupo(replica: ReplicaConOrigen): string {
  return `${replica.esDelControl ? 'control' : 'entrada'}::${firmaEstable(replica.params)}`;
}

function construirGrupos(replicas: ReplicaConOrigen[], huboControlExplicito: boolean, conflictos: ConflictoDeterminismo[]): GrupoResumen[] {
  const porGrupo = new Map<string, ReplicaConOrigen[]>();
  for (const replica of replicas) porGrupo.set(claveGrupo(replica), [...(porGrupo.get(claveGrupo(replica)) ?? []), replica]);
  const causas = [...new Set(replicas.flatMap(r => r.dias.flatMap(d => Object.keys(d.muertes))))].sort();
  const firmasConConflicto = new Set(conflictos.map(c => c.firma.split('::')[0]));

  // El grupo de control es: (a) con `--control` explícito, el (único) grupo cuyas réplicas vienen
  // de esa fuente; (b) sin `--control`, el grupo de `--entrada` cuyos `params` son `{}`, si existe.
  const claveControlAutomatico = `entrada::${firmaEstable({})}`;
  const claveControl = huboControlExplicito
    ? [...porGrupo.keys()].find(c => c.startsWith('control::')) ?? null
    : (porGrupo.has(claveControlAutomatico) ? claveControlAutomatico : null);
  const gruposControl = claveControl !== null ? (porGrupo.get(claveControl) ?? []).filter(r => !r.abortada) : null;
  const metricasControl = gruposControl && gruposControl.length ? agregarGrupo(gruposControl, causas) : null;

  const grupos: GrupoResumen[] = [];
  for (const [clave, replicasGrupo] of porGrupo) {
    const firma = firmaEstable(replicasGrupo[0]!.params);
    const vivas = replicasGrupo.filter(r => !r.abortada);
    const metricasVivas = vivas.map(metricasReplica);
    const metricas = agregarGrupo(vivas, causas);
    const colapsoReplicas = vivas.filter((_, i) => metricasVivas[i]!.colapsoTemprano).map(r => r.directorio);
    const muertesDesconocidas = metricasVivas.reduce((total, m) => total + m.muertesDesconocidas, 0);
    const esControl = clave === claveControl;
    // Día realmente usado para diversidadFinal (SC-003): el mínimo entre las réplicas vivas del
    // grupo, para no ocultar que alguna se quedó corta y cayó al último día disponible.
    const diasUsados = metricasVivas.map(m => m.diaDiversidadUsado).filter((d): d is number => d !== null);
    const diaDiversidadUsado: number | null = diasUsados.length ? Math.min(...diasUsados) : null;

    // Un grupo sin NINGUNA réplica válida (todas abortadas, o abortada:false pero sin días
    // registrados) no tiene datos con los que evaluar SC-002..005: NO puede salir verde por
    // defecto. Igual si, habiendo réplicas válidas, una métrica con umbral SC sigue sin mediana
    // (todas sus réplicas devolvieron `null` para esa métrica): sin datos ≠ cumple el umbral.
    const sinReplicasValidas = vivas.length === 0;
    const metricaSinDatos = !sinReplicasValidas &&
      (metricas.supervivenciaFundadores === null || metricas.diversidadFinal === null || metricas.giniFinal === null);

    const semSuperv = semaforoUmbral(metricas.supervivenciaFundadores?.mediana ?? null, 0.70);
    const semDiv = semaforoUmbral(metricas.diversidadFinal?.mediana ?? null, 0.60);
    const semGini = semaforoUmbral(metricas.giniFinal?.mediana ?? null, 0.35);
    const semDesconocidas: Semaforo | null = muertesDesconocidas > 0 ? '🔴' : null;
    const semColapso: Semaforo | null = colapsoReplicas.length > 0 ? '🔴' : null;
    const semDeterminismo: Semaforo | null = firmasConConflicto.has(firma) ? '🔴' : null;
    const semSinDatos: Semaforo | null = (sinReplicasValidas || metricaSinDatos) ? '🔴' : null;
    const semaforo = peor(semSuperv, semDiv, semGini, semDesconocidas, semColapso, semDeterminismo, semSinDatos);

    const motivos: string[] = [];
    if (sinReplicasValidas) motivos.push('sin réplicas válidas (todas abortadas o sin días registrados): SC-002..005 no evaluables, no puede salir verde');
    else if (metricaSinDatos) motivos.push('una o más métricas con umbral SC-002..005 no tienen mediana calculable (sin datos)');
    if (semSuperv === '🔴' || semSuperv === '🟡') motivos.push(`supervivencia de fundadores ${((metricas.supervivenciaFundadores?.mediana ?? 0) * 100).toFixed(1)} % (SC-002 ≥ 70 %)`);
    if (semDiv === '🔴' || semDiv === '🟡') motivos.push(`diversidad día ${diaDiversidadUsado ?? '?'} = ${(metricas.diversidadFinal?.mediana ?? 0).toFixed(2)} (SC-003 ≥ 0,60 al día 5)`);
    if (semGini === '🔴' || semGini === '🟡') motivos.push(`gini ${(metricas.giniFinal?.mediana ?? 0).toFixed(2)} (SC-004 ≥ 0,35)`);
    if (semDesconocidas) motivos.push(`${muertesDesconocidas} muerte(s) con causa desconocida (SC-005 = 0)`);
    if (semColapso) motivos.push(`colapso > 50 % en los 2 primeros días en ${colapsoReplicas.length} réplica(s)`);
    if (semDeterminismo) motivos.push('rotura de determinismo: misma semilla + mismo digest con métricas distintas');

    let comparacionControl: GrupoResumen['comparacionControl'] = null;
    if (metricasControl && !esControl) {
      const delta = (a: Agregado | null, b: Agregado | null) => a && b ? a.mediana - b.mediana : null;
      const conSemaforo = (valor: number | null, sem: Semaforo | null) => valor === null ? null : { delta: valor, semaforo: sem };
      comparacionControl = {
        supervivenciaFundadores: conSemaforo(delta(metricas.supervivenciaFundadores, metricasControl.supervivenciaFundadores), semSuperv),
        diversidadFinal: conSemaforo(delta(metricas.diversidadFinal, metricasControl.diversidadFinal), semDiv),
        giniFinal: conSemaforo(delta(metricas.giniFinal, metricasControl.giniFinal), semGini),
        poblacionFinalSobreInicial: conSemaforo(delta(metricas.poblacionFinalSobreInicial, metricasControl.poblacionFinalSobreInicial), null),
        p95Ms: conSemaforo(delta(metricas.p95Ms, metricasControl.p95Ms), null),
      };
    }

    grupos.push({ params: replicasGrupo[0]!.params, firma, esControl, replicas: vivas.length, abortadas: replicasGrupo.length - vivas.length,
      diaDiversidadUsado,
      metricas, colapsoTemprano: { detectado: colapsoReplicas.length > 0, replicas: colapsoReplicas }, muertesDesconocidas,
      comparacionControl, semaforo, motivos });
  }
  return grupos.sort((a, b) => (b.esControl ? 1 : 0) - (a.esControl ? 1 : 0) || a.firma.localeCompare(b.firma));
}

interface ResultadoResumen {
  generadoEn: string; entrada: string; control: string | null; totalReplicas: number; replicasAbortadas: number;
  causasConocidas: readonly string[]; grupos: GrupoResumen[]; determinismo: { ok: boolean; conflictos: ConflictoDeterminismo[] };
}

function formatoAgregado(a: Agregado | null, decimales = 2): string {
  return a ? `${a.mediana.toFixed(decimales)} [p10 ${a.p10.toFixed(decimales)}, p90 ${a.p90.toFixed(decimales)}, n=${a.n}]` : 's/d';
}

function generarMarkdown(resultado: ResultadoResumen): string {
  const filas = resultado.grupos.map(g => {
    const nombre = g.esControl ? '**control**' : JSON.stringify(g.params);
    const delta = (clave: string) => {
      const d = g.comparacionControl?.[clave]; return d ? `${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(3)}` : '—';
    };
    const diversidad = `${formatoAgregado(g.metricas.diversidadFinal)}${g.diaDiversidadUsado !== null ? ` (día ${g.diaDiversidadUsado})` : ''}`;
    return `| ${nombre} | ${g.replicas}${g.abortadas ? ` (+${g.abortadas} abortadas)` : ''} | ${formatoAgregado(g.metricas.supervivenciaFundadores)} | ${delta('supervivenciaFundadores')} | ${formatoAgregado(g.metricas.poblacionFinalSobreInicial)} | ${diversidad} | ${formatoAgregado(g.metricas.giniFinal)} | ${formatoAgregado(g.metricas.fraccionComidaFinal)} | ${formatoAgregado(g.metricas.distanciaAguaFinal, 1)} | ${formatoAgregado(g.metricas.p95Ms, 1)} | ${g.muertesDesconocidas} | ${g.semaforo} |`;
  }).join('\n');

  const causasFilas = resultado.causasConocidas.length || resultado.grupos.some(g => Object.keys(g.metricas.muertesPorCausa).length)
    ? [...new Set(resultado.grupos.flatMap(g => Object.keys(g.metricas.muertesPorCausa)))].sort().map(causa =>
        `| ${causa} | ${resultado.grupos.map(g => formatoAgregado(g.metricas.muertesPorCausa[causa] ?? null, 1)).join(' | ')} |`).join('\n')
    : '(sin muertes registradas)';

  const conflictos = resultado.determinismo.conflictos.length
    ? resultado.determinismo.conflictos.map(c => `- semilla ${c.seed}, digest \`${c.digest.slice(0, 12)}…\`: ${c.replicas.join(' vs ')} — ${c.primeraDiferencia}`).join('\n')
    : '(ninguna)';

  const motivos = resultado.grupos.filter(g => g.motivos.length).map(g =>
    `- ${g.esControl ? 'control' : JSON.stringify(g.params)} ${g.semaforo}: ${g.motivos.join('; ')}`).join('\n') || '(ninguno)';

  return `# Resumen del laboratorio\n\n` +
    `Generado: ${resultado.generadoEn} · Entrada: \`${resultado.entrada}\` · Control: ${resultado.control ? `\`${resultado.control}\`` : 'ninguno declarado'}\n\n` +
    `Réplicas: ${resultado.totalReplicas} (${resultado.replicasAbortadas} abortadas) en ${resultado.grupos.length} grupo(s) de parámetros.\n\n` +
    `## Por grupo de parámetros\n\n` +
    `| Grupo | Réplicas | Superv. fundadores | Δ vs control | Población final/inicial | Diversidad | Gini | % celdas comida | Dist. agua | p95 ms | Muertes desconocidas | Semáforo |\n` +
    `|---|---|---|---|---|---|---|---|---|---|---|---|\n${filas}\n\n` +
    `## Muertes por causa (mediana por réplica del grupo)\n\n` +
    `| Causa | ${resultado.grupos.map(g => g.esControl ? 'control' : JSON.stringify(g.params)).join(' | ')} |\n` +
    `|---|${resultado.grupos.map(() => '---').join('|')}|\n${causasFilas}\n\n` +
    `## Determinismo (misma semilla + mismo digest de \`src/world\`)\n\n` +
    `${resultado.determinismo.ok ? '🟢 sin conflictos.' : `🔴 rotura de determinismo:\n\n${conflictos}`}\n\n` +
    `## Motivos de semáforo no verde\n\n${motivos}\n\n` +
    `_Semáforo: verde cumple el umbral SC-002/003/004 de \`spec.md\`; rojo, por debajo de la mitad del umbral (o incumplimiento` +
    ` duro SC-005 / colapso temprano / rotura de determinismo / grupo sin réplicas válidas o sin datos para una métrica con` +
    ` umbral SC); ámbar, la zona intermedia — banda no fijada en \`spec.md\`. Diversidad: SC-003 se mide al día 5; con réplicas` +
    ` más cortas se usa el último día disponible (indicado entre paréntesis)._\n`;
}

function resumirBarrido(entrada: string, opciones: { control?: string | null; salida?: string } = {}): ResultadoResumen {
  const replicasEntradaCrudas = descubrirReplicas(entrada);
  const replicasControlCrudas = opciones.control ? descubrirReplicas(opciones.control) : [];
  // Si `--control` apunta a un subdirectorio DENTRO de `--entrada`, `descubrirReplicas` las
  // encuentra por las dos rutas: se descartan de "entrada" los directorios ya cubiertos por
  // `--control` (por ruta resuelta) para no contarlos ni pesarlos dos veces en las medianas.
  const directoriosControl = new Set(replicasControlCrudas.map(r => resolve(r.directorio)));
  const replicasEntrada = replicasEntradaCrudas.filter(r => !directoriosControl.has(resolve(r.directorio)));
  const todas: ReplicaConOrigen[] = [
    ...replicasEntrada.map(r => ({ ...r, esDelControl: false as const })),
    ...replicasControlCrudas.map(r => ({ ...r, esDelControl: true as const })),
  ];
  const huboControlExplicito = opciones.control != null;
  const conflictos = detectarRoturaDeterminismo(todas);
  const grupos = construirGrupos(todas, huboControlExplicito, conflictos);
  const resultado: ResultadoResumen = {
    generadoEn: new Date().toISOString(), entrada: resolve(entrada), control: opciones.control ? resolve(opciones.control) : null,
    totalReplicas: todas.length, replicasAbortadas: todas.filter(r => r.abortada).length,
    causasConocidas: CAUSAS_CONOCIDAS, grupos, determinismo: { ok: conflictos.length === 0, conflictos },
  };
  const salida = opciones.salida ? resolve(opciones.salida) : resolve(entrada);
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'resumen.json'), JSON.stringify(resultado, null, 2) + '\n');
  writeFileSync(join(salida, 'resumen.md'), generarMarkdown(resultado));
  return resultado;
}

function opciones() {
  const valores = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log('Uso: npx tsx scripts/lab/resumen.ts --entrada <dir> [--control <dir>] [--salida <dir>]\n' +
        'Lee un directorio de barrido (réplicas con replica.json + dia-NNN.json), agrega mediana/p10/p90\n' +
        'por grupo de parámetros, compara con --control (delta y semáforo SC-002..005) y detecta rotura\n' +
        'de determinismo. Escribe resumen.json y resumen.md en --salida (por defecto, --entrada).');
      return null;
    }
    const separador = arg.indexOf('='), clave = separador < 0 ? arg : arg.slice(0, separador);
    const inline = separador < 0 ? undefined : arg.slice(separador + 1);
    if (!['--entrada', '--control', '--salida'].includes(clave) || valores.has(clave)) throw new Error(`Opción desconocida o repetida: ${clave}`);
    const valor = inline ?? process.argv[++i];
    if (!valor || (valor.startsWith('--') && inline === undefined)) throw new Error(`Falta valor para ${clave}`);
    valores.set(clave, valor);
  }
  const entrada = valores.get('--entrada') ?? process.argv[2];
  if (!entrada || entrada.startsWith('--')) throw new Error('Falta --entrada <dir> (directorio del barrido).');
  return { entrada, control: valores.get('--control') ?? null, salida: valores.get('--salida') };
}

function main() {
  const config = opciones(); if (!config) return;
  const resultado = resumirBarrido(config.entrada, { control: config.control, salida: config.salida });
  const salida = config.salida ? resolve(config.salida) : resolve(config.entrada);
  console.log(JSON.stringify({ salida: relative(process.cwd(), salida) || '.', grupos: resultado.grupos.length,
    replicas: resultado.totalReplicas, abortadas: resultado.replicasAbortadas, determinismoOk: resultado.determinismo.ok,
    semaforos: Object.fromEntries(resultado.grupos.map(g => [g.esControl ? 'control' : g.firma, g.semaforo])) }));
  if (!resultado.determinismo.ok || resultado.grupos.some(g => g.semaforo === '🔴')) process.exitCode = 1;
}

main();
