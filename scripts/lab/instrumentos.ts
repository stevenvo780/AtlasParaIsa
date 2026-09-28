/**
 * Instrumentos de MEDIDA del laboratorio (ronda INSTR, noche 2026-09-22). No cambian el mundo:
 * solo LEEN `World`/`Person` y acumulan en memoria del laboratorio (nunca en `World` ni `Person`).
 * `tests/instrumentos-lab.test.ts` lo comprueba con el digesto canónico del mundo y los
 * `dia-NNN.json` con y sin instrumentos.
 *
 * 1. Conducta por TIEMPO. `src/world/diversidad.ts` lee `person.activity`, y `move()` suma +1 a
 *    `activity.explore` por CADA celda nueva mientras los demás oficios suman 1 por trabajo
 *    terminado: explorar pesa el 45-61 % de la activity con el 10-21 % del tiempo (ronda EXPL). Este
 *    instrumento registra, tras CADA paso, la acción (`person.action`) de cada persona viva y
 *    acumula ticks por acción; `diversidadConductaTiempo` es EL MISMO índice
 *    (`indiceDiversidad`, misma fórmula y mismos componentes) sobre vistas de las personas cuya
 *    `activity` se sustituye por esos ticks. Solo cambia la entrada de actividad.
 *    `diversidadConductaActiva` (preregistro del orquestador, noche 2026-09-22): el MISMO índice con
 *    esos ticks SIN `rest` (`sinDescanso`). Descansar es inactividad, no conducta, y domina el tiempo
 *    (20-39 %) y el «oficio dominante» por tiempo de casi todos. Quien solo ha descansado queda con la
 *    actividad vacía, como alguien que aún no actuó. Es la serie que decide C8 en
 *    `criterio-terminado.mts` (modo auto); ver scripts/lab/README.md §«Preregistro del criterio C8».
 * 2. Comida compartida. Cuenta los actos de `share()` (src/world/index.ts): cada uno emite
 *    exactamente un suceso `kind: 'care'` (el único emisor de ese tipo en src/world) cuando una
 *    persona entrega 0,025 de su reserva (`inventory`) a otra con hambre > 0,27 a ≤ 2 celdas, junto
 *    a un lugar. Se leen los sucesos nuevos del paso en `world.chronicleJournal.pending`, que el mundo
 *    ya emite; no cuentan la herencia al morir (`transferEstate`, suceso 'ecology') ni el depósito o
 *    la toma de comida en estructuras (almacén común, no una entrega entre personas).
 */
import type { Action } from '../../src/shared/types.js';
import type { DatabaseSync } from 'node:sqlite';
import type { LegacyRecord } from '../../src/shared/demography.js';
import type { Capability, TechnologyExecution } from '../../src/shared/technology.js';
import { TICKS_PER_DAY, tileAt, type Person, type World } from '../../src/world/index.js';
import { indiceDiversidad } from '../../src/world/diversidad.js';
import { containedWaterQuanta } from '../../src/world/technology-water.js';


/** Las 18 acciones de `Action`, en el orden de `ACTIONS` de src/world/diversidad.ts (no exportado):
 * fija el orden de las claves de las fracciones en el JSON. */
export const ACCIONES: readonly Action[] = ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft'];

export interface Indice { conducta: number; oficios: number; total: number }

/**
 * `indiceDiversidad(world)` de src/world/diversidad.ts con la entrada de actividad sustituida. Cada
 * persona se sustituye por una vista (`Object.create(person)`) que solo redefine `activity`; el
 * mundo, por una vista que solo redefine `people`. Nada se escribe en el mundo ni en las personas.
 * Con `actividad = p => p.activity` da exactamente `worldStatistics(world).diversidad` (test).
 */
export function indiceDiversidadConActividad(world: World, actividad: (person: Person) => Readonly<Record<string, number>>): Indice {
  const vistas = world.people.map(person => {
    const vista = Object.create(person) as Person;
    Object.defineProperty(vista, 'activity', { value: actividad(person), enumerable: true });
    return vista;
  });
  const mundo = Object.create(world) as World;
  Object.defineProperty(mundo, 'people', { value: vistas, enumerable: true });
  return indiceDiversidad(mundo);
}

/** El mismo índice sobre un subconjunto de personas (vista del mundo con `people` = `personas`). */
export function indiceDiversidadDe(world: World, personas: readonly Person[], actividad: (person: Person) => Readonly<Record<string, number>>): Indice {
  const mundo = Object.create(world) as World;
  Object.defineProperty(mundo, 'people', { value: personas, enumerable: true });
  return indiceDiversidadConActividad(mundo, actividad);
}

/** Acción excluida de la conducta ACTIVA: descansar es inactividad, no conducta. */
export const ACCION_INACTIVA: Action = 'rest';

/**
 * Ticks por acción sin `rest` (copia; solo las acciones con ticks > 0). Si solo hay descanso devuelve
 * `{}`: el vector de actividad queda vacío, igual que el de alguien que aún no actuó (`activity: {}`
 * de un recién nacido), y su «oficio dominante» es «sin oficio aún» (`dominantAction` = null).
 */
export function sinDescanso(ticks: Readonly<Record<string, number>>): Record<string, number> {
  const activa: Record<string, number> = {};
  for (const [accion, n] of Object.entries(ticks)) if (accion !== ACCION_INACTIVA && n > 0) activa[accion] = n;
  return activa;
}

/** Media de la distancia de Jensen-Shannon entre perfiles activos; es la raíz de la
 * divergencia JS en base 2, NO la divergencia. Los perfiles sin ticks activos no forman pares. */
export function diversidadPerfilesJS(perfiles: readonly Readonly<Record<string, number>>[]): number | null {
  const accionesActivas = ACCIONES.filter(accion => accion !== ACCION_INACTIVA);
  const proporciones = perfiles.map(ticks => {
    const total = accionesActivas.reduce((suma, accion) => suma + (ticks[accion] ?? 0), 0);
    return total > 0 ? accionesActivas.map(accion => (ticks[accion] ?? 0) / total) : null;
  }).filter((perfil): perfil is number[] => perfil !== null);
  if (proporciones.length < 2) return null;
  let suma = 0, pares = 0;
  for (let i = 0; i < proporciones.length; i++) for (let j = i + 1; j < proporciones.length; j++) {
    const a = proporciones[i]!, b = proporciones[j]!;
    let divergencia = 0;
    for (let k = 0; k < a.length; k++) {
      const p = a[k]!, q = b[k]!, mezcla = (p + q) / 2;
      if (p > 0) divergencia += p * Math.log2(p / mezcla) / 2;
      if (q > 0) divergencia += q * Math.log2(q / mezcla) / 2;
    }
    suma += Math.sqrt(Math.max(0, Math.min(1, divergencia)));
    pares++;
  }
  return suma / pares;
}

const CAPACIDADES: readonly Capability[] = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
export interface UsoUtil { recipeId: string; capacities: Readonly<Record<Capability, number>> }
export interface RepertorioAbierto { usos: number; clasesR100: number; recetasR100: number; clasesHill2: number }

/** B: cada uso exitoso con benefit>0 pesa uno. Clase = máscara de las seis capacidades en
 * CAPACIDADES cuyo valor es >=0,2. R100 = Σ_i [1-C(N-N_i,100)/C(N,100)] (sin reemplazo);
 * el producto de 100 razones evita factoriales y overflow. Hill-2 = 1/Σ_i(N_i/N)^2.
 * Los cuatro campos son null en conjunto si N<100; no hay muestreo ni azar. */
export function repertorioAbierto(usos: readonly UsoUtil[]): RepertorioAbierto | null {
  const N = usos.length, n = 100;
  if (N < n) return null;
  const recetas = new Map<string, number>(), clases = new Map<number, number>();
  for (const uso of usos) {
    recetas.set(uso.recipeId, (recetas.get(uso.recipeId) ?? 0) + 1);
    let clase = 0;
    for (let i = 0; i < CAPACIDADES.length; i++) if ((uso.capacities[CAPACIDADES[i]!] ?? 0) >= 0.2) clase |= 1 << i;
    clases.set(clase, (clases.get(clase) ?? 0) + 1);
  }
  const rareza = (cuentas: ReadonlyMap<unknown, number>): number => {
    let suma = 0;
    for (const Ni of cuentas.values()) {
      let ausente = 1;
      for (let k = 0; k < n; k++) { ausente *= (N - Ni - k) / (N - k); if (ausente <= 0) break; }
      suma += 1 - Math.max(0, ausente);
    }
    return suma;
  };
  return { usos: N, clasesR100: rareza(clases), recetasR100: rareza(recetas),
    clasesHill2: 1 / [...clases.values()].reduce((s, Ni) => s + (Ni / N) ** 2, 0) };
}

/** Lee exactamente el intervalo y el predicado de usosUtiles en metrics.ts, después de save().
 * JOIN con la definición archivada: la receta puede haber salido de la ventana LRU del mundo.
 * Una definición ausente invalida la medida; nunca se agrupa silenciosamente como clase cero. */
export function repertorioAbiertoDurable(db: DatabaseSync, desdeTickExclusivo: number, hastaTickInclusivo: number): RepertorioAbierto | null {
  const usos: UsoUtil[] = [];
  const rows = db.prepare(`SELECT e.body AS execution, d.body AS recipe FROM technology_executions e
    LEFT JOIN technology_definitions d ON d.id=json_extract(e.body,'$.recipeId')
    WHERE e.tick>? AND e.tick<=? ORDER BY e.serial`);
  for (const row of rows.iterate(desdeTickExclusivo, hastaTickInclusivo)) {
    const execution = JSON.parse(row.execution as string) as TechnologyExecution;
    if (!execution.success || !execution.recipeId || execution.kind !== 'use' || execution.benefit <= 0) continue;
    if (row.recipe === null) throw new Error(`Instrumentos: falta la definición de ${execution.recipeId}.`);
    const recipe = JSON.parse(row.recipe as string) as { capacities: Record<Capability, number> };
    usos.push({ recipeId: execution.recipeId, capacities: recipe.capacities });
  }
  return repertorioAbierto(usos);
}

export interface PerfilGrupo { ticks: Readonly<Record<string, number>>; grupo: string | null }
/** Cuenta cada comunidad registrada al cierre, incluso si hoy no tiene mortales vivos. */
export function censoComunidades(comunidades: readonly { id: string }[], personas: readonly Pick<Person, 'role' | 'communityId'>[]): { n: number; tamanos: number[]; sinComunidad: number } {
  const cuentas = new Map<string, number>(comunidades.map(comunidad => [comunidad.id, 0]));
  let sinComunidad = 0;
  for (const person of personas) if (person.role === 'neighbor') {
    if (person.communityId === null) sinComunidad++;
    else if (cuentas.has(person.communityId)) cuentas.set(person.communityId, cuentas.get(person.communityId)! + 1);
  }
  return { n: comunidades.length, tamanos: [...cuentas.values()].sort((a, b) => b - a), sinComunidad };
}
/** C: W(d) = mortales vivos tanto al comienzo como al cierre. Perfil = ticks de acciones
 * del día sin rest, normalizados a suma 1; un perfil sin actividad es el vector cero.
 * Distancia declarada: L1/2. SS_total=Σ_{i<j}d(i,j)^2/N y
 * SS_intra=Σ_g Σ_{i<j∈g}d(i,j)^2/n_g; F=1-SS_intra/SS_total (0 si SS_total=0).
 * Se excluyen etiquetas null. Se exige >=2 grupos con >=2 personas. El resultado resta la media
 * de 20 F tras barajar etiquetas entre personas, preservando tamaños, con xorshift32 local
 * sembrado por semilla del mundo, día y canal. Nunca usa ni escribe world.rng. */
export function diversidadEntreGrupos(perfiles: readonly PerfilGrupo[], seed: number, dia: number, canal = 0): number | null {
  const validos = perfiles.filter(p => p.grupo !== null);
  const N = validos.length, etiquetas = validos.map(p => p.grupo!);
  const tamanos = new Map<string, number>();
  for (const g of etiquetas) tamanos.set(g, (tamanos.get(g) ?? 0) + 1);
  if ([...tamanos.values()].filter(n => n >= 2).length < 2) return null;
  const acciones = ACCIONES.filter(a => a !== 'rest');
  const vectores = validos.map(({ ticks }) => {
    const total = acciones.reduce((s, a) => s + (ticks[a] ?? 0), 0);
    return acciones.map(a => total ? (ticks[a] ?? 0) / total : 0);
  });
  const pares: { i: number; j: number; d2: number }[] = [];
  let totalDistancia = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    let d = 0;
    for (let k = 0; k < acciones.length; k++) d += Math.abs(vectores[i]![k]! - vectores[j]![k]!);
    const d2 = (d / 2) ** 2;
    pares.push({ i, j, d2 }); totalDistancia += d2;
  }
  if (totalDistancia === 0) return 0;
  const fraccion = (labels: readonly string[]): number => {
    let intra = 0;
    for (const { i, j, d2 } of pares) if (labels[i] === labels[j]) intra += d2 / tamanos.get(labels[i]!)!;
    return 1 - N * intra / totalDistancia;
  };
  const observado = fraccion(etiquetas);
  let estado = (seed ^ Math.imul(dia, 0x9e3779b9) ^ Math.imul(canal + 1, 0x85ebca6b)) >>> 0;
  if (estado === 0) estado = 0x6d2b79f5;
  const azar = (): number => { estado ^= estado << 13; estado ^= estado >>> 17; estado ^= estado << 5; return estado >>> 0; };
  let nulo = 0;
  for (let r = 0; r < 20; r++) {
    const perm = [...etiquetas];
    for (let i = N - 1; i > 0; i--) { const j = azar() % (i + 1); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
    nulo += fraccion(perm);
  }
  return observado - nulo / 20;
}

function fracciones(conteo: ReadonlyMap<string, number>, total: number): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const accion of ACCIONES) { const n = conteo.get(accion) ?? 0; if (n > 0) salida[accion] = n / total; }
  return salida;
}

/** Campos nuevos de `dia-NNN.json` (ver README del laboratorio, «Instrumentos de medida»).
 * La poda de leyes refutadas (ola 1, 2026-09-27) retiró las claves `natalidadLocal`,
 * `vocacionVarianza`, `vocacionEntropiaArgmax` y `vocacionCoincidencia`; los JSON antiguos
 * las conservan y los evaluadores congelados las siguen leyendo de esos ficheros. */
export interface MetricasInstrumentos {
  diversidadConductaTiempo: number;
  diversidadConductaTiempoComponentes: { conducta: number; oficios: number };
  /** El mismo índice con los ticks por acción SIN `rest` (conducta activa). */
  diversidadConductaActiva: number;
  diversidadConductaActivaComponentes: { conducta: number; oficios: number };
  diversidadConductaComponentes: { conducta: number; oficios: number };
  /**
   * C8 v3: el índice sobre perfiles de VENTANA FIJA — ticks por acción de cada mortal durante ESE día, sin
   * `rest`, solo de quienes vivieron el día completo. Con perfiles acumulados desde el nacimiento el índice
   * baja al envejecer la población aunque nadie cambie de conducta (modelo nulo en el README); con una
   * ventana de longitud fija el ruido de fondo es el mismo cada día. `null` con menos de 2 personas.
   */
  diversidadConductaVentana: number | null;
  diversidadConductaVentanaComponentes: { conducta: number; oficios: number } | null;
  personasVentana: number;
  repartoTiempoPorAccion: { personaTicks: number; fracciones: Record<string, number> };
  repartoActividadPorAccion: { incrementos: number; fracciones: Record<string, number> };
  foodShared: number;
  diversidadConductaVentanaGen1: number | null;
  /** `approach` cuyo motivo empieza con el texto de `settlementOpportunity`. */
  approachHogar: number | null;
  maderaMediaAdultos: number | null;
  piedraMediaAdultos: number | null;
  muertesMenores8Dias: number;
  cambiosHogar: { adopta: number; pierde: number };
  diversidadPerfilesJS: number | null;
  linajesVivos: number;
  linajesHerfindahl: number | null;
  /** Comunidades registradas al cierre; el tamaño de una comunidad sin mortales es cero. */
  censoComunidades: { n: number; tamanos: number[]; sinComunidad: number };
  /** Alternativa B, null si hubo menos de 100 usos útiles en el día. */
  repertorioAbierto: RepertorioAbierto | null;
  /** Alternativa C; cada canal es null si no hay dos grupos de al menos dos personas. */
  diversidadEntreGrupos: { comunidades: number | null; linajes: number | null };
  /** Diagnóstico sequía (2026-09-28): ficha por cada muerte por deshidratación del día. */
  sedMuertes: MuerteSed[];
  /** Diagnóstico sequía: clima del día + agua agregada y por región 16×16. */
  sedRegiones: { lluviaTicks: number; aguaTeselas: number; aguaCisternas: number; manantiales: number; regiones: RegionSed[] };
  /** Diagnóstico sequía: celda "x,y" (redondeada) → personas distintas vistas bebiendo (`drink`) ese día. */
  sedFuentes: Record<string, number>;
}

/** 3. Muertes por sed (diagnóstico sequía 2026-09-28). Rastro por persona viva + ficha por
 * muerte por deshidratación + agua por región y bebedores por fuente. Todo vive en memoria
 * del laboratorio: `src/` no se toca (el observador pasivo no hizo falta). */

export interface PuntoRastro { t: number; x: number; y: number; accion: Action; sed: number }
export interface FuenteCercana { dist: number; x: number; y: number; fuente: 'tesela' | 'cisterna' }
export interface MuerteSed {
  tick: number; id: string; edadDias: number;
  x: number; y: number; accion: Action; motivo: string; sed: number;
  aguaLlevada: number; contenedores: number;
  memoria: { x: number; y: number } | null; memoriaDist: number | null;
  memoriaEstado: 'conAgua' | 'seca' | 'fueraDeVista' | null;
  rastro: PuntoRastro[];
  cercaActiva: FuenteCercana | null; cercaInactiva: FuenteCercana | null;
  region: string;
}
export interface RegionSed {
  id: string; tierra: boolean; aguaTeselas: number; fuentes: number; manantiales: number;
  cisternas: number; aguaCisternas: number; poblacion: number;
}

/** Mismo umbral de «hay agua» que las decisiones (`index.ts`: `waterAvailable > 0.005`). */
export const SED_UMBRAL_AGUA = 0.005;
/** Radio máximo de búsqueda de agua cercana (celdas). */
export const SED_RADIO_MAX = 128;
/** Cadencia de instantáneas del rastro + tope (60 × 50 = 3000 ticks ≈ 1,25 días). */
export const SED_RASTRO_CADA = 50, SED_RASTRO_MAX = 60;
const claveCeldaSed = (x: number, y: number): string => `${Math.round(x)},${Math.round(y)}`;
const claveRegionSed = (x: number, y: number): string => `${Math.floor(x / 16)},${Math.floor(y / 16)}`;

export type PuntosAgua = ReadonlyMap<string, { x: number; y: number; fuente: 'tesela' | 'cisterna' }>;

/** Agua disponible más cercana a (x, y) por anillos cuadrados expandidos; null si nada ≤ maxR.
 * Determinista: los anillos se recorren en orden fijo y solo mejora una distancia estrictamente
 * menor (la primera encontrada gana los empates). */
export function aguaCercana(puntos: PuntosAgua, x: number, y: number, maxR = SED_RADIO_MAX): FuenteCercana | null {
  const x0 = Math.round(x), y0 = Math.round(y);
  let mejorDist = Infinity;
  let mejor: FuenteCercana | null = null;
  const mirar = (cx: number, cy: number): void => {
    const p = puntos.get(`${cx},${cy}`);
    if (!p) return;
    const d = Math.hypot(cx - x0, cy - y0);
    if (d < mejorDist) { mejorDist = d; mejor = { dist: d, x: p.x, y: p.y, fuente: p.fuente }; }
  };
  for (let r = 0; r <= maxR; r++) {
    // La celda de distancia euclídea mínima del anillo r está a r (ejes): más allá de la
    // mejor encontrada no puede haber mejora.
    if (r > mejorDist) break;
    if (r === 0) { mirar(x0, y0); continue; }
    for (let dx = -r; dx <= r; dx++) { mirar(x0 + dx, y0 - r); mirar(x0 + dx, y0 + r); }
    for (let dy = -r + 1; dy <= r - 1; dy++) { mirar(x0 - r, y0 + dy); mirar(x0 + r, y0 + dy); }
  }
  return mejor;
}

export interface UltimoSed {
  motivo: string; sed: number; llevada: number; contenedores: number;
  memoria: { x: number; y: number } | null;
}

/** Ficha de una muerte por deshidratación a partir del rastro acumulado (pura, para tests).
 * `aguaEn` devuelve el `drinkingWater` de la tesela ACTIVA en (x, y), o null si no está activa.
 * Falla en voz alta sin rastro: morir de sed exige miles de ticks con sed y hay instantánea
 * cada 50, así que un rastro vacío es un bug del instrumento, nunca un dato. */
export function fichaMuerteSed(args: {
  record: Pick<LegacyRecord, 'id' | 'diedAt' | 'bornAt'>;
  rastro: readonly PuntoRastro[]; ultimo: UltimoSed;
  aguaActiva: PuntosAgua; aguaInactiva: PuntosAgua;
  aguaEn: (x: number, y: number) => number | null;
}): MuerteSed {
  const { record, rastro, ultimo, aguaActiva, aguaInactiva, aguaEn } = args;
  const fin = rastro[rastro.length - 1];
  if (!fin) throw new Error(`Instrumentos sed: muerte ${record.id} sin rastro previo.`);
  const memoriaDist = ultimo.memoria === null ? null : Math.hypot(ultimo.memoria.x - fin.x, ultimo.memoria.y - fin.y);
  const aguaMemoria = ultimo.memoria === null ? null : aguaEn(ultimo.memoria.x, ultimo.memoria.y);
  return {
    tick: record.diedAt, id: record.id, edadDias: (record.diedAt - record.bornAt) / TICKS_PER_DAY,
    x: fin.x, y: fin.y, accion: fin.accion, motivo: ultimo.motivo, sed: ultimo.sed,
    aguaLlevada: ultimo.llevada, contenedores: ultimo.contenedores,
    memoria: ultimo.memoria, memoriaDist,
    memoriaEstado: ultimo.memoria === null ? null : aguaMemoria === null ? 'fueraDeVista'
      : aguaMemoria > SED_UMBRAL_AGUA ? 'conAgua' : 'seca',
    rastro: [...rastro],
    cercaActiva: aguaCercana(aguaActiva, fin.x, fin.y),
    cercaInactiva: aguaCercana(aguaInactiva, fin.x, fin.y),
    region: claveRegionSed(fin.x, fin.y),
  };
}

function mortalesVivos(world: World): Set<string> {
  return new Set(world.people.filter(person => person.role === 'neighbor').map(person => person.id));
}

export class InstrumentosConducta {
  /** Ticks por acción de cada persona viva desde que el laboratorio la ve (tick 0 o su nacimiento). */
  private readonly ticksPorPersona = new Map<string, Record<string, number>>();
  /** Ticks por acción de cada persona en el día en curso (ventana fija de C8 v3). */
  private readonly ticksDiaPorPersona = new Map<string, Record<string, number>>();
  /** Mortales vivos al empezar el día: solo ellos, si siguen vivos al acabarlo, entran en la ventana. */
  private vivosInicioDia = new Set<string>();
  /** Persona-ticks por acción de los vecinos mortales en el día en curso. */
  private readonly tiempoDia = new Map<string, number>();
  private personaTicksDia = 0;
  /** `activity` de cada vecino mortal al empezar el día (copia), para el reparto de activity del día. */
  private actividadInicioDia = new Map<string, Record<string, number>>();
  private comidaCompartida = 0;
  private approachHogarTicks = 0;
  private readonly muertesConocidas = new Set<string>();
  private muertesMenores8Dias = 0;
  /** Solo posiciones, nunca referencias a `home` mutables del mundo. */
  private readonly hogarAnterior = new Map<string, string | null>();
  private cambiosHogar = { adopta: 0, pierde: 0 };
  /** Raíz estable aun cuando el registro del antepasado salga de `world.legacy`. */
  private readonly raizPorId = new Map<string, string>();
  private contadorAntes = 0;
  /** Diagnóstico sequía: rastro por persona viva (instantánea cada SED_RASTRO_CADA ticks). */
  private readonly rastroSed = new Map<string, PuntoRastro[]>();
  /** Diagnóstico sequía: última instantánea no posicional por persona (motivo, sed, agua, memoria). */
  private readonly ultimoSed = new Map<string, UltimoSed>();
  private readonly muertesSedConocidas = new Set<string>();
  private muertesSedDia: MuerteSed[] = [];
  /** Diagnóstico sequía: celda "x,y" → ids distintos vistos con action 'drink' en el día. */
  private readonly bebedoresDia = new Map<string, Set<string>>();
  private lluviaTicksDia = 0;
  /** Índice de agua por paso con muertes: solo se construye si hay que fichar alguna. */
  private indiceAguaTick = -1;
  private readonly aguaActivaPaso = new Map<string, { x: number; y: number; fuente: 'tesela' | 'cisterna' }>();
  /** Las teselas retiradas son inmutables: el conjunto de agua inactiva se reutiliza mientras
   * `retiredChunks` sea el mismo arreglo con la misma longitud (solo cambia en sitio). */
  private retiradasRef: readonly unknown[] | null = null;
  private retiradasLongitud = -1;
  private readonly aguaInactivaCache = new Map<string, { x: number; y: number; fuente: 'tesela' | 'cisterna' }>();
  /** Coste de los instrumentos en ms de reloj (se informa por consola, nunca en el JSON). */
  costeMs = 0;
  pasos = 0;

  constructor(world: World, db?: DatabaseSync) {
    this.fotografiarActividad(world); this.vivosInicioDia = mortalesVivos(world);
    const identidades = new Map([...world.legacy, ...world.retiredLegacy, ...world.people]
      .filter(person => person.role === 'neighbor').map(person => [person.id, person] as const));
    const legadoArchivado = db?.prepare('SELECT body FROM legacy WHERE id=?');
    const raiz = (id: string): string => {
      const conocida = this.raizPorId.get(id);
      if (conocida) return conocida;
      let persona = identidades.get(id);
      if (!persona && legadoArchivado) {
        const fila = legadoArchivado.get(id) as { body: string } | undefined;
        if (fila) { persona = JSON.parse(fila.body) as Person; identidades.set(id, persona); }
      }
      if (!persona) throw new Error(`Instrumentos: falta el progenitor transmisor ${id}.`);
      // reproduce() clona a `a` e inheritGenome([a,b]) conserva ese orden: parents[0] es `a`.
      const transmisor = persona.genome.parents[0];
      const resultado = transmisor === undefined ? id : raiz(transmisor);
      this.raizPorId.set(id, resultado);
      return resultado;
    };
    for (const person of world.people) if (person.role === 'neighbor') {
      raiz(person.id);
      this.hogarAnterior.set(person.id, person.home ? `${person.home.x},${person.home.y}` : null);
    }
    for (const record of [...world.legacy, ...world.retiredLegacy]) {
      if (this.muertesConocidas.has(record.id)) continue;
      this.muertesConocidas.add(record.id);
      if (record.role === 'neighbor' && record.diedAt - record.bornAt < 8 * TICKS_PER_DAY) this.muertesMenores8Dias++;
    }
  }

  private fotografiarActividad(world: World): void {
    this.actividadInicioDia = new Map(world.people.filter(p => p.role === 'neighbor').map(p => [p.id, { ...p.activity }]));
  }

  antesDelPaso(world: World): void {
    this.contadorAntes = world.eventCounter;
  }

  /** Sin observadores que retirar: los instrumentos solo leen (la poda ola 1 retiró el observador NAT-L). */
  cerrar(): void { /* sin estado externo */ }

  /** Ticks por acción observados de una persona viva (copia; para tests y diagnóstico). */
  ticksDe(id: string): Record<string, number> | undefined {
    const ticks = this.ticksPorPersona.get(id);
    return ticks ? { ...ticks } : undefined;
  }

  /** Llamar tras `stepWorld` y ANTES de `store.save` (que vacía `chronicleJournal.pending`). */
  despuesDelPaso(world: World): void {
    const inicio = performance.now();
    for (const person of world.people) {
      let ticks = this.ticksPorPersona.get(person.id);
      if (!ticks) { ticks = {}; this.ticksPorPersona.set(person.id, ticks); }
      ticks[person.action] = (ticks[person.action] ?? 0) + 1;
      let dia = this.ticksDiaPorPersona.get(person.id);
      if (!dia) { dia = {}; this.ticksDiaPorPersona.set(person.id, dia); }
      dia[person.action] = (dia[person.action] ?? 0) + 1;
      if (person.role === 'neighbor') {
        if (!this.raizPorId.has(person.id)) {
          const transmisor = person.genome.parents[0];
          if (!transmisor || !this.raizPorId.has(transmisor))
            throw new Error(`Instrumentos: falta la raíz del progenitor transmisor de ${person.id}.`);
          this.raizPorId.set(person.id, this.raizPorId.get(transmisor)!);
        }
        const hogar = person.home ? `${person.home.x},${person.home.y}` : null;
        const anterior = this.hogarAnterior.get(person.id) ?? null;
        if (hogar !== anterior) {
          if (hogar === null) this.cambiosHogar.pierde++;
          else this.cambiosHogar.adopta++;
        }
        this.hogarAnterior.set(person.id, hogar);
        this.tiempoDia.set(person.action, (this.tiempoDia.get(person.action) ?? 0) + 1); this.personaTicksDia++;
        // El motivo exacto lo emite sólo `settlementOpportunity`, antes de cualquier recuerdo añadido.
        if (person.action === 'approach' && person.reason.startsWith('Vuelve a un lugar conocido con agua, alimento, techo o cooperación;')) this.approachHogarTicks++;
      }
    }
    if (world.weather === 'rain') this.lluviaTicksDia++;
    if (world.tick % SED_RASTRO_CADA === 0) {
      for (const person of world.people) {
        let rastro = this.rastroSed.get(person.id);
        if (!rastro) { rastro = []; this.rastroSed.set(person.id, rastro); }
        rastro.push({ t: world.tick, x: person.x, y: person.y, accion: person.action, sed: person.thirst });
        if (rastro.length > SED_RASTRO_MAX) rastro.splice(0, rastro.length - SED_RASTRO_MAX);
        this.ultimoSed.set(person.id, {
          motivo: person.reason, sed: person.thirst, llevada: containedWaterQuanta(person),
          contenedores: person.technology.items.filter(item => (item.contents?.water ?? 0) > 0).length,
          memoria: person.waterMemory === undefined ? null : { x: person.waterMemory.x, y: person.waterMemory.y },
        });
      }
    }
    for (const person of world.people) {
      if (person.action !== 'drink') continue;
      const celda = claveCeldaSed(person.x, person.y);
      let bebedores = this.bebedoresDia.get(celda);
      if (!bebedores) { bebedores = new Set(); this.bebedoresDia.set(celda, bebedores); }
      bebedores.add(person.id);
    }
    const vivos = new Set(world.people.filter(person => person.role === 'neighbor').map(person => person.id));
    for (const id of this.hogarAnterior.keys()) if (!vivos.has(id)) this.hogarAnterior.delete(id);
    for (const record of world.retiredLegacy) if (!this.muertesConocidas.has(record.id)) {
      this.muertesConocidas.add(record.id);
      if (record.role === 'neighbor' && record.diedAt - record.bornAt < 8 * TICKS_PER_DAY) this.muertesMenores8Dias++;
      if (record.cause === 'dehydration' && !this.muertesSedConocidas.has(record.id)) {
        this.muertesSedConocidas.add(record.id);
        this.muertesSedDia.push(this.ficharMuerteSed(world, record));
      }
    }
    const nuevos = world.eventCounter - this.contadorAntes;
    if (nuevos > 0) {
      const pendientes = world.chronicleJournal?.pending ?? [];
      const desde = pendientes.length - nuevos;
      // Los sucesos del paso son la cola de `pending` (serie contigua e<antes+1>..e<después>). Si no
      // están todos, el recuento sería incompleto: se falla en voz alta, nunca se cuenta de menos.
      if (desde < 0 || pendientes[desde]!.id !== `e${this.contadorAntes + 1}`)
        throw new Error(`Instrumentos: los ${nuevos} sucesos del paso ${world.tick} no están en chronicleJournal.pending (¿guardado antes de observar?).`);
      for (let i = desde; i < pendientes.length; i++) if (pendientes[i]!.kind === 'care') this.comidaCompartida++;
    }
    this.pasos++;
    this.costeMs += performance.now() - inicio;
  }

  /** Ficha una muerte por deshidratación con el rastro acumulado (solo lectura del mundo). */
  private ficharMuerteSed(world: World, record: LegacyRecord): MuerteSed {
    if (this.indiceAguaTick !== world.tick) {
      this.indiceAguaTick = world.tick;
      this.aguaActivaPaso.clear();
      for (const tile of world.tiles) {
        if ((tile.drinkingWater ?? 0) > SED_UMBRAL_AGUA) {
          this.aguaActivaPaso.set(`${tile.x},${tile.y}`, { x: tile.x, y: tile.y, fuente: 'tesela' });
        }
      }
      for (const structure of world.structures) {
        if (structure.water > 0) {
          this.aguaActivaPaso.set(claveCeldaSed(structure.x, structure.y),
            { x: structure.x, y: structure.y, fuente: 'cisterna' });
        }
      }
      if (this.retiradasRef !== world.retiredChunks || this.retiradasLongitud !== world.retiredChunks.length) {
        this.retiradasRef = world.retiredChunks;
        this.retiradasLongitud = world.retiredChunks.length;
        this.aguaInactivaCache.clear();
        for (const chunk of world.retiredChunks) {
          for (const tile of chunk.tiles) {
            if ((tile.drinkingWater ?? 0) > SED_UMBRAL_AGUA) {
              this.aguaInactivaCache.set(`${tile.x},${tile.y}`, { x: tile.x, y: tile.y, fuente: 'tesela' });
            }
          }
        }
      }
    }
    const rastro = this.rastroSed.get(record.id) ?? [];
    const ultimo = this.ultimoSed.get(record.id);
    if (!ultimo) throw new Error(`Instrumentos sed: muerte ${record.id} sin instantánea previa.`);
    return fichaMuerteSed({
      record, rastro, ultimo,
      aguaActiva: this.aguaActivaPaso, aguaInactiva: this.aguaInactivaCache,
      aguaEn: (x, y) => tileAt(world, { x, y })?.drinkingWater ?? null,
    });
  }

  /** Agua por región 16×16 al cierre del día (misma cuadrícula que `regionesSinAgua`). */
  private sedRegionesDia(world: World): MetricasInstrumentos['sedRegiones'] {
    const regiones = new Map<string, RegionSed>();
    const region = (id: string): RegionSed => {
      let r = regiones.get(id);
      if (!r) {
        r = { id, tierra: false, aguaTeselas: 0, fuentes: 0, manantiales: 0, cisternas: 0, aguaCisternas: 0, poblacion: 0 };
        regiones.set(id, r);
      }
      return r;
    };
    let aguaTeselas = 0, manantiales = 0;
    for (const tile of world.tiles) {
      const r = region(claveRegionSed(tile.x, tile.y));
      if (tile.terrain !== 'water') r.tierra = true;
      const agua = tile.drinkingWater ?? 0;
      if (agua > 0) { r.aguaTeselas += agua; aguaTeselas += agua; r.fuentes++; }
      if (tile.feature === 'spring') { r.manantiales++; manantiales++; }
    }
    let aguaCisternas = 0;
    for (const structure of world.structures) {
      if (structure.water > 0) {
        const r = region(claveRegionSed(structure.x, structure.y));
        r.cisternas++; r.aguaCisternas += structure.water; aguaCisternas += structure.water;
      }
    }
    for (const person of world.people) region(claveRegionSed(person.x, person.y)).poblacion++;
    return {
      lluviaTicks: this.lluviaTicksDia, aguaTeselas, aguaCisternas, manantiales,
      regiones: [...regiones.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    };
  }

  /** Métricas del día que acaba en `world.tick`; reinicia los acumuladores del día. */
  metricasDia(world: World, db?: DatabaseSync): MetricasInstrumentos {
    const inicio = performance.now();
    const vacio: Record<string, number> = {};
    const tiempo = indiceDiversidadConActividad(world, person => this.ticksPorPersona.get(person.id) ?? vacio);
    const activa = indiceDiversidadConActividad(world, person => sinDescanso(this.ticksPorPersona.get(person.id) ?? vacio));
    const actividad = indiceDiversidadConActividad(world, person => person.activity);
    const enVentana = world.people.filter(person => person.role === 'neighbor' && this.vivosInicioDia.has(person.id));
    const ventana = enVentana.length >= 2
      ? indiceDiversidadDe(world, enVentana, person => sinDescanso(this.ticksDiaPorPersona.get(person.id) ?? vacio))
      : null;
    const gen1 = enVentana.filter(person => person.genome.generation >= 1);
    const ventanaGen1 = gen1.length >= 2
      ? indiceDiversidadDe(world, gen1, person => sinDescanso(this.ticksDiaPorPersona.get(person.id) ?? vacio))
      : null;
    const adultos = world.people.filter(person => person.role === 'neighbor' && world.tick - person.bornAt >= 5 * TICKS_PER_DAY);
    const mediaAdultos = (material: 'wood' | 'stone'): number | null => adultos.length
      ? adultos.reduce((suma, person) => suma + person.materials[material], 0) / adultos.length : null;
    const linajes = new Map<string, number>();
    for (const person of world.people) if (person.role === 'neighbor') {
      const raiz = this.raizPorId.get(person.id);
      if (!raiz) throw new Error(`Instrumentos: falta la raíz de ${person.id}.`);
      linajes.set(raiz, (linajes.get(raiz) ?? 0) + 1);
    }
    const mortales = [...linajes.values()].reduce((suma, n) => suma + n, 0);
    const comunidades = censoComunidades(world.communities, world.people);
    const comunidadPerfiles = enVentana.map(person => ({ ticks: this.ticksDiaPorPersona.get(person.id) ?? vacio, grupo: person.communityId }));
    const linajePerfiles = enVentana.map(person => ({ ticks: this.ticksDiaPorPersona.get(person.id) ?? vacio, grupo: this.raizPorId.get(person.id) ?? null }));
    const dia = Math.ceil(world.tick / TICKS_PER_DAY);
    const ticksActivos = this.personaTicksDia - (this.tiempoDia.get('rest') ?? 0);
    const incrementos = new Map<string, number>();
    let totalIncrementos = 0;
    for (const person of world.people) {
      if (person.role !== 'neighbor') continue;
      const previa = this.actividadInicioDia.get(person.id);
      for (const accion of ACCIONES) {
        const n = (person.activity[accion] ?? 0) - (previa?.[accion] ?? 0);
        if (n > 0) { incrementos.set(accion, (incrementos.get(accion) ?? 0) + n); totalIncrementos += n; }
      }
    }
    const metricas: MetricasInstrumentos = {
      diversidadConductaTiempo: tiempo.total,
      diversidadConductaTiempoComponentes: { conducta: tiempo.conducta, oficios: tiempo.oficios },
      diversidadConductaActiva: activa.total,
      diversidadConductaActivaComponentes: { conducta: activa.conducta, oficios: activa.oficios },
      diversidadConductaComponentes: { conducta: actividad.conducta, oficios: actividad.oficios },
      diversidadConductaVentana: ventana ? ventana.total : null,
      diversidadConductaVentanaComponentes: ventana ? { conducta: ventana.conducta, oficios: ventana.oficios } : null,
      personasVentana: enVentana.length,
      repartoTiempoPorAccion: { personaTicks: this.personaTicksDia, fracciones: fracciones(this.tiempoDia, this.personaTicksDia) },
      repartoActividadPorAccion: { incrementos: totalIncrementos, fracciones: fracciones(incrementos, totalIncrementos) },
      foodShared: this.comidaCompartida,
      diversidadConductaVentanaGen1: ventanaGen1?.total ?? null,
      approachHogar: ticksActivos ? this.approachHogarTicks / ticksActivos : null,
      maderaMediaAdultos: mediaAdultos('wood'),
      piedraMediaAdultos: mediaAdultos('stone'),
      muertesMenores8Dias: this.muertesMenores8Dias,
      cambiosHogar: { ...this.cambiosHogar },
      diversidadPerfilesJS: diversidadPerfilesJS(enVentana.map(person => this.ticksDiaPorPersona.get(person.id) ?? vacio)),
      linajesVivos: linajes.size,
      linajesHerfindahl: mortales ? [...linajes.values()].reduce((suma, n) => suma + (n / mortales) ** 2, 0) : null,
      censoComunidades: comunidades,
      repertorioAbierto: db ? repertorioAbiertoDurable(db, world.tick - TICKS_PER_DAY, world.tick) : null,
      diversidadEntreGrupos: {
        comunidades: diversidadEntreGrupos(comunidadPerfiles, world.seed, dia, 0),
        linajes: diversidadEntreGrupos(linajePerfiles, world.seed, dia, 1),
      },
      sedMuertes: this.muertesSedDia,
      sedRegiones: this.sedRegionesDia(world),
      sedFuentes: Object.fromEntries([...this.bebedoresDia.entries()].map(([celda, ids]) => [celda, ids.size])),
    };
    const vivos = new Set(world.people.map(person => person.id));
    for (const id of [...this.ticksPorPersona.keys()]) if (!vivos.has(id)) this.ticksPorPersona.delete(id);
    for (const id of [...this.rastroSed.keys()]) if (!vivos.has(id)) { this.rastroSed.delete(id); this.ultimoSed.delete(id); }
    this.muertesSedDia = [];
    this.bebedoresDia.clear();
    this.lluviaTicksDia = 0;
    this.tiempoDia.clear(); this.personaTicksDia = 0; this.approachHogarTicks = 0;
    this.cambiosHogar = { adopta: 0, pierde: 0 };
    this.ticksDiaPorPersona.clear(); this.vivosInicioDia = mortalesVivos(world);
    this.fotografiarActividad(world);
    this.costeMs += performance.now() - inicio;
    return metricas;
  }
}
