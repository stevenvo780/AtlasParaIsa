/**
 * scripts/lab/calibrar-c8.mts — calibración del criterio C8 (diversidad creciente) del preregistro v2.
 *
 *   npx tsx scripts/lab/calibrar-c8.mts [--series 1000] [--semilla 20260922] [--salida calibracion.json]
 *
 * Genera series SINTÉTICAS (no lee ninguna réplica) con un PRNG determinista propio y mide con qué
 * frecuencia C8 dice «cumple» con cada regla. Mide la función que usa el evaluador
 * (`evaluarSerieDiversidad` de criterio-terminado.mts), no una copia.
 *
 * Casos, días 1..D con D = 60 y D = 30 (C8 mira los días 5..D):
 *   estacionaria     0,3 + U(−0,1; 0,1) independiente cada día (desviación típica 0,058)
 *   ar1              0,3 + e_d, e_d = 0,7·e_{d−1} + U(−0,1; 0,1) (AR(1) φ = 0,7; desviación marginal 0,081)
 *   ar1-var          igual con innovación √(1 − 0,7²)·U(−0,1; 0,1): misma desviación marginal (0,058) que la estacionaria
 *   sube-0.001       0,3 + 0,001·(d − 5) + U(−0,1; 0,1)
 *   sube-0.003       0,3 + 0,003·(d − 5) + U(−0,1; 0,1)
 *   baja-0.001       0,3 − 0,001·(d − 5) + U(−0,1; 0,1)
 *   paseo            informativo: 0,3 + Σ U(−0,03; 0,03), paseo aleatorio (no estacionario; sin cota en el preregistro)
 *   satura           informativo: 0,3 + 0,2·(1 − e^{−(d−5)/10}) + U(−0,1; 0,1), crecimiento que se aplana (potencia)
 * El AR(1) arranca tras 100 pasos de calentamiento (estado estacionario). Todo valor se acota a [0, 1]
 * (en los casos del preregistro ninguno sale de [0,03; 0,63]: la cota no actúa).
 *
 * Reglas medidas: C8 v2 por defecto (Mann-Kendall p < 0,05 con Var(S) corregida por el mayor de los factores
 * de Hamed-Rao y AR(1), y subida de Sen ≥ 0,02), la misma solo con Hamed-Rao y sin corrección, y las reglas
 * v1 «o» y «y» (pendiente MCO / bloques).
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UMBRALES_POR_DEFECTO, evaluarSerieDiversidad, type Umbrales } from './criterio-terminado.mjs';

/** mulberry32 (Tommy Ettinger): 32 bits de estado, uniforme en [0, 1). Determinista y sin dependencias. */
export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a de 32 bits: una semilla por caso y horizonte, independiente del orden en que se calculen. */
function fnv1a(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

const BASE = UMBRALES_POR_DEFECTO.diaBaseDiversidad;
const ruido = (rnd: () => number) => 0.2 * (rnd() - 0.5);

export interface Caso { id: string; descripcion: string; informativo?: boolean; generar: (D: number, rnd: () => number) => number[] }

/** Serie de los días 0..D (índice = día; el 0 no se usa). */
const tendencia = (pendiente: number) => (D: number, rnd: () => number) => Array.from({ length: D + 1 }, (_, d) => 0.3 + pendiente * (d - BASE) + ruido(rnd));
function ar1(phi: number, escalaInnovacion: number) {
  return (D: number, rnd: () => number) => {
    let e = 0;
    for (let i = 0; i < 100; i++) e = phi * e + escalaInnovacion * ruido(rnd);
    return Array.from({ length: D + 1 }, () => { e = phi * e + escalaInnovacion * ruido(rnd); return 0.3 + e; });
  };
}

export const CASOS: readonly Caso[] = [
  { id: 'estacionaria', descripcion: '0,3 ± 0,1 uniforme, independiente', generar: tendencia(0) },
  { id: 'ar1', descripcion: 'AR(1) φ = 0,7, innovación U(±0,1) (σ marginal 0,081)', generar: ar1(0.7, 1) },
  { id: 'ar1-var', descripcion: 'AR(1) φ = 0,7, σ marginal 0,058 (= estacionaria)', generar: ar1(0.7, Math.sqrt(1 - 0.49)) },
  { id: 'sube-0.001', descripcion: 'creciente 0,001/día + ruido U(±0,1)', generar: tendencia(0.001) },
  { id: 'sube-0.003', descripcion: 'creciente 0,003/día + ruido U(±0,1)', generar: tendencia(0.003) },
  { id: 'baja-0.001', descripcion: 'decreciente 0,001/día + ruido U(±0,1)', generar: tendencia(-0.001) },
  // Informativos (sin cota en el preregistro): cómo se comporta C8 fuera de los casos pedidos.
  { id: 'paseo', descripcion: 'informativo: paseo aleatorio 0,3 + Σ U(±0,03) (no estacionario, sin tendencia)', informativo: true,
    generar: (D, rnd) => { let e = 0; return Array.from({ length: D + 1 }, () => { e += 0.3 * ruido(rnd); return 0.3 + e; }); } },
  { id: 'satura', descripcion: 'informativo: sube 0,2 saturando, 0,3 + 0,2·(1 − e^{−(d−5)/10}) + ruido U(±0,1)', informativo: true,
    generar: (D, rnd) => Array.from({ length: D + 1 }, (_, d) => 0.3 + 0.2 * (1 - Math.exp(-(d - BASE) / 10)) + ruido(rnd)) },
];

export const REGLAS = {
  v2: { etiqueta: 'v2 por defecto (MK, Hamed-Rao + AR(1))', umbrales: {} },
  v2HamedRao: { etiqueta: 'MK, solo Hamed-Rao', umbrales: { correccionMk: 'hamed-rao' } },
  v2SinCorreccion: { etiqueta: 'MK sin corrección', umbrales: { correccionMk: 'ninguna' } },
  v1o: { etiqueta: 'v1 «o»', umbrales: { diversidadRegla: 'o' } },
  v1y: { etiqueta: 'v1 «y»', umbrales: { diversidadRegla: 'y' } },
} as const satisfies Record<string, { etiqueta: string; umbrales: Partial<Umbrales> }>;
export type IdRegla = keyof typeof REGLAS;

export interface FilaCalibracion {
  caso: string; descripcion: string; D: number; series: number;
  /** Fracción de series con C8 = «cumple», por regla; `desconocidos` = de la regla v2. */
  cumple: Record<IdRegla, number>; desconocidos: number;
}
export interface Calibracion { semilla: number; series: number; horizontes: number[]; filas: FilaCalibracion[] }

export function calibrar({ series = 1000, semilla = 20260922, horizontes = [60, 30] }: { series?: number; semilla?: number; horizontes?: number[] } = {}): Calibracion {
  const filas: FilaCalibracion[] = [];
  const umbrales = Object.fromEntries(Object.entries(REGLAS).map(([id, r]) => [id, { ...UMBRALES_POR_DEFECTO, causasConocidas: [...UMBRALES_POR_DEFECTO.causasConocidas], ...r.umbrales, dia: 60 } as Umbrales])) as Record<IdRegla, Umbrales>;
  for (const D of horizontes) for (const caso of CASOS) {
    const rnd = mulberry32((semilla ^ fnv1a(`${caso.id}/${D}`)) >>> 0);
    const cuenta = Object.fromEntries(Object.keys(REGLAS).map(id => [id, 0])) as Record<IdRegla, number>;
    let desconocidos = 0;
    for (let i = 0; i < series; i++) {
      const serie = caso.generar(D, rnd).map(v => Math.min(1, Math.max(0, v)));
      for (const id of Object.keys(REGLAS) as IdRegla[]) {
        const estado = evaluarSerieDiversidad(dia => serie[dia], D, umbrales[id]).estado;
        if (estado === 'cumple') cuenta[id]++;
        if (id === 'v2' && estado === 'desconocido') desconocidos++;
      }
    }
    filas.push({ caso: caso.id, descripcion: caso.descripcion, D, series,
      cumple: Object.fromEntries(Object.entries(cuenta).map(([id, n]) => [id, n / series])) as Record<IdRegla, number>, desconocidos: desconocidos / series });
  }
  return { semilla, series, horizontes, filas };
}

const pct = (x: number) => `${(100 * x).toFixed(1).replace('.', ',')} %`;

/** Tabla en Markdown (la del README): tasa de «cumple» por caso, horizonte y regla. */
export function tablaMarkdown(c: Calibracion): string {
  const ids = Object.keys(REGLAS) as IdRegla[];
  const l = [`| caso | D | ${ids.map(id => REGLAS[id].etiqueta).join(' | ')} |`, `|---|---|${ids.map(() => '---:').join('|')}|`];
  for (const f of c.filas) l.push(`| ${f.caso} — ${f.descripcion} | ${f.D} | ${ids.map(id => pct(f.cumple[id])).join(' | ')} |`);
  return l.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const valor = (bandera: string) => { const i = argv.indexOf(bandera); return i >= 0 ? argv[i + 1] : undefined; };
  const series = Number(valor('--series') ?? 1000), semilla = Number(valor('--semilla') ?? 20260922), salida = valor('--salida');
  if (!Number.isInteger(series) || series < 1 || !Number.isInteger(semilla)) throw new Error('Uso: npx tsx scripts/lab/calibrar-c8.mts [--series 1000] [--semilla 20260922] [--salida calibracion.json]');
  const c = calibrar({ series, semilla });
  console.log(`Calibración de C8 — ${series} series por caso, semilla ${semilla} (mulberry32), días 5..D; tasa de «cumple»:\n`);
  console.log(tablaMarkdown(c));
  if (salida) { mkdirSync(dirname(resolve(salida)), { recursive: true }); writeFileSync(salida, JSON.stringify(c, null, 2) + '\n'); console.log(`\nJSON: ${resolve(salida)}`); }
}

const invocadoDirectamente = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invocadoDirectamente) {
  try { main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
