/**
 * Equivalencia estadística de `choose` (M2b): corre un mundo del régimen abierto de un árbol cualquiera y registra
 * cada decisión (acción y distancia al objetivo) y lo que recorre cada persona por día; luego compara brazos con χ²
 * sobre las acciones y KS sobre las distancias.
 *
 *   tsx tests/v23-decision-equivalencia.ts correr --raiz <árbol> --semilla N --dias D [--hilos 32] --salida f.json
 *   tsx tests/v23-decision-equivalencia.ts analizar <brazoA> <brazoB> [<brazoC>]   (cada brazo: carpeta con f.json por semilla)
 *
 * Con `--hilos` la percepción va al doble de hilos de `v23-decision-hilos.ts` (solo existe en el árbol nuevo).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Corrida { raiz: string; semilla: number; dias: number; hilos: number; digesto: string; personasPorDia: number[];
  acciones: Record<string, number>; distObjetivo: number[]; recorrido: number[]; ms: number }

const args = process.argv.slice(2);
const opcion = (nombre: string) => { const i = args.indexOf(`--${nombre}`); return i >= 0 ? args[i + 1] : undefined; };

if (args[0] === 'correr') await correr();
else if (args[0] === 'analizar') analizar(args.slice(1));
else { console.error('uso: correr … | analizar …'); process.exit(2); }

async function correr(): Promise<void> {
  const raiz = resolve(opcion('raiz')!), semilla = Number(opcion('semilla')), dias = Number(opcion('dias')), hilos = Number(opcion('hilos') ?? 1);
  const imp = (p: string) => import(pathToFileURL(`${raiz}/${p}`).href);
  const { createWorld, stepWorld } = await imp('src/world/index.ts');
  const { parseParams } = await imp('src/world/params.ts');
  const { hostOpenWorldParams } = await imp('src/server/hardware-limits.ts');
  const { digestoCanonico } = await imp('src/world/digesto.ts');
  let params = hostOpenWorldParams();
  params = parseParams({ motor: { ...params.motor, hilos: 1, gpu: [] } }, params);
  const world = createWorld(semilla, params);
  let cerrar = async () => {};
  if (hilos > 1) {
    const { percepcionDe } = await imp('src/world/decision/percepcion.ts');
    const { PercibidorHilos } = await import(pathToFileURL(resolve(import.meta.dirname, 'v23-decision-hilos.ts')).href);
    const percepcion = percepcionDe(world), doble = new PercibidorHilos(percepcion.vista, hilos);
    percepcion.percibidor = doble;
    cerrar = () => doble.cerrar();
  }
  const r: Corrida = { raiz, semilla, dias, hilos, digesto: '', personasPorDia: [], acciones: {}, distObjetivo: [], recorrido: [], ms: 0 };
  const t0 = performance.now();
  type P = { id: string; x: number; y: number; action: string; decisionAt: number; target: { x: number; y: number } };
  for (let dia = 0; dia < dias; dia++) {
    const andado = new Map<string, number>();
    for (let t = 0; t < 2400; t++) {
      const antes = new Map((world.people as P[]).map(p => [p.id, { x: p.x, y: p.y, decisionAt: p.decisionAt }]));
      stepWorld(world);
      for (const p of world.people as P[]) {
        const a = antes.get(p.id);
        if (!a) continue;
        andado.set(p.id, (andado.get(p.id) ?? 0) + Math.hypot(p.x - a.x, p.y - a.y));
        if (p.decisionAt !== a.decisionAt) {
          r.acciones[p.action] = (r.acciones[p.action] ?? 0) + 1;
          r.distObjetivo.push(Math.hypot(p.target.x - p.x, p.target.y - p.y));
        }
      }
    }
    r.recorrido.push(...andado.values());
    r.personasPorDia.push(world.people.length);
  }
  await cerrar();
  r.ms = performance.now() - t0;
  r.digesto = digestoCanonico(world);
  writeFileSync(opcion('salida')!, JSON.stringify(r));
  console.log(JSON.stringify({ semilla, hilos, personas: r.personasPorDia, decisiones: r.distObjetivo.length, ms: Math.round(r.ms), digesto: r.digesto }));
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
function gammaQ(s: number, x: number): number {
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

/** χ² de homogeneidad de dos recuentos por categoría (las categorías con esperado < 5 se juntan en «otras»). */
function chi2(a: Record<string, number>, b: Record<string, number>): { chi2: number; gl: number; p: number; v: number } {
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
  return { chi2: x2, gl, p: gl > 0 ? gammaQ(gl / 2, x2 / 2) : 1, v: Math.sqrt(x2 / n) };
}

/** KS de dos muestras: D y p asintótico (Kolmogorov) con n efectivo = n·m/(n+m). */
function ks(a: number[], b: number[]): { d: number; p: number } {
  const x = Float64Array.from(a).sort(), y = Float64Array.from(b).sort();
  let i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i]!, y[j]!);
    while (i < x.length && x[i]! <= v) i++;
    while (j < y.length && y[j]! <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const ne = x.length * y.length / (x.length + y.length), l = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d;
  let p = 0;
  for (let k = 1; k <= 100; k++) p += 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * l * l);
  return { d, p: Math.min(1, Math.max(0, p)) };
}

/** Distancia de variación total entre dos distribuciones de acciones. */
function dvt(a: Record<string, number>, b: Record<string, number>): number {
  const na = Object.values(a).reduce((s, x) => s + x, 0), nb = Object.values(b).reduce((s, x) => s + x, 0);
  let s = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) s += Math.abs((a[k] ?? 0) / na - (b[k] ?? 0) / nb);
  return s / 2;
}

function analizar(carpetas: string[]): void {
  const brazos = carpetas.map(c => new Map(readdirSync(c).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(resolve(c, f), 'utf8')) as Corrida).map(r => [r.semilla, r])));
  const semillas = [...brazos[0]!.keys()].filter(s => brazos.every(b => b.has(s))).sort((x, y) => x - y);
  const juntar = (b: Map<number, Corrida>) => {
    const acciones: Record<string, number> = {}, distObjetivo: number[] = [], recorrido: number[] = [];
    for (const s of semillas) {
      const r = b.get(s)!;
      for (const [k, v] of Object.entries(r.acciones)) acciones[k] = (acciones[k] ?? 0) + v;
      distObjetivo.push(...r.distObjetivo); recorrido.push(...r.recorrido);
    }
    return { acciones, distObjetivo, recorrido };
  };
  const base = brazos[0]!, fmt = (p: number) => p < 1e-4 ? p.toExponential(2) : p.toFixed(4);
  console.log(`semillas: ${semillas.join(', ')}\n`);
  for (let k = 1; k < brazos.length; k++) {
    const otro = brazos[k]!;
    console.log(`## ${carpetas[0]} frente a ${carpetas[k]}\n`);
    console.log('| semilla | decisiones A | decisiones B | χ² acciones (gl) | p | V de Cramér | DVT | KS dist. objetivo D | p | KS recorrido D | p | digesto igual |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of semillas) {
      const a = base.get(s)!, b = otro.get(s)!, c = chi2(a.acciones, b.acciones);
      const ko = ks(a.distObjetivo, b.distObjetivo), kr = ks(a.recorrido, b.recorrido);
      console.log(`| ${s} | ${a.distObjetivo.length} | ${b.distObjetivo.length} | ${c.chi2.toFixed(1)} (${c.gl}) | ${fmt(c.p)} | ${c.v.toFixed(4)} | ${dvt(a.acciones, b.acciones).toFixed(4)} | ${ko.d.toFixed(4)} | ${fmt(ko.p)} | ${kr.d.toFixed(4)} | ${fmt(kr.p)} | ${a.digesto === b.digesto ? 'sí' : 'no'} |`);
    }
    const A = juntar(base), B = juntar(otro), c = chi2(A.acciones, B.acciones), ko = ks(A.distObjetivo, B.distObjetivo), kr = ks(A.recorrido, B.recorrido);
    console.log(`| **juntas** | ${A.distObjetivo.length} | ${B.distObjetivo.length} | ${c.chi2.toFixed(1)} (${c.gl}) | ${fmt(c.p)} | ${c.v.toFixed(4)} | ${dvt(A.acciones, B.acciones).toFixed(4)} | ${ko.d.toFixed(4)} | ${fmt(ko.p)} | ${kr.d.toFixed(4)} | ${fmt(kr.p)} | |\n`);
    // Referencia de ruido: lo que difieren dos semillas del MISMO brazo (mundos caóticos: cada corrida es una muestra).
    const entre = (b: Map<number, Corrida>) => {
      const v: number[] = [];
      for (let i = 0; i < semillas.length; i++) for (let j = i + 1; j < semillas.length; j++) v.push(dvt(b.get(semillas[i]!)!.acciones, b.get(semillas[j]!)!.acciones));
      return v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
    };
    const misma = semillas.map(s => dvt(base.get(s)!.acciones, otro.get(s)!.acciones));
    console.log(`DVT media misma semilla A↔B: ${(misma.reduce((x, y) => x + y, 0) / misma.length).toFixed(4)}; entre semillas dentro de A: ${entre(base).toFixed(4)}; dentro de B: ${entre(otro).toFixed(4)}\n`);
  }
  // Las decisiones de una corrida no son independientes (un mundo caótico es UNA muestra por semilla): la prueba
  // honesta es por semilla, emparejada, con el signo de la diferencia permutado (2^semillas casos, exacta).
  const signos = (d: number[]) => {
    const media = Math.abs(d.reduce((x, y) => x + y, 0)) / d.length;
    let extremos = 0;
    for (let m = 0; m < 1 << d.length; m++) {
      const v = Math.abs(d.reduce((x, y, i) => x + (m >> i & 1 ? -y : y), 0)) / d.length;
      if (v >= media - 1e-15) extremos++;
    }
    return { media: d.reduce((x, y) => x + y, 0) / d.length, p: extremos / (1 << d.length) };
  };
  const media = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const parte = (r: Corrida, k: string) => (r.acciones[k] ?? 0) / Object.values(r.acciones).reduce((x, y) => x + y, 0);
  const A = juntar(base);
  const principales = Object.entries(A.acciones).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k]) => k);
  for (let k = 1; k < brazos.length; k++) {
    const otro = brazos[k]!;
    console.log(`## Por semilla, emparejado (${carpetas[0]} → ${carpetas[k]}): diferencia media y p exacto de signos\n`);
    console.log('| medida | ' + semillas.join(' | ') + ' | media | p |');
    console.log('|---|' + semillas.map(() => '---|').join('') + '---|---|');
    const fila = (nombre: string, f: (r: Corrida) => number, escala = 1, dec = 2) => {
      const d = semillas.map(s => (f(otro.get(s)!) - f(base.get(s)!)) * escala), t = signos(d);
      console.log(`| ${nombre} | ${d.map(x => x.toFixed(dec)).join(' | ')} | ${t.media.toFixed(dec)} | ${t.p.toFixed(3)} |`);
    };
    for (const a of principales) fila(`% ${a}`, r => parte(r, a), 100);
    fila('dist. objetivo media', r => media(r.distObjetivo), 1, 3);
    fila('recorrido por persona y día', r => media(r.recorrido), 1, 2);
    fila('personas el último día', r => r.personasPorDia.at(-1)!, 1, 1);
    console.log('');
  }
  const total = Object.values(A.acciones).reduce((s, x) => s + x, 0);
  console.log('Acciones (A, juntas): ' + Object.entries(A.acciones).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${(100 * v / total).toFixed(1)} %`).join(', '));
}
