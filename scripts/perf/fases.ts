/**
 * Perfil de CPU por fase de `stepWorld` sobre un mundo guardado (sprint noche-perf2 2026-09-22).
 *
 *   tsx scripts/perf/fases.ts --db <world.sqlite> [--pasos 600] [--salida <json>] [--digesto <hex>]
 *
 * Copia la base (y su -wal/-shm si existen) a un directorio temporal PROPIO bajo `$TMPDIR` —el
 * original no se escribe nunca—, la carga con el `Store` del proyecto (params del propio mundo)
 * y avanza N pasos con el mismo régimen que `scripts/lab/replica.ts` sin gobernador: `stepWorld`
 * y `store.save` cada `persistencia.cadaTicks`. Mide CPU PROPIA del proceso (`process.cpuUsage`,
 * usuario+sistema), nunca reloj de pared: la torre corre a carga 60–140.
 *
 * Imprime (y con `--salida` escribe) JSON con: población inicial/final, CPU por paso del paso
 * completo, del guardado, por fase (`FaseMedicion`), por bloques de 100 pasos (para ver la
 * deriva con N) y el digesto canónico inicial/final (con `--digesto` exige el inicial).
 *
 * Para el perfil por función: `node --cpu-prof --cpu-prof-dir D --import tsx scripts/perf/fases.ts …`
 * y luego `tsx scripts/perf/cpuprof.ts D/*.cpuprofile --pasos N`.
 *
 * Calibración: la CPU propia NO es inmune a la carga. Con la torre a carga ~75 (los dos hilos de
 * cada núcleo ocupados) los mismos pasos cuestan 2–2,5 veces más CPU que a carga ~20 (medido: el
 * mundo de 6 días de la semilla 3, 49 → 20 ms/paso; los mismos 100 pasos de un mundo de 12 días,
 * 55 → 160 ms según subía la carga). Por eso cada bloque de 100 pasos corre también una carga fija
 * de referencia (`calibrar`: mapas, cadenas, arreglos y aritmética, ~5 ms) y `pasoNormalizado` es
 * CPU del paso / CPU de la referencia en ese bloque: compara mejor entre corridas separadas en el
 * tiempo. Para decidir entre base y rama, igual, correr las dos a la vez.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { stepWorld, type FaseMedicion } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf } from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Carga fija de referencia (CPU propia en ms, mediana de 3): parecida en mezcla al paso —Map con
 * claves de texto, arreglos de objetos, `Math.hypot`, filtros— y sin depender del mundo. */
let sumidero = 0;
function calibrar(): number {
  const tiempos: number[] = [];
  for (let repeticion = 0; repeticion < 3; repeticion++) {
    const inicio = cpuMs();
    const mapa = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 4000; i++) mapa.set(`c${i % 997},${i % 13}`, { x: i % 97, y: i % 89 });
    const puntos = [...mapa.values()];
    let suma = 0;
    for (let i = 0; i < 60; i++) {
      const centro = puntos[i]!;
      suma += puntos.filter(p => Math.hypot(p.x - centro.x, p.y - centro.y) <= 7).length;
    }
    sumidero += suma;
    tiempos.push(cpuMs() - inicio);
  }
  return tiempos.sort((a, b) => a - b)[1]!;
}

const db = arg('--db'), pasos = Number(arg('--pasos') ?? 600), salida = arg('--salida'), esperado = arg('--digesto');
const sinDigesto = process.argv.includes('--sin-digesto');
if (!db || !existsSync(db)) throw new Error('Uso: fases.ts --db <world.sqlite> [--pasos N] [--salida json] [--digesto hex] [--sin-digesto]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');

const dir = mkdtempSync(join(tmpdir(), 'atlas-perf2-'));
for (const sufijo of ['', '-wal', '-shm']) if (existsSync(db + sufijo)) copyFileSync(db + sufijo, join(dir, 'world.sqlite' + sufijo));
const store = new Store(join(dir, 'world.sqlite'));
try {
  const cargaInicio = cpuMs();
  const loaded = store.load();
  if (!loaded) throw new Error('La base no tiene mundo');
  const world = loaded.world;
  const cargaCpuMs = cpuMs() - cargaInicio;
  const digestoInicial = sinDigesto ? null : digestoCanonico(world);
  if (esperado && digestoInicial !== esperado) throw new Error(`Digesto inicial ${digestoInicial} ≠ ${esperado}`);
  const poblacionInicial = world.people.length, tickInicial = world.tick;
  const medicion: FaseMedicion = { clock: cpuMs, fases: {} };
  const acumulado: Record<string, number> = {};
  const bloques: { hastaPaso: number; poblacion: number; cpuMsPorPaso: number; calibracionMs: number; pasoNormalizado: number }[] = [];
  let calibracionTotal = 0;
  let pasoCpu = 0, saveCpu = 0, bloqueCpu = 0, saves = 0;
  for (let n = 0; n < pasos; n++) {
    medicion.fases = {};
    const a = cpuMs();
    stepWorld(world, [], undefined, medicion);
    const b = cpuMs();
    pasoCpu += b - a; bloqueCpu += b - a;
    for (const [fase, ms] of Object.entries(medicion.fases)) acumulado[fase] = (acumulado[fase] ?? 0) + ms!;
    if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) { store.save(world); saveCpu += cpuMs() - b; saves++; }
    if ((n + 1) % 100 === 0) {
      const calibracionMs = calibrar(); calibracionTotal += calibracionMs;
      bloques.push({ hastaPaso: n + 1, poblacion: world.people.length, cpuMsPorPaso: r3(bloqueCpu / 100), calibracionMs: r3(calibracionMs), pasoNormalizado: r3(bloqueCpu / 100 / calibracionMs) });
      bloqueCpu = 0;
    }
  }
  const fases = Object.fromEntries(Object.entries(acumulado).sort((x, y) => y[1] - x[1]).map(([fase, ms]) => [fase, r3(ms / pasos)]));
  const resultado = {
    mundo: basename(db), seed: world.seed, tickInicial, pasos, poblacionInicial, poblacionFinal: world.people.length,
    animales: world.animals.length, estructuras: world.structures.length, legado: world.legacy.length, teselas: world.tiles.length, comunidades: world.communities.length,
    lugares: world.places.length, recetasResidentes: world.technology.recipes.length,
    cargaCpuMs: Math.round(cargaCpuMs), cpuMsPorPaso: r3(pasoCpu / pasos), saves, saveCpuMsPorPaso: r3(saveCpu / pasos),
    calibracionMediaMs: bloques.length ? r3(calibracionTotal / bloques.length) : null,
    pasoNormalizado: bloques.length ? r3(bloques.reduce((suma, b) => suma + b.cpuMsPorPaso * 100, 0) / (bloques.length * 100) / (calibracionTotal / bloques.length)) : null,
    fasesCpuMsPorPaso: fases, bloques, digestoInicial, digestoFinal: sinDigesto ? null : digestoCanonico(world), controlCalibracion: sumidero,
  };
  const texto = JSON.stringify(resultado, null, 2);
  if (salida) writeFileSync(salida, texto + '\n');
  console.log(texto);
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
