// T171 — Invariantes permanentes de la revisión adversarial en tres lentes.
//
// Lente 1 (hardware en la regla): ninguna ley de `src/world` puede leer el número de
// hilos, la CPU, un reloj o el azar del proceso. Esos valores solo pueden vivir en el
// despacho (`src/world/paralelo/`, `src/world/gpu/`), y allí solo como espera,
// diagnóstico o reparto de trabajo: nunca deciden qué sale del mundo.
// Lente 2 (orden de llegada): el reparto por regiones es estático y por contenido;
// las colas de workers no roban trabajo y la partición no depende del orden de entrada.
// Lente 3 (cambio de mundo no declarado): los defaults siguen siendo las reglas 11 con
// la Fase B en valores históricos, y el mundo por defecto es bit a bit el mismo con
// 1 hilo, con 4 hilos o con el SoA de terreno.
//
// Este fichero es la guarda automática de esa revisión: si un diff futuro mete
// hardware en una ley, compila CUDA con fast-math o mueve un default, falla aquí
// aunque el resto de la suite pase.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestoCanonico } from '../src/world/digesto.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { cloneWorld, createWorld, RULES_VERSION, stepWorld, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { partitionRegions, type StaticRegion } from '../src/world/paralelo/particion.js';

const WORLD_DIR = fileURLToPath(new URL('../src/world/', import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));

after(async () => { await closeEcosystemWorkers(); });

function ficherosTs(directorio: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) salida.push(...ficherosTs(ruta));
    else if (entrada.name.endsWith('.ts')) salida.push(ruta);
  }
  return salida.sort();
}

/** Quita comentarios de línea y de bloque respetando cadenas y plantillas. */
function sinComentarios(fuente: string): string {
  let resultado = '', i = 0;
  type Estado = 'codigo' | 'linea' | 'bloque' | 'simple' | 'doble' | 'plantilla';
  let estado: Estado = 'codigo';
  while (i < fuente.length) {
    const c = fuente[i]!, siguiente = fuente[i + 1] ?? '';
    if (estado === 'codigo') {
      if (c === '/' && siguiente === '/') { estado = 'linea'; i += 2; continue; }
      if (c === '/' && siguiente === '*') { estado = 'bloque'; i += 2; continue; }
      if (c === "'") estado = 'simple';
      else if (c === '"') estado = 'doble';
      else if (c === '`') estado = 'plantilla';
      resultado += c; i++; continue;
    }
    if (estado === 'linea') { if (c === '\n') { estado = 'codigo'; resultado += c; } i++; continue; }
    if (estado === 'bloque') { if (c === '*' && siguiente === '/') { estado = 'codigo'; i += 2; } else i++; continue; }
    resultado += c;
    if (c === '\\') { resultado += siguiente; i += 2; continue; }
    if ((estado === 'simple' && c === "'") || (estado === 'doble' && c === '"') || (estado === 'plantilla' && c === '`')) estado = 'codigo';
    i++;
  }
  return resultado;
}

const PROHIBIDOS_EN_LEY = ['availableParallelism', 'os.cpus', 'Math.random', 'Date.now', 'performance.now'] as const;

function violaciones(ruta: string, prohibidos: readonly string[]): string[] {
  const codigo = sinComentarios(readFileSync(ruta, 'utf8'));
  return prohibidos.filter(token => codigo.includes(token)).map(token => `${ruta}: «${token}»`);
}

test('T171 lente 1: las leyes no leen hardware, relojes ni azar del proceso', () => {
  // Leyes: todo `src/world` salvo el despacho paralelo y el puente GPU. El SoA de
  // terreno (`soa/`) sí es ley a estos efectos: guarda el estado del que salen las
  // decisiones, así que tampoco puede mirar la máquina ni el reloj.
  const despacho = `${WORLD_DIR}paralelo/`;
  const gpu = `${WORLD_DIR}gpu/`;
  const leyes = ficherosTs(WORLD_DIR).filter(ruta => !ruta.startsWith(despacho) && !ruta.startsWith(gpu));
  assert.ok(leyes.length > 20, 'el escaneo debe cubrir el motor');
  const encontradas = leyes.flatMap(ruta => violaciones(ruta, PROHIBIDOS_EN_LEY));
  assert.deepEqual(encontradas, []);
  // Ninguna ley importa el módulo del sistema operativo: el reparto llega por
  // parámetros (`motor.hilos`, `motor.gpu`), nunca preguntando a la máquina.
  const conOs = leyes.filter(ruta => sinComentarios(readFileSync(ruta, 'utf8')).includes("from 'node:os'"));
  assert.deepEqual(conOs, []);
});

test('T171 lente 1: en el despacho solo hay relojes de espera/diagnóstico, jamás CPU ni azar', () => {
  const despacho = ficherosTs(join(WORLD_DIR, 'paralelo')).concat(ficherosTs(join(WORLD_DIR, 'gpu')));
  assert.ok(despacho.length >= 5, 'el escaneo debe cubrir el despacho');
  const encontradas = despacho.flatMap(ruta => violaciones(ruta, ['availableParallelism', 'os.cpus', 'Math.random']));
  assert.deepEqual(encontradas, []);
  const conOs = despacho.filter(ruta => sinComentarios(readFileSync(ruta, 'utf8')).includes("from 'node:os'"));
  assert.deepEqual(conOs, []);
  // Lista blanca estricta de relojes en el despacho, con su único uso legítimo:
  // · piscina.ts — `performance.now` mide la espera adversarial y alimenta el
  //   diagnóstico del despacho; no escribe ningún valor del mundo.
  // · gpu/puente.ts — `Date.now` acota la espera al subproceso GPU (60 s) y el
  //   hook de aborto de la prueba (2 s); si vence, el paso lanza y no se confirma.
  // · gpu/autoprueba.ts — `process.hrtime` mide el presupuesto de 200 ms de la
  //   autoprueba de paridad; su resultado habilita o no un dispositivo, no una ley.
  const blanca: Readonly<Record<string, readonly string[]>> = {
    'paralelo/piscina.ts': ['performance.now'],
    'gpu/puente.ts': ['Date.now'],
    'gpu/autoprueba.ts': ['hrtime'],
  };
  for (const ruta of despacho) {
    const relativo = ruta.slice(WORLD_DIR.length);
    const codigo = sinComentarios(readFileSync(ruta, 'utf8'));
    for (const token of ['Date.now', 'performance.now', 'hrtime'] as const) {
      if (codigo.includes(token)) assert.ok((blanca[relativo] ?? []).includes(token), `${relativo}: reloj «${token}» fuera de la lista blanca`);
    }
  }
});

test('T171 lente 1/2: los kernels GPU compilan FP64 con --fmad=false y sin fast-math', () => {
  for (const nombre of ['compute-ecology-gpu-resident.py', 'compute-ecology-gpu.py', 'compute-policy-gpu.py']) {
    const fuente = readFileSync(join(SCRIPTS_DIR, nombre), 'utf8');
    assert.ok(fuente.includes('--fmad=false'), `${nombre}: debe compilar con --fmad=false`);
    assert.ok(!fuente.includes('use_fast_math') && !fuente.includes('fast_math'), `${nombre}: fast-math prohibido`);
  }
  // El backend residente (el que usa el puente del motor) no admite otro modo:
  // su única lista de opciones NVRTC lleva el literal `--fmad=false`.
  const residente = readFileSync(join(SCRIPTS_DIR, 'compute-ecology-gpu-resident.py'), 'utf8');
  assert.ok(!residente.includes('fmad=true'), 'compute-ecology-gpu-resident.py: sin rama fmad=true');
  for (const nombre of ['compute-ecology-resident.cu', 'compute-ecology.cu']) {
    const fuente = readFileSync(join(SCRIPTS_DIR, nombre), 'utf8');
    assert.ok(fuente.includes('--fmad=false'), `${nombre}: la cabecera debe declarar --fmad=false`);
    assert.ok(!fuente.includes('__fma') && !fuente.includes('fma('), `${nombre}: sin FMA explícito`);
  }
});

test('T171 lente 2: la partición por regiones es estática, completa y sin robo', () => {
  const regiones: StaticRegion[] = Array.from({ length: 10 }, (_, id) => ({ id, begin: id * 4, end: id * 4 + 4 }));
  const desordenadas = [regiones[7]!, regiones[0]!, regiones[9]!, regiones[3]!, ...regiones.slice(4, 7), regiones[1]!, regiones[2]!, regiones[8]!];
  for (const orden of ['natural', 'inverso', 'adversarial'] as const) {
    const colas = partitionRegions(desordenadas, 3, orden);
    assert.equal(colas.length, 3);
    const vistos = colas.flatMap(cola => cola.map(region => region.id));
    assert.deepEqual([...vistos].sort((a, b) => Number(a) - Number(b)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'cada región se calcula exactamente una vez');
    // La pertenencia a cada cola no depende del orden en que llegaron las regiones.
    assert.deepEqual(partitionRegions(regiones, 3, orden), colas);
  }
  const natural = partitionRegions(regiones, 3, 'natural');
  const inverso = partitionRegions(regiones, 3, 'inverso');
  assert.deepEqual(inverso.map(cola => cola.map(r => r.id)), natural.map(cola => [...cola].reverse().map(r => r.id)),
    'invertir solo recorre la misma cola al revés: no mueve regiones entre workers');
});

test('T171 lente 3: los defaults son reglas 12 con la Fase B y las leyes V12 opt-in en su valor histórico', () => {
  assert.equal(RULES_VERSION, 12);
  assert.equal(DEFAULT_PARAMS.poblacion.natalidadVecindad, false);
  assert.equal(DEFAULT_PARAMS.conducta.politicaPeso, 0);
  // Claves reales de la Fase B en `params.ts` (la tarea las nombra como
  // cuantización/puerta/especulación; en el código son estas cuatro):
  // dosisCuanto=0 (sin cuantizar), mejoraLocal=0 (sin puerta), enfriamiento=45
  // y evitarNoOp=false reproducen la tecnología de siempre, bit a bit.
  const historica = { dosisCuanto: 0, mejoraLocal: 0, enfriamiento: 45, evitarNoOp: false, efectosHerramientas: false };
  assert.deepEqual(DEFAULT_PARAMS.tecnologia, historica);
  assert.deepEqual(HISTORICAL_PARAMS.tecnologia, historica);
  // El motor nace en el camino de siempre: serie, sin GPU y sin SoA de terreno.
  assert.deepEqual(DEFAULT_PARAMS.motor, {
    clonPorPaso: true, hilos: 1, soaTerreno: false, particionarPersonas: false, gpu: [], orden: 'natural', depuracion: false,
  });
  assert.deepEqual(DEFAULT_PARAMS.gobernador, { presupuestoMs: 50, senales: ['p95'], politica: 'techo' });
  assert.equal(DEFAULT_PARAMS.red.deltas, false);
});

/** Digesto comparable entre ejecuciones: los cuatro selectores de motor son
 * configuración de despacho (T102/T117), no ley; el resto de params queda intacto. */
function digestoNormalizado(world: World): string {
  const copia = cloneWorld(world);
  const params = structuredClone(paramsOf(copia));
  Object.assign(params.motor, { hilos: 1, orden: 'natural', gpu: [], soaTerreno: false });
  setParams(copia, params);
  return digestoCanonico(copia);
}

function mundoTras(seed: number, params?: string, pasos = 120): World {
  const world = params === undefined ? createWorld(seed) : createWorld(seed, parseParams(params));
  for (let paso = 0; paso < pasos; paso++) stepWorld(world);
  return world;
}

test('T171 lente 3: el mundo por defecto no cambia con hilos ni con SoA (semilla 7)', () => {
  const serie = mundoTras(7);
  const explicita = mundoTras(7, 'tecnologia.dosisCuanto=0,tecnologia.mejoraLocal=0,tecnologia.enfriamiento=45,tecnologia.evitarNoOp=false');
  assert.equal(digestoCanonico(explicita), digestoCanonico(serie),
    'declarar la Fase B con sus valores históricos no puede mover ni el mundo ni su digesto');
  const paralelo = mundoTras(7, 'motor.hilos=4');
  const soa = mundoTras(7, 'motor.soaTerreno=true');
  for (const [nombre, mundo] of [['hilos=4', paralelo], ['soaTerreno=true', soa]] as const) {
    assert.equal(mundo.tiles.length, serie.tiles.length, `${nombre}: mismas teselas`);
    assert.equal(mundo.people.length, serie.people.length, `${nombre}: misma población`);
    assert.equal(digestoNormalizado(mundo), digestoNormalizado(serie), `${nombre}: mismo mundo bit a bit`);
  }
});

test('T171 lente 3: paridad serie/SoA en la semilla 51926', () => {
  const serie = mundoTras(51926);
  const soa = mundoTras(51926, 'motor.soaTerreno=true');
  assert.equal(digestoNormalizado(soa), digestoNormalizado(serie));
});
