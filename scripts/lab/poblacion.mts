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
 *        [--params p.json] [--hilos 1] [--gpu sin|0,1] [--bloque 8] [--tope N] [--desde punto.v8] [--guardar punto.v8] --salida corrida.json
 *   tsx scripts/lab/poblacion.mts curva --semillas 7,51926 --n 50,100,200,400 --zona 0,0,48,32 [--coherencia 200] [--paralelo 6] --salida dir
 *   tsx scripts/lab/poblacion.mts resumir dir [--transitorio auto|K] [--bloque 8]
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
  assertWorld, bindWorldContext, closeFaunaParallelPools, closePersonasParallelPools, closePolicyGpuBatchers,
  createWorld, stepWorld, TICKS_PER_DAY, type Person, type World,
} from '../../src/world/index.js';
import { initializePerson, seededTraits } from '../../src/world/mundo/crear.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams, type WorldParams } from '../../src/world/params.js';
import { demographicTraits, initialDemography, updateDemography } from '../../src/world/demography.js';
import { expressGenome, founderGenome, localRandom, type Genome } from '../../src/world/genetics.js';
import { founderPolicy, initialPolicyPlasticity } from '../../src/world/politica.js';
import { activate, tileAt } from '../../src/world/spatial.js';
import { CHUNK_SIZE, proceduralPersonName, type Chunk } from '../../src/world/terrain.js';
import { pruneBonds } from '../../src/world/lineage.js';
import { captureTechnologyCheckpoint } from '../../src/world/technology-checkpoint.js';
import { closeKin, reproductiveReadiness } from '../../src/world/family.js';
import { crearComprobador } from '../../src/world/invariantes.js';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import type { DemographicDeathCause, DemographicState } from '../../src/shared/demography.js';

export const CAUSAS: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
/** La confianza mutua que `reproduce` exige a una pareja (`natalidad-local.ts`, `CONFIANZA_MUTUA_MINIMA`). */
const CONFIANZA_PAREJA = 0.3;
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
  const alelos = new Array<number>(14).fill(0.5);
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

/** Un mundo detenido con lo que hace falta para seguirlo: sus params (viven fuera del objeto) y el territorio retirado. */
export interface PuntoGuardado { formato: 'atlas-punto-1'; mundo: World; params: WorldParams; archivo: [string, Buffer][] }

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
  const punto: PuntoGuardado = { formato: 'atlas-punto-1', mundo, params: paramsOf(mundo), archivo: [...archivo] };
  writeFileSync(ruta, serialize(punto));
}

export function cargarPunto(ruta: string): { mundo: World; archivo: Map<string, Buffer> } {
  const punto = deserialize(readFileSync(ruta)) as PuntoGuardado;
  if (punto?.formato !== 'atlas-punto-1') throw new Error(`${ruta} no es un punto guardado atlas-punto-1`);
  setParams(punto.mundo, punto.params);
  return { mundo: punto.mundo, archivo: new Map(punto.archivo) };
}

// ── Medir ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Individuo {
  id: string; origen: 'inicial' | 'nacido'; x0: number; y0: number; desde: number; hasta: number | null; causa: DemographicDeathCause | null;
  /** Ticks de los nacimientos de sus hijos y de las parejas nuevas que formó (un par de confianza mutua no visto antes):
   * cada evento vale ½ a cada uno de sus dos miembros. */
  hijos: number[]; parejas: number[];
}
export interface Embudo { adultosFertiles: number; listos: number; conPareja: number; conParejaYLugar: number }
export interface DiaMedido {
  dia: number; tick: number; vivos: number; fueraDeZona: number; muestras: number; embudo: Embudo;
  /** Suma, sobre personas y muestras, de cuántos otros mortales tiene cada una a ≤ 3 y a ≤ 8 celdas. */
  vecinos3: number; vecinos8: number;
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

/** Corre `dias` días y registra cada vida, cada nacimiento y cada pareja que se forma; no escribe el mundo. */
export function medir(mundo: World, o: OpcionesMedida): Registro {
  const cadaMuestra = o.cadaMuestra ?? 120, cadaInvariantes = o.cadaInvariantes ?? DIA, comprobar = crearComprobador();
  const inicio = mundo.tick, individuos = new Map<string, Individuo>(), dias: DiaMedido[] = [];
  const violaciones = { duras: 0, blandas: 0, comprobaciones: 0 };
  const revisar = () => {
    const v = comprobar(mundo);
    violaciones.duras += v.filter(x => x.gravedad === 'dura').length; violaciones.blandas += v.filter(x => x.gravedad === 'blanda').length; violaciones.comprobaciones++;
  };
  const alta = (p: Person, origen: Individuo['origen']) => individuos.set(p.id, { id: p.id, origen, x0: p.x, y0: p.y, desde: mundo.tick, hasta: null, causa: null, hijos: [], parejas: [] });
  for (const p of mortales(mundo)) alta(p, 'inicial');
  let vivos = new Set(individuos.keys()), legado = mundo.retiredLegacy.length;
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
      const ahora = mortales(mundo), ids = new Set<string>();
      for (const p of ahora) {
        ids.add(p.id);
        if (vivos.has(p.id)) continue;
        alta(p, 'nacido');
        for (const padre of p.genome.parents) individuos.get(padre)?.hijos.push(mundo.tick);
      }
      for (const id of vivos) if (!ids.has(id)) { const i = individuos.get(id)!; i.hasta = mundo.tick; i.causa = causaDe(id); }
      vivos = ids; legado = mundo.retiredLegacy.length;
      if (mundo.tick % cadaMuestra === 0) {
        // Un vínculo que ronda el umbral entra y sale de él muestra a muestra: cuenta solo la primera vez que el par lo cruza.
        for (const par of parejasDeConfianza(ahora)) if (!pares.has(par)) { pares.add(par); for (const id of par.split('|')) individuos.get(id)!.parejas.push(mundo.tick); }
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
    dias.push({ dia, tick: mundo.tick, vivos: vivos.size, fueraDeZona, muestras, embudo: suma, vecinos3, vecinos8, hambre, sed, msPared: ms, ticksPorSegundo: (mundo.tick - (dias.at(-1)?.tick ?? inicio)) * 1000 / ms, carga: loadavg() });
    o.alDia?.(dias.at(-1)!);
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

export const claveBloque = (zona: Zona, lado: number) => (i: Individuo) => `${Math.floor((i.x0 - zona.x) / lado)},${Math.floor((i.y0 - zona.y) / lado)}`;
export const clavePersona = (i: Individuo) => i.id;

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
export function transitorio(registro: Registro, minimo = 1): { dias: number; pruebas: { desde: number; p: { nacimientos: number; muertes: number; parejas: number } }[] } {
  const serie = serieDiaria(registro), pruebas: { desde: number; p: { nacimientos: number; muertes: number; parejas: number } }[] = [];
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

export interface Analisis {
  transitorio: number; ventana: [number, number]; diasPersona: number; densidadInicial: number; densidadMedia: number;
  bloques: Record<Tasa, Estimacion>; personas: Record<Tasa, Estimacion>; anchoBloqueSobrePersona: number; replicasR: number[];
  fraccionConPareja: number; embudo: Embudo; hambre: number[]; sed: number[]; fraccionFueraDeZona: number; grupos: number;
  /** Otros mortales a ≤ 3 y a ≤ 8 celdas de cada persona, de media en la ventana: la densidad que de verdad se vive. */
  vecinos3: number; vecinos8: number;
}

export function analizar(registro: Registro, opciones: { transitorio: number; bloque: number; replicas?: number }): Analisis {
  const ti = registro.inicio + opciones.transitorio * DIA, tf = registro.fin, dias = registro.dias.filter(d => d.tick > ti);
  const porBloque = agrupar(registro.individuos, ti, tf, claveBloque(registro.zona, opciones.bloque));
  const bloques = remuestreo(porBloque, opciones.replicas), personas = remuestreo(agrupar(registro.individuos, ti, tf, clavePersona), opciones.replicas);
  const ancho = (e: Estimacion) => e.ic95[1] - e.ic95[0];
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
    anchoBloqueSobrePersona: ancho(bloques.estimaciones.r) / ancho(personas.estimaciones.r), replicasR: bloques.r.filter((_, k) => k % 5 === 0),
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
}

export function paramsDeCorrida(o: Pick<OpcionesCorrida, 'regimen' | 'params' | 'hilos' | 'gpu'>): WorldParams {
  let params = o.regimen === 'abierto' ? hostOpenWorldParams() : DEFAULT_PARAMS;
  if (o.params) params = parseParams(JSON.parse(readFileSync(o.params, 'utf8')), params);
  // Las opciones de hilos y tarjetas pasan tal cual al mundo: con un hilo y sin tarjeta, la corrida es reproducible.
  return parseParams({ motor: { ...params.motor, hilos: o.hilos, gpu: o.gpu } }, params);
}

export function correr(o: OpcionesCorrida): unknown {
  const cargaInicio = loadavg(), uptimeInicio = uptime(), t0 = performance.now();
  let mundo: World, archivo: Map<string, Buffer> | undefined, caminables: number, siembra: Omit<ResultadoSiembra, 'sembrados'> & { n: number } | undefined;
  if (o.desde) {
    ({ mundo, archivo } = cargarPunto(o.desde));
    if (o.hilos !== paramsOf(mundo).motor.hilos || o.gpu.join() !== paramsOf(mundo).motor.gpu.join())
      setParams(mundo, parseParams({ motor: { ...paramsOf(mundo).motor, hilos: o.hilos, gpu: o.gpu } }, paramsOf(mundo)));
    caminables = celdasDeTierra(mundo, o.zona).length;
  } else {
    mundo = createWorld(o.semilla, paramsDeCorrida(o));
    const r = poblar(mundo, { n: o.n, zona: o.zona, siembra: o.siembra });
    caminables = r.caminables; siembra = { n: o.n, caminables: r.caminables, candidatos: r.candidatos };
  }
  assertWorld(mundo);
  const msSiembra = performance.now() - t0, chunks = archivoDeChunks(mundo, archivo);
  try {
    const registro = medir(mundo, { dias: o.dias, zona: o.zona, caminables, tope: o.tope, archivar: chunks.archivar,
      alDia: d => appendFileSync(`${o.salida}.progreso`, `${JSON.stringify({ dia: d.dia, vivos: d.vivos, msPared: Math.round(d.msPared), carga: d.carga })}\n`) });
    assertWorld(mundo);
    if (o.guardar) { chunks.archivar(); guardarPunto(o.guardar, mundo, chunks.archivo); }
    const informe = { tipo: 'poblacion-corrida', opciones: o, params: paramsOf(mundo), siembra, msSiembra, msTotal: performance.now() - t0,
      carga: { inicio: cargaInicio, fin: loadavg() }, uptime: { inicio: uptimeInicio, fin: uptime() }, maxRssMiB: process.resourceUsage().maxRSS / 1024, registro };
    writeFileSync(o.salida, JSON.stringify(informe));
    return informe;
  } finally {
    closePersonasParallelPools(); closeFaunaParallelPools(); closePolicyGpuBatchers();
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

export function resumir(dir: string, opciones: { transitorio: 'auto' | number; bloque: number }): { texto: string; json: unknown } {
  const corridas = leerCorridas(dir).sort((a, b) => a.opciones.semilla - b.opciones.semilla || a.opciones.zona.ancho - b.opciones.zona.ancho || a.opciones.n - b.opciones.n || a.opciones.zona.x - b.opciones.zona.x);
  const propios = corridas.map(c => ({ archivo: c.archivo, ...transitorio(c.registro) }));
  // Una sola ventana para todas: la curva compara densidades, no ventanas distintas.
  const comun = opciones.transitorio === 'auto' ? Math.max(...propios.map(p => p.dias)) : opciones.transitorio;
  const filas = corridas.map(c => ({ c, a: analizar(c.registro, { transitorio: comun, bloque: opciones.bloque }), serie: serieDiaria(c.registro) }));
  const completas = filas.filter(f => f.c.opciones.zona.ancho * f.c.opciones.zona.alto === Math.max(...filas.filter(g => g.c.opciones.semilla === f.c.opciones.semilla).map(g => g.c.opciones.zona.ancho * g.c.opciones.zona.alto)));
  const lineas = [`Ventana: días ${comun + 1}..${Math.max(...corridas.map(c => c.registro.dias.length))} (transitorio común = ${comun} d; propio de cada corrida: ${propios.map(p => p.dias).join(', ')}). Tasas por habitante y día, IC 95 % por bloques de ${opciones.bloque}×${opciones.bloque} celdas.`, '',
    '| semilla | N | zona | densidad (hab/celda de tierra) | vecinos a ≤3 / ≤8 | fuera de zona | r = b − m | nacimientos b | muertes m | hambre | sed | intemperie | vejez | parejas | con pareja | N final | IC bloque/persona | tiempo (min) | ticks/s | carga |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const { c, a } of filas) {
    const b = a.bloques, z = c.opciones.zona;
    lineas.push(`| ${c.opciones.semilla} | ${c.opciones.n} | ${z.x},${z.y},${z.ancho}×${z.alto} | ${fmt(a.densidadInicial)} (media ${fmt(a.densidadMedia)}) | ${fmt(a.vecinos3, 1)} / ${fmt(a.vecinos8, 1)} | ${fmt(a.fraccionFueraDeZona, 2)} | ${fmtE(b.r)} | ${fmtE(b.nacimientos)} | ${fmtE(b.muertes)} | ${fmt(b.starvation.valor)} | ${fmt(b.dehydration.valor)} | ${fmt(b.exposure.valor)} | ${fmt(b.senescence.valor)} | ${fmtE(b.parejas)} | ${fmt(a.fraccionConPareja, 2)} | ${c.registro.dias.at(-1)?.vivos ?? '—'} | ${fmt(a.anchoBloqueSobrePersona, 2)} | ${fmt(c.msTotal / 60000, 1)} | ${fmt((c.registro.fin - c.registro.inicio) * 1000 / c.registro.dias.reduce((s, d) => s + d.msPared, 0), 1)} | ${fmt(c.carga.inicio[0]!, 1)}→${fmt(c.carga.fin[0]!, 1)} |`);
  }
  // Dos ejes: la densidad sembrada (la variable del diseño) y el apiñamiento vivido (vecinos a ≤ 8 celdas).
  const pendientes: Record<string, { sembrada: Estimacion; vivida: Estimacion }> = {};
  for (const semilla of [...new Set(completas.map(f => f.c.opciones.semilla))]) {
    const filasMapa = completas.filter(f => f.c.opciones.semilla === semilla);
    const puntos = (x: (a: Analisis) => number) => filasMapa.map(f => ({ densidad: x(f.a), r: f.a.bloques.r.valor, replicas: f.a.replicasR }));
    if (filasMapa.length >= 2) pendientes[semilla] = { sembrada: pendiente(puntos(a => a.densidadInicial)), vivida: pendiente(puntos(a => a.vecinos8)) };
  }
  lineas.push('', 'Pendiente de r por mapa: ' + Object.entries(pendientes).map(([s, e]) => `${s}: dr/d(densidad sembrada) ${fmtE(e.sembrada)} · dr/d(vecinos a ≤8) ${fmtE(e.vivida, 4)}`).join(' · '));
  const coherencia = coherenciaEscala(filas.map(f => f.c), comun, opciones.bloque);
  for (const k of coherencia) lineas.push(`Coherencia de escala, semilla ${k.semilla}: N=${k.n} entera r ${fmtE(k.entera.r)} · dos mitades N=${k.n / 2} r ${fmtE(k.mitades.r)} · diferencia r ${fmtE(k.diferencia.r)} → ${k.coinciden ? 'coinciden' : 'NO coinciden'} (b ${fmtE(k.diferencia.nacimientos)}, m ${fmtE(k.diferencia.muertes)}, parejas ${fmtE(k.diferencia.parejas)})`);
  lineas.push('', 'Serie diaria de r (sin ventana): ' + filas.map(f => `${f.c.opciones.semilla}/N${f.c.opciones.n}/${f.c.opciones.zona.ancho}: ${f.serie.map(s => fmt(s.tasas.r, 2)).join(' ')}`).join(' · '));
  const json = { ventana: { transitorio: comun, propios }, bloque: opciones.bloque, pendientes, coherencia,
    puntos: filas.map(({ c, a, serie }) => ({ archivo: c.archivo, semilla: c.opciones.semilla, siembra: c.opciones.siembra, n: c.opciones.n, zona: c.opciones.zona,
      caminables: c.registro.caminables, msTotal: c.msTotal, carga: c.carga, maxRssMiB: c.maxRssMiB, nFinal: c.registro.dias.at(-1)?.vivos, violaciones: c.registro.violaciones,
      piramideInicial: c.registro.piramideInicial, piramideFinal: c.registro.piramideFinal,
      serie: serie.map(s => ({ dia: s.dia, ...s.tasas, exposicion: s.grupo.exposicion })), ...a, replicasR: undefined })) };
  return { texto: lineas.join('\n'), json };
}

/** A la misma densidad, una corrida con N en la zona entera frente a dos con N/2 en sus dos mitades, sumadas. */
export function coherenciaEscala(corridas: readonly CorridaLeida[], transitorioDias: number, bloque: number) {
  const salida: { semilla: number; n: number; entera: Record<Tasa, Estimacion>; mitades: Record<Tasa, Estimacion>; diferencia: Record<Tasa, Estimacion>; coinciden: boolean }[] = [];
  for (const entera of corridas) {
    const z = entera.opciones.zona;
    const mitades = corridas.filter(c => c.opciones.semilla === entera.opciones.semilla && c.opciones.n * 2 === entera.opciones.n
      && c.opciones.zona.alto === z.alto && c.opciones.zona.y === z.y && c.opciones.zona.ancho * 2 === z.ancho && (c.opciones.zona.x === z.x || c.opciones.zona.x === z.x + z.ancho / 2));
    if (mitades.length !== 2 || mitades[0]!.opciones.zona.x === mitades[1]!.opciones.zona.x) continue;
    const grupos = (c: CorridaLeida) => agrupar(c.registro.individuos, c.registro.inicio + transitorioDias * DIA, c.registro.fin, claveBloque(c.registro.zona, bloque));
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
      case '--desde': o.desde = resolve(valor); break;
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

/** Corridas de la curva: cada N en la zona entera y, para la coherencia, N/2 en cada mitad con siembras propias. */
export function planCurva(semillas: number[], ns: number[], z: Zona, coherencia: number | undefined): { semilla: number; n: number; zona: Zona; siembra: number; nombre: string }[] {
  const plan: { semilla: number; n: number; zona: Zona; siembra: number; nombre: string }[] = [];
  for (const semilla of semillas) {
    for (const n of ns) plan.push({ semilla, n, zona: z, siembra: semilla, nombre: `${semilla}-n${n}` });
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
  let semillas = [7, 51926], ns = [50, 100, 200, 400], z: Zona = { x: 0, y: 0, ancho: 48, alto: 32 }, paralelo = 6, salida = '', coherencia: number | undefined;
  const resto: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const bandera = args[i]!, valor = args[i + 1]!;
    if (bandera === '--semillas') semillas = valor.split(',').map(s => entero(s, bandera));
    else if (bandera === '--n') ns = valor.split(',').map(s => entero(s, bandera, 1));
    else if (bandera === '--zona') z = zona(valor);
    else if (bandera === '--paralelo') paralelo = entero(valor, bandera, 1);
    else if (bandera === '--coherencia') coherencia = entero(valor, bandera, 2);
    else if (bandera === '--salida') salida = resolve(valor);
    else resto.push(bandera, valor);
  }
  if (!salida) throw new Error('Falta --salida');
  mkdirSync(salida, { recursive: true });
  // Las más caras primero: así la última en terminar no es una grande lanzada al final.
  const plan = planCurva(semillas, ns, z, coherencia).sort((a, b) => b.n * (a.zona.ancho) - a.n * (b.zona.ancho) || b.n - a.n);
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
  const { texto, json } = resumir(salida, { transitorio: 'auto', bloque: 8 });
  writeFileSync(join(salida, 'curva.json'), JSON.stringify(json, null, 2)); writeFileSync(join(salida, 'curva.md'), `${texto}\n`);
  process.stdout.write(`${texto}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [orden, ...args] = process.argv.slice(2);
  const fallo = (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1); };
  if (orden === 'correr') {
    try { correr(argumentosCorrida(args)); process.exit(0); } catch (error) { fallo(error); }
  } else if (orden === 'curva') curva(args).catch(fallo);
  else if (orden === 'resumir') {
    const dir = resolve(args[0] ?? '.'), t = args.indexOf('--transitorio'), b = args.indexOf('--bloque');
    const { texto, json } = resumir(dir, { transitorio: t >= 0 && args[t + 1] !== 'auto' ? entero(args[t + 1]!, '--transitorio') : 'auto', bloque: b >= 0 ? entero(args[b + 1]!, '--bloque', 1) : 8 });
    writeFileSync(join(dir, 'curva.json'), JSON.stringify(json, null, 2)); writeFileSync(join(dir, 'curva.md'), `${texto}\n`);
    process.stdout.write(`${texto}\n`);
  } else process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n') + '\n');
}
