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
import { familiaCatalitica, indiceTipoEnlace } from '../src/world/materia/quimica.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { registrarSustanciasBase } from '../scripts/lab-materia.mjs';

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

test('enmienda 1: fronteras exactas de nivelDeT, H–H catalizable (familia 3 desde la enmienda 2) y ATOMOS_POR_REACCION', () => {
  const { nivelDeT, tFronteraNivel, tDeNivel, NIVELES_T } = tipos;
  const anterior = (x: number) => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x); v.setBigUint64(0, v.getBigUint64(0) - 1n);
    return v.getFloat64(0);
  };
  // Cada frontera T_ℓ = 200·2^(ℓ/4) es del nivel de arriba; el double justo debajo, del de abajo (sin el error del log).
  for (let l = 1; l < NIVELES_T; l++) {
    const t = tFronteraNivel(l);
    assert.equal(nivelDeT(t), l, `frontera ${l} (${t} K)`);
    assert.equal(nivelDeT(anterior(t)), l - 1, `bajo la frontera ${l}`);
    assert.ok(tFronteraNivel(l) < tDeNivel(l) && tDeNivel(l) < tFronteraNivel(l + 1));
  }
  assert.equal(tFronteraNivel(4), 400);
  assert.equal(nivelDeT(295), 2, 'suelo'); assert.equal(nivelDeT(310), 2, 'cuerpo: mismo nivel que el suelo');
  for (const T of [0, -5, NaN, 199.9]) assert.equal(nivelDeT(T), 0, `T = ${T}`);
  assert.equal(nivelDeT(Infinity), NIVELES_T - 1);
  // Familias (enmienda 2): C–O 0, C–N 1, C–C/C–H 2, H–H 3; O=O, O–H y lo demás no catalizable. `Kappa` tiene una por familia.
  const i = (a: string, b: string, k: 1 | 2 | 3 = 1) => indiceTipoEnlace(ELEMENTOS.indexOf(a as never), ELEMENTOS.indexOf(b as never), k);
  assert.deepEqual([i('C', 'O'), i('C', 'O', 2), i('C', 'N'), i('C', 'C'), i('C', 'H'), i('H', 'H'), i('O', 'O', 2), i('O', 'H'), i('N', 'H')].map(familiaCatalitica),
    [0, 0, 1, 2, 2, 3, -1, -1, -1]);
  assert.equal(tipos.FAMILIAS_CATALITICAS, 4);
  // La barrera efectiva: κ rebaja solo exotérmicas; una endotérmica o sin familia paga ea (≥ dH).
  const r = (ea: number, dH: number, catalisis: -1 | 0 | 1 | 2 | 3, paresCatalisis: 0 | 1 | 2 | 3 = catalisis === -1 ? 0 : 1) =>
    ({ ea, dH, catalisis, paresCatalisis });
  assert.equal(tipos.barreraEfectiva(r(100, -5, 3), [0, 0, 0, 30]), 70);
  // Enmienda 3: la rebaja es κ por par del enlace que decide la familia.
  assert.equal(tipos.barreraEfectiva(r(100, -5, 0, 2), [30, 0, 0, 0]), 40);
  assert.equal(tipos.barreraEfectiva(r(100, 5, 3), [0, 0, 0, 1e3]), 100);
  assert.equal(tipos.barreraEfectiva(r(100, -5, -1), [1e3, 1e3, 1e3, 1e3]), 100);
  assert.equal(materia.ATOMOS_POR_REACCION, 2 * materia.ATOMOS_POR_UNIDAD);
  assert.equal(naturaleza.FRACTURA, 1);
  // Las constantes de Q (enmienda 1) viven en naturaleza con su intervalo escrito, sin marcadores por rellenar.
  const fuente = readFileSync(resolve(RAIZ, 'src/shared/naturaleza.ts'), 'utf8');
  for (const c of ['E_RES_IONICO', 'E_HID_IONICO', 'E_CAT_IONICO', 'FUSION_MOLECULA', 'VOLUMEN_ATOMO', 'EMPAQUETADO_BASE',
    'EMPAQUETADO_POR_R', 'TENACIDAD_RED', 'TENACIDAD_ANCHO', 'TENACIDAD_METAL']) assert.ok(c in naturaleza, c);
  assert.doesNotMatch(fuente, /@[A-Z_]+@/, 'intervalos sin medir');
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

test('COLUMNAS_FIJAS fija tipos, anchos y orden del frente, y Col cumple ArrayBufferView', () => {
  const mapa = new Map<string, readonly [contratos.TipoColumna, number]>();
  for (const [nombre, tipo, ancho] of contratos.COLUMNAS_FIJAS) {
    assert.equal(mapa.has(nombre), false, `columna fija repetida: ${nombre}`);
    assert.ok(Number.isInteger(ancho) && ancho >= 1);
    mapa.set(nombre, [tipo, ancho]);
  }
  // Identidades y ticks deben ir en f64 (i32 desborda a 300 Hz en 82 días).
  for (const c of ['uid', 'decideEn', 'pareja']) assert.deepEqual(mapa.get(c), ['f64', 1], c);
  assert.deepEqual(mapa.get('cuerpo'), ['f32', contratos.CUERPO_ANCHO]);
  assert.deepEqual(mapa.get('rasgos'), ['f32', contratos.RASGOS_ANCHO]);
  assert.deepEqual(mapa.get('genoma'), ['f32', contratos.GENOMA_ANCHO]);
  // Toda TypedArray (sobre ArrayBuffer o SharedArrayBuffer) satisface Col y ArrayBufferView (copia directa al CanalGpu).
  const vista: contratos.Col = new Float32Array(new SharedArrayBuffer(16));
  const abv: ArrayBufferView = vista;
  assert.equal(abv.byteLength, 16);
  // Cada nombre en COLUMNAS_FIJAS existe como columna en FrentePublico.
  const _claveValida: (k: (typeof contratos.COLUMNAS_FIJAS)[number][0]) => contratos.Col = (k) =>
    ({} as contratos.FrentePublico)[k];
  assert.equal(typeof _claveValida, 'function');
});

test('los contratos fijan colas M/A/B/F0, canal GPU no bloqueante, percepción multi-ancho, ciclo de vida y vistas lentas', () => {
  // Comprobación en tiempo de compilación de las firmas que enlazan carriles (M1, M3, M4a, M5, M6, C1a, A, B, N, F).
  const chequearTipos = (
    ctx: contratos.CtxMateria,
    canal: contratos.CanalGpu,
    plan: contratos.Plan,
    perc: contratos.Percepcion,
    gest: tipos.Gestacion,
    corte: cinta.Corte,
    texto: fotograma.SucesoTexto,
    vistas: fotograma.VistasLentas,
  ) => {
    const colas: contratos.Cola[] = ['M', 'A', 'B', 'F0'];
    const r = ctx.alta(contratos.Clase.Persona);
    ctx.baja(r);
    const px = ctx.terreno.paginaX[0]!, py = ctx.terreno.paginaY[0]!, vv = ctx.terreno.versionVisible[0]!;
    const okProp = ctx.materia.propio(gest.embrion);
    ctx.materia.adoptar(gest.embrion);
    ctx.materia.moverParte(gest.embrion, gest.embrion, { parte: tipos.Parte.Todo, esp: 0, cuantos: 0, kappa: null });
    canal.enviar(new Uint8Array(4));
    const resp: Uint8Array = canal.recibir(100);
    const q: contratos.ConsultaOrganismo = { radio: 7, clase: 0, filtros: new Float32Array(4), criterio: 1, columna: 11, componente: contratos.CAMPOS_CUERPO.masa };
    const tr: Float32Array = plan.transitable;
    const dims: [number, number, number] = [perc.q, perc.v, perc.a];
    const pol: number[] | undefined = gest.politica;
    const nac: number = corte.serie.nacimientos;
    const tNulo: fotograma.SucesoTexto = { ...texto, valor: null };
    const cl: fotograma.VistasLentas['clima'] = vistas.clima;
    const su: fotograma.VistasLentas['susurro'] = vistas.susurro;
    return [colas, px, py, vv, okProp, resp, q, tr, dims, pol, nac, tNulo, cl, su];
  };
  assert.equal(typeof chequearTipos, 'function');
});

test('naturaleza y enlaces mantienen coherencia física: fuego sostenible, CO₂ gas, digestión/suelo, hierro en horno y enteros seguros', async () => {
  const { TIPOS } = materia;
  const { R, NU, GAMMA, KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH, S_GAS, CAPACIDAD_ATOMO } = naturaleza;
  const D = (a: string, b: string, k = 1): number => {
    const [e, f] = [ELEMENTOS.indexOf(a as never), ELEMENTOS.indexOf(b as never)].sort((x, y) => x - y);
    return TIPOS.find(t => t.e === e && t.f === f && t.k === k)!.d;
  };
  // Enmiendas 1 y 2 (`barreraEfectiva`): κ rebaja la barrera de una exotérmica hasta 0; una endotérmica paga ea ≥ dH.
  const kRate = (T: number, d: number, kappa = 0, dH = 0) => NU * Math.exp(-(dH > 0 ? Math.max(GAMMA * d, dH) : Math.max(0, GAMMA * d - kappa)) / (R * T));

  // 1. CO₂ gas supera al polímero sólido [4×C–O] incluso a 0 K; fosfatos (H₃PO₄/CaHPO₄) son más estables que P=O extra.
  assert.ok(2 * D('C', 'O', 2) > 4 * D('C', 'O', 1), 'CO₂ gas debe vencer al polímero sólido [4×C–O]');
  assert.ok(2 * D('P', 'O', 1) > D('P', 'O', 2), 'H₃PO₄ y CaHPO₄ deben vencer a la deshidratación en frío');

  // 2. Combustibles estables en frío, llama adiabática en aire sostenible (> 1.000 K) y orden madera < carbón < grasa.
  const eC = -2 * D('C', 'C'), eO2 = -D('O', 'O', 2), eCO2 = -2 * D('C', 'O', 2), eH2O = -2 * D('O', 'H');
  const eCH2O = -(D('C', 'C') + D('C', 'H') + D('C', 'O') + D('O', 'H'));
  const eCH2 = -(D('C', 'C') + 2 * D('C', 'H'));
  const qMadera = -((eCO2 + eH2O) - (eCH2O + eO2));
  const qCarbon = -(eCO2 - (eC + eO2));
  const qGrasa = -((eCO2 + eH2O) - (eCH2 + 1.5 * eO2));
  assert.ok(qMadera > 0 && qCarbon > 0 && qGrasa > 0);
  assert.ok(qMadera / 30.03 < qCarbon / 12.01 && qCarbon / 12.01 < qGrasa / 14.03, 'MJ/kg: madera < carbón < grasa');
  const tLlamaMadera = 295 + qMadera / (14 * CAPACIDAD_ATOMO);
  const tLlamaCarbon = 295 + qCarbon / (11 * CAPACIDAD_ATOMO);
  assert.ok(tLlamaMadera > 1000 && tLlamaCarbon > 1000, `llama adiabática insuficiente: madera=${tLlamaMadera}, carbón=${tLlamaCarbon}`);
  assert.ok(kRate(295, D('O', 'O', 2)) < 1e-18, 'combustible debe ser estable en frío');
  assert.ok(kRate(tLlamaCarbon, D('O', 'O', 2)) > 1, 'carbón debe sostener su propia llama');

  // 3. Atmósfera (N₂ + O₂) y etano (C₂H₆) estables a 295 K.
  const dH_aire = -(4 * D('N', 'O') + 4 * D('N', 'O', 2)) + (2 * D('N', 'N', 3) + 3 * D('O', 'O', 2));
  assert.ok(dH_aire > 100, 'el aire N₂ + O₂ debe ser estable');
  const dG_etano = (2 * D('C', 'H') + D('C', 'C') - D('C', 'C', 2) - D('H', 'H')) - 295 * S_GAS;
  assert.ok(dG_etano > 20, 'el etano debe ser estable a 295 K');

  // 4 y 5, con las reacciones reales de Q (revisión de la enmienda 3, hallazgo 9: antes se rehacían aquí con γ·D del enlace
  // que se suponía decisivo y con un Fe₂O₃ + C → Fe₂O + CO₂ 1:1 que Q ya no elige).
  const q = crearServicioQuimico({ modo: 'inmediato' });
  try {
    const S = registrarSustanciasBase(q), { nivelDeT, barreraEfectiva } = tipos;
    const k = (a: number, b: number, T: number, kappa: readonly [number, number, number, number]) => {
      const r = q.reaccion(a, b, nivelDeT(T));
      return r ? NU * Math.exp(-barreraEfectiva(r, kappa) / (R * T)) : 0;
    };
    const K0 = [KAPPA0, KAPPA0, KAPPA0, KAPPA0] as const, KS = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH] as const;
    // 4. Hierro: Fe₂O₃ + C no se reduce en fogata (800 K) ni en llama abierta (1.095 K); en horno (1.250 K) da CO₂ y metal.
    assert.equal(q.reaccion(S.Fe2O3, S.C, nivelDeT(800)), null, 'Fe₂O₃ no se reduce en fogata');
    assert.equal(q.reaccion(S.Fe2O3, S.C, nivelDeT(1095)), null, 'ni en llama abierta');
    const horno = q.reaccion(S.Fe2O3, S.C, nivelDeT(1250));
    assert.ok(horno && horno.salidas.some((t) => t.id === S.CO2) && horno.salidas.some((t) => t.id === S.Fe2), 'en horno, CO₂ y hierro');
    // 5. Digestión (310 K, KAPPA0): las rutas sin O₂ de la proteína, la madera y el glicósido (→ NH₃ + C, → H₂O + C) tienen
    // su barrera en γ·D(C–H) = 141,05 (rompen un C–H), así que con κ₀ = 60 van a ~2·10⁻⁵/tick: el tubo apenas digiere por
    // química (pedido a B: κ del tubo ≳ 88 o plantillas cuya ruta la decida C–N o C–O). No oxida con O₂ ni carboniza la grasa.
    for (const id of [S.proteina, S.madera, S.glicosido]) {
      const v = k(id, 0, 310, K0);
      assert.ok(v > 1e-6 && v < 1e-4, `digestión de ${id} a 310 K: k = ${v.toExponential(2)}`);
    }
    assert.ok(k(S.madera, S.O2, 310, K0) < 1e-9 && k(S.CH2, 0, 310, K0) < 1e-12, 'el tubo no quema ni carboniza');
    // Suelo (295 K, KAPPA_SUELO): mineraliza con O₂ y oxida el H₂ sin barrera; nada parte el agua.
    assert.ok(k(S.madera, S.O2, 295, KS) > 1e-4, 'el suelo debe mineralizar cadáveres con O₂');
    assert.ok(KAPPA_SUELO_HH >= GAMMA * D('O', 'O', 2) && k(S.H2, S.O2, 295, KS) === NU, 'el suelo oxida el H₂ al paso');
    assert.equal(q.reaccion(S.H2O, 0, nivelDeT(310)), null, 'ni el suelo ni el tubo parten el agua');
  } finally { await q.cerrar(); }

  // 6. Magnitudes en enteros seguros (un chunk nuevo entero cabe con margen en Float64 entero antes de plegar a bigint en F0).
  const cuantosChunk = 256 * Math.round(2000e6 / 60.08);
  const energiaChunk = cuantosChunk * (4 * D('Si', 'O')) + Math.round(CAPACIDAD_ATOMO * cuantosChunk * 3 * 300);
  assert.ok(Number.isSafeInteger(cuantosChunk) && Number.isSafeInteger(energiaChunk));
});

test('los índices de los 52 tipos de enlace son los de la congelación: la clave de toda sustancia guardada', () => {
  // e, f y k de cada índice: solo dependen de las valencias y de qué π son 0, que no cambian con un mundo creado.
  const congelados = '001 011 021 031 041 051 061 071 111 112 113 121 122 123 131 132 141 142 143 151 161 171 221 222 223 231 232 ' +
    '241 242 243 251 261 271 331 332 341 342 351 361 371 441 442 443 451 461 471 551 561 571 661 671 771';
  assert.equal(materia.TIPOS.map(t => `${t.e}${t.f}${t.k}`).join(' '), congelados);
});

test('las columnas fijas del frente son exactamente las Col de FrentePublico', () => {
  type ColumnasFrente = { [K in keyof contratos.FrentePublico]-?: contratos.FrentePublico[K] extends contratos.Col ? K : never }[keyof contratos.FrentePublico];
  type Fijas = (typeof contratos.COLUMNAS_FIJAS)[number][0];
  const sinFija: [Exclude<ColumnasFrente, Fijas>] extends [never] ? true : false = true;
  const sinCampo: [Exclude<Fijas, ColumnasFrente>] extends [never] ? true : false = true;
  assert.ok(sinFija && sinCampo);
  assert.equal(contratos.COLUMNAS_FIJAS.length, 15);
});

test('el metano rinde más por masa que la grasa y su llama en aire también pasa de 1.000 K', () => {
  const { TIPOS } = materia;
  const D = (a: string, b: string, k = 1): number => {
    const [e, f] = [ELEMENTOS.indexOf(a as never), ELEMENTOS.indexOf(b as never)].sort((x, y) => x - y);
    return TIPOS.find(t => t.e === e && t.f === f && t.k === k)!.d;
  };
  const qMetano = 2 * D('C', 'O', 2) + 4 * D('O', 'H') - 4 * D('C', 'H') - 2 * D('O', 'O', 2);
  const qGrasa = 2 * D('C', 'O', 2) + 2 * D('O', 'H') - D('C', 'C') - 2 * D('C', 'H') - 1.5 * D('O', 'O', 2);
  assert.ok(qMetano / 16.04 > qGrasa / 14.03, 'MJ/kg: grasa < metano');
  // CH₄ + 2 O₂ + 8 N₂: 25 átomos.
  assert.ok(295 + qMetano / (25 * naturaleza.CAPACIDAD_ATOMO) > 1000);
});
