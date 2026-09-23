/**
 * Resumen de un perfil V8 (`node --cpu-prof`) por función, en ms de CPU por paso simulado.
 *
 *   tsx scripts/perf/cpuprof.ts resumen <perfil.cpuprofile> --pasos N [--raiz stepWorld] [--poblacion N] [--mapas dir] [--top 60] [--salida json]
 *   tsx scripts/perf/cpuprof.ts comparar <chico.json> <grande.json> [--top 60]
 *
 * `resumen` sólo cuenta las muestras que caen DENTRO de una llamada a `--raiz` (por defecto
 * `stepWorld`; `save` para el guardado), así la carga del mundo y el arranque de tsx no ensucian
 * el reparto. Para cada función (nombre + fichero + línea) da:
 *   - `incl`: CPU inclusiva (la función y todo lo que llama), contando una sola vez por muestra
 *     aunque la función aparezca varias veces en la pila (recursión);
 *   - `self`: CPU propia;
 *   - `llamadoPor`: las tres funciones que más CPU inclusiva le aportan como llamadoras directas.
 * El tiempo de cada muestra es el intervalo hasta la muestra siguiente (lo que usa DevTools).
 *
 * tsx entrega a V8 cada módulo en UNA línea (esbuild sin espacios): el perfil trae línea 0 y una
 * columna del código transformado. Para nombrar la línea real del `.ts` se leen los mapas de
 * fuente que tsx deja en su caché (`$TMPDIR/tsx-<uid>/`, JSON con `code` y `map`; se toma la
 * entrada más reciente de cada fichero). Sin caché la clave queda en `fichero:c<columna>`.
 *
 * `comparar` toma dos resúmenes (JSON de `resumen --salida`) de mundos con distinta población y
 * estima el exponente de escala de cada función: k = ln(t_grande/t_chico) / ln(N_grande/N_chico)
 * con N = población media (el campo `poblacion` que se añade con `--poblacion`). k≈1 es lineal,
 * k≈2 cuadrático; con un N de 60 → 225 un k de 2 multiplica el coste por 14 y uno de 1 por 3,7.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { SourceMapConsumer } from 'source-map-js';

interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface Node { id: number; callFrame: CallFrame; children?: number[]; hitCount?: number }
interface Profile { nodes: Node[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }
interface Fila { funcion: string; incl: number; self: number; llamadoPor: string[] }
interface Resumen { perfil: string; raiz: string; pasos: number; poblacion: number | null; totalMsPorPaso: number; filas: Fila[] }

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Mapas de fuente de la caché de tsx, por ruta absoluta del `.ts` (la entrada más reciente). */
function mapasTsx(dir: string): Map<string, SourceMapConsumer> {
  const mapas = new Map<string, { mtime: number; map: unknown }>();
  if (!existsSync(dir)) return new Map();
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre), mtime = statSync(ruta).mtimeMs;
    let entrada: { map?: { sources?: string[] } };
    try { entrada = JSON.parse(readFileSync(ruta, 'utf8')) as typeof entrada; } catch { continue; }
    const fuente = entrada.map?.sources?.length === 1 ? entrada.map.sources[0]! : undefined;
    if (!fuente) continue;
    const previa = mapas.get(fuente);
    if (!previa || previa.mtime < mtime) mapas.set(fuente, { mtime, map: entrada.map });
  }
  return new Map([...mapas].map(([fuente, { map }]) => [fuente, new SourceMapConsumer(map as never)]));
}
let MAPAS: Map<string, SourceMapConsumer> = new Map();

function clave(frame: CallFrame): string {
  const ruta = frame.url.replace(/^file:\/\//, ''), fichero = frame.url ? basename(ruta) : '';
  const nombre = frame.functionName || '(anónima)';
  const mapa = MAPAS.get(ruta);
  if (mapa) {
    const original = mapa.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
    if (original.line) return `${nombre} ${fichero}:${original.line}`;
  }
  return frame.lineNumber === 0 && frame.url.endsWith('.ts') ? `${nombre} ${fichero}:c${frame.columnNumber}` : `${nombre} ${fichero}:${frame.lineNumber + 1}`;
}

function resumen(ruta: string, pasos: number, raiz: string, poblacion: number | null): Resumen {
  const profile = JSON.parse(readFileSync(ruta, 'utf8')) as Profile;
  const porId = new Map<number, Node>(), padre = new Map<number, number>();
  for (const node of profile.nodes) porId.set(node.id, node);
  for (const node of profile.nodes) for (const hijo of node.children ?? []) padre.set(hijo, node.id);
  // Tiempo de cada muestra: hasta la siguiente (la última toma su propio delta).
  const tiempos = new Float64Array(profile.samples.length);
  for (let i = 0; i < profile.samples.length; i++) tiempos[i] = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
  // Pila de claves de cada nodo (memorizada) y si está bajo la raíz.
  const pilas = new Map<number, string[] | null>();
  const pilaDe = (id: number): string[] | null => {
    if (pilas.has(id)) return pilas.get(id)!;
    const cadena: string[] = [];
    let actual: number | undefined = id, bajoRaiz = false;
    while (actual !== undefined) {
      const node = porId.get(actual)!;
      cadena.push(clave(node.callFrame));
      if (node.callFrame.functionName === raiz) { bajoRaiz = true; break; }
      actual = padre.get(actual);
    }
    const valor = bajoRaiz ? cadena : null;
    pilas.set(id, valor);
    return valor;
  };
  const incl = new Map<string, number>(), self = new Map<string, number>(), aristas = new Map<string, Map<string, number>>();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const cadena = pilaDe(profile.samples[i]!);
    if (!cadena) continue;
    const t = tiempos[i]!;
    total += t;
    self.set(cadena[0]!, (self.get(cadena[0]!) ?? 0) + t);
    const vistas = new Set<string>();
    for (let j = 0; j < cadena.length; j++) {
      const f = cadena[j]!;
      if (vistas.has(f)) continue;
      vistas.add(f);
      incl.set(f, (incl.get(f) ?? 0) + t);
      const llamador = cadena[j + 1];
      if (llamador !== undefined) {
        const porLlamador = aristas.get(f) ?? new Map<string, number>();
        porLlamador.set(llamador, (porLlamador.get(llamador) ?? 0) + t);
        aristas.set(f, porLlamador);
      }
    }
  }
  const filas = [...incl.entries()].sort((a, b) => b[1] - a[1]).map(([funcion, ms]) => ({
    funcion, incl: r3(ms / pasos), self: r3((self.get(funcion) ?? 0) / pasos),
    llamadoPor: [...(aristas.get(funcion) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, t]) => `${f} (${r3(t / pasos)})`),
  }));
  return { perfil: basename(ruta), raiz, pasos, poblacion, totalMsPorPaso: r3(total / pasos), filas };
}

function imprimir(r: Resumen, top: number): void {
  console.log(`# ${r.perfil} raíz=${r.raiz} pasos=${r.pasos} población=${r.poblacion ?? '?'} total=${r.totalMsPorPaso} ms/paso (CPU perfilada)`);
  console.log('\n## Inclusiva (ms/paso)');
  for (const f of r.filas.slice(0, top)) console.log(`${f.incl.toFixed(3).padStart(9)} ${f.self.toFixed(3).padStart(8)}  ${f.funcion}   <- ${f.llamadoPor.join(' | ')}`);
  console.log('\n## Propia (ms/paso)');
  for (const f of [...r.filas].sort((a, b) => b.self - a.self).slice(0, top)) console.log(`${f.self.toFixed(3).padStart(8)} ${f.incl.toFixed(3).padStart(9)}  ${f.funcion}`);
}

function comparar(rutaA: string, rutaB: string, top: number): void {
  const a = JSON.parse(readFileSync(rutaA, 'utf8')) as Resumen, b = JSON.parse(readFileSync(rutaB, 'utf8')) as Resumen;
  if (!a.poblacion || !b.poblacion) throw new Error('Los dos resúmenes necesitan `poblacion` (usa --poblacion al resumir).');
  const lnN = Math.log(b.poblacion / a.poblacion);
  const deA = new Map(a.filas.map(f => [f.funcion, f]));
  console.log(`# escala ${a.perfil} (N=${a.poblacion}, ${a.totalMsPorPaso} ms/paso) -> ${b.perfil} (N=${b.poblacion}, ${b.totalMsPorPaso} ms/paso); N×${r3(b.poblacion / a.poblacion)}, N²×${r3((b.poblacion / a.poblacion) ** 2)}`);
  console.log(`total: k=${r3(Math.log(b.totalMsPorPaso / a.totalMsPorPaso) / lnN)}`);
  console.log('   inclB    inclA   ×     k    selfB  función');
  for (const f of b.filas.slice(0, top)) {
    const prev = deA.get(f.funcion);
    const ratio = prev && prev.incl > 0 ? f.incl / prev.incl : Infinity;
    const k = Number.isFinite(ratio) ? Math.log(ratio) / lnN : Infinity;
    console.log(`${f.incl.toFixed(3).padStart(8)} ${(prev?.incl ?? 0).toFixed(3).padStart(8)} ${Number.isFinite(ratio) ? ratio.toFixed(1).padStart(5) : '  new'} ${Number.isFinite(k) ? k.toFixed(2).padStart(5) : '    ∞'} ${f.self.toFixed(3).padStart(8)}  ${f.funcion}`);
  }
}

const comando = process.argv[2], top = Number(arg('--top') ?? 60);
if (comando === 'resumen') {
  const ruta = process.argv[3], pasos = Number(arg('--pasos'));
  if (!ruta || !Number.isFinite(pasos) || pasos <= 0) throw new Error('Uso: cpuprof.ts resumen <perfil> --pasos N [--raiz f] [--poblacion N] [--salida json]');
  const poblacion = arg('--poblacion') ? Number(arg('--poblacion')) : null;
  MAPAS = mapasTsx(arg('--mapas') ?? join(tmpdir(), `tsx-${userInfo().uid}`));
  const r = resumen(ruta, pasos, arg('--raiz') ?? 'stepWorld', poblacion);
  const salida = arg('--salida');
  if (salida) writeFileSync(salida, JSON.stringify(r, null, 1) + '\n');
  imprimir(r, top);
} else if (comando === 'comparar') {
  const [a, b] = [process.argv[3], process.argv[4]];
  if (!a || !b) throw new Error('Uso: cpuprof.ts comparar <chico.json> <grande.json>');
  comparar(a, b, top);
} else throw new Error('Uso: cpuprof.ts resumen|comparar …');
