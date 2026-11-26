/**
 * scripts/lab/poblacion.mts — instrumento de poblaciones grandes: tasas por habitante y su dependencia de la densidad.
 *
 * Una banda de 14 fundadores coetáneos tarda horas en decir algo y lo dice con el ruido de unos pocos emparejamientos.
 * Aquí el mundo se puebla de golpe con N personas normales (las mismas funciones que crean a los fundadores) repartidas
 * al azar sobre la tierra de una zona elegida, con la estructura de edades estacionaria de la ley de longevidad, y se
 * corre pocos días. Se miden tasas por habitante y día con su intervalo: nacimientos, muertes por causa,
 * emparejamientos y r = nacimientos − muertes. La curva r(densidad) dice si el mundo tiene punto de equilibrio.
 *
 *   tsx scripts/lab/poblacion.mts correr --semilla 7 --n 200 --zona 0,0,48,32 [--siembra S] [--dias 5] [--regimen abierto|defecto]
 *        [--params p.json] [--hasta interruptor] [--hilos 1] [--gpu sin|0,1] [--bloque 8] [--tope N] [--ticks T] [--desde punto.v8] [--guardar punto.v8] --salida corrida.json
 *   tsx scripts/lab/poblacion.mts curva --semillas 7,51926 --n 50,100,200,400 --zona 0,0,48,32 [--coherencia 200] [--replicas K] [--paralelo 6] --salida dir
 *   tsx scripts/lab/poblacion.mts resumir dir [--transitorio auto|K] [--bloque 8|16|32] [--hasta D]
 *
 * Con `--desde` el punto de partida es un mundo ya crecido y guardado (`guardarPunto`), con su cultura, sus obras y sus
 * comunidades; sin él, una población sembrada, que no tiene nada de eso.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { loadavg, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import {
  assertWorld, bindWorldContext, closePolicyGpuBatchers,
  createWorld, stepWorld, TICKS_PER_DAY, type Person, type World,
} from '../../src/world/index.js';
import { initializePerson, seededTraits } from '../../src/world/mundo/crear.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams, type WorldParams } from '../../src/world/params.js';
import { demographicTraits, initialDemography, updateDemography } from '../../src/world/demography.js';
import { ALLELE_COUNT, expressGenome, founderGenome, localRandom, type Genome } from '../../src/world/genetics.js';
import { founderPolicy, initialPolicyPlasticity } from '../../src/world/politica.js';
import { activate, tileAt } from '../../src/world/spatial.js';
import { CHUNK_SIZE, proceduralPersonName, type Chunk } from '../../src/world/terrain.js';
import { pruneBonds } from '../../src/world/lineage.js';
import { captureTechnologyCheckpoint } from '../../src/world/technology-checkpoint.js';
import { closeKin, reproductiveReadiness } from '../../src/world/family.js';
import { crearComprobador } from '../../src/world/invariantes.js';
import type { MateriaCheckpoint } from '../../src/world/materia/tipos.js';
import { duenoDe, duenoSi } from '../../src/world/motor/contexto.js';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import type { DemographicDeathCause, DemographicState } from '../../src/shared/demography.js';
import { escalon, INTERRUPTORES, type Interruptor } from '../../src/shared/interruptores.js';

export const CAUSAS: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
/**
 * La confianza mutua mínima de una pareja fértil: la regla es de la natalidad (`natalidad.ts`, que exporta lo de n), no de este
 * instrumento. Todo el guion pasa por esta función; cuando n la exporte, solo cambia su cuerpo. Mientras tanto vale la de
 * `natalidad-local.ts` (`CONFIANZA_MUTUA_MINIMA`, 0,3, adimensional), que no se exporta.
 */
export function confianzaMutuaMinima(): number { return 0.3; }
const CONFIANZA_PAREJA = confianzaMutuaMinima();
const DIA = TICKS_PER_DAY;

// ── Estadística ──────────────────────────────────────────────────────────────────────────────────────────

export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentil(ordenados: readonly number[], q: number): number {
  if (!ordenados.length) return NaN;
  const i = (ordenados.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return ordenados[lo]! + (ordenados[hi]! - ordenados[lo]!) * (i - lo);
}

function lnGamma(z: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const ci of c) s += ci / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}

/** Q(a, x) = Γ(a, x)/Γ(a), la gamma incompleta superior regularizada (serie o fracción continua). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let suma = 1 / a, termino = suma;
    for (let n = 1; n < 1000; n++) { termino *= x / (a + n); suma += termino; if (Math.abs(termino) < Math.abs(suma) * 1e-15) break; }
    return 1 - suma * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Probabilidad de cola de una χ² con `gl` grados de libertad. */
export function colaChiCuadrado(x: number, gl: number): number { return gl <= 0 ? 1 : gammaQ(gl / 2, x / 2); }

/** Bondad de ajuste de Pearson. Las clases con esperado < 5 se funden con la vecina para que la χ² valga. */
export function bondadAjuste(observados: readonly number[], probabilidades: readonly number[]): { chi2: number; gl: number; p: number; clases: number } {
  const total = observados.reduce((a, b) => a + b, 0), suma = probabilidades.reduce((a, b) => a + b, 0);
  const o: number[] = [], e: number[] = [];
  let ao = 0, ae = 0;
  for (let i = 0; i < observados.length; i++) {
    ao += observados[i]!; ae += total * probabilidades[i]! / suma;
    if (ae >= 5) { o.push(ao); e.push(ae); ao = 0; ae = 0; }
  }
  if (ae > 0 || ao > 0) { if (e.length) { o[o.length - 1]! += ao; e[e.length - 1]! += ae; } else { o.push(ao); e.push(ae); } }
  const chi2 = o.reduce((s, oi, i) => s + (oi - e[i]!) ** 2 / e[i]!, 0), gl = o.length - 1;
  return { chi2, gl, p: colaChiCuadrado(chi2, gl), clases: o.length };
}

/** Homogeneidad de recuentos de Poisson con exposiciones distintas: ¿una sola tasa explica todos los días? */
export function homogeneidadPoisson(recuentos: readonly number[], exposiciones: readonly number[]): { chi2: number; gl: number; p: number } {
  const total = recuentos.reduce((a, b) => a + b, 0), exposicion = exposiciones.reduce((a, b) => a + b, 0);
  if (total === 0 || exposicion === 0) return { chi2: 0, gl: 0, p: 1 };
  let chi2 = 0, gl = -1;
  for (let i = 0; i < recuentos.length; i++) {
    const esperado = total * exposiciones[i]! / exposicion;
    if (esperado > 0) { chi2 += (recuentos[i]! - esperado) ** 2 / esperado; gl++; }
  }
  return { chi2, gl, p: colaChiCuadrado(chi2, gl) };
}

// ── Ley de longevidad: curva de supervivencia y edades estacionarias ─────────────────────────────────────

/** Cuerpo bien atendido: sin hambre, sed ni intemperie que dañen. La curva es la de la ley de longevidad sola. */
export const NECESIDADES_REFERENCIA = { hunger: 0.2, thirst: 0.15, energy: 0.8, fatigue: 0.2 } as const;
export const PASO_CURVA = 120;

export interface CurvaSupervivencia {
  paso: number;
  /** l[k]: probabilidad de seguir vivo a la edad k·paso. */
  l: number[];
  salud: number[];
  vitalidad: number[];
  /** Esperanza de vida al nacer, en ticks. */
  esperanza: number;
}

/**
 * Supervivencia de un genoma bajo la ley vigente, con la propia `updateDemography`. Dos llamadas por paso: una con la
 * ley tal cual da el riesgo de senescencia del intervalo (su tirada se ignora) y otra con el riesgo a cero da la
 * trayectoria de salud y vitalidad sin la tirada, que solo depende del desgaste. Así no se copia la ley aquí.
 */
export function curvaSupervivencia(genoma: Pick<Genome, 'alleles'>, cuerpo: WorldParams['cuerpo'], paso = PASO_CURVA): CurvaSupervivencia {
  const rasgos = demographicTraits(genoma, cuerpo), sinRiesgo = { ...cuerpo, riesgoSenescenciaDiario: 0 };
  const entorno = { exposure: 0, shelter: 0, protected: false, seed: 0, tick: 0 };
  let estado: DemographicState = initialDemography(0), vivo = 1, esperanza = 0;
  const l = [1], salud = [1], vitalidad = [1];
  while (vivo > 1e-9 && estado.age < 4 * rasgos.maximumAge) {
    const cuerpoActor = { id: 'curva', state: estado, traits: rasgos, ...NECESIDADES_REFERENCIA };
    const riesgo = updateDemography(cuerpoActor, { ...entorno, senescence: cuerpo }, paso).senescenceRisk;
    const siguiente = updateDemography(cuerpoActor, { ...entorno, senescence: sinRiesgo }, paso);
    const despues = siguiente.death ? 0 : vivo * (1 - riesgo);
    esperanza += paso * (vivo + despues) / 2;
    vivo = despues; estado = siguiente.state;
    l.push(vivo); salud.push(estado.health); vitalidad.push(estado.vitality);
  }
  return { paso, l, salud, vitalidad, esperanza };
}

/**
 * Edad de una persona de una población estacionaria (r = 0): densidad ∝ l(a). Se elige el intervalo con peso trapecial
 * y la edad dentro de él uniforme (intervalos de 0,05 días: la diferencia con la densidad lineal no se ve en clases de un día).
 */
export function edadEstacionaria(curva: CurvaSupervivencia, u: number, v: number): number {
  const pesos = curva.l.slice(0, -1).map((li, k) => (li + curva.l[k + 1]!) / 2), total = pesos.reduce((a, b) => a + b, 0);
  let objetivo = u * total, k = 0;
  while (k < pesos.length - 1 && objetivo >= pesos[k]!) { objetivo -= pesos[k]!; k++; }
  return Math.min(Math.round((k + v) * curva.paso), (curva.l.length - 1) * curva.paso);
}

/** Probabilidad de cada clase de edad [i·ancho, (i+1)·ancho) en la población estacionaria de esa curva. */
export function probabilidadesEdad(curva: CurvaSupervivencia, ancho: number, clases: number): number[] {
  const p = new Array<number>(clases).fill(0);
  let total = 0;
  for (let k = 0; k + 1 < curva.l.length; k++) {
    const peso = (curva.l[k]! + curva.l[k + 1]!) / 2;
    p[Math.min(clases - 1, Math.floor(k * curva.paso / ancho))]! += peso; total += peso;
  }
  return p.map(x => x / total);
}

/** Estado del cuerpo a esa edad sobre la trayectoria de referencia: un mayor llega ya gastado por su vejez. */
function estadoAEdad(genoma: Genome, cuerpo: WorldParams['cuerpo'], curva: CurvaSupervivencia, edad: number): DemographicState {
  const k = Math.floor(edad / curva.paso), resto = edad - k * curva.paso;
  const base: DemographicState = { age: k * curva.paso, health: curva.salud[k]!, vitality: curva.vitalidad[k]!, deathCause: null };
  if (resto === 0) return base;
  const siguiente = updateDemography({ id: 'curva', state: base, traits: demographicTraits(genoma, cuerpo), ...NECESIDADES_REFERENCIA },
    { exposure: 0, shelter: 0, protected: false, seed: 0, tick: 0, senescence: { ...cuerpo, riesgoSenescenciaDiario: 0 } }, resto);
  return siguiente.state;
}

/** La mayor esperanza que permite la ley: resiliencia 1 y actividad 0 (la ley es afín en ambas, `longevityAges`). */
function esperanzaMaxima(cuerpo: WorldParams['cuerpo']): number {
  const alelos = new Array<number>(ALLELE_COUNT).fill(0.5);
  alelos[8] = alelos[9] = 1; alelos[4] = alelos[5] = 0;
  return curvaSupervivencia({ alleles: alelos }, cuerpo).esperanza;
}

// ── Poblar de golpe ──────────────────────────────────────────────────────────────────────────────────────

export interface Zona { x: number; y: number; ancho: number; alto: number }
export interface Siembra { n: number; zona: Zona; siembra: number }
export interface ResultadoSiembra { sembrados: Person[]; caminables: number; candidatos: number }

export function celdasDeTierra(mundo: World, zona: Zona): { x: number; y: number }[] {
  const celdas: { x: number; y: number }[] = [];
  for (let y = zona.y; y < zona.y + zona.alto; y++) for (let x = zona.x; x < zona.x + zona.ancho; x++) {
    const tesela = tileAt(mundo, { x, y });
    if (tesela && tesela.terrain !== 'water') celdas.push({ x, y });
  }
  return celdas;
}

/**
 * Sustituye a los vecinos mortales de un mundo recién creado por N personas repartidas al azar sobre la tierra de la
 * zona. Cada una es un fundador del mundo con otra identidad, otro sitio y otra edad: se clona un vecino recién creado
 * (así lleva todo lo que lleva un fundador, también lo que se añada mañana) y se le dan genes, cultura y política con
 * las funciones de `createWorld`. Las edades siguen la población estacionaria de la ley de longevidad: cada genoma se
 * admite con probabilidad proporcional a su esperanza de vida (entre los vivos, los longevos están sobrerrepresentados)
 * y su edad se sortea de su propia curva. El mundo no tiene sexos: cualquier par fértil puede concebir.
 * Puro en (semilla del mundo, siembra): no consume el generador del mundo.
 */
export function poblar(mundo: World, { n, zona, siembra }: Siembra): ResultadoSiembra {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('n debe ser un entero ≥ 1');
  if (mundo.tick !== 0) throw new Error('Solo se puebla un mundo recién creado; para un mundo crecido, --desde');
  for (let cy = Math.floor(zona.y / CHUNK_SIZE); cy <= Math.floor((zona.y + zona.alto - 1) / CHUNK_SIZE); cy++)
    for (let cx = Math.floor(zona.x / CHUNK_SIZE); cx <= Math.floor((zona.x + zona.ancho - 1) / CHUNK_SIZE); cx++) activate(mundo, cx * CHUNK_SIZE, cy * CHUNK_SIZE);
  const tierra = celdasDeTierra(mundo, zona);
  if (!tierra.length) throw new Error('La zona no tiene tierra');
  const plantilla = mundo.people.find(p => p.role === 'neighbor');
  if (!plantilla) throw new Error('El mundo no creó ningún vecino que sirva de plantilla');
  const params = paramsOf(mundo), cuerpo = params.cuerpo, politica = params.conducta.politicaPeso > 0;
  const fundadores = mundo.people.filter(p => p.role === 'neighbor');
  mundo.people = mundo.people.filter(p => p.role !== 'neighbor');
  pruneBonds(mundo.people, fundadores);
  const vivos = new Set(mundo.people.map(p => p.id));
  for (const c of mundo.communities) c.members = c.members.filter(id => vivos.has(id));
  mundo.communities = mundo.communities.filter(c => c.members.length > 0);
  for (const p of mundo.people) if (p.communityId !== null && !mundo.communities.some(c => c.id === p.communityId)) p.communityId = null;

  const cota = esperanzaMaxima(cuerpo) * (1 + 1e-9), sembrados: Person[] = [];
  let candidato = 0;
  for (; sembrados.length < n; candidato++) {
    const id = `sembrado-${siembra}-${candidato}`, rasgos = seededTraits(siembra, candidato);
    const genoma = founderGenome(mundo.seed, id, rasgos, params.genes.varianzaFundadores), curva = curvaSupervivencia(genoma, cuerpo);
    if (curva.esperanza > cota) throw new Error(`Esperanza ${curva.esperanza} por encima de la cota ${cota}`);
    if (localRandom(siembra, `admite:${id}`)() >= curva.esperanza / cota) continue;
    const azarEdad = localRandom(siembra, `edad:${id}`), edad = edadEstacionaria(curva, azarEdad(), azarEdad());
    const celda = tierra[Math.floor(localRandom(siembra, `celda:${id}`)() * tierra.length)]!;
    const persona = structuredClone(plantilla);
    for (const adquirido of ['home', 'waterMemory', 'conflictMemory', 'agreement', 'partnerMemory', 'compounds', 'lastInvention'] as const) delete persona[adquirido];
    Object.assign(persona, { id, name: proceduralPersonName(siembra, candidato + 1, 0), role: 'neighbor', x: celda.x, y: celda.y,
      target: { x: celda.x, y: celda.y }, heading: candidato * 2.399963229728653, traits: rasgos });
    initializePerson(mundo, persona, params.genes.varianzaFundadores);
    // Mismos intervalos que los vecinos fundadores de `createWorld`, con un azar propio de la siembra.
    const azar = localRandom(siembra, `necesidades:${id}`);
    persona.energy = 0.78 + azar() * 0.18; persona.hunger = 0.2 + azar() * 0.28; persona.fatigue = 0.1 + azar() * 0.2;
    persona.traits = expressGenome(persona.genome);
    persona.curiosity = persona.traits.curiosity; persona.sociability = persona.traits.sociability; persona.generosity = persona.traits.care;
    persona.demography = estadoAEdad(persona.genome, cuerpo, curva, edad);
    persona.bornAt = mundo.tick - edad; persona.lastBirth = mundo.tick - Math.min(edad, DIA);
    if (politica) { persona.policy = founderPolicy(mundo.seed, id); persona.policyPlasticity = initialPolicyPlasticity(); }
    else { delete persona.policy; delete persona.policyPlasticity; }
    sembrados.push(persona);
  }
  mundo.people.push(...sembrados);
  mundo.technology.checkpoint = captureTechnologyCheckpoint(mundo.technology, mundo.people, mundo.tick, 'initial');
  return { sembrados, caminables: tierra.length, candidatos: candidato };
}

// ── Puntos guardados ─────────────────────────────────────────────────────────────────────────────────────

/** Un mundo detenido con sus parámetros, territorio retirado y arena material, si la hay. */
export interface PuntoGuardado {
  formato: 'atlas-punto-1'; mundo: World; params: WorldParams; archivo: [string, Buffer][]; materia?: MateriaCheckpoint | null;
}

/** Archivo de chunks retirados de una corrida sin almacén: el mundo los devuelve por `loadChunk` al volver a ellos. */
export function archivoDeChunks(mundo: World, archivo = new Map<string, Buffer>()): { archivo: Map<string, Buffer>; archivar: () => void } {
  bindWorldContext(mundo, { loadChunk: clave => { const guardado = archivo.get(clave); return guardado ? deserialize(guardado) as Chunk : null; } });
  // Como en panel.ts: de un chunk repetido en la cola vale su primera aparición.
  return { archivo, archivar: () => {
    const vistos = new Set<string>();
    for (const chunk of mundo.retiredChunks) if (!vistos.has(chunk.key)) { vistos.add(chunk.key); archivo.set(chunk.key, serialize(chunk)); }
    mundo.retiredChunks = [];
  } };
}

export function guardarPunto(ruta: string, mundo: World, archivo: Map<string, Buffer>): void {
  const d = duenoSi(mundo);
  const materia = d?.instantaneaMateria(d.pendientes()) ?? null;
  const punto: PuntoGuardado = { formato: 'atlas-punto-1', mundo, params: paramsOf(mundo), archivo: [...archivo], materia };
  writeFileSync(ruta, serialize(punto));
}

export function cargarPunto(ruta: string, ajustarParams: (base: WorldParams) => WorldParams = base => base): { mundo: World; archivo: Map<string, Buffer> } {
  // Vale el punto de este guion (`atlas-punto-1`, `archivo` como pares) y el que guarda `panel.ts --guardar-dia` (`formato: 1`, `archivo` como Map).
  const punto = deserialize(readFileSync(ruta)) as Omit<PuntoGuardado, 'formato' | 'archivo'> & { formato: unknown; archivo: [string, Buffer][] | Map<string, Buffer> };
  if (punto?.formato !== 'atlas-punto-1' && punto?.formato !== 1) throw new Error(`${ruta} no es un punto guardado atlas-punto-1`);
  const { mundo, materia } = punto, params = ajustarParams(punto.params);
  if (!materia && ((punto.params.v23?.materia && mundo.tick > 0) || mundo.people.some(p => p.cuerpo) || mundo.animals.some(a => a.cuerpo))) {
    throw new Error(`El punto ${ruta} no guarda su materia. Vuelve a generar el punto desde el origen.`);
  }
  if (materia && (!params.v23.materia || materia.tick !== mundo.tick)) {
    throw new Error(`El punto de materia de ${ruta} requiere el mismo tick del mundo y v23.materia activa.`);
  }
  setParams(mundo, params);
  const archivo = new Map(punto.archivo);
  if (materia) {
    archivoDeChunks(mundo, archivo);
    const d = duenoDe(mundo, materia.sustancias);
    d.epoca = materia.epoca;
    d.abrirEpoca(materia);
  }
  return { mundo, archivo };
}

// ── Medir ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Individuo {
  id: string; origen: 'inicial' | 'nacido'; desde: number; hasta: number | null; causa: DemographicDeathCause | null;
  /** Ticks de los nacimientos de sus hijos y de las parejas nuevas que formó (un par de confianza mutua no visto antes):
   * cada evento vale ½ a cada uno de sus dos miembros. */
  hijos: number[]; parejas: number[];
}
export interface Embudo { adultosFertiles: number; listos: number; conPareja: number; conParejaYLugar: number }
export interface DiaMedido {
  dia: number; tick: number; vivos: number; fueraDeZona: number; muestras: number; embudo: Embudo;
  /** Suma, sobre personas y muestras, de cuántos otros mortales tiene cada una a ≤ 3 y a ≤ 8 celdas. */
  vecinos3: number; vecinos8: number;
  /** Lo ocurrido ese día en cada bloque de `LADO_BLOQUE` celdas, allí donde ocurrió: [clave, ticks-persona, nacimientos,
   * muertes por causa (en el orden de CAUSAS), parejas nuevas]. */
  bloques: [string, ...number[]][];
  hambre: number[]; sed: number[]; msPared: number; ticksPorSegundo: number; carga: number[];
}
export interface Piramide { anchoDias: number; clases: number[]; etapas: { juveniles: number; fertiles: number; mayores: number } }
export interface Registro {
  inicio: number; fin: number; zona: Zona; caminables: number; individuos: Individuo[]; dias: DiaMedido[];
  piramideInicial: Piramide; piramideFinal: Piramide; violaciones: { duras: number; blandas: number; comprobaciones: number };
  tope?: number;
}
export interface OpcionesMedida {
  dias: number; zona: Zona; caminables: number; cadaMuestra?: number; cadaInvariantes?: number; tope?: number;
  /** Duración total en ticks si no es un número entero de días (sondas cortas); el último «día» queda parcial. */
  ticks?: number;
  archivar?: () => void; alDia?: (dia: DiaMedido) => void;
}

const mortales = (mundo: World) => mundo.people.filter(p => p.role === 'neighbor');
const clase = (v: number) => Math.min(9, Math.max(0, Math.floor(v * 10)));

export function piramide(mundo: World, anchoDias = 1): Piramide {
  const cuerpo = paramsOf(mundo).cuerpo, clases: number[] = [], etapas = { juveniles: 0, fertiles: 0, mayores: 0 };
  for (const p of mortales(mundo)) {
    const i = Math.floor(p.demography.age / (anchoDias * DIA));
    while (clases.length <= i) clases.push(0);
    clases[i]!++;
    const r = demographicTraits(p.genome, cuerpo);
    if (p.demography.age < r.maturityAge) etapas.juveniles++; else if (p.demography.age < r.senescenceStart) etapas.fertiles++; else etapas.mayores++;
  }
  return { anchoDias, clases, etapas };
}

/** Pares de mortales no emparentados con confianza mutua suficiente para concebir. */
function parejasDeConfianza(vivos: readonly Person[]): Set<string> {
  const porId = new Map(vivos.map(p => [p.id, p])), pares = new Set<string>();
  for (const a of vivos) for (const [id, v] of Object.entries(a.bonds)) {
    if (v < CONFIANZA_PAREJA || id <= a.id) continue;
    const b = porId.get(id);
    if (b && (b.bonds[a.id] ?? 0) >= CONFIANZA_PAREJA && !closeKin(a, b)) pares.add(`${a.id}|${id}`);
  }
  return pares;
}

/** Pares de `actuales` que no estaban en `vistos`, que los recuerda: un vínculo que ronda el umbral entra y sale de él
 * muestra a muestra y no debe contar cada vez, solo la primera que el par lo cruza. */
export function parejasNuevas(vistos: Set<string>, actuales: ReadonlySet<string>): string[] {
  const nuevas = [...actuales].filter(par => !vistos.has(par));
  for (const par of nuevas) vistos.add(par);
  return nuevas;
}

/** Embudo de la natalidad: en edad fértil → cuerpo listo → con pareja de confianza a ≤ radioPareja → y un lugar a ≤ radioLugar. */
function embudo(mundo: World, vivos: readonly Person[]): Embudo {
  const { cuerpo, poblacion } = paramsOf(mundo), porId = new Map(vivos.map(p => [p.id, p]));
  const enEdad = (p: Person) => { const r = demographicTraits(p.genome, cuerpo); return p.demography.age >= r.maturityAge && p.demography.age < r.senescenceStart; };
  const fertiles = new Set(vivos.filter(enEdad).map(p => p.id));
  const e: Embudo = { adultosFertiles: fertiles.size, listos: 0, conPareja: 0, conParejaYLugar: 0 };
  for (const id of fertiles) {
    const a = porId.get(id)!;
    if (reproductiveReadiness(mundo, a)) e.listos++;
    const pareja = Object.entries(a.bonds).some(([otro, v]) => {
      const b = porId.get(otro);
      return v >= CONFIANZA_PAREJA && !!b && fertiles.has(otro) && (b.bonds[a.id] ?? 0) >= CONFIANZA_PAREJA && !closeKin(a, b)
        && Math.hypot(a.x - b.x, a.y - b.y) <= poblacion.radioPareja;
    });
    if (!pareja) continue;
    e.conPareja++;
    if (mundo.places.some(l => Math.hypot(a.x - l.x, a.y - l.y) <= poblacion.radioLugar)) e.conParejaYLugar++;
  }
  return e;
}

/** Apiñamiento que vive cada persona: otros mortales a ≤ 3 celdas (radio de pareja) y a ≤ 8. La gente se dispersa
 * fuera de la zona sembrada, así que la densidad de la zona solo es la del primer instante. */
function apinamiento(vivos: readonly Person[]): { a3: number; a8: number } {
  const casillas = new Map<string, Person[]>(), lado = 8, clave = (x: number, y: number) => `${Math.floor(x / lado)},${Math.floor(y / lado)}`;
  for (const p of vivos) { const k = clave(p.x, p.y), l = casillas.get(k); if (l) l.push(p); else casillas.set(k, [p]); }
  let a3 = 0, a8 = 0;
  for (const a of vivos) {
    const cx = Math.floor(a.x / lado), cy = Math.floor(a.y / lado);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const b of casillas.get(`${cx + dx},${cy + dy}`) ?? []) {
      if (b === a) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d <= 8) a8++;
      if (d <= 3) a3++;
    }
  }
  return { a3, a8 };
}

/** Lado de los bloques de espacio en que se anotan exposición y eventos; el análisis puede juntarlos en múltiplos. */
export const LADO_BLOQUE = 8;

/** Corre `dias` días y registra cada vida, cada nacimiento y cada pareja que se forma; no escribe el mundo. */
export function medir(mundo: World, o: OpcionesMedida): Registro {
  const cadaMuestra = o.cadaMuestra ?? 120, cadaInvariantes = o.cadaInvariantes ?? DIA, comprobar = crearComprobador();
  const inicio = mundo.tick, individuos = new Map<string, Individuo>(), dias: DiaMedido[] = [];
  const violaciones = { duras: 0, blandas: 0, comprobaciones: 0 };
  const revisar = () => {
    const v = comprobar(mundo);
    violaciones.duras += v.filter(x => x.gravedad === 'dura').length; violaciones.blandas += v.filter(x => x.gravedad === 'blanda').length; violaciones.comprobaciones++;
  };
  const alta = (p: Person, origen: Individuo['origen']) => individuos.set(p.id, { id: p.id, origen, desde: mundo.tick, hasta: null, causa: null, hijos: [], parejas: [] });
  for (const p of mortales(mundo)) alta(p, 'inicial');
  let vivos = new Map(mortales(mundo).map(p => [p.id, p])), legado = mundo.retiredLegacy.length;
  let bloques = new Map<string, number[]>();
  const bloque = (p: Person) => {
    const k = `${Math.floor(p.x / LADO_BLOQUE)},${Math.floor(p.y / LADO_BLOQUE)}`;
    let v = bloques.get(k);
    if (!v) { v = new Array<number>(3 + CAUSAS.length).fill(0); bloques.set(k, v); }
    return v;
  };
  const causaDe = (id: string): DemographicDeathCause => {
    const registro = mundo.retiredLegacy.slice(legado).find(r => r.id === id) ?? mundo.legacy.find(r => r.id === id);
    if (!registro) throw new Error(`Muerte de ${id} sin registro de legado`);
    return registro.cause;
  };
  const fuera = (p: Person) => p.x < o.zona.x || p.y < o.zona.y || p.x >= o.zona.x + o.zona.ancho || p.y >= o.zona.y + o.zona.alto;
  const pares = parejasDeConfianza(mortales(mundo)), piramideInicial = piramide(mundo);
  revisar();
  let tope: number | undefined;
  const fin = inicio + (o.ticks ?? o.dias * DIA);
  for (let dia = 1; mundo.tick < fin; dia++) {
    const desde = performance.now(), hambre = new Array<number>(10).fill(0), sed = new Array<number>(10).fill(0);
    const suma: Embudo = { adultosFertiles: 0, listos: 0, conPareja: 0, conParejaYLugar: 0 };
    let muestras = 0, fueraDeZona = 0, vecinos3 = 0, vecinos8 = 0;
    for (let t = 0; t < DIA && mundo.tick < fin; t++) {
      stepWorld(mundo);
      const ahora = mortales(mundo), ids = new Map<string, Person>();
      for (const p of ahora) {
        ids.set(p.id, p);
        bloque(p)[0]!++;
        if (vivos.has(p.id)) continue;
        alta(p, 'nacido'); bloque(p)[1]!++;
        for (const padre of p.genome.parents) individuos.get(padre)?.hijos.push(mundo.tick);
      }
      // El objeto de quien muere conserva su último sitio: ahí se anota su muerte.
      for (const [id, p] of vivos) if (!ids.has(id)) {
        const i = individuos.get(id)!; i.hasta = mundo.tick; i.causa = causaDe(id); bloque(p)[2 + CAUSAS.indexOf(i.causa)]!++;
      }
      vivos = ids; legado = mundo.retiredLegacy.length;
      if (mundo.tick % cadaMuestra === 0) {
        for (const par of parejasNuevas(pares, parejasDeConfianza(ahora))) {
          const [a, b] = par.split('|') as [string, string];
          individuos.get(a)!.parejas.push(mundo.tick); individuos.get(b)!.parejas.push(mundo.tick); bloque(ids.get(a)!)[2 + CAUSAS.length]!++;
        }
        const e = embudo(mundo, ahora);
        suma.adultosFertiles += e.adultosFertiles; suma.listos += e.listos; suma.conPareja += e.conPareja; suma.conParejaYLugar += e.conParejaYLugar;
        for (const p of ahora) { hambre[clase(p.hunger)]!++; sed[clase(p.thirst)]!++; if (fuera(p)) fueraDeZona++; }
        const { a3, a8 } = apinamiento(ahora);
        vecinos3 += a3; vecinos8 += a8;
        muestras++;
      }
      if (mundo.tick % cadaInvariantes === 0) revisar();
    }
    o.archivar?.();
    const ms = performance.now() - desde;
    dias.push({ dia, tick: mundo.tick, vivos: vivos.size, fueraDeZona, muestras, embudo: suma, vecinos3, vecinos8,
      bloques: [...bloques].map(([k, v]) => [k, ...v] as [string, ...number[]]), hambre, sed, msPared: ms, ticksPorSegundo: (mundo.tick - (dias.at(-1)?.tick ?? inicio)) * 1000 / ms, carga: loadavg() });
    o.alDia?.(dias.at(-1)!);
    bloques = new Map();
    if (o.tope !== undefined && vivos.size >= o.tope) { tope = dia; break; }
  }
  return { inicio, fin: mundo.tick, zona: o.zona, caminables: o.caminables, individuos: [...individuos.values()], dias,
    piramideInicial, piramideFinal: piramide(mundo), violaciones, ...(tope !== undefined ? { tope } : {}) };
}

// ── Tasas ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Estimacion { valor: number; ic95: [number, number]; ee: number }
export interface Grupo { exposicion: number; nacimientos: number; muertes: Record<DemographicDeathCause, number>; parejas: number }
export type Tasa = 'nacimientos' | 'muertes' | DemographicDeathCause | 'parejas' | 'r';
export const TASAS: readonly Tasa[] = ['nacimientos', 'muertes', ...CAUSAS, 'parejas', 'r'];

const grupoVacio = (): Grupo => ({ exposicion: 0, nacimientos: 0, muertes: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 }, parejas: 0 });
function sumar(a: Grupo, b: Grupo): void {
  a.exposicion += b.exposicion; a.nacimientos += b.nacimientos; a.parejas += b.parejas;
  for (const c of CAUSAS) a.muertes[c] += b.muertes[c];
}
export function razones(g: Grupo): Record<Tasa, number> {
  const e = g.exposicion, m = CAUSAS.reduce((s, c) => s + g.muertes[c], 0);
  const r = { nacimientos: g.nacimientos / e, muertes: m / e, parejas: g.parejas / e, r: (g.nacimientos - m) / e } as Record<Tasa, number>;
  for (const c of CAUSAS) r[c] = g.muertes[c] / e;
  return r;
}

/** Contribución de un individuo a la ventana (ti, tf]: días-persona, ½ por cada hijo y por cada pareja, y su muerte. */
export function contribucion(i: Individuo, ti: number, tf: number): Grupo {
  const g = grupoVacio(), dentro = (t: number) => t > ti && t <= tf;
  g.exposicion = Math.max(0, Math.min(i.hasta ?? tf, tf) - Math.max(i.desde, ti)) / DIA;
  g.nacimientos = i.hijos.filter(dentro).length / 2;
  g.parejas = i.parejas.filter(dentro).length / 2;
  if (i.hasta !== null && i.causa !== null && dentro(i.hasta)) g.muertes[i.causa] = 1;
  return g;
}

export function agrupar(individuos: readonly Individuo[], ti: number, tf: number, clave: (i: Individuo) => string): Grupo[] {
  const grupos = new Map<string, Grupo>();
  for (const i of individuos) {
    const k = clave(i);
    let g = grupos.get(k);
    if (!g) { g = grupoVacio(); grupos.set(k, g); }
    sumar(g, contribucion(i, ti, tf));
  }
  return [...grupos.values()].filter(g => g.exposicion > 0);
}

/** Remuestreo de grupos con reemplazo: razón de sumas por tasa, IC percentil del 95 % y sus réplicas. */
export function remuestreo(grupos: readonly Grupo[], replicas = 2000, semilla = 51926): { estimaciones: Record<Tasa, Estimacion>; r: number[] } {
  const total = grupoVacio();
  for (const g of grupos) sumar(total, g);
  const puntual = razones(total), azar = mulberry32(semilla), muestras = Object.fromEntries(TASAS.map(t => [t, [] as number[]])) as Record<Tasa, number[]>;
  for (let b = 0; b < replicas; b++) {
    const s = grupoVacio();
    for (let k = 0; k < grupos.length; k++) sumar(s, grupos[Math.floor(azar() * grupos.length)]!);
    if (s.exposicion === 0) continue;
    const r = razones(s);
    for (const t of TASAS) muestras[t].push(r[t]);
  }
  const estimaciones = {} as Record<Tasa, Estimacion>;
  for (const t of TASAS) {
    const xs = muestras[t], orden = [...xs].sort((a, b) => a - b), media = xs.reduce((a, b) => a + b, 0) / xs.length;
    estimaciones[t] = { valor: puntual[t], ic95: [percentil(orden, 0.025), percentil(orden, 0.975)], ee: Math.sqrt(xs.reduce((s, x) => s + (x - media) ** 2, 0) / Math.max(1, xs.length - 1)) };
  }
  return { estimaciones, r: muestras.r };
}

export const clavePersona = (i: Individuo) => i.id;

/**
 * Grupos de espacio para el remuestreo: cada bloque de `lado` celdas con la exposición y los eventos que ocurrieron en él
 * durante la ventana. La gente se dispersa decenas de celdas en un día, así que el bloque de cada persona al empezar no
 * dice nada de dónde se correlacionan sus eventos (sequía local, encuentros): se anotan donde y cuando ocurren.
 */
export function agruparEspacio(registro: Registro, ti: number, tf: number, lado: number): Grupo[] {
  if (lado % LADO_BLOQUE !== 0) throw new Error(`El lado del bloque debe ser múltiplo de ${LADO_BLOQUE}`);
  const f = lado / LADO_BLOQUE, grupos = new Map<string, Grupo>();
  for (const d of registro.dias) {
    if (d.tick <= ti || d.tick > tf) continue;
    for (const [clave, ticks, nacimientos, ...resto] of d.bloques) {
      const [bx, by] = clave.split(',').map(Number) as [number, number], k = `${Math.floor(bx / f)},${Math.floor(by / f)}`;
      let g = grupos.get(k);
      if (!g) { g = grupoVacio(); grupos.set(k, g); }
      g.exposicion += ticks! / DIA; g.nacimientos += nacimientos!; g.parejas += resto[CAUSAS.length]!;
      CAUSAS.forEach((c, i) => { g!.muertes[c] += resto[i]!; });
    }
  }
  return [...grupos.values()].filter(g => g.exposicion > 0);
}

/** Nacimientos, muertes y exposición de cada día, para ver el transitorio. */
export function serieDiaria(registro: Registro): { dia: number; grupo: Grupo; tasas: Record<Tasa, number> }[] {
  return registro.dias.map((d, k) => {
    const grupo = grupoVacio(), desde = k ? registro.dias[k - 1]!.tick : registro.inicio;
    for (const i of registro.individuos) sumar(grupo, contribucion(i, desde, d.tick));
    return { dia: d.dia, grupo, tasas: razones(grupo) };
  });
}

/**
 * Transitorio: los primeros días tras poblar de golpe (sin vínculos, nadie puede concebir: la confianza mutua que pide
 * `reproduce` tiene que crecer primero; tampoco hay reservas, refugio ni memoria del agua). Regla fijada antes de mirar
 * los datos: se excluyen al menos `minimo` días y luego los primeros días hasta que los nacimientos, las muertes y las
 * parejas de los días restantes sean compatibles con una tasa constante por habitante (homogeneidad de Poisson,
 * p ≥ 0,05 en las tres), dejando siempre dos días al menos.
 */
export function transitorio(registro: Registro, minimo = 1, hasta?: number): { dias: number; pruebas: { desde: number; p: { nacimientos: number; muertes: number; parejas: number } }[] } {
  const serie = serieDiaria(registro).slice(0, hasta), pruebas: { desde: number; p: { nacimientos: number; muertes: number; parejas: number } }[] = [];
  const muertes = (g: Grupo) => CAUSAS.reduce((s, c) => s + g.muertes[c], 0);
  for (let d0 = minimo; d0 <= serie.length - 2; d0++) {
    const resto = serie.slice(d0), exp = resto.map(s => s.grupo.exposicion);
    const p = { nacimientos: homogeneidadPoisson(resto.map(s => s.grupo.nacimientos), exp).p,
      muertes: homogeneidadPoisson(resto.map(s => muertes(s.grupo)), exp).p, parejas: homogeneidadPoisson(resto.map(s => s.grupo.parejas), exp).p };
    pruebas.push({ desde: d0, p });
    if (p.nacimientos >= 0.05 && p.muertes >= 0.05 && p.parejas >= 0.05) return { dias: d0, pruebas };
  }
  return { dias: Math.max(minimo, serie.length - 2), pruebas };
}

/**
 * Pendiente por mínimos cuadrados de la r diaria desde el día `desde` hasta el final (por día): la regla del transitorio
 * solo comprueba que los días de la ventana sean compatibles entre sí, y con dos días no ve una subida. Si r sigue
 * subiendo donde se mide, la tabla muestra el camino hacia el régimen y no el régimen.
 */
export function tendenciaDiaria(registro: Registro, desde = 3): number {
  const ys = serieDiaria(registro).filter(s => s.dia >= desde).map(s => s.tasas.r);
  if (ys.length < 3) return NaN;
  const mx = (ys.length - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  ys.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; });
  return sxy / sxx;
}

export interface Analisis {
  transitorio: number; ventana: [number, number]; diasPersona: number; densidadInicial: number; densidadMedia: number;
  bloques: Record<Tasa, Estimacion>; personas: Record<Tasa, Estimacion>; replicasR: number[];
  /** Ancho del IC de r según la unidad de remuestreo: bloques de 8, 16 y 32 celdas y personas. Si crece con el lado,
   * hay correlación espacial que los bloques pequeños no recogen. */
  anchoR: Record<'b8' | 'b16' | 'b32' | 'personas', number>;
  fraccionConPareja: number; embudo: Embudo; hambre: number[]; sed: number[]; fraccionFueraDeZona: number; grupos: number;
  /** Otros mortales a ≤ 3 y a ≤ 8 celdas de cada persona, de media en la ventana: la densidad que de verdad se vive. */
  vecinos3: number; vecinos8: number;
}

/** Ventana de medida: de acabar el transitorio al día `hasta` (o al final). */
export function ventana(registro: Registro, transitorioDias: number, hasta?: number): [number, number] {
  return [registro.inicio + transitorioDias * DIA, Math.min(registro.fin, hasta === undefined ? Infinity : registro.inicio + hasta * DIA)];
}

export function analizar(registro: Registro, opciones: { transitorio: number; bloque: number; hasta?: number; replicas?: number }): Analisis {
  const [ti, tf] = ventana(registro, opciones.transitorio, opciones.hasta), dias = registro.dias.filter(d => d.tick > ti && d.tick <= tf);
  const porBloque = agruparEspacio(registro, ti, tf, opciones.bloque);
  const bloques = remuestreo(porBloque, opciones.replicas), personas = remuestreo(agrupar(registro.individuos, ti, tf, clavePersona), opciones.replicas);
  const ancho = (e: Estimacion) => e.ic95[1] - e.ic95[0], anchoLado = (lado: number) => ancho(remuestreo(agruparEspacio(registro, ti, tf, lado), opciones.replicas).estimaciones.r);
  const embudoVentana: Embudo = { adultosFertiles: 0, listos: 0, conPareja: 0, conParejaYLugar: 0 };
  const hambre = new Array<number>(10).fill(0), sed = new Array<number>(10).fill(0);
  let muestras = 0, fuera = 0, vivosMedios = 0, v3 = 0, v8 = 0;
  for (const d of dias) {
    v3 += d.vecinos3; v8 += d.vecinos8;
    for (const k of Object.keys(embudoVentana) as (keyof Embudo)[]) embudoVentana[k] += d.embudo[k];
    d.hambre.forEach((n, i) => { hambre[i]! += n; }); d.sed.forEach((n, i) => { sed[i]! += n; });
    muestras += d.hambre.reduce((a, b) => a + b, 0); fuera += d.fueraDeZona;
  }
  const diasPersona = porBloque.reduce((s, g) => s + g.exposicion, 0);
  vivosMedios = diasPersona / ((tf - ti) / DIA);
  const iniciales = registro.individuos.filter(i => i.origen === 'inicial').length;
  return {
    transitorio: opciones.transitorio, ventana: [ti, tf], diasPersona,
    densidadInicial: iniciales / registro.caminables, densidadMedia: vivosMedios / registro.caminables,
    bloques: bloques.estimaciones, personas: personas.estimaciones,
    anchoR: { b8: anchoLado(8), b16: anchoLado(16), b32: anchoLado(32), personas: ancho(personas.estimaciones.r) }, replicasR: bloques.r.filter((_, k) => k % 5 === 0),
    fraccionConPareja: embudoVentana.adultosFertiles ? embudoVentana.conPareja / embudoVentana.adultosFertiles : NaN, embudo: embudoVentana,
    hambre: hambre.map(n => n / Math.max(1, muestras)), sed: sed.map(n => n / Math.max(1, muestras)),
    fraccionFueraDeZona: fuera / Math.max(1, muestras), grupos: porBloque.length,
    vecinos3: v3 / Math.max(1, muestras), vecinos8: v8 / Math.max(1, muestras),
  };
}

// ── Correr un punto ──────────────────────────────────────────────────────────────────────────────────────

export interface OpcionesCorrida {
  semilla: number; n: number; zona: Zona; siembra: number; dias: number; regimen: 'abierto' | 'defecto'; params?: string;
  hilos: number; gpu: number[]; bloque: number; tope?: number; desde?: string; guardar?: string; salida: string;
  /** Sonda corta: duración en ticks en vez de días. */
  ticks?: number;
  /** Enciende los interruptores V23 hasta este (`escalon()`), encima de `--params` (y de los del punto con `--desde`). */
  hasta?: Interruptor;
}

export function paramsDeCorrida(o: Pick<OpcionesCorrida, 'regimen' | 'params' | 'hilos' | 'gpu'> & { hasta?: Interruptor }, base?: WorldParams): WorldParams {
  let params = base ?? (o.regimen === 'abierto' ? hostOpenWorldParams() : DEFAULT_PARAMS);
  if (o.params) params = parseParams(JSON.parse(readFileSync(o.params, 'utf8')), params);
  if (o.hasta) params = parseParams({ v23: escalon(o.hasta) }, params);
  // Las opciones de hilos y tarjetas pasan tal cual al mundo: con un hilo y sin tarjeta, la corrida es reproducible.
  return parseParams({ motor: { ...params.motor, hilos: o.hilos, gpu: o.gpu } }, params);
}

export function correr(o: OpcionesCorrida): unknown {
  const cargaInicio = loadavg(), uptimeInicio = uptime(), t0 = performance.now();
  let mundo: World, archivo: Map<string, Buffer> | undefined, caminables: number, siembra: Omit<ResultadoSiembra, 'sembrados'> & { n: number } | undefined;
  if (o.desde) {
    ({ mundo, archivo } = cargarPunto(o.desde, base => paramsDeCorrida(o, base)));
    caminables = celdasDeTierra(mundo, o.zona).length;
  } else {
    mundo = createWorld(o.semilla, paramsDeCorrida(o));
    const r = poblar(mundo, { n: o.n, zona: o.zona, siembra: o.siembra });
    caminables = r.caminables; siembra = { n: o.n, caminables: r.caminables, candidatos: r.candidatos };
  }
  assertWorld(mundo);
  const msSiembra = performance.now() - t0, chunks = archivoDeChunks(mundo, archivo);
  try {
    const registro = medir(mundo, { dias: o.dias, ticks: o.ticks, zona: o.zona, caminables, tope: o.tope, archivar: chunks.archivar,
      alDia: d => appendFileSync(`${o.salida}.progreso`, `${JSON.stringify({ dia: d.dia, vivos: d.vivos, msPared: Math.round(d.msPared), carga: d.carga })}\n`) });
    // Con la V23 los hijos se llaman `nacido-<uid>` (natalidad.ts `idDeCria`) y `assertWorld` (validar.ts, exige `descendant-N`) rechaza el
    // mundo en cuanto nace uno. Aquí el rechazo se anota en el informe (`aserto`) en vez de perder la corrida.
    let aserto: string | null = null;
    try { assertWorld(mundo); } catch (error) { aserto = String(error); }
    if (o.guardar) { chunks.archivar(); guardarPunto(o.guardar, mundo, chunks.archivo); }
    const informe = { tipo: 'poblacion-corrida', aserto, opciones: o, params: paramsOf(mundo), interruptores: paramsOf(mundo).v23, siembra, msSiembra, msTotal: performance.now() - t0,
      carga: { inicio: cargaInicio, fin: loadavg() }, uptime: { inicio: uptimeInicio, fin: uptime() }, maxRssMiB: process.resourceUsage().maxRSS / 1024, registro };
    writeFileSync(o.salida, JSON.stringify(informe));
    return informe;
  } finally {
    closePolicyGpuBatchers();
  }
}

// ── Curva r(densidad) y coherencia de escala ─────────────────────────────────────────────────────────────

interface CorridaLeida { archivo: string; opciones: OpcionesCorrida; registro: Registro; msTotal: number; carga: { inicio: number[]; fin: number[] }; maxRssMiB: number }

export function leerCorridas(dir: string): CorridaLeida[] {
  return readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('curva')).map(f => ({ archivo: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
    .filter(c => c.tipo === 'poblacion-corrida');
}

/** Pendiente de mínimos cuadrados de r sobre la densidad, con IC por réplicas independientes de cada punto. */
export function pendiente(puntos: { densidad: number; r: number; replicas: number[] }[], semilla = 7): Estimacion {
  const ajuste = (ys: number[]) => {
    const mx = puntos.reduce((s, p) => s + p.densidad, 0) / puntos.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0;
    puntos.forEach((p, i) => { sxy += (p.densidad - mx) * (ys[i]! - my); sxx += (p.densidad - mx) ** 2; });
    return sxy / sxx;
  };
  const azar = mulberry32(semilla), draws: number[] = [];
  for (let b = 0; b < 2000; b++) draws.push(ajuste(puntos.map(p => p.replicas[Math.floor(azar() * p.replicas.length)]!)));
  const orden = [...draws].sort((a, b) => a - b), media = draws.reduce((a, b) => a + b, 0) / draws.length;
  return { valor: ajuste(puntos.map(p => p.r)), ic95: [percentil(orden, 0.025), percentil(orden, 0.975)], ee: Math.sqrt(draws.reduce((s, x) => s + (x - media) ** 2, 0) / (draws.length - 1)) };
}

const fmt = (x: number, d = 3) => Number.isFinite(x) ? x.toFixed(d) : '—';
const fmtE = (e: Estimacion, d = 3) => `${fmt(e.valor, d)} [${fmt(e.ic95[0], d)}, ${fmt(e.ic95[1], d)}]`;

export function resumir(dir: string, opciones: { transitorio: 'auto' | number; bloque: number; hasta?: number }): { texto: string; json: unknown; svg: string } {
  const corridas = leerCorridas(dir).sort((a, b) => a.opciones.semilla - b.opciones.semilla || a.opciones.zona.ancho - b.opciones.zona.ancho || a.opciones.n - b.opciones.n || a.opciones.zona.x - b.opciones.zona.x);
  const propios = corridas.map(c => ({ archivo: c.archivo, ...transitorio(c.registro, 1, opciones.hasta) }));
  // Una sola ventana para todas: la curva compara densidades, no ventanas distintas.
  const comun = opciones.transitorio === 'auto' ? Math.max(...propios.map(p => p.dias)) : opciones.transitorio;
  const filas = corridas.map(c => ({ c, a: analizar(c.registro, { transitorio: comun, bloque: opciones.bloque, hasta: opciones.hasta }), serie: serieDiaria(c.registro) }));
  const completas = filas.filter(f => f.c.opciones.siembra === f.c.opciones.semilla && f.c.opciones.zona.ancho * f.c.opciones.zona.alto === Math.max(...filas.filter(g => g.c.opciones.semilla === f.c.opciones.semilla).map(g => g.c.opciones.zona.ancho * g.c.opciones.zona.alto)));
  const ultimo = Math.min(opciones.hasta ?? Infinity, Math.max(...corridas.map(c => c.registro.dias.length)));
  const lineas = [`Ventana: días ${comun + 1}..${ultimo} (transitorio común = ${comun} d; propio de cada corrida: ${propios.map(p => p.dias).join(', ')}). Tasas por habitante y día, IC 95 % por bloques de ${opciones.bloque}×${opciones.bloque} celdas donde ocurre cada cosa; «ancho IC r» compara bloques de 8/16/32 y personas.`, '',
    '| semilla | N | zona | densidad (hab/celda de tierra) | vecinos a ≤3 / ≤8 | fuera de zona | r = b − m | nacimientos b | muertes m | hambre | sed | intemperie | vejez | parejas | con pareja | N final | ancho IC r b8/b16/b32/personas | tiempo (min) | ticks/s | carga |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const { c, a } of filas) {
    const b = a.bloques, z = c.opciones.zona;
    lineas.push(`| ${c.opciones.semilla} | ${c.opciones.n} | ${z.x},${z.y},${z.ancho}×${z.alto} | ${fmt(a.densidadInicial)} (media ${fmt(a.densidadMedia)}) | ${fmt(a.vecinos3, 1)} / ${fmt(a.vecinos8, 1)} | ${fmt(a.fraccionFueraDeZona, 2)} | ${fmtE(b.r)} | ${fmtE(b.nacimientos)} | ${fmtE(b.muertes)} | ${fmt(b.starvation.valor)} | ${fmt(b.dehydration.valor)} | ${fmt(b.exposure.valor)} | ${fmt(b.senescence.valor)} | ${fmtE(b.parejas)} | ${fmt(a.fraccionConPareja, 2)} | ${c.registro.dias.at(-1)?.vivos ?? '—'} | ${[a.anchoR.b8, a.anchoR.b16, a.anchoR.b32, a.anchoR.personas].map(x => fmt(x, 3)).join('/')} | ${fmt(c.msTotal / 60000, 1)} | ${fmt((c.registro.fin - c.registro.inicio) * 1000 / c.registro.dias.reduce((s, d) => s + d.msPared, 0), 1)} | ${fmt(c.carga.inicio[0]!, 1)}→${fmt(c.carga.fin[0]!, 1)} |`);
  }
  // Dos ejes: la densidad sembrada (la variable del diseño) y el apiñamiento vivido (vecinos a ≤ 8 celdas).
  const pendientes: Record<string, { sembrada: Estimacion; vivida: Estimacion }> = {};
  for (const semilla of [...new Set(completas.map(f => f.c.opciones.semilla))]) {
    const filasMapa = completas.filter(f => f.c.opciones.semilla === semilla);
    const puntos = (x: (a: Analisis) => number) => filasMapa.map(f => ({ densidad: x(f.a), r: f.a.bloques.r.valor, replicas: f.a.replicasR }));
    if (filasMapa.length >= 2) pendientes[semilla] = { sembrada: pendiente(puntos(a => a.densidadInicial)), vivida: pendiente(puntos(a => a.vecinos8)) };
  }
  lineas.push('', 'Pendiente de r por mapa: ' + Object.entries(pendientes).map(([s, e]) => `${s}: dr/d(densidad sembrada) ${fmtE(e.sembrada)} · dr/d(vecinos a ≤8) ${fmtE(e.vivida, 4)}`).join(' · '));
  const replicas = entreSiembras(filas.map(f => f.c), comun, opciones.bloque, opciones.hasta);
  for (const k of replicas) lineas.push(`Réplicas de siembra, semilla ${k.semilla} N=${k.n} (${k.zona.ancho}×${k.zona.alto}): r ${k.r.map(x => fmt(x)).join(' ')} · media ${fmt(k.media)} IC entre siembras [${fmt(k.ic95[0])}, ${fmt(k.ic95[1])}] · desviación entre siembras / error dentro de cada corrida = ${fmt(k.razon, 2)}`);
  const coherencia = coherenciaEscala(filas.map(f => f.c), comun, opciones.bloque, opciones.hasta);
  for (const k of coherencia) lineas.push(`Coherencia de escala, semilla ${k.semilla}: N=${k.n} entera r ${fmtE(k.entera.r)} · dos mitades N=${k.n / 2} r ${fmtE(k.mitades.r)} · diferencia r ${fmtE(k.diferencia.r)} → ${k.coinciden ? 'coinciden' : 'NO coinciden'} (b ${fmtE(k.diferencia.nacimientos)}, m ${fmtE(k.diferencia.muertes)}, parejas ${fmtE(k.diferencia.parejas)})`);
  lineas.push('', 'Tendencia de r por día (mínimos cuadrados desde el día 3; si no es ≈ 0 la ventana aún no es régimen): ' + filas.map(f => `${f.c.opciones.semilla}/N${f.c.opciones.n}/${f.c.opciones.zona.ancho}: ${fmt(tendenciaDiaria(f.c.registro), 3)}`).join(' · '));
  lineas.push('', 'Serie diaria de r (sin ventana): ' + filas.map(f => `${f.c.opciones.semilla}/N${f.c.opciones.n}/${f.c.opciones.zona.ancho}: ${f.serie.map(s => fmt(s.tasas.r, 2)).join(' ')}`).join(' · '));
  const json = { ventana: { transitorio: comun, hasta: ultimo, propios }, bloque: opciones.bloque, pendientes, replicas, coherencia,
    puntos: filas.map(({ c, a, serie }) => ({ archivo: c.archivo, semilla: c.opciones.semilla, siembra: c.opciones.siembra, n: c.opciones.n, zona: c.opciones.zona,
      caminables: c.registro.caminables, msTotal: c.msTotal, carga: c.carga, maxRssMiB: c.maxRssMiB, nFinal: c.registro.dias.at(-1)?.vivos, violaciones: c.registro.violaciones,
      piramideInicial: c.registro.piramideInicial, piramideFinal: c.registro.piramideFinal,
      serie: serie.map(s => ({ dia: s.dia, ...s.tasas, exposicion: s.grupo.exposicion })), tendenciaR: tendenciaDiaria(c.registro), ...a, replicasR: undefined })) };
  const svg = grafica(completas.map(f => ({ serie: String(f.c.opciones.semilla), x: f.a.vecinos8, r: f.a.bloques.r, n: f.c.opciones.n })));
  return { texto: lineas.join('\n'), json, svg };
}

/** La curva a la vista: r (con su IC) frente al apiñamiento vivido, una serie por mapa, y la línea de r = 0. */
export function grafica(puntos: { serie: string; x: number; r: Estimacion; n: number }[]): string {
  const an = 640, al = 400, m = { i: 64, d: 16, s: 24, b: 48 }, colores = ['#2a6f97', '#c4572a', '#4f772d', '#7b2cbf'];
  const xs = puntos.map(p => p.x), ys = puntos.flatMap(p => [...p.r.ic95, 0]);
  const x0 = 0, x1 = Math.max(...xs) * 1.1 || 1, y0 = Math.min(...ys) * 1.1, y1 = Math.max(...ys) * 1.1 || 0.01;
  const X = (x: number) => m.i + (x - x0) / (x1 - x0) * (an - m.i - m.d), Y = (y: number) => m.s + (y1 - y) / (y1 - y0) * (al - m.s - m.b);
  const series = [...new Set(puntos.map(p => p.serie))], partes: string[] = [];
  partes.push(`<line x1="${m.i}" x2="${an - m.d}" y1="${Y(0)}" y2="${Y(0)}" stroke="#888" stroke-dasharray="4 4"/>`);
  for (let k = 0; k <= 4; k++) {
    const y = y0 + (y1 - y0) * k / 4, x = x0 + (x1 - x0) * k / 4;
    partes.push(`<text x="${m.i - 6}" y="${Y(y) + 4}" text-anchor="end">${y.toFixed(2)}</text>`, `<text x="${X(x)}" y="${al - m.b + 16}" text-anchor="middle">${x.toFixed(1)}</text>`);
  }
  series.forEach((serie, k) => {
    const c = colores[k % colores.length]!, propios = puntos.filter(p => p.serie === serie).sort((a, b) => a.x - b.x);
    partes.push(`<polyline fill="none" stroke="${c}" stroke-width="1.5" points="${propios.map(p => `${X(p.x)},${Y(p.r.valor)}`).join(' ')}"/>`);
    for (const p of propios) partes.push(`<line x1="${X(p.x)}" x2="${X(p.x)}" y1="${Y(p.r.ic95[0])}" y2="${Y(p.r.ic95[1])}" stroke="${c}"/>`,
      `<circle cx="${X(p.x)}" cy="${Y(p.r.valor)}" r="4" fill="${c}"><title>semilla ${serie}, N=${p.n}: r=${p.r.valor.toFixed(3)} [${p.r.ic95.map(v => v.toFixed(3)).join(', ')}]</title></circle>`);
    partes.push(`<text x="${an - m.d - 4}" y="${m.s + 14 + 16 * k}" text-anchor="end" fill="${c}">semilla ${serie}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${an}" height="${al}" font-family="sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#fff"/>${partes.join('')}
<text x="${(an + m.i) / 2}" y="${al - 10}" text-anchor="middle">otros mortales a ≤ 8 celdas de cada persona (media en la ventana)</text>
<text transform="translate(16 ${(al - m.b + m.s) / 2}) rotate(-90)" text-anchor="middle">r = nacimientos − muertes (por habitante y día)</text>
</svg>
`;
}

/** Cuantil 0,975 de la t de Student (tabla para pocos grados de libertad). */
function t975(gl: number): number {
  const tabla = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131];
  return gl < 1 ? NaN : gl <= tabla.length ? tabla[gl - 1]! : 1.96 + 2.4 / gl;
}

/**
 * El IC por bloques de una corrida es condicional a su siembra: no recoge que otra población sembrada (edades, sitios,
 * genes) dé otra r. Con réplicas del mismo punto (mismo mapa, N y zona, otra siembra) se estima esa varianza: IC t de la
 * media de r entre siembras y la razón entre la desviación observada entre siembras y el error medio que anunciaba cada
 * corrida. Una razón cercana a 1 dice que el IC por bloques estaba bien calibrado; mayor, que se quedaba corto.
 */
export function entreSiembras(corridas: readonly CorridaLeida[], transitorioDias: number, bloque: number, hasta?: number) {
  const puntos = new Map<string, CorridaLeida[]>();
  for (const c of corridas) {
    const o = c.opciones, clave = `${o.semilla}|${o.n}|${o.zona.x},${o.zona.y},${o.zona.ancho},${o.zona.alto}`;
    puntos.set(clave, [...(puntos.get(clave) ?? []), c]);
  }
  const salida: { semilla: number; n: number; zona: Zona; siembras: number[]; r: number[]; media: number; sd: number; ic95: [number, number]; eeDentro: number; razon: number }[] = [];
  for (const cs of puntos.values()) {
    if (cs.length < 2) continue;
    const e = cs.map(c => remuestreo(agruparEspacio(c.registro, ...ventana(c.registro, transitorioDias, hasta), bloque), 2000, 1).estimaciones.r);
    const r = e.map(x => x.valor), k = r.length, media = r.reduce((a, b) => a + b, 0) / k;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - media) ** 2, 0) / (k - 1)), eeDentro = Math.sqrt(e.reduce((a, x) => a + x.ee ** 2, 0) / k);
    const margen = t975(k - 1) * sd / Math.sqrt(k), o = cs[0]!.opciones;
    salida.push({ semilla: o.semilla, n: o.n, zona: o.zona, siembras: cs.map(c => c.opciones.siembra), r, media, sd, ic95: [media - margen, media + margen], eeDentro, razon: sd / eeDentro });
  }
  return salida.sort((a, b) => a.semilla - b.semilla || a.n - b.n);
}

/** A la misma densidad, una corrida con N en la zona entera frente a dos con N/2 en sus dos mitades, sumadas. */
export function coherenciaEscala(corridas: readonly CorridaLeida[], transitorioDias: number, bloque: number, hasta?: number) {
  const salida: { semilla: number; n: number; entera: Record<Tasa, Estimacion>; mitades: Record<Tasa, Estimacion>; diferencia: Record<Tasa, Estimacion>; coinciden: boolean }[] = [];
  for (const entera of corridas) {
    if (entera.opciones.siembra !== entera.opciones.semilla) continue;
    const z = entera.opciones.zona;
    const mitades = corridas.filter(c => c.opciones.semilla === entera.opciones.semilla && c.opciones.n * 2 === entera.opciones.n
      && c.opciones.zona.alto === z.alto && c.opciones.zona.y === z.y && c.opciones.zona.ancho * 2 === z.ancho && (c.opciones.zona.x === z.x || c.opciones.zona.x === z.x + z.ancho / 2));
    if (mitades.length !== 2 || mitades[0]!.opciones.zona.x === mitades[1]!.opciones.zona.x) continue;
    // Los bloques de dos mundos distintos son grupos distintos aunque tengan la misma clave.
    const grupos = (c: CorridaLeida) => agruparEspacio(c.registro, ...ventana(c.registro, transitorioDias, hasta), bloque);
    const a = remuestreo(grupos(entera), 2000, 1), dos = [...grupos(mitades[0]!), ...grupos(mitades[1]!)];
    const b = remuestreo(dos, 2000, 2);
    // Diferencia por remuestreo independiente de las dos poblaciones (corridas independientes).
    const azar = mulberry32(3), ga = grupos(entera), diferencia = {} as Record<Tasa, Estimacion>, draws = Object.fromEntries(TASAS.map(t => [t, [] as number[]])) as Record<Tasa, number[]>;
    for (let k = 0; k < 2000; k++) {
      const sa = grupoVacio(), sb = grupoVacio();
      for (let i = 0; i < ga.length; i++) sumar(sa, ga[Math.floor(azar() * ga.length)]!);
      for (let i = 0; i < dos.length; i++) sumar(sb, dos[Math.floor(azar() * dos.length)]!);
      const ra = razones(sa), rb = razones(sb);
      for (const t of TASAS) draws[t].push(ra[t] - rb[t]);
    }
    for (const t of TASAS) {
      const orden = [...draws[t]].sort((x, y) => x - y), media = orden.reduce((s, x) => s + x, 0) / orden.length;
      diferencia[t] = { valor: a.estimaciones[t].valor - b.estimaciones[t].valor, ic95: [percentil(orden, 0.025), percentil(orden, 0.975)], ee: Math.sqrt(orden.reduce((s, x) => s + (x - media) ** 2, 0) / (orden.length - 1)) };
    }
    const contiene = (e: Estimacion) => e.ic95[0] <= 0 && e.ic95[1] >= 0;
    salida.push({ semilla: entera.opciones.semilla, n: entera.opciones.n, entera: a.estimaciones, mitades: b.estimaciones, diferencia,
      coinciden: contiene(diferencia.r) && contiene(diferencia.nacimientos) && contiene(diferencia.muertes) && contiene(diferencia.parejas) });
  }
  return salida;
}

// ── Línea de órdenes ─────────────────────────────────────────────────────────────────────────────────────

const entero = (texto: string, nombre: string, minimo = 0) => {
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n < minimo) throw new Error(`${nombre}: se esperaba un entero ≥ ${minimo}`);
  return n;
};
export function zona(texto: string): Zona {
  const [x, y, ancho, alto] = texto.split(',').map(Number);
  if (![x, y, ancho, alto].every(Number.isSafeInteger) || ancho! < 1 || alto! < 1) throw new Error('--zona x,y,ancho,alto (enteros, ancho y alto ≥ 1)');
  return { x: x!, y: y!, ancho: ancho!, alto: alto! };
}

export function argumentosCorrida(args: string[]): OpcionesCorrida {
  const o: Partial<OpcionesCorrida> = { dias: 5, regimen: 'abierto', hilos: 1, gpu: [], bloque: 8, zona: { x: 0, y: 0, ancho: 48, alto: 32 } };
  for (let i = 0; i < args.length; i += 2) {
    const bandera = args[i]!, valor = args[i + 1];
    if (valor === undefined) throw new Error(`Falta valor para ${bandera}`);
    switch (bandera) {
      case '--semilla': o.semilla = entero(valor, bandera); break;
      case '--n': o.n = entero(valor, bandera, 1); break;
      case '--zona': o.zona = zona(valor); break;
      case '--siembra': o.siembra = entero(valor, bandera); break;
      case '--dias': o.dias = entero(valor, bandera, 1); break;
      case '--regimen': if (valor !== 'abierto' && valor !== 'defecto') throw new Error('Régimen inválido'); o.regimen = valor; break;
      case '--params': o.params = resolve(valor); break;
      case '--hilos': o.hilos = entero(valor, bandera, 1); break;
      case '--gpu': o.gpu = valor === 'sin' ? [] : valor.split(',').map(s => entero(s, bandera)); break;
      case '--bloque': o.bloque = entero(valor, bandera, 1); break;
      case '--tope': o.tope = entero(valor, bandera, 1); break;
      case '--ticks': o.ticks = entero(valor, bandera, 1); break;
      case '--desde': o.desde = resolve(valor); break;
      case '--hasta':
        if (!(INTERRUPTORES as readonly string[]).includes(valor)) throw new Error(`--hasta: «${valor}» no es un interruptor V23`);
        o.hasta = valor as Interruptor; break;
      case '--guardar': o.guardar = resolve(valor); break;
      case '--salida': o.salida = resolve(valor); break;
      default: throw new Error(`Opción desconocida: ${bandera}`);
    }
  }
  if (o.semilla === undefined && !o.desde) throw new Error('Falta --semilla (o --desde)');
  if (o.n === undefined && !o.desde) throw new Error('Falta --n (o --desde)');
  if (!o.salida) throw new Error('Falta --salida');
  return { ...o, semilla: o.semilla ?? 0, n: o.n ?? 0, siembra: o.siembra ?? o.semilla ?? 0 } as OpcionesCorrida;
}

export const SALTO_REPLICA = 3_000_003;

/** Corridas de la curva: cada N en la zona entera y, para la coherencia, N/2 en cada mitad con siembras propias. */
export function planCurva(semillas: number[], ns: number[], z: Zona, coherencia: number | undefined, replicas = 0): { semilla: number; n: number; zona: Zona; siembra: number; nombre: string }[] {
  const plan: { semilla: number; n: number; zona: Zona; siembra: number; nombre: string }[] = [];
  for (const semilla of semillas) {
    for (const n of ns) plan.push({ semilla, n, zona: z, siembra: semilla, nombre: `${semilla}-n${n}` });
    // Réplicas del mismo punto con otra población sembrada en el mismo mapa: miden la varianza entre siembras.
    for (let k = 1; k <= replicas; k++) for (const n of ns) plan.push({ semilla, n, zona: z, siembra: semilla + SALTO_REPLICA * k, nombre: `${semilla}-n${n}-r${k}` });
    if (coherencia !== undefined) {
      if (coherencia % 2 || z.ancho % 2) throw new Error('--coherencia y el ancho de la zona deben ser pares');
      const mitad = z.ancho / 2;
      plan.push({ semilla, n: coherencia / 2, zona: { ...z, ancho: mitad }, siembra: semilla + 1_000_001, nombre: `${semilla}-n${coherencia / 2}-izq` });
      plan.push({ semilla, n: coherencia / 2, zona: { ...z, x: z.x + mitad, ancho: mitad }, siembra: semilla + 2_000_002, nombre: `${semilla}-n${coherencia / 2}-der` });
    }
  }
  return plan;
}

async function curva(args: string[]): Promise<void> {
  let semillas = [7, 51926], ns = [50, 100, 200, 400], z: Zona = { x: 0, y: 0, ancho: 48, alto: 32 }, paralelo = 6, salida = '', coherencia: number | undefined, replicas = 0;
  const resto: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const bandera = args[i]!, valor = args[i + 1]!;
    if (bandera === '--semillas') semillas = valor.split(',').map(s => entero(s, bandera));
    else if (bandera === '--n') ns = valor.split(',').map(s => entero(s, bandera, 1));
    else if (bandera === '--zona') z = zona(valor);
    else if (bandera === '--paralelo') paralelo = entero(valor, bandera, 1);
    else if (bandera === '--coherencia') coherencia = entero(valor, bandera, 2);
    else if (bandera === '--replicas') replicas = entero(valor, bandera);
    else if (bandera === '--salida') salida = resolve(valor);
    else resto.push(bandera, valor);
  }
  if (!salida) throw new Error('Falta --salida');
  mkdirSync(salida, { recursive: true });
  // Las más caras primero: así la última en terminar no es una grande lanzada al final.
  const plan = planCurva(semillas, ns, z, coherencia, replicas).sort((a, b) => b.n - a.n);
  writeFileSync(join(salida, 'curva-plan.json'), JSON.stringify({ plan, resto, carga: loadavg(), inicio: new Date().toISOString() }, null, 2));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(paralelo, plan.length) }, async () => {
    while (cursor < plan.length) {
      const p = plan[cursor++]!;
      const orden = ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), 'correr', '--semilla', String(p.semilla), '--n', String(p.n),
        '--zona', `${p.zona.x},${p.zona.y},${p.zona.ancho},${p.zona.alto}`, '--siembra', String(p.siembra), ...resto, '--salida', join(salida, `${p.nombre}.json`)];
      await new Promise<void>(cumplir => {
        const hijo = spawn(process.execPath, orden, { stdio: ['ignore', 'ignore', 'pipe'] });
        let error = '';
        hijo.stderr?.on('data', b => { error = (error + String(b)).slice(-8192); });
        hijo.once('close', codigo => { if (codigo !== 0) writeFileSync(join(salida, `${p.nombre}.error.txt`), `código ${codigo}\n${error}`); cumplir(); });
      });
    }
  }));
  const { texto, json, svg } = resumir(salida, { transitorio: 'auto', bloque: 8 });
  writeFileSync(join(salida, 'curva.json'), JSON.stringify(json, null, 2)); writeFileSync(join(salida, 'curva.md'), `${texto}\n`); writeFileSync(join(salida, 'curva.svg'), svg);
  process.stdout.write(`${texto}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [orden, ...args] = process.argv.slice(2);
  const fallo = (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1); };
  if (orden === 'correr') {
    try { correr(argumentosCorrida(args)); process.exit(0); } catch (error) { fallo(error); }
  } else if (orden === 'curva') curva(args).catch(fallo);
  else if (orden === 'resumir') {
    const dir = resolve(args[0] ?? '.'), t = args.indexOf('--transitorio'), b = args.indexOf('--bloque'), h = args.indexOf('--hasta');
    const { texto, json, svg } = resumir(dir, { transitorio: t >= 0 && args[t + 1] !== 'auto' ? entero(args[t + 1]!, '--transitorio') : 'auto', bloque: b >= 0 ? entero(args[b + 1]!, '--bloque', 1) : 8,
      hasta: h >= 0 ? entero(args[h + 1]!, '--hasta', 1) : undefined });
    writeFileSync(join(dir, 'curva.json'), JSON.stringify(json, null, 2)); writeFileSync(join(dir, 'curva.md'), `${texto}\n`); writeFileSync(join(dir, 'curva.svg'), svg);
    process.stdout.write(`${texto}\n`);
  } else process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n') + '\n');
}
