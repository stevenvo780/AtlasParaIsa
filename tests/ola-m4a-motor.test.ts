// Carril m4a: piezas puras del motor de dueños (reparto, fusión de partes, celdas del punto de control, tabla de varios
// dueños) y un humo del conductor del tick con un dueño. No mide ni simula: pocos ticks, para ver que el camino corre.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrenoPercepcion } from '../src/world/decision/terreno-percepcion.js';
import { ctxSi } from '../src/world/motor/acceso.js';
import { cuentaPorDueno, duenoDeVecino, ordenMorton, repartirPorTramos } from '../src/world/motor/bloques.js';
import { celdaLocal, celdaMundo, duenoSi } from '../src/world/motor/contexto.js';
import { Clase, REF_NULA, slotDe, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { fundir, nuevosDe } from '../src/world/motor/reunir.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { mortonCode } from '../src/world/soa/morton.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';

test('m4a: el código Morton ordena por cuadrantes y cubre todo int32', () => {
  // Pedido de m2b.cierre2 (lo probaba gpu-reparto.test.ts): orden, extremos y límites.
  assert.equal(mortonCode(-0x80000000, -0x80000000), 0n);
  assert.equal(mortonCode(0x7fffffff, 0x7fffffff), 2n ** 64n - 1n);
  assert.ok(mortonCode(0, 0) < mortonCode(1, 0) && mortonCode(1, 0) < mortonCode(0, 1) && mortonCode(0, 1) < mortonCode(1, 1));
  assert.ok(mortonCode(-1, -1) < mortonCode(0, -1) && mortonCode(0, -1) < mortonCode(-1, 0) && mortonCode(-1, 0) < mortonCode(0, 0));
  assert.throws(() => mortonCode(0x80000000, 0), RangeError);
  assert.throws(() => mortonCode(0, -0x80000001), RangeError);
  assert.throws(() => mortonCode(0.5, 0), RangeError);
});

test('m4a: el reparto corta el orden Morton en tramos contiguos y parejos', () => {
  const lado = 8, px: number[] = [], py: number[] = [];
  for (let y = 0; y < lado; y++) for (let x = 0; x < lado; x++) { px.push(x - 3); py.push(y - 5); }
  const hilos = 4, dueno = repartirPorTramos(px, py, hilos), orden = ordenMorton(px, py);
  assert.deepEqual([...cuentaPorDueno(dueno, hilos)], [16, 16, 16, 16]);
  for (let i = 1; i < orden.length; i++) assert.ok(dueno[orden[i]!]! >= dueno[orden[i - 1]!]!, 'los tramos son contiguos en el orden Morton');
  // Con pesos, el chunk pesado deja menos vecinos a su dueño.
  const peso = Float64Array.from(px, (_, i) => i === orden[0] ? 100 : 1);
  const pesado = repartirPorTramos(px, py, hilos, peso);
  assert.ok(cuentaPorDueno(pesado, hilos)[pesado[orden[0]!]!]! < 16);
  assert.equal(repartirPorTramos(px, py, 1).every(d => d === 0), true);
  assert.equal(duenoDeVecino(100, 100, [0, 99], [0, 100], [2, 3], 0), 3);
  assert.equal(duenoDeVecino(5, 5, [], [], [], 7), 7);
});

test('m4a: fundir suma diferencias con la base y une listas sin repetir', () => {
  const base = { n: 10, lista: [{ id: 'a' }], sub: { k: 1 }, texto: 'x' };
  const fundido = fundir(base, [
    { n: 13, lista: [{ id: 'a' }, { id: 'b' }], sub: { k: 1, nuevo: 2 }, texto: 'x' },
    { n: 11, lista: [{ id: 'a' }, { id: 'c' }, { id: 'b' }], sub: { k: 4 }, texto: 'y' },
  ]) as typeof base & { sub: { nuevo: number } };
  assert.equal(fundido.n, 14);
  assert.deepEqual(fundido.lista.map(v => v.id), ['a', 'b', 'c']);
  assert.deepEqual(fundido.sub, { k: 4, nuevo: 2 });
  assert.equal(fundido.texto, 'y');
  assert.deepEqual(nuevosDe([1, 2], [1, 2, 3]), [3]);
  assert.equal(fundir(undefined, [undefined, undefined]), undefined);
});

test('m4a: una celda del punto de control vuelve a su sitio en otra arena', () => {
  const a = new TerrenoPercepcion(), b = new TerrenoPercepcion();
  a.asegurarPagina(7, -3); const chunk = a.asegurarPagina(-120, 45);
  const celda = chunk * 256 + 37, guardada = celdaMundo(a, celda);
  assert.equal(guardada % 256, 37);
  b.asegurarPagina(1, 1); b.asegurarPagina(2, 2); b.asegurarPagina(3, 3);
  const vuelta = celdaLocal(b, guardada);
  assert.equal(vuelta & 255, 37);
  assert.equal(b.paginaX[vuelta >> 8], -120);
  assert.equal(b.paginaY[vuelta >> 8], 45);
  assert.equal(celdaMundo(a, -1), -1);
  assert.equal(celdaLocal(b, -1), -1);
});

test('m4a: la tabla de varios dueños reparte ranuras y cede filas entre copias', () => {
  const coordinador = new TablaOrganismosSoA(true, { reservaFilas: 4096 });
  const otro = TablaOrganismosSoA.conectar(coordinador.compartirTabla(), 1);
  const r0 = coordinador.alta(0, Clase.Persona), r1 = otro.alta(0, Clase.Animal);
  assert.notEqual(slotDe(r0), slotDe(r1));
  const sellar = (tabla: TablaOrganismosSoA, hilo: number, slots: number[]): void => { const w = tabla.escritura(hilo); for (const s of slots) w.fila(s); };
  sellar(coordinador, 0, [slotDe(r0)]); sellar(otro, 1, [slotDe(r1)]);
  let frente = coordinador.publicar(1);
  assert.equal(frente.dueno[slotDe(r1)], 1, 'una copia conectada da de alta con su hilo');
  assert.equal(otro.lectura().tick, 1);
  // El dueño 0 cede su fila al 1; desde el frente siguiente es el 1 quien la sella.
  sellar(coordinador, 0, [slotDe(r0)]); sellar(otro, 1, [slotDe(r1)]);
  coordinador.ceder(0, r0, 1);
  frente = coordinador.publicar(2);
  assert.equal(frente.dueno[slotDe(r0)], 1);
  sellar(otro, 1, [slotDe(r0)]);
  otro.baja(1, r1);
  coordinador.publicar(3);
  assert.equal(coordinador.lectura().vivo[slotDe(r1)], 0);
  // La ranura dada de baja vuelve por la pila compartida tras la cuarentena.
  for (let tick = 4; tick <= 6; tick++) { sellar(otro, 1, [slotDe(r0)]); coordinador.publicar(tick); }
  assert.equal(slotDe(otro.alta(1, Clase.Animal)), slotDe(r1));
});

test('m4a: con todo apagado el motor de un hilo es stepWorld y no arma dueño', () => {
  const mundo = createWorld(7), motor = crearMotor(mundo, unSoloDueno(7));
  const { tick, resultados } = motor.paso([]);
  assert.equal(tick, mundo.tick);
  assert.deepEqual(resultados, []);
  assert.equal(ctxSi(mundo), undefined);
  assert.equal(motor.instantanea().materia, null);
  assert.equal(motor.telemetria().hilos, 1);
  assert.throws(() => crearMotor(mundo, { ...unSoloDueno(7), hilos: 2 }), /v23\.duenos/);
});

test('m4a: con una ley encendida el dueño único conduce el tick y publica el frente', () => {
  const mundo = createWorld(7, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, cohesion: true } });
  const motor = crearMotor(mundo, unSoloDueno(7));
  for (let i = 0; i < 3; i++) motor.paso([]);
  const d = duenoSi(mundo)!;
  assert.ok(d, 'el mundo tiene su dueño');
  assert.equal(d.tick, mundo.tick);
  assert.equal(d.frente.tick, mundo.tick);
  assert.equal(d.personas.size, mundo.people.length);
  assert.ok(d.chunks.length > 0);
  const persona = mundo.people[0]!;
  assert.equal(d.idDe(persona.uid!), persona.id);
  assert.equal(d.uidDe(persona.id), persona.uid);
  assert.notEqual(d.ref(persona.uid!), REF_NULA);
  assert.equal(d.ref(-5), REF_NULA);
  assert.ok(d.id('nonce') < d.id('nonce'));
});

test('m4a: varios dueños reparten el mundo, dan ticks y lo reúnen entero (sin leyes)', async () => {
  // Solo el interruptor del motor (incoherente a propósito: sin leyes ningún gancho corre): se prueba la maquinaria.
  const mundo = createWorld(11, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, duenos: true } });
  const cuenta = { personas: mundo.people.length, teselas: mundo.tiles.length, fauna: mundo.animals.length, chunks: Object.keys(mundo.chunks).length };
  const ids = mundo.people.map(p => p.id).sort();
  const motor = crearMotor(mundo, { ...unSoloDueno(11), hilos: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal(motor.paso([]).tick, i + 1);
    const { world, materia } = motor.instantanea();
    assert.equal(materia, null);
    assert.equal(world.tick, 3);
    assert.deepEqual(world.people.map(p => p.id).sort(), ids);
    // El coordinador lleva las regiones desde el frente: activa el halo de cada persona, así que puede haber más chunks.
    const claves = new Set(world.tiles.map(t => `${t.x},${t.y}`));
    assert.equal(claves.size, world.tiles.length, 'ninguna tesela repetida entre dueños');
    assert.equal(world.tiles.length, 256 * Object.keys(world.chunks).length);
    assert.ok(world.tiles.length >= cuenta.teselas && Object.keys(world.chunks).length >= cuenta.chunks);
    assert.ok(world.animals.length >= cuenta.fauna);
    assert.equal(new Set(world.animals.map(a => a.id)).size, world.animals.length, 'ningún animal repetido');
    assert.equal(new Set(world.people.map(p => p.uid)).size, cuenta.personas, 'cada persona con su uid');
    const t = motor.telemetria();
    assert.equal(t.hilos, 3);
    assert.equal(t.tick, 3);
    // Un gesto y una ficha llegan al dueño que tiene a la persona, esté en el hilo que esté.
    for (const quien of [world.people[0]!, world.people[world.people.length - 1]!]) {
      const ficha = motor.detalle(quien.uid!);
      const { resultados } = motor.paso([{ id: `g-${quien.id}`, kind: 'command', x: quien.x, y: quien.y, agentId: quien.id, order: 'rest' }]);
      assert.deepEqual(resultados.map(r => [r.id, r.accepted]), [[`g-${quien.id}`, true]]);
      assert.equal((await ficha)?.id, quien.id);
    }
    assert.equal(await (async () => { const nadie = motor.detalle(-1); motor.paso([]); return nadie; })(), null);
    // Cargar la instantánea abre otra época y el mundo sigue.
    motor.cargar({ world, materia: null }, 2);
    assert.equal(motor.paso([]).tick, 4);
    assert.equal(motor.instantanea().world.people.length, cuenta.personas);
  } finally { await motor.cerrar(); }
});

test('m4a: al cambiar de sitio la gente, se activan sus chunks, se archivan los viejos y nadie se pierde al migrar', async () => {
  const mundo = createWorld(13, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, duenos: true } });
  const ids = mundo.people.map(p => p.id).sort();
  const motor = crearMotor(mundo, { ...unSoloDueno(13), hilos: 4 });
  try {
    motor.paso([]);
    const antes = motor.instantanea().world;
    // Nadie se mueve sin leyes: se desplaza a todos 6 chunks y se abre otra época con ese mundo.
    antes.people.forEach((p, i) => { p.x += 96 + (i % 3) * 16; p.target = { x: p.x, y: p.y }; });
    motor.cargar({ world: antes, materia: null }, 2);
    for (let i = 0; i < 5; i++) motor.paso([]);
    const { world } = motor.instantanea();
    assert.deepEqual(world.people.map(p => p.id).sort(), ids);
    assert.equal(new Set(world.people.map(p => p.uid)).size, ids.length);
    const teselas = new Set(world.tiles.map(t => `${t.x},${t.y}`));
    assert.equal(teselas.size, world.tiles.length, 'ninguna tesela repetida');
    assert.equal(world.tiles.length, 256 * Object.keys(world.chunks).length);
    for (const p of world.people) assert.ok(teselas.has(`${p.x},${p.y}`), `${p.id} pisa un chunk activo`);
    assert.ok(world.retiredChunks.length > 0, 'los chunks que nadie pide quedan archivados');
    assert.equal(new Set(world.animals.map(a => a.id)).size, world.animals.length);
    assert.ok(motor.telemetria().migraciones > 0);
  } finally { await motor.cerrar(); }
});

test('m4a: con v23.materia el dueño arma la arena de lotes y la química, con uno y con varios dueños', async () => {
  const v23 = { ...DEFAULT_PARAMS.v23, materia: true };
  const mundo = createWorld(17, { ...DEFAULT_PARAMS, v23 });
  const unico = crearMotor(mundo, unSoloDueno(17));
  unico.paso([]); unico.paso([]);
  const d = duenoSi(mundo)!;
  assert.ok(d.materia && d.quimica, 'el contexto lleva materia y química');
  assert.equal(d.materia.vivo(-1), false);
  const punto = unico.instantanea().materia;
  assert.equal(punto?.tick, 2);
  assert.ok(punto.paginas.length > 0, 'la instantánea conserva las páginas de materia');
  const repartido = createWorld(17, { ...DEFAULT_PARAMS, v23: { ...v23, duenos: true } });
  const motor = crearMotor(repartido, { ...unSoloDueno(17), hilos: 2 });
  try {
    assert.equal(motor.paso([]).tick, 1);
    assert.equal(motor.paso([]).tick, 2);
  } finally { await motor.cerrar(); }
});
