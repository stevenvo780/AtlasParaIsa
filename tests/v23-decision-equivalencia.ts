/**
 * Equivalencia estadística de `choose` (M2b) entre dos árboles del motor, en el régimen abierto.
 *
 *   tsx tests/v23-decision-equivalencia.ts preparar --raiz <árbol> --destino <copia>
 *   tsx tests/v23-decision-equivalencia.ts correr --raiz <copia> --semilla N --orden K --dias D [--hilos 32 [--tanda 2]] [--residente] --salida f.json
 *   tsx tests/v23-decision-equivalencia.ts analizar <brazoA> <brazoB>        (cada brazo: carpeta con <semilla>-<orden>.json)
 *
 * `preparar` copia `src/` del árbol e inyecta en `choose`, justo después de fijar `decisionAt`, una llamada a
 * `globalThis.__eleccionM2b`: así se cuenta cada elección de verdad (no cada cambio de calendario, que también hacen
 * beber, acabar un trabajo o quedarse sin objetivo) con su acción y la distancia al objetivo ANTES de moverse, y el
 * código que se publica no lleva el gancho. Los dos brazos se preparan igual.
 *
 * Réplicas: `--orden K` (K ≥ 1) permuta `world.people` al crear el mundo con una permutación fija de (semilla, K); la 0
 * es el orden de siempre. Los dos motores corren los mismos órdenes, así que cada par (semilla, orden) es una
 * comparación emparejada, el orden mide la dispersión entre corridas independientes del mismo motor y su interacción
 * con el motor se estima aparte. Con `--hilos` la percepción va al doble de hilos de `v23-decision-hilos.ts`, en tandas
 * de `--tanda` slots (64 por defecto; con pocas personas, una tanda pequeña es lo que reparte el lote entre hilos).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Corrida {
  raiz: string; semilla: number; orden: number; dias: number; hilos: number; residente: boolean; digesto: string;
  personasPorDia: number[]; hambrePorDia: number[]; nacimientos: number; muertes: number;
  acciones: Record<string, number>; accionesPorDia: Record<string, number>[]; anidadas: number;
  distObjetivo: number[]; recorrido: number[]; ms: number; hilosConFilas?: number; despachosRepartidos?: number;
}

const ANCLA = 'person.decisionAt = world.tick + (selected === restCandidate && recoverWater ? 1 : 30);';
const GANCHO = '  (globalThis as { __eleccionM2b?: (w: unknown, p: unknown, anidada: boolean) => void }).__eleccionM2b?.(world, person, !own);';

// ── Corridas ─────────────────────────────────────────────────────────────────────────────────────────────

function preparar(raiz: string, destino: string): void {
  if (existsSync(destino)) throw new Error(`${destino} ya existe`);
  mkdirSync(destino, { recursive: true });
  for (const f of ['src', 'package.json', 'tsconfig.json']) cpSync(resolve(raiz, f), resolve(destino, f), { recursive: true });
  symlinkSync(resolve(raiz, 'node_modules'), resolve(destino, 'node_modules'));
  const fichero = resolve(destino, 'src/world/decision/personas.ts'), texto = readFileSync(fichero, 'utf8');
  if (texto.split(ANCLA).length !== 2) throw new Error(`El ancla de choose no aparece una sola vez en ${fichero}`);
  writeFileSync(fichero, texto.replace(ANCLA, `${ANCLA}\n${GANCHO}`));
}

/** Permutación fija de `n` posiciones para (semilla, orden): Fisher–Yates con mulberry32; el orden 0 es la identidad. */
export function permutacion(n: number, semilla: number, orden: number): number[] {
  const indices = Array.from({ length: n }, (_, i) => i);
  if (orden === 0) return indices;
  let a = (semilla * 7919 + orden * 104729) >>> 0;
  const azar = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(azar() * (i + 1)); [indices[i], indices[j]] = [indices[j]!, indices[i]!]; }
  return indices;
}

async function correr(opcion: (nombre: string) => string | undefined, banderas: readonly string[]): Promise<void> {
  const raiz = resolve(opcion('raiz')!), semilla = Number(opcion('semilla')), orden = Number(opcion('orden') ?? 0);
  const dias = Number(opcion('dias')), hilos = Number(opcion('hilos') ?? 1), residente = banderas.includes('--residente');
  const imp = (p: string) => import(pathToFileURL(`${raiz}/${p}`).href);
  const { createWorld, stepWorld } = await imp('src/world/index.ts');
  const { parseParams } = await imp('src/world/params.ts');
  const { hostOpenWorldParams } = await imp('src/server/hardware-limits.ts');
  const { digestoCanonico } = await imp('src/world/digesto.ts');
  let params = hostOpenWorldParams();
  params = parseParams({ motor: { ...params.motor, hilos: residente ? 2 : 1, gpu: [] } }, params);
  const world = createWorld(semilla, params);
  if (residente) {
    const { ResidentTopologyOwner } = await imp('src/world/soa/topologia.ts');
    const { bindWorldContext, worldContext } = await imp('src/world/spatial.ts');
    const dueno = new ResidentTopologyOwner();
    world.tiles = dueno.tiles(world.tiles.map((t: unknown) => dueno.tile(t)));
    bindWorldContext(world, { ...worldContext(world), tileOwnership: dueno });
  }
  world.people = permutacion(world.people.length, semilla, orden).map((i: number) => world.people[i]);
  let cerrar = async () => {};
  if (hilos > 1) {
    const { percepcionDe } = await imp('src/world/decision/percepcion.ts');
    const { PercibidorHilos } = await import(pathToFileURL(resolve(import.meta.dirname, 'v23-decision-hilos.ts')).href);
    const percepcion = percepcionDe(world), doble = new PercibidorHilos(percepcion.vista, hilos, Number(opcion('tanda') ?? 64));
    percepcion.percibidor = doble;
    cerrar = async () => {
      await doble.cerrar();
      if (percepcion.respaldos > 0) throw new Error(`${percepcion.respaldos} despachos recalculados en CPU`);
      r.hilosConFilas = doble.filasPorHilo.filter((f: number) => f > 0).length; r.despachosRepartidos = doble.despachosRepartidos;
    };
  }
  const r: Corrida = { raiz, semilla, orden, dias, hilos, residente, digesto: '', personasPorDia: [], hambrePorDia: [], nacimientos: 0, muertes: 0,
    acciones: {}, accionesPorDia: [], anidadas: 0, distObjetivo: [], recorrido: [], ms: 0 };
  type P = { id: string; x: number; y: number; action: string; hunger: number; target: { x: number; y: number } };
  let delDia: Record<string, number> = {};
  (globalThis as { __eleccionM2b?: unknown }).__eleccionM2b = (w: unknown, p: P, anidada: boolean) => {
    if (w !== world) return;
    if (anidada) { r.anidadas++; return; }
    r.acciones[p.action] = (r.acciones[p.action] ?? 0) + 1;
    delDia[p.action] = (delDia[p.action] ?? 0) + 1;
    r.distObjetivo.push(Math.hypot(p.target.x - p.x, p.target.y - p.y));
  };
  const t0 = performance.now(), nacidos0 = world.birthCounter as number;
  for (let dia = 0; dia < dias; dia++) {
    const andado = new Map<string, number>();
    delDia = {};
    for (let t = 0; t < 2400; t++) {
      const antes = new Map((world.people as P[]).map(p => [p.id, { x: p.x, y: p.y }]));
      stepWorld(world);
      for (const p of world.people as P[]) {
        const a = antes.get(p.id);
        if (a) andado.set(p.id, (andado.get(p.id) ?? 0) + Math.hypot(p.x - a.x, p.y - a.y));
        antes.delete(p.id);
      }
      r.muertes += antes.size;
    }
    r.recorrido.push(...andado.values());
    r.personasPorDia.push(world.people.length);
    r.hambrePorDia.push((world.people as P[]).reduce((s, p) => s + p.hunger, 0) / Math.max(1, world.people.length));
    r.accionesPorDia.push(delDia);
  }
  await cerrar();
  r.ms = performance.now() - t0;
  r.nacimientos = (world.birthCounter as number) - nacidos0;
  r.digesto = digestoCanonico(world);
  writeFileSync(opcion('salida')!, JSON.stringify(r));
  console.log(JSON.stringify({ semilla, orden, hilos, residente, personas: r.personasPorDia, decisiones: r.distObjetivo.length, ms: Math.round(r.ms),
    hilosConFilas: r.hilosConFilas, despachosRepartidos: r.despachosRepartidos, digesto: r.digesto }));
}

// ── Estadística ──────────────────────────────────────────────────────────────────────────────────────────

/** ln Γ(x) (Lanczos, g = 7). */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Q(s, x) = Γ(s, x)/Γ(s): serie para x < s + 1, fracción continua en otro caso (Numerical Recipes). */
export function gammaQ(s: number, x: number): number {
  if (x <= 0) return 1;
  if (x < s + 1) {
    let suma = 1 / s, termino = suma;
    for (let n = 1; n < 1000; n++) { termino *= x / (s + n); suma += termino; if (Math.abs(termino) < Math.abs(suma) * 1e-15) break; }
    return 1 - suma * Math.exp(-x + s * Math.log(x) - lnGamma(s));
  }
  let b = x + 1 - s, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + s * Math.log(x) - lnGamma(s)) * h;
}

/** Beta incompleta regularizada I_x(a, b) por fracción continua (Numerical Recipes). */
function betaI(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const frente = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (a: number, b: number, x: number) => {
    let c = 1, d = 1 - (a + b) * x / (a + 1);
    d = Math.abs(d) < 1e-300 ? 1e-300 : d; d = 1 / d;
    let h = d;
    for (let m = 1; m < 300; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d; d = Math.abs(d) < 1e-300 ? 1e-300 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c; d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d; d = Math.abs(d) < 1e-300 ? 1e-300 : d; c = 1 + aa / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c; d = 1 / d;
      const delta = d * c; h *= delta;
      if (Math.abs(delta - 1) < 1e-15) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? frente * cf(a, b, x) / a : 1 - frente * cf(b, a, 1 - x) / b;
}

/** P(T ≤ t) con T de Student de `gl` grados de libertad. */
export function tAcumulada(t: number, gl: number): number {
  const cola = 0.5 * betaI(gl / 2, 0.5, gl / (gl + t * t));
  return t >= 0 ? 1 - cola : cola;
}
/** Cuantil `p` de Student con `gl` grados de libertad (bisección). */
export function tCuantil(p: number, gl: number): number {
  let lo = -1e3, hi = 1e3;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tAcumulada(m, gl) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** χ² de homogeneidad de dos recuentos por categoría (las categorías con esperado < 5 se juntan en «otras»). */
export function chi2(a: Record<string, number>, b: Record<string, number>): { chi2: number; gl: number; p: number; v: number } {
  const na = Object.values(a).reduce((s, x) => s + x, 0), nb = Object.values(b).reduce((s, x) => s + x, 0), n = na + nb;
  const filas: [number, number][] = [];
  let otras: [number, number] = [0, 0];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const fila: [number, number] = [a[k] ?? 0, b[k] ?? 0];
    if (Math.min(na, nb) * (fila[0] + fila[1]) / n < 5) otras = [otras[0] + fila[0], otras[1] + fila[1]]; else filas.push(fila);
  }
  if (otras[0] + otras[1] > 0) filas.push(otras);
  let x2 = 0;
  for (const [oa, ob] of filas) {
    const t = oa + ob, ea = t * na / n, eb = t * nb / n;
    x2 += (oa - ea) ** 2 / ea + (ob - eb) ** 2 / eb;
  }
  const gl = filas.length - 1;
  return { chi2: x2, gl, p: gl > 0 ? gammaQ(gl / 2, x2 / 2) : 1, v: n > 0 ? Math.sqrt(x2 / n) : 0 };
}

/** Q_KS(λ) = P(√n·D > λ) de Kolmogorov. La serie alterna 2Σ(−1)^{k−1}e^{−2k²λ²} no converge cerca de 0 (con λ = 0 sus
 * términos se cancelan y daba 0): por debajo de 1,18 se usa la forma de Jacobi, que converge allí. */
export function qKolmogorov(l: number): number {
  if (!(l > 0)) return 1;
  if (l < 1.18) {
    const y = Math.exp(-Math.PI * Math.PI / (8 * l * l));
    let s = 0;
    for (let k = 1; k <= 30; k++) s += y ** ((2 * k - 1) ** 2);
    return Math.min(1, Math.max(0, 1 - Math.sqrt(2 * Math.PI) / l * s));
  }
  const x = Math.exp(-2 * l * l);
  let s = 0;
  for (let k = 1; k <= 100; k++) { const t = (k % 2 ? 1 : -1) * x ** (k * k); s += t; if (Math.abs(t) < 1e-17) break; }
  return Math.min(1, Math.max(0, 2 * s));
}

/** KS de dos muestras: D y p asintótico (Kolmogorov) con n efectivo = n·m/(n+m). */
export function ks(a: readonly number[], b: readonly number[]): { d: number; p: number } {
  const x = Float64Array.from(a).sort(), y = Float64Array.from(b).sort();
  let i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i]!, y[j]!);
    while (i < x.length && x[i]! <= v) i++;
    while (j < y.length && y[j]! <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const ne = x.length * y.length / (x.length + y.length), l = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d;
  return { d, p: qKolmogorov(l) };
}

/** Distancia de variación total entre dos distribuciones de acciones. */
export function dvt(a: Record<string, number>, b: Record<string, number>): number {
  const na = Object.values(a).reduce((s, x) => s + x, 0), nb = Object.values(b).reduce((s, x) => s + x, 0);
  let s = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) s += Math.abs((a[k] ?? 0) / na - (b[k] ?? 0) / nb);
  return s / 2;
}

const media = (v: readonly number[]) => v.reduce((x, y) => x + y, 0) / v.length;
const varianza = (v: readonly number[]) => { const m = media(v); return v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1); };

/** Prueba exacta de signos permutados (dos colas) de media cero: 2^n casos; con n > 20, 2^20 al azar con semilla fija. */
export function signos(d: readonly number[]): { media: number; p: number } {
  const m = Math.abs(media(d)), n = d.length, exhaustiva = n <= 20, casos = exhaustiva ? 2 ** n : 2 ** 20;
  let extremos = 0, a = 12345;
  for (let c = 0; c < casos; c++) {
    let mascara = c;
    if (!exhaustiva) { a = (a * 1103515245 + 12345) >>> 0; mascara = a; }
    let s = 0;
    for (let i = 0; i < n; i++) s += (exhaustiva ? (mascara >> i) & 1 : (Math.imul(mascara, i + 1) >>> 7) & 1) ? -d[i]! : d[i]!;
    if (Math.abs(s) / n >= m - 1e-12) extremos++;
  }
  return { media: media(d), p: extremos / casos };
}

/**
 * Comparación emparejada de una medida entre dos brazos sobre las mismas (semilla, orden).
 * - `porPar`: la diferencia de cada par como unidad (supone que los órdenes de una semilla son réplicas independientes).
 * - `porSemilla`: la media de cada semilla como unidad (conservadora: absorbe cualquier interacción semilla × motor).
 * - `ic`: intervalo t bilateral de nivel 1 − 2α (TOST) con unidad semilla; `equivalente` si cabe en ±margen.
 * - `necesarias`: semillas (con los mismos órdenes por semilla) para que ese intervalo quepa en ±margen con potencia 0,8
 *   si la diferencia real fuera 0, con la varianza observada entre semillas; `necesariasCaos`, las mismas si los dos
 *   motores divergieran como dos réplicas independientes (varianza 2·σ²orden/K por semilla con K órdenes).
 * - `sigmaOrden`: dispersión entre corridas independientes del mismo motor (desviación entre órdenes de una semilla,
 *   juntada); `sigmaInteraccion`: la de la diferencia entre motores de un orden a otro (orden × motor).
 */
export function emparejar(pares: readonly { semilla: number; a: number; b: number }[], alfa: number, margen: number) {
  const semillas = [...new Set(pares.map(p => p.semilla))].sort((x, y) => x - y);
  const d = pares.map(p => p.b - p.a);
  const porSemilla = semillas.map(s => media(pares.filter(p => p.semilla === s).map(p => p.b - p.a)));
  const S = semillas.length, se = Math.sqrt(varianza(porSemilla) / S);
  const t = S > 1 ? tCuantil(1 - alfa, S - 1) : Infinity, mediaD = media(d);
  const ic: [number, number] = [media(porSemilla) - t * se, media(porSemilla) + t * se];
  let sOrden = 0, gOrden = 0, sInter = 0, gInter = 0;
  for (const s of semillas) {
    const deS = pares.filter(p => p.semilla === s);
    if (deS.length < 2) continue;
    for (const v of [deS.map(p => p.a), deS.map(p => p.b)]) { sOrden += varianza(v) * (v.length - 1); gOrden += v.length - 1; }
    const dif = deS.map(p => p.b - p.a);
    sInter += varianza(dif) * (dif.length - 1); gInter += dif.length - 1;
  }
  const z = (p: number) => tCuantil(p, 1e6), sigmaSemilla = Math.sqrt(varianza(porSemilla));
  const necesarias = Math.ceil(((z(1 - alfa) + z(0.8)) * sigmaSemilla / margen) ** 2);
  const sigmaOrden = gOrden ? Math.sqrt(sOrden / gOrden) : NaN, K = pares.length / S;
  const necesariasCaos = Math.ceil(((z(1 - alfa) + z(0.8)) * sigmaOrden * Math.sqrt(2 / K) / margen) ** 2);
  return {
    mediaD, porPar: signos(d), porSemilla: signos(porSemilla), ic, equivalente: ic[0] > -margen && ic[1] < margen, necesarias, necesariasCaos,
    sigmaSemilla, sigmaOrden, sigmaInteraccion: gInter ? Math.sqrt(sInter / gInter) : NaN,
  };
}

// ── Análisis ─────────────────────────────────────────────────────────────────────────────────────────────

function cargar(carpeta: string): Map<string, Corrida> {
  return new Map(readdirSync(carpeta).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(resolve(carpeta, f), 'utf8')) as Corrida).map(r => [`${r.semilla}-${r.orden ?? 0}`, r]));
}

const parte = (r: Corrida, k: string) => (r.acciones[k] ?? 0) / Object.values(r.acciones).reduce((x, y) => x + y, 0);

function analizar(carpetas: string[]): void {
  const [A, B] = carpetas.map(cargar) as [Map<string, Corrida>, Map<string, Corrida>];
  const claves = [...A.keys()].filter(k => B.has(k)).sort((x, y) => { const [a, b] = [x.split('-').map(Number), y.split('-').map(Number)]; return a[0]! - b[0]! || a[1]! - b[1]!; });
  const semillas = [...new Set(claves.map(k => A.get(k)!.semilla))];
  const fmt = (p: number) => p < 1e-4 ? p.toExponential(2) : p.toFixed(4);
  console.log(`# ${carpetas[0]} → ${carpetas[1]}\n\npares (semilla-orden): ${claves.join(', ')}\n`);
  console.log(`digestos iguales: ${claves.filter(k => A.get(k)!.digesto === B.get(k)!.digesto).length} de ${claves.length}\n`);

  const juntas: Record<string, number> = {};
  for (const k of claves) for (const [a, v] of Object.entries(A.get(k)!.acciones)) juntas[a] = (juntas[a] ?? 0) + v;
  const total = Object.values(juntas).reduce((s, x) => s + x, 0);
  const principales = Object.entries(juntas).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k]) => k);
  console.log('Acciones de A, juntas: ' + Object.entries(juntas).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${(100 * v / total).toFixed(1)} %`).join(', ') + '\n');

  // Simultáneo sobre las 8 acciones (Bonferroni) a α = 0,05: cada TOST con α/8.
  const alfa = 0.05 / principales.length;
  console.log(`## Emparejado por (semilla, orden): diferencia B − A, TOST a ±1 pp con α = 0,05/${principales.length} por acción (IC ${(100 * (1 - 2 * alfa)).toFixed(2)} %, unidad semilla)\n`);
  console.log('| medida | media B−A | p signos por par | p signos por semilla | IC unidad semilla | ¿equivalente? | σ entre semillas | σ entre órdenes (mismo motor) | σ orden × motor | semillas necesarias | ídem si divergieran como dos órdenes |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const fila = (nombre: string, f: (r: Corrida) => number, escala: number, margen: number, dec: number) => {
    const pares = claves.map(k => ({ semilla: A.get(k)!.semilla, a: f(A.get(k)!) * escala, b: f(B.get(k)!) * escala }));
    const e = emparejar(pares, alfa, margen);
    console.log(`| ${nombre} | ${e.mediaD.toFixed(dec)} | ${e.porPar.p.toFixed(4)} | ${e.porSemilla.p.toFixed(3)} | [${e.ic[0].toFixed(dec)}, ${e.ic[1].toFixed(dec)}] | ${Number.isFinite(margen) ? (e.equivalente ? 'sí' : 'no') : '—'} | ${e.sigmaSemilla.toFixed(dec)} | ${e.sigmaOrden.toFixed(dec)} | ${e.sigmaInteraccion.toFixed(dec)} | ${Number.isFinite(margen) ? e.necesarias : '—'} | ${Number.isFinite(margen) ? e.necesariasCaos : '—'} |`);
  };
  for (const a of principales) fila(`% ${a}`, r => parte(r, a), 100, 1, 2);
  fila('dist. objetivo media', r => media(r.distObjetivo), 1, Infinity, 3);
  fila('recorrido por persona y día', r => media(r.recorrido), 1, Infinity, 2);
  fila('personas el último día', r => r.personasPorDia.at(-1)!, 1, Infinity, 2);
  fila('hambre media el último día', r => r.hambrePorDia.at(-1)!, 1, Infinity, 4);
  fila('nacimientos', r => r.nacimientos, 1, Infinity, 2);
  fila('muertes', r => r.muertes, 1, Infinity, 2);
  console.log('');

  // Referencia: las mismas medidas entre órdenes del MISMO motor (orden 0 frente a los demás): lo que mueve el caos solo.
  const ordenes = [...new Set(claves.map(k => A.get(k)!.orden))].filter(o => o !== 0);
  if (ordenes.length) {
    console.log('## Referencia de caos: mismo motor, orden 0 frente a otro orden (|diferencia| media por par)\n');
    console.log('| medida | A: orden 0 ↔ k | B: orden 0 ↔ k | A ↔ B mismo orden |');
    console.log('|---|---|---|---|');
    for (const a of principales) {
      const mismo = (M: Map<string, Corrida>) => media(semillas.flatMap(s => ordenes.filter(o => M.has(`${s}-${o}`) && M.has(`${s}-0`))
        .map(o => Math.abs(parte(M.get(`${s}-${o}`)!, a) - parte(M.get(`${s}-0`)!, a)) * 100)));
      const cruz = media(claves.map(k => Math.abs(parte(B.get(k)!, a) - parte(A.get(k)!, a)) * 100));
      console.log(`| % ${a} | ${mismo(A).toFixed(2)} | ${mismo(B).toFixed(2)} | ${cruz.toFixed(2)} |`);
    }
    console.log('');
  }

  // Lo de antes, con su advertencia: las decisiones de una corrida no son independientes, así que estos p son anticonservadores.
  const sumar = (M: Map<string, Corrida>) => {
    const acciones: Record<string, number> = {}, dist: number[] = [], rec: number[] = [];
    for (const k of claves) { const r = M.get(k)!; for (const [a, v] of Object.entries(r.acciones)) acciones[a] = (acciones[a] ?? 0) + v; dist.push(...r.distObjetivo); rec.push(...r.recorrido); }
    return { acciones, dist, rec };
  };
  const [sa, sb] = [sumar(A), sumar(B)], c = chi2(sa.acciones, sb.acciones), ko = ks(sa.dist, sb.dist), kr = ks(sa.rec, sb.rec);
  console.log('## Todo junto (anticonservador: trata como independientes decisiones de una misma corrida)\n');
  console.log(`χ² acciones ${c.chi2.toFixed(1)} (${c.gl} gl), p ${fmt(c.p)}, V ${c.v.toFixed(4)}, DVT ${dvt(sa.acciones, sb.acciones).toFixed(4)}; KS distancia al objetivo D ${ko.d.toFixed(4)} p ${fmt(ko.p)}; KS recorrido D ${kr.d.toFixed(4)} p ${fmt(kr.p)}`);
  const dias = Math.min(...claves.flatMap(k => [A.get(k)!.accionesPorDia.length, B.get(k)!.accionesPorDia.length]));
  console.log('DVT por día A↔B (media de pares): ' + Array.from({ length: dias }, (_, d) => media(claves.map(k => dvt(A.get(k)!.accionesPorDia[d]!, B.get(k)!.accionesPorDia[d]!))).toFixed(4)).join(', '));
  console.log(`anidadas A ${claves.reduce((s, k) => s + A.get(k)!.anidadas, 0)}, B ${claves.reduce((s, k) => s + B.get(k)!.anidadas, 0)}; ms medios A ${Math.round(media(claves.map(k => A.get(k)!.ms)))}, B ${Math.round(media(claves.map(k => B.get(k)!.ms)))}`);
}

// ── Orden ────────────────────────────────────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opcion = (nombre: string) => { const i = args.indexOf(`--${nombre}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === 'preparar') preparar(resolve(opcion('raiz')!), resolve(opcion('destino')!));
  else if (args[0] === 'correr') await correr(opcion, args);
  else if (args[0] === 'analizar') analizar(args.slice(1));
  else { console.error('uso: preparar … | correr … | analizar …'); process.exit(2); }
}
