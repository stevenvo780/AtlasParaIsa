// T171 — Invariantes permanentes de la revisión adversarial en tres lentes.
//
// Lente 1 (hardware en la regla): ninguna ley de `src/world` puede leer el número de
// hilos, la CPU, un reloj o el azar del proceso. Esos valores solo pueden vivir en el
// despacho (`src/world/paralelo/`, `src/world/gpu/`), y allí solo como espera,
// diagnóstico o reparto de trabajo: nunca deciden qué sale del mundo.
// Lente 2 (reparto): el reparto por regiones es estático, completo y sin robo. Desde V23
// no hay paridad entre hilos que defender, así que las colas siguen el orden de entrada.
// Lente 3 (cambio de mundo no declarado): los defaults siguen siendo las reglas 11 con
// la Fase B en valores históricos, y el mundo por defecto de un hilo con semilla es bit a
// bit el mismo con o sin el SoA de terreno. Desde V23 el mundo con varios hilos o con GPU
// es irrepetible (AJUSTES-ORQUESTADOR §1): no se prueba su paridad, ni se exige FP64 sin FMA
// en la GPU.
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
  // Leyes: todo `src/world` salvo el despacho paralelo, el de la percepción y el puente GPU. El SoA de
  // terreno (`soa/`) sí es ley a estos efectos: guarda el estado del que salen las
  // decisiones, así que tampoco puede mirar la máquina ni el reloj.
  const despacho = `${WORLD_DIR}paralelo/`;
  const gpu = `${WORLD_DIR}gpu/`;
  // Del motor V23 (despacho de la percepción, coordinador y dueños de página) solo se admiten, por fichero, los relojes de
  // espera y de medida y la cuenta de hilos del `auto`: ninguno entra en una decisión ni en el resultado de una ley.
  //  · decision/despacho.ts — plazo de los mensajes a la piscina y tiempo de pared de cada lote.
  //  · decision/percepcion.ts — contadores de tiempo del lote (diagnóstico).
  //  · motor/coordinador.ts — `motor.hilos='auto'` pregunta cuántos hilos hay; mide cada fase para el reparto.
  //  · motor/dueno-worker.ts y motor/fotograma.ts — medida del tramo de cada dueño y plazo de la barrera.
  //  · motor/mensajes-corte.ts — diagnóstico de la codificación y lectura de los sobres de guardado.
  //  · motor/perfil-materia.ts — publicación opcional de la duración del paso material.
  const permitidos: Readonly<Record<string, readonly string[]>> = {
    'decision/despacho.ts': ['Date.now', 'performance.now'],
    'decision/percepcion.ts': ['performance.now'],
    'motor/coordinador.ts': ['availableParallelism', 'performance.now'],
    'motor/dueno-worker.ts': ['performance.now'],
    'motor/fotograma.ts': ['performance.now'],
    'motor/mensajes-corte.ts': ['performance.now'],
    'motor/perfil-materia.ts': ['performance.now'],
  };
  const permitidosDe = (ruta: string): readonly string[] => permitidos[ruta.slice(WORLD_DIR.length)] ?? [];
  const leyes = ficherosTs(WORLD_DIR).filter(ruta => !ruta.startsWith(despacho) && !ruta.startsWith(gpu));
  assert.ok(leyes.length > 20, 'el escaneo debe cubrir el motor');
  const encontradas = leyes.flatMap(ruta => violaciones(ruta, PROHIBIDOS_EN_LEY.filter(token => !permitidosDe(ruta).includes(token))));
  assert.deepEqual(encontradas, []);
  // Ninguna ley importa el módulo del sistema operativo: el reparto llega por
  // parámetros (`motor.hilos`, `motor.gpu`), nunca preguntando a la máquina.
  const conOs = leyes.filter(ruta => !permitidosDe(ruta).includes('availableParallelism')).filter(ruta => sinComentarios(readFileSync(ruta, 'utf8')).includes("from 'node:os'"));
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
  // · piscina.ts — `performance.now` mide tiempos activos y de barrera para el
  //   diagnóstico del despacho; no escribe ningún valor del mundo.
  // · barrera.ts — `performance.now` acota la barrera y los cerrojos compartidos (60 s);
  //   si vence, el paso es fatal y el servidor sale con 75.
  // · gpu/puente.ts — `Date.now` acota la espera al subproceso GPU (60 s) y el
  //   hook de aborto de la prueba (2 s); si vence, el paso lanza y no se confirma.
  //   `performance.now` da el plazo de B2 a las tarjetas y mide su rendimiento para
  //   repartir el lote siguiente: decide qué dispositivo percibe, no qué percibe.
  // · gpu/canal.ts — `performance.now` da el plazo de cada respuesta del servidor y
  //   la espera activa de 1 ms antes de bloquear.
  // · gpu/broker-percepcion.ts — plazos monotónicos, colas y coste observado para elegir el dispositivo.
  // · gpu/materia-gpu.ts — plazo de transporte del suelo y diagnóstico de la preparación, espera y lectura.
  // · gpu/autoprueba.ts — `process.hrtime` mide el presupuesto de 200 ms de la
  //   autoprueba de paridad; su resultado habilita o no un dispositivo, no una ley.
  const blanca: Readonly<Record<string, readonly string[]>> = {
    'paralelo/piscina.ts': ['performance.now'],
    'paralelo/barrera.ts': ['performance.now'],
    'gpu/puente.ts': ['Date.now', 'performance.now'],
    'gpu/canal.ts': ['performance.now'],
    'gpu/broker-percepcion.ts': ['performance.now', 'hrtime'],
    'gpu/materia-gpu.ts': ['performance.now'],
    'gpu/autoprueba.ts': ['hrtime'],
  };
  const relojes = despacho.flatMap(ruta => violaciones(ruta,
    ['Date.now', 'performance.now', 'hrtime'].filter(token => !blanca[ruta.slice(WORLD_DIR.length)]?.includes(token))));
  assert.deepEqual(relojes, []);
});

test('T171 lente 1/2: los kernels GPU compilan sin fast-math', () => {
  // FMA sí se admite (V23 no pide paridad con la CPU); fast-math no: cambia los resultados
  // fuera del redondeo (divisiones y raíces aproximadas, sin NaN ni infinitos).
  for (const nombre of ['compute-ecology-gpu-resident.py', 'compute-ecology-gpu.py', 'compute-policy-gpu.py', 'gpu/servidor-gpu.py',
    'compute-ecology-resident.cu', 'compute-ecology.cu', 'gpu/percibir.cu', 'gpu/materia.cu', 'gpu/materia_kernel.py']) {
    const fuente = readFileSync(join(SCRIPTS_DIR, nombre), 'utf8');
    assert.ok(!fuente.includes('use_fast_math') && !fuente.includes('fast_math'), `${nombre}: fast-math prohibido`);
  }
});

test('T171 lente 2: la partición por regiones es estática, completa y sin robo', () => {
  const regiones: StaticRegion[] = Array.from({ length: 10 }, (_, id) => ({ id, begin: id * 4, end: id * 4 + 4 }));
  const desordenadas = [regiones[7]!, regiones[0]!, regiones[9]!, regiones[3]!, ...regiones.slice(4, 7), regiones[1]!, regiones[2]!, regiones[8]!];
  const colas = partitionRegions(desordenadas, 3);
  assert.equal(colas.length, 3);
  assert.deepEqual(colas.flat(), desordenadas, 'cada región se calcula exactamente una vez, en tramos contiguos de la entrada');
  assert.deepEqual(partitionRegions(desordenadas, 3), colas, 'la misma entrada da siempre las mismas colas');
});

test('T171 lente 3: los defaults son reglas 12 con la Fase B y las leyes V12 opt-in en su valor histórico', () => {
  assert.equal(RULES_VERSION, 14);
  assert.equal(DEFAULT_PARAMS.poblacion.natalidadVecindad, false);
  assert.equal(DEFAULT_PARAMS.conducta.politicaPeso, 0);
  // Claves reales de la Fase B en `params.ts` (la tarea las nombra como
  // cuantización/puerta/especulación; en el código son estas cuatro):
  // dosisCuanto=0 (sin cuantizar), mejoraLocal=0 (sin puerta), enfriamiento=45
  // y evitarNoOp=false reproducen la tecnología de siempre, bit a bit.
  const historica = { dosisCuanto: 0, mejoraLocal: 0, enfriamiento: 45, evitarNoOp: false, efectosHerramientas: false, obrasPorPropiedades: false };
  assert.deepEqual(DEFAULT_PARAMS.tecnologia, historica);
  assert.deepEqual(HISTORICAL_PARAMS.tecnologia, historica);
  assert.equal(DEFAULT_PARAMS.construccion.poliminosYSinergia, false);
  assert.equal(DEFAULT_PARAMS.terreno.caminosFisicos, false);
  assert.equal(DEFAULT_PARAMS.quimica.emergente, false);
  // El motor nace en el camino de siempre: serie, sin GPU y sin SoA de terreno.
  assert.deepEqual(DEFAULT_PARAMS.motor, {
    clonPorPaso: true, hilos: 1, soaTerreno: false, particionarPersonas: false, gpu: [], orden: 'natural', depuracion: false,
  });
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

test('T171 lente 3: el mundo por defecto de un hilo no cambia con SoA (semilla 7)', () => {
  const serie = mundoTras(7);
  const explicita = mundoTras(7, 'tecnologia.dosisCuanto=0,tecnologia.mejoraLocal=0,tecnologia.enfriamiento=45,tecnologia.evitarNoOp=false');
  assert.equal(digestoCanonico(explicita), digestoCanonico(serie),
    'declarar la Fase B con sus valores históricos no puede mover ni el mundo ni su digesto');
  const soa = mundoTras(7, 'motor.soaTerreno=true');
  assert.equal(soa.tiles.length, serie.tiles.length, 'mismas teselas');
  assert.equal(soa.people.length, serie.people.length, 'misma población');
  assert.equal(digestoNormalizado(soa), digestoNormalizado(serie), 'mismo mundo bit a bit');
});

test('T171 lente 3: paridad serie/SoA en la semilla 51926', () => {
  const serie = mundoTras(51926);
  const soa = mundoTras(51926, 'motor.soaTerreno=true');
  assert.equal(digestoNormalizado(soa), digestoNormalizado(serie));
});
