import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contratos from '../src/world/motor/contratos.js';
import * as tipos from '../src/world/materia/tipos.js';
import * as materia from '../src/shared/materia.js';
import * as naturaleza from '../src/shared/naturaleza.js';
import * as cinta from '../src/shared/cinta.js';
import * as fotograma from '../src/shared/fotograma.js';
import { POLICY_ACTIONS, POLICY_HIDDEN, POLICY_INPUTS, POLICY_WEIGHTS } from '../src/world/politica.js';

// Si dos contratos exportan el mismo nombre, sea tipo o valor, `npm run typecheck` falla aquí (TS2308).
export type * from '../src/world/motor/contratos.js';
export type * from '../src/world/materia/tipos.js';
export type * from '../src/shared/materia.js';
export type * from '../src/shared/naturaleza.js';
export type * from '../src/shared/cinta.js';
export type * from '../src/shared/fotograma.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FICHEROS = ['src/world/motor/contratos.ts', 'src/world/materia/tipos.ts', 'src/shared/materia.ts',
  'src/shared/naturaleza.ts', 'src/shared/cinta.ts', 'src/shared/fotograma.ts'];
const { ELEMENTOS, NE, TABLA, ORDEN_MAX } = naturaleza;

test('los contratos no repiten nombres de valor entre sí', () => {
  const vistos = new Map<string, number>();
  [contratos, tipos, materia, naturaleza, cinta, fotograma].forEach((modulo, i) => {
    for (const nombre of Object.keys(modulo)) {
      assert.equal(vistos.get(nombre), undefined, `«${nombre}» se exporta desde ${FICHEROS[vistos.get(nombre)!]} y ${FICHEROS[i]}`);
      vistos.set(nombre, i);
    }
  });
});

test('los contratos no forman ciclos y del mundo solo importan tipos del barril', () => {
  const importaciones = new Map<string, string[]>();
  for (const fichero of FICHEROS) {
    const fuente = readFileSync(resolve(RAIZ, fichero), 'utf8');
    const destinos: string[] = [];
    for (const [linea, ruta] of fuente.matchAll(/^import[^;]*?from '([^']+)';/gms)) {
      const destino = resolve(RAIZ, dirname(fichero), ruta!).slice(RAIZ.length + 1).replace(/\.js$/, '.ts');
      if (destino.startsWith('src/world/') && !FICHEROS.includes(destino)) {
        assert.equal(destino, 'src/world/index.ts', `${fichero} importa ${destino}: el mundo se importa del barril`);
        assert.match(linea!, /^import type /, `${fichero} arrastra el mundo en tiempo de ejecución`);
      }
      if (FICHEROS.includes(destino)) destinos.push(destino);
    }
    importaciones.set(fichero, destinos);
  }
  const estado = new Map<string, 'abierto' | 'cerrado'>();
  const visitar = (fichero: string, camino: string[]): void => {
    if (estado.get(fichero) === 'cerrado') return;
    assert.notEqual(estado.get(fichero), 'abierto', `ciclo: ${[...camino, fichero].join(' → ')}`);
    estado.set(fichero, 'abierto');
    for (const destino of importaciones.get(fichero)!) visitar(destino, [...camino, fichero]);
    estado.set(fichero, 'cerrado');
  };
  for (const fichero of FICHEROS) visitar(fichero, []);
});

test('refDe, slotDe y genDe son inversas en todo el rango (gen < 2²¹)', () => {
  const { refDe, slotDe, genDe } = contratos;
  const slots = [0, 1, 2 ** 31, 2 ** 32 - 1], gens = [0, 1, 2 ** 20, 2 ** 21 - 1];
  for (let i = 0; i < 200; i++) { slots.push(Math.floor(Math.random() * 2 ** 32)); gens.push(Math.floor(Math.random() * 2 ** 21)); }
  for (const s of slots) for (const g of gens.slice(0, 20)) {
    const r = refDe(s, g);
    assert.ok(Number.isSafeInteger(r));
    assert.equal(slotDe(r), s); assert.equal(genDe(r), g);
  }
  assert.ok(refDe(0, 1) > refDe(2 ** 32 - 1, 0), 'otra generación nunca coincide con una ref vigente');
});

test('el Libro tiene NE + 1 posiciones, la última de energía, y cada libro nuevo es independiente', () => {
  const a = tipos.libroVacio(), b = tipos.libroVacio();
  for (const campo of [a.enVuelo, a.fuentes, a.sumideros]) { assert.equal(campo.length, NE + 1); assert.ok(campo.every(v => v === 0)); }
  assert.equal(tipos.ENERGIA, NE);
  a.enVuelo[tipos.ENERGIA] = 5;
  assert.equal(b.enVuelo[tipos.ENERGIA], 0);
  assert.notEqual(a.fuentes, a.sumideros);
});

test('la tabla de elementos es coherente con las valencias y deriva los ≈ 52 tipos de enlace', () => {
  assert.equal(TABLA.length, NE);
  assert.deepEqual(ELEMENTOS, ['H', 'C', 'N', 'O', 'P', 'Si', 'Ca', 'Fe']);
  assert.deepEqual(TABLA.map(t => t.valencia), [1, 4, 3, 2, 5, 4, 2, 3]);
  for (const t of TABLA) for (const v of Object.values(t)) assert.ok(Number.isFinite(v) && v >= 0);
  const { TIPOS } = materia;
  assert.equal(TIPOS.length, 52);
  const claves = new Set<string>();
  let anterior = -1;
  for (const { e, f, k, d } of TIPOS) {
    assert.ok(e <= f && f < NE);
    assert.ok(k <= Math.min(TABLA[e]!.valencia, TABLA[f]!.valencia, ORDEN_MAX));
    if (k > 1) assert.ok(TABLA[e]!.pi * TABLA[f]!.pi > 0, 'solo hay enlaces múltiples entre elementos con π');
    assert.ok(Number.isInteger(d) && d > 0);
    const orden = (e * NE + f) * 4 + k;
    assert.ok(orden > anterior, 'orden fijo: e, f, k crecientes'); anterior = orden;
    claves.add(`${e}-${f}-${k}`);
  }
  assert.equal(claves.size, TIPOS.length);
});

test('las sustancias de ejemplo de ARQ-materia saturan las valencias con ≤ 8 átomos', () => {
  const { TIPOS } = materia;
  const tipo = (a: string, b: string, k = 1) => {
    const [e, f] = [ELEMENTOS.indexOf(a as never), ELEMENTOS.indexOf(b as never)].sort((x, y) => x - y);
    const i = TIPOS.findIndex(t => t.e === e && t.f === f && t.k === k);
    assert.ok(i >= 0, `${a}–${b} de orden ${k}`);
    return i;
  };
  const atomos = (enlaces: [number, number][]): number[] => {
    const usos = new Array<number>(NE).fill(0);
    for (const [i, cuenta] of enlaces) { const { e, f, k } = TIPOS[i]!; usos[e]! += k * cuenta; usos[f]! += k * cuenta; }
    return usos.map((u, e) => u / TABLA[e]!.valencia);
  };
  const ejemplos: Record<string, [number, number][]> = {
    agua: [[tipo('O', 'H'), 2]],
    'CO₂': [[tipo('C', 'O', 2), 2]],
    etano: [[tipo('C', 'C'), 1], [tipo('C', 'H'), 6]],
    'sílice (unidad)': [[tipo('Si', 'O'), 4]],
    'hierro (unidad)': [[tipo('Fe', 'Fe'), 3]],
    'CaCO₃': [[tipo('Ca', 'O'), 2], [tipo('C', 'O'), 2], [tipo('C', 'O', 2), 1]],
    'H₃PO₄': [[tipo('P', 'O'), 3], [tipo('P', 'O', 2), 1], [tipo('O', 'H'), 3]],
    'N₂': [[tipo('N', 'N', 3), 1]],
  };
  for (const [nombre, enlaces] of Object.entries(ejemplos)) {
    const n = atomos(enlaces);
    assert.ok(n.every(Number.isInteger), `${nombre} no satura: ${n}`);
    assert.ok(n.reduce((s, x) => s + x, 0) <= materia.ATOMOS_POR_UNIDAD, `${nombre} pasa de 8 átomos`);
  }
});

test('la columna cuerpo del frente reparte VistaCuerpo sin huecos ni solapes', () => {
  const posiciones = Object.values(contratos.CAMPOS_CUERPO).sort((a, b) => a - b);
  assert.deepEqual(posiciones, Array.from({ length: contratos.CUERPO_ANCHO }, (_, i) => i));
  assert.equal(contratos.GENOMA_ANCHO, 2 * contratos.RASGOS_ANCHO);
});

test('las columnas del cerebro tienen las dimensiones de la red de politica.ts', () => {
  const { CEREBRO, COLUMNAS_CEREBRO } = contratos;
  assert.deepEqual([CEREBRO.entradas, CEREBRO.ocultas, CEREBRO.acciones], [POLICY_INPUTS, POLICY_HIDDEN, POLICY_ACTIONS.length]);
  assert.deepEqual(COLUMNAS_CEREBRO, { observacion: POLICY_INPUTS, politica: POLICY_WEIGHTS, sesgo: POLICY_ACTIONS.length });
});

test('los códigos de intento, de rol y de las posiciones de dato no se repiten', () => {
  const distintos = (o: object) => new Set(Object.values(o)).size === Object.keys(o).length;
  for (const o of [contratos.TipoIntento, contratos.Clase, tipos.Rol, tipos.Parte, contratos.DATO_TOMAR, contratos.DATO_GOLPEAR, contratos.DATO_MATERIA, materia.ClaseSustancia]) assert.ok(distintos(o));
  assert.ok(!Object.values(contratos.TipoIntento).includes(0 as never), '0 queda para «sin intento»');
});

test('codigoForma cabe en 30 bits y es su propia inversa sobre los códigos', () => {
  const { codigoForma, formaDeCodigo } = materia;
  for (let i = 0; i < 2000; i++) {
    const c = Math.floor(Math.random() * 2 ** 30);
    assert.equal(codigoForma(formaDeCodigo(c)), c);
  }
  const f = { largo: 1.8, ancho: 0.05, grueso: 0.02, hueco: 0.25, filo: 0.9 }, g = formaDeCodigo(codigoForma(f));
  for (const k of ['largo', 'ancho', 'grueso'] as const) assert.ok(Math.abs(g[k] / f[k] - 1) < 0.13, k);
  for (const k of ['hueco', 'filo'] as const) assert.ok(Math.abs(g[k] - f[k]) <= 1 / 126, k);
  assert.equal(codigoForma({ largo: 0, ancho: 0, grueso: 0, hueco: 0, filo: 0 }), 0);
  assert.ok(codigoForma({ largo: 1e9, ancho: 1e9, grueso: 1e9, hueco: 1, filo: 1 }) < 2 ** 30);
});

test('nivelDeT y tDeNivel son coherentes y cubren de 200 K a 3.200 K', () => {
  const { nivelDeT, tDeNivel, NIVELES_T } = tipos;
  for (let l = 0; l < NIVELES_T; l++) assert.equal(nivelDeT(tDeNivel(l)), l);
  assert.equal(nivelDeT(0), 0); assert.equal(nivelDeT(1e6), NIVELES_T - 1);
  assert.ok(nivelDeT(290) < nivelDeT(373) && nivelDeT(373) < nivelDeT(1800));
});

test('los esquemas del fotograma tienen nombres únicos y cada campo alineado a su tamaño', () => {
  for (const esquema of [fotograma.ESQUEMA_ORGANISMO, fotograma.ESQUEMA_CELDA]) {
    assert.equal(new Set(esquema.map(c => c.nombre)).size, esquema.length);
    const { ancho, desde } = fotograma.disposicion(esquema);
    let fin = 0, mayor = 1;
    for (const c of esquema) {
      const bytes = fotograma.BYTES_CAMPO[c.tipo];
      assert.equal(desde[c.nombre]! % bytes, 0, c.nombre);
      assert.ok(desde[c.nombre]! >= fin, `${c.nombre} pisa al anterior`);
      fin = desde[c.nombre]! + bytes; mayor = Math.max(mayor, bytes);
    }
    assert.ok(ancho >= fin && ancho % mayor === 0 && ancho - fin < mayor);
  }
});

test('el enlace cruza hilos como SABs y sus contadores no se solapan', () => {
  const ranura = new SharedArrayBuffer(fotograma.regionesRanura(4, 2).total);
  const d = { control: new SharedArrayBuffer(fotograma.CONTROL_ENLACE_BYTES), ranuras: [ranura], sucesos: new SharedArrayBuffer(64) };
  const otro = fotograma.enlaceCinta(structuredClone(d)), este = fotograma.enlaceCinta(d);
  const contadores = [este.creditos, este.pedirCompleto, este.cadencia, este.entregados, este.sucesosEscritos, este.sucesosLeidos];
  const tramos = contadores.map(c => [c.byteOffset, c.byteOffset + c.byteLength] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < tramos.length; i++) assert.ok(tramos[i]![0] >= tramos[i - 1]![1]);
  assert.ok(tramos.at(-1)![1] <= fotograma.CONTROL_ENLACE_BYTES);
  Atomics.add(este.entregados, 0, 1n); Atomics.store(este.cadencia, 0, 4);
  assert.equal(Atomics.load(otro.entregados, 0), 1n); assert.equal(otro.cadencia[0], 4);
});

test('fotogramaDe lee de la ranura lo que el motor escribió', () => {
  const r = fotograma.regionesRanura(3, 2), ranura = new SharedArrayBuffer(r.total);
  const i32 = new Int32Array(ranura, 0, 8), f64 = new Float64Array(ranura, 0, 8);
  const { n, paginas, completo, saltados, capOrganismos, capPaginas } = fotograma.RANURA_I32;
  i32[capOrganismos] = 3; i32[capPaginas] = 2; i32[n] = 2; i32[paginas] = 1; i32[completo] = 1; i32[saltados] = 5;
  f64[fotograma.RANURA_F64.tick] = 2401; f64[fotograma.RANURA_F64.epoca] = 3;
  f64[fotograma.RANURA_F64.sucesosDesde] = 10; f64[fotograma.RANURA_F64.sucesosHasta] = 12;
  new Int32Array(ranura, r.paginas, 2).set([7, -2]);
  new Int16Array(ranura, r.reparto, 1)[0] = 9;
  const { ancho, desde } = fotograma.disposicion(fotograma.ESQUEMA_ORGANISMO);
  new DataView(ranura).setFloat64(r.organismos + ancho + desde.uid!, 42, true);
  const f = fotograma.fotogramaDe(ranura);
  assert.deepEqual([f.tick, f.epoca, f.completo, f.saltados, f.n, f.sucesos], [2401, 3, true, 5, 2, [10, 12]]);
  assert.deepEqual([...f.paginas], [7, -2]); assert.deepEqual([...f.reparto!], [9]);
  assert.equal(f.organismos.length, 2 * ancho); assert.equal(f.serie.length, fotograma.SERIE_CAMPOS.length);
  assert.equal(new DataView(f.organismos.buffer, f.organismos.byteOffset).getFloat64(ancho + desde.uid!, true), 42);
  for (const [a, b] of [[r.serie, r.organismos], [r.organismos, r.paginas], [r.paginas, r.celdas], [r.celdas, r.reparto], [r.reparto, r.total]] as const)
    assert.ok(a % 8 === 0 && a <= b);
});

test('los niveles de la cinta crecen y sus cuotas dejan margen', () => {
  const { pasos, cuotas } = cinta.CINTA;
  assert.equal(pasos.length, 5); assert.equal(cuotas.length, 5);
  for (let i = 1; i < pasos.length; i++) assert.ok(pasos[i]! > pasos[i - 1]!);
  const total = cuotas.reduce((s: number, c: number) => s + c, 0);
  assert.ok(total <= 1 && total >= 0.95);
});

test('el modo de un solo dueño con semilla es el único reproducible', () => {
  const { reproducible, unSoloDueno } = contratos;
  const base = unSoloDueno(51926);
  assert.ok(reproducible(base));
  assert.equal(base.decisionGpu, 'siempre');
  assert.ok(!reproducible({ ...base, hilos: 2 }));
  assert.ok(!reproducible({ ...base, gpu: [0] }));
  assert.ok(!reproducible({ ...base, semilla: null }));
  assert.ok(!reproducible({ ...base, hilos: 'auto' }));
});
