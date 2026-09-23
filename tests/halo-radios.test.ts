import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALCANCES, ESCRITURAS, FASES_CON_HALO, FUERA_DEL_PASO, HALO_CELDAS, LECTURAS_GLOBALES, LECTURAS_POR_IDENTIDAD, RADIOS_CON_NOMBRE,
  RECORRIDOS, UMBRALES_QUE_NO_SON_LECTURAS, alcanceCompuesto, excesos, fraccionBorde, haloRequerido,
  type Alcance, type ClaveDeRadio, type Fase, type FueraDelPaso, type Sitio,
} from '../src/world/halo.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, parseParams } from '../src/world/params.js';
import { CHUNK_SIZE } from '../src/world/terrain.js';
import { RADIO_CONVIVENCIA } from '../src/world/society.js';

const DIRECTORIO = fileURLToPath(new URL('../src/world/', import.meta.url));
const FUENTES: Readonly<Record<string, string>> = Object.fromEntries(readdirSync(DIRECTORIO).filter(f => f.endsWith('.ts') && f !== 'halo.ts').sort()
  .map(f => [f, readFileSync(DIRECTORIO + f, 'utf8')]));
const SITIOS: readonly Sitio[] = [...ALCANCES, ...LECTURAS_GLOBALES, ...LECTURAS_POR_IDENTIDAD, ...RECORRIDOS, ...ESCRITURAS];

// Colecciones del mundo situadas en el espacio, consultas sobre ellas y primitivas de búsqueda: el grep de la tarea.
const COLECCION = /\b(?:world|host)\.(?:people|places|structures|tiles|animals|communities|invitations|reminders)\b/;
const CONSULTA = /distance\(|\.filter\(|\.some\(|\.find\(|\.findIndex\(|\.includes\(|\.every\(|\bof\s+(?:world|host)\./;
const PRIMITIVA = /\b(?:filtrarCerca|primeroCerca|algunoCerca|tileAt|firstTileAt|lastTileAt|tileLookup|personById)\(/;
const COMENTARIO = /^\s*(?:\/\/|\*|\/\*)/;
const FUNCION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>/;

interface Linea { fichero: string; numero: number; funcion: string; texto: string }
/** Cada línea con la función de primer nivel que la contiene (la última declarada en la columna 0). */
function lineas(fichero: string, texto: string): Linea[] {
  let funcion = '';
  return texto.split('\n').map((linea, i) => {
    const m = FUNCION.exec(linea);
    if (m) funcion = m[1] ?? m[2]!;
    return { fichero, numero: i + 1, funcion, texto: linea };
  });
}
const esLectura = (texto: string): boolean => (COLECCION.test(texto) && CONSULTA.test(texto)) || PRIMITIVA.test(texto);
function lecturasEnFuente(fichero: string, texto: string): Linea[] {
  return lineas(fichero, texto).filter(l => !COMENTARIO.test(l.texto) && esLectura(l.texto));
}
/** Problemas de cobertura en los dos sentidos: lecturas sin entrada y entradas que ya no están en el código.
 * Cada patrón de la función tapa su fragmento de la línea; si lo que queda sigue leyendo el mundo, falta una
 * entrada (así una segunda lectura en una línea ya inventariada no pasa desapercibida). */
function verificarCobertura(fuentes: Readonly<Record<string, string>>, sitios: readonly Sitio[], fuera: readonly FueraDelPaso[]): string[] {
  const problemas: string[] = [];
  for (const [fichero, texto] of Object.entries(fuentes)) for (const l of lecturasEnFuente(fichero, texto)) {
    if (fuera.some(f => f.fichero === fichero && f.funcion === l.funcion)) continue;
    let resto = l.texto;
    for (const s of sitios) if (s.fichero === fichero && s.funcion === l.funcion) for (const p of s.patrones) resto = resto.split(p).join(' ');
    if (esLectura(resto)) problemas.push(`${fichero}:${l.numero} (${l.funcion}) lectura fuera del inventario: ${resto.trim().slice(0, 140)}`);
  }
  for (const s of sitios) {
    const texto = fuentes[s.fichero];
    if (texto === undefined) { problemas.push(`${s.fichero}: fichero inexistente`); continue; }
    const propias = lineas(s.fichero, texto).filter(l => l.funcion === s.funcion && !COMENTARIO.test(l.texto));
    for (const p of s.patrones) if (!propias.some(l => l.texto.includes(p))) problemas.push(`${s.fichero} (${s.funcion}) patrón inexistente: ${p}`);
  }
  for (const f of fuera) if (!lineas(f.fichero, fuentes[f.fichero] ?? '').some(l => l.funcion === f.funcion)) problemas.push(`${f.fichero}: función ${f.funcion} inexistente`);
  return problemas;
}
/** Todo `distance(…) OP umbral` debe acotar por un número ≤ halo o por un nombre inventariado. */
function verificarUmbrales(fuentes: Readonly<Record<string, string>>, halo = HALO_CELDAS): string[] {
  const problemas: string[] = [];
  for (const [fichero, texto] of Object.entries(fuentes)) for (const l of lineas(fichero, texto)) {
    if (COMENTARIO.test(l.texto)) continue;
    for (const m of l.texto.matchAll(/distance\([^()]*\)\s*(?:<=|<|>=|>)\s*(-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*)/g)) {
      const umbral = m[1]!, n = Number(umbral);
      if (Number.isFinite(n) ? n <= halo || UMBRALES_QUE_NO_SON_LECTURAS.some(u => u.fichero === fichero && u.funcion === l.funcion && u.umbral === n)
        : Object.hasOwn(RADIOS_CON_NOMBRE, umbral)) continue;
      problemas.push(`${fichero}:${l.numero} (${l.funcion}) umbral ${umbral} fuera del halo o sin inventariar`);
    }
    for (const m of l.texto.matchAll(/for \(let d[xy]\s*=\s*-\s*(\d+|[A-Za-z_][\w.]*)/g)) {
      const umbral = m[1]!, valor = /^\d+$/.test(umbral) ? Number(umbral) : RADIOS_CON_NOMBRE[umbral];
      if (typeof valor !== 'number' || valor > halo) problemas.push(`${fichero}:${l.numero} (${l.funcion}) recorrido ±${umbral} fuera del halo o sin inventariar`);
    }
  }
  return problemas;
}
const constante = (fichero: string, nombre: string): number => Number(new RegExp(`const ${nombre} = (\\d+(?:\\.\\d+)?);`).exec(FUENTES[fichero]!)?.[1]);
const maximo = (fase: Fase, params = HISTORICAL_PARAMS): number => Math.max(...ALCANCES.filter(e => e.fase === fase && !e.excepcion).map(e => alcanceCompuesto(e.id, ALCANCES, params)!));

test('el inventario cubre toda lectura del mundo en src/world y ninguna entrada está obsoleta', () => {
  assert.deepEqual(verificarCobertura(FUENTES, SITIOS, FUERA_DEL_PASO), []);
  const ids = [...ALCANCES, ...LECTURAS_GLOBALES, ...LECTURAS_POR_IDENTIDAD, ...RECORRIDOS, ...ESCRITURAS].map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids repetidos en el inventario');
  for (const e of ALCANCES) assert.ok(e.centro === 'actor' || ALCANCES.some(c => c.id === e.centro), `centro desconocido: ${e.id} → ${e.centro}`);
  for (const e of ALCANCES) if (e.excepcion) assert.ok(FASES_CON_HALO.includes(e.fase), `excepción fuera de una fase con halo: ${e.id}`);
});

test('todo umbral de distancia y todo recorrido de desplazamientos cae dentro del halo o está inventariado', () => {
  assert.deepEqual(verificarUmbrales(FUENTES), []);
  // Los radios con nombre son los del código, no una copia que pueda quedarse vieja.
  assert.equal(RADIOS_CON_NOMBRE.RADIUS, constante('index.ts', 'RADIUS'));
  assert.equal(RADIOS_CON_NOMBRE.CONSTRUCTION_RADIUS, constante('inventions.ts', 'CONSTRUCTION_RADIUS'));
  assert.equal(RADIOS_CON_NOMBRE.RADIO_CONVIVENCIA, RADIO_CONVIVENCIA);
  assert.match(FUENTES['inventions.ts']!, /const functionalNear = \(world: World, point: Point, radius = 1\.5\)/);
  for (const m of FUENTES['inventions.ts']!.matchAll(/functionalNear\(world, \w+, ([\d.]+)\)/g)) assert.ok(Number(m[1]) <= 1.5, `functionalNear con radio ${m[1]}`);
  assert.match(FUENTES['index.ts']!, /earlierForagerExhausts\(person, tile, workers, work, \{\s*tick: world\.tick, radius: RADIUS,/);
});

test('el alcance compuesto de las fases con halo no supera HALO_CELDAS, y el máximo es exactamente el halo', () => {
  assert.deepEqual(excesos(), []);
  const conHalo = ALCANCES.filter(e => FASES_CON_HALO.includes(e.fase) && !e.excepcion && typeof e.radio === 'number');
  const alcances = new Map(conHalo.map(e => [e.id, alcanceCompuesto(e.id)!]));
  assert.equal(Math.max(...alcances.values()), HALO_CELDAS);
  // 7 + 7 desde el otro de la cooperación; el 13 de G2 (hogar 7 + personas 6) y su rama hermana de 12.
  assert.deepEqual([...alcances].filter(([, v]) => v === HALO_CELDAS).map(([id]) => id).sort(),
    ['cooperacion.destinoDelOtro', 'cooperacion.insumos', 'cooperacion.necesidad']);
  assert.equal(alcances.get('asentamiento.hogar.personas'), 13);
  assert.equal(alcances.get('asentamiento.hogar.teselas'), 11);
  assert.equal(alcances.get('asentamiento.hogar.estructuras'), 11);
  assert.equal(alcances.get('asentamiento.lugares.personas'), 12);
  assert.equal(alcances.get('decision.obra'), 12);
  const porColeccion = (coleccion: Alcance['coleccion']) => Math.max(...conHalo.filter(e => e.coleccion === coleccion).map(e => alcances.get(e.id)!));
  assert.deepEqual({ teselas: porColeccion('teselas'), personas: porColeccion('personas'), estructuras: porColeccion('estructuras'),
    lugares: porColeccion('lugares'), animales: porColeccion('animales') }, { teselas: 14, personas: 13, estructuras: 11, lugares: 12, animales: 7 });
});

test('alcances fijados de todas las fases, incluidas las seriales que el halo no acota', () => {
  const fases: Fase[] = ['decision', 'ecologia', 'fauna', 'faunaSerial', 'accion', 'gestos', 'estructuras', 'encuentros', 'demografia', 'comunidades', 'reproduccion'];
  assert.deepEqual(Object.fromEntries(fases.map(f => [f, maximo(f)])), {
    decision: 14, ecologia: 1, fauna: 6, faunaSerial: 1, accion: 4096, gestos: 7, estructuras: 1.5, encuentros: 3, demografia: 2, comunidades: 7, reproduccion: 4,
  });
  assert.equal(alcanceCompuesto('accion.caminable'), 24, 'la búsqueda de ruta de `move` lee terreno y presencia a 24 celdas');
  assert.match(FUENTES['index.ts']!, /Math\.abs\(next\.y - start\.y\)\) > 24 \|\| !walkable/);
  // Escritura: `maintainRegions` activa el chunk de (x ± 8, y ± 8).
  const activacion = ESCRITURAS.find(e => e.id === 'activacion')!;
  assert.equal(activacion.radio, 8 + CHUNK_SIZE - 1);
  assert.ok(activacion.radio > HALO_CELDAS, 'el área escrita supera el halo de lectura: la activación queda en el coordinador');
  // Recuerdos de la fauna: 6 celdas vistas + 480 pasos de vida a un paso de celda cada ≥ 4 pasos.
  const memoria = ALCANCES.find(e => e.id === 'fauna.memoria')!;
  assert.equal(memoria.excepcion, 'presencia');
  assert.match(FUENTES['animals.ts']!, /const interval = Math\.ceil\(11 - animal\.genes\.speed \* 7 \+ animal\.fatigue \* 3\);/);
  assert.equal(memoria.radio, 6 + constante('animals.ts', 'MEMORY_TTL') / (11 - 7));
});

test('radios de parámetros: el cortejo de reglas 10 exige 128 celdas y el histórico cabe en el halo', () => {
  assert.deepEqual(haloRequerido(HISTORICAL_PARAMS), { celdas: HALO_CELDAS, causa: 'cooperacion.destinoDelOtro' });
  assert.equal(DEFAULT_PARAMS.poblacion.cortejo > 0, true, 'reglas 10 activa el cortejo');
  assert.deepEqual(haloRequerido(DEFAULT_PARAMS), { celdas: DEFAULT_PARAMS.poblacion.radioCortejo, causa: 'decision.cortejo' });
  assert.equal(DEFAULT_PARAMS.poblacion.radioCortejo, 128);
  // Con el cortejo apagado el radio no cuenta, aunque sea grande.
  assert.equal(haloRequerido(parseParams('poblacion.cortejo=0,poblacion.radioCortejo=128', DEFAULT_PARAMS)).celdas, HALO_CELDAS);
  // Qué claves, en el máximo de su rango, llevan su lectura más allá del halo (en cualquier fase).
  const claves: ClaveDeRadio[] = ['poblacion.radioPareja', 'poblacion.radioLugar', 'poblacion.radioCortejo', 'social.disputaRadio'];
  const exceden = claves.filter(clave => {
    const params = parseParams(`${clave}=${PARAM_RANGES[clave]![1]},poblacion.cortejo=1`, HISTORICAL_PARAMS);
    return ALCANCES.some(e => typeof e.radio !== 'number' && e.radio.param === clave && alcanceCompuesto(e.id, ALCANCES, params)! > HALO_CELDAS);
  });
  assert.deepEqual(exceden, ['poblacion.radioPareja', 'poblacion.radioLugar', 'poblacion.radioCortejo']);
  assert.deepEqual(excesos(ALCANCES, HALO_CELDAS, DEFAULT_PARAMS), [{ id: 'decision.cortejo', alcance: 128 }]);
});

test('la prueba muerde: una lectura nueva, un radio 9 compuesto y una composición 7 + 8 fallan', () => {
  // (a) Una lectura de radio 9 que nadie inventarió.
  const sintetico = { 'sintetico.ts': 'function nueva(world, person) {\n  return world.people.filter(p => distance(person, p) <= 9);\n}\n' };
  const problemas = verificarCobertura(sintetico, SITIOS, FUERA_DEL_PASO).filter(p => p.startsWith('sintetico.ts'));
  assert.equal(problemas.length, 1);
  assert.match(problemas[0]!, /sintetico\.ts:2 \(nueva\) lectura fuera del inventario/);
  // Un umbral mayor que el halo falla aunque la línea esté inventariada.
  assert.deepEqual(verificarUmbrales({ 'sintetico.ts': 'function lejos(a, b) { return distance(a, b) <= 15; }' }), ['sintetico.ts:1 (lejos) umbral 15 fuera del halo o sin inventariar']);
  assert.deepEqual(verificarUmbrales({ 'sintetico.ts': 'function barrido(world, p) {\n  for (let dy = -20; dy <= 20; dy++) {}\n}' }), ['sintetico.ts:2 (barrido) recorrido ±20 fuera del halo o sin inventariar']);
  // (b) Radio 9 alrededor del hogar (a 7): 16.
  const nueve: Alcance = { id: 'sintetico.nueve', fase: 'decision', coleccion: 'personas', centro: 'asentamiento.hogar', radio: 9, fichero: 'society.ts', funcion: 'settlementOpportunity', patrones: [] };
  assert.deepEqual(excesos([...ALCANCES, nueve]), [{ id: 'sintetico.nueve', alcance: 16 }]);
  // (c) 7 + 8: ninguna supera 14 por sí sola, la composición sí.
  const siete: Alcance = { id: 'sintetico.siete', fase: 'decision', coleccion: 'personas', centro: 'actor', radio: 7, fichero: 'index.ts', funcion: 'choose', patrones: [] };
  const ocho: Alcance = { ...siete, id: 'sintetico.ocho', coleccion: 'teselas', centro: 'sintetico.siete', radio: 8 };
  assert.ok(siete.radio as number <= HALO_CELDAS && ocho.radio as number <= HALO_CELDAS);
  assert.deepEqual(excesos([...ALCANCES, siete, ocho]), [{ id: 'sintetico.ocho', alcance: 15 }]);
  // Y fuera de las fases con halo no cuenta: es una fase serial.
  assert.deepEqual(excesos([...ALCANCES, { ...siete, fase: 'accion' }, { ...ocho, fase: 'accion' }]), []);
  assert.throws(() => alcanceCompuesto('x', [{ ...siete, id: 'x', centro: 'y' }, { ...siete, id: 'y', centro: 'x' }]), /Ciclo/);
});

test('coste del halo: fracción de celdas leídas de las regiones vecinas', () => {
  const casi = (valor: number, esperado: number) => assert.ok(Math.abs(valor - esperado) < 1e-4, `${valor} ≠ ${esperado}`);
  casi(fraccionBorde(256, 8), 0.1289);
  casi(fraccionBorde(256, 13), 0.2134);
  casi(fraccionBorde(256, 14), 0.2307);
  casi(fraccionBorde(512, 13), 0.1041);
  casi(fraccionBorde(512, 14), 0.1124);
  casi(fraccionBorde(256, 128), 3);
  casi(fraccionBorde(512, 128), 1.25);
});
