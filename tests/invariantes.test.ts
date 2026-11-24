import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, type World } from '../src/world/index.js';
import { comprobarInvariantes, crearComprobador, registrar, listaInvariantes } from '../src/world/invariantes.js';
import { Muestreador } from '../src/server/diagnostico.js';
import { AzarPropiedades } from './lib/propiedades.js';
import { conRejilla, vecinos } from '../src/world/rejilla.js';
import { conRejillaFauna, animalesVivosEnCelda } from '../src/world/animals.js';
import { CHUNK_SIZE, chunkKey } from '../src/world/terrain.js';
import { ELEMENTS } from '../src/shared/chemistry.js';
import { intervaloWilson, resumirIntentos, ejecutarIntento } from '../scripts/lab/reproducir.js';
import { evaluarPanel, configurarPanel, permutacionEstratificada } from '../scripts/lab/panel.js';

const temporal = (): string => { mkdirSync('/tmp/atlas-v23-0c', { recursive: true }); return mkdtempSync('/tmp/atlas-v23-0c/test-'); };
const detecta = (id: string, romper: (m: World) => void): void => {
  const m = createWorld(51926); romper(m);
  const violaciones = comprobarInvariantes(m, { ids: [id] });
  assert.ok(violaciones.length > 0, `${id} no detectó la corrupción`);
  assert.ok(violaciones.every(v => v.id === id && v.tick === m.tick && v.gravedad === 'dura'));
};

test('un mundo nuevo cumple todo el registro y la comprobación no cambia su estado', () => {
  const m = createWorld(51926), antes = JSON.stringify(m);
  assert.deepEqual(comprobarInvariantes(m), []);
  assert.equal(JSON.stringify(m), antes);
});

test('cada invariante nativa detecta una corrupción inyectada con contexto', () => {
  const inyecciones: Record<string, (m: World) => void> = {
    'numeros.cuerpos': m => { m.people[0]!.energy = NaN; },
    'numeros.inventarios': m => { m.people[0]!.materials.wood = -1; },
    'numeros.teselas': m => { m.tiles[0]!.food = Infinity; },
    'identidades.unicas': m => { m.people[1]!.id = m.people[0]!.id; },
    'referencias.validas': m => { m.people[0]!.communityId = 'comunidad-inexistente'; },
    'indices.coherentes': m => { m.tiles[0]!.fauna = (m.tiles[0]!.fauna ?? 0) + 1; },
    'demografia.causas': m => { m.events.push({ ...m.events[0]!, id: 'muerte-inyectada', kind: 'death' }); },
    'balances.actuales': m => { m.technology.ledger.imported.wood++; },
  };
  assert.deepEqual(listaInvariantes().filter(inv => inv.carril === '0C').map(inv => inv.id).sort(), Object.keys(inyecciones).sort());
  for (const [id, inyectar] of Object.entries(inyecciones)) detecta(id, inyectar);
});

test('cuerpos, inventarios y teselas rechazan negativos, NaN e infinitos', () => {
  for (const valor of [-1, NaN, Infinity, -Infinity]) {
    detecta('numeros.cuerpos', m => { m.animals[0]!.health = valor; });
    detecta('numeros.inventarios', m => { m.people[0]!.inventory = valor; });
    detecta('numeros.teselas', m => { m.tiles[0]!.moisture = valor; });
  }
});

test('referencias de personas, estructuras, animales, planos y lugares se validan', () => {
  for (const inyectar of [
    (m: World) => { m.people[0]!.bonds.fantasma = 0.5; },
    (m: World) => { m.people[0]!.genome.parents = ['fantasma']; },
    (m: World) => { m.structures[0]!.blueprintId = 'fantasma'; },
    (m: World) => { m.animals[0]!.x = 123456; },
    (m: World) => { m.memories[0]!.placeId = 'fantasma'; },
    (m: World) => { m.blueprints[0]!.parents = ['fantasma']; },
  ]) detecta('referencias.validas', inyectar);
});

test('balances de nacimientos y agua contenida detectan sus propias diferencias', () => {
  detecta('balances.actuales', m => { m.totals.births++; });
  detecta('balances.actuales', m => { m.technology.water!.filled++; });
  detecta('demografia.causas', m => { m.demographyDynamics.causes.senescence++; });
});

test('identidades, cuerpos, índices y balances detectan corrupciones que antes no tenían prueba', () => {
  detecta('identidades.unicas', m => { m.tiles.push({ ...m.tiles[0]! }); });
  detecta('identidades.unicas', m => { m.legacy.push({ ...m.people[0]!, cause: 'senescence' } as never); });
  detecta('numeros.cuerpos', m => { m.people[0]!.demography.health = -1; });
  detecta('indices.coherentes', m => { m.communities.push({ id: 'comunidad-prueba', members: [] } as never); m.people[0]!.communityId = 'comunidad-prueba'; });
  detecta('indices.coherentes', m => { m.communities.push({ id: 'comunidad-prueba', members: [m.people[0]!.id] } as never); });
  detecta('balances.actuales', m => { m.people[0]!.technology.items.push({ id: 'product-1', mass: 5, composition: { wood: 1, stone: 0, water: 0 } } as never); });
  detecta('balances.actuales', m => { m.blueprints.push({ ...m.blueprints[0]!, id: 'blueprint-999' }); });
  const lote = (masa: number) => ({ id: 'lote-1', formulaId: 'formula', composition: { ...Object.fromEntries(ELEMENTS.map(e => [e, 0])), O: 5 }, phase: 'solid', mass: masa, properties: {} }) as never;
  detecta('balances.actuales', m => { m.people[0]!.compounds = [lote(1)]; });
  detecta('numeros.inventarios', m => { m.people[0]!.compounds = [lote(-1)]; });
});

test('los invariantes por región solo ven su región, salvo las coordenadas no finitas', () => {
  const m = createWorld(51926), tesela = m.tiles[0]!, animal = m.animals[0]!;
  const propia = { chunkX: Math.floor(tesela.x / CHUNK_SIZE), chunkY: Math.floor(tesela.y / CHUNK_SIZE) };
  const ajena = { chunkX: propia.chunkX + 50, chunkY: propia.chunkY };
  tesela.food = NaN;
  assert.ok(comprobarInvariantes(m, { ids: ['numeros.teselas'], region: propia }).every(v => v.region === `${propia.chunkX},${propia.chunkY}`));
  assert.ok(comprobarInvariantes(m, { ids: ['numeros.teselas'], region: propia }).length > 0);
  assert.deepEqual(comprobarInvariantes(m, { ids: ['numeros.teselas'], region: ajena }), []);
  tesela.food = 0.5;
  animal.energy = NaN;
  const regionAnimal = { chunkX: Math.floor(animal.x / CHUNK_SIZE), chunkY: Math.floor(animal.y / CHUNK_SIZE) };
  assert.ok(comprobarInvariantes(m, { ids: ['numeros.cuerpos'], region: regionAnimal }).length > 0);
  assert.deepEqual(comprobarInvariantes(m, { ids: ['numeros.cuerpos'], region: ajena }), []);
  animal.energy = 1; animal.x = NaN;
  assert.ok(comprobarInvariantes(m, { ids: ['numeros.cuerpos'], region: ajena }).length > 0, 'una posición NaN debe verse desde cualquier región');
});

test('un mundo muy corrupto devuelve solo una muestra acotada de hallazgos', () => {
  const m = createWorld(51926);
  for (const t of m.tiles) t.food = NaN;
  const v = comprobarInvariantes(m, { ids: ['numeros.teselas'] });
  assert.ok(m.tiles.length > 64);
  assert.equal(v.length, 64);
});

test('los recuerdos resuelven asentamientos y lugares de regiones archivadas', () => {
  const m = createWorld(51926), p = m.people[0]!;
  const lugar = { id: 'settlement-27--97', x: 27, y: -97, name: 'Archivo', description: 'prueba', gatherings: 0 };
  m.retiredChunks.push({ key: chunkKey(lugar.x, lugar.y), cx: 1, cy: -7, tiles: [], places: [lugar], discovered: true, lastTick: 0 });
  p.experiences.push({ tick: 0, text: 'prueba', causeId: '', placeId: lugar.id });
  assert.deepEqual(comprobarInvariantes(m, { ids: ['referencias.validas'] }), []);
  m.retiredChunks[0]!.places = [];
  assert.ok(comprobarInvariantes(m, { ids: ['referencias.validas'] }).some(v => v.contexto?.destino === lugar.id));
});

test('la comprobación dentro del ámbito detecta rejillas desactualizadas', () => {
  const m = createWorld(51926), p = m.people[0]!, a = m.animals[0]!;
  conRejilla(m, () => {
    vecinos(m, p, 0, q => q === p);
    p.x += 1000;
    assert.ok(comprobarInvariantes(m, { ids: ['indices.coherentes'] }).some(v => v.detalle.includes('Rejilla de personas')));
    p.x -= 1000;
  });
  conRejillaFauna(m, () => {
    animalesVivosEnCelda(m, a.x, a.y);
    const destino = m.tiles.find(t => t.x !== a.x || t.y !== a.y)!;
    a.x = destino.x; a.y = destino.y;
    assert.ok(comprobarInvariantes(m, { ids: ['indices.coherentes'] }).some(v => v.detalle.includes('Rejilla de fauna')));
  });
});

test('el observador detecta pérdida de población y acumulados decrecientes entre pasos', () => {
  const m = createWorld(51926), comprobar = crearComprobador();
  m.totals.hunts = 2; assert.deepEqual(comprobar(m), []);
  m.tick++; m.people.pop(); m.totals.hunts--;
  const ids = comprobar(m).map(v => v.id);
  assert.ok(ids.includes('demografia.balance'));
  assert.ok(ids.includes('acumulados.monotonos'));
});

test('registro extensible, cadencia, severidad y excepciones de comprobadores', () => {
  const m = createWorld(51926);
  const quitar = registrar({ id: 'prueba.blanda', carril: 'prueba', gravedad: 'blanda', cadaTicks: 2, alcance: 'global', comprobar: () => [{ id: 'otro', tick: -1, gravedad: 'dura', detalle: 'prueba' }] });
  const quitarError = registrar({ id: 'prueba.error', carril: 'prueba', gravedad: 'dura', cadaTicks: 1, alcance: 'global', comprobar: () => { throw new Error('inyectado'); } });
  try {
    assert.throws(() => registrar(listaInvariantes().find(i => i.id === 'prueba.blanda')!));
    const v = comprobarInvariantes(m, { ids: ['prueba.blanda'] });
    assert.equal(v[0]!.gravedad, 'blanda'); assert.equal(v[0]!.id, 'prueba.blanda'); assert.equal(v[0]!.tick, 0);
    m.tick = 1; assert.deepEqual(comprobarInvariantes(m, { ids: ['prueba.blanda'], cadencia: true }), []);
    assert.match(comprobarInvariantes(m, { ids: ['prueba.error'] })[0]!.detalle, /excepción/);
  } finally { quitar(); quitarError(); }
});

test('muestreador respeta la cadencia de cada invariante, registra contexto no finito y expone salud', async () => {
  const dir = temporal(), ejecuciones: number[] = [];
  const quitar = registrar({ id: 'prueba.bitacora', carril: 'prueba', gravedad: 'blanda', cadaTicks: 3, alcance: 'global',
    comprobar: m => { ejecuciones.push(m.tick); return [{ id: 'prueba.bitacora', gravedad: 'blanda', tick: m.tick, detalle: 'inyectada', contexto: { valor: NaN, x: 17, y: 13 } }]; } });
  const m = createWorld(51926), muestreador = new Muestreador({ directorio: dir });
  try {
    // La ronda puede gastar los primeros presupuestos en los comprobadores nativos.
    for (let i = 1; i <= 80 && ejecuciones.length < 3; i++) { m.tick = i; muestreador.paso(m, 1000); }
    assert.ok(ejecuciones.length >= 3);
    assert.ok(ejecuciones.every((tick, i) => i === 0 || tick - ejecuciones[i - 1]! >= 3), `ejecuciones ${ejecuciones}`);
    await muestreador.vaciar();
    const registros = readFileSync(muestreador.fichero, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const v = registros.find(r => r.violacion.id === 'prueba.bitacora');
    assert.equal(v.violacion.contexto.valor, 'NaN');
    assert.ok(v.entorno.teselas.length <= 9);
    assert.ok(muestreador.resumen().blandas24h >= 3);
    assert.equal(muestreador.resumen().pendientesBitacora, 0);
    assert.deepEqual(muestreador.paso(m, 1000), []);
  } finally { quitar(); rmSync(dir, { recursive: true, force: true }); }
});

test('una comprobación con miles de violaciones las cuenta todas pero registra solo una muestra', async () => {
  const dir = temporal();
  const quitar = registrar({ id: 'prueba.masiva', carril: 'prueba', gravedad: 'dura', cadaTicks: 1000, alcance: 'global',
    comprobar: m => Array.from({ length: 5000 }, (_, i) => ({ id: 'prueba.masiva', gravedad: 'dura' as const, tick: m.tick, detalle: `n${i}` })) });
  const m = createWorld(51926), muestreador = new Muestreador({ directorio: dir });
  try {
    for (let i = 1; i <= 80 && muestreador.resumen().duras24h === 0; i++) { m.tick = i; muestreador.paso(m, 1000); }
    await muestreador.vaciar();
    assert.equal(muestreador.resumen().duras24h, 5000);
    const lineas = readFileSync(muestreador.fichero, 'utf8').trim().split('\n').filter(l => l.includes('prueba.masiva'));
    assert.ok(lineas.length > 0 && lineas.length <= 8, `${lineas.length} registros`);
  } finally { quitar(); rmSync(dir, { recursive: true, force: true }); }
});

test('la bitácora rota por tamaño y nunca conserva más de ocho ficheros', async () => {
  const dir = temporal();
  const quitar = registrar({ id: 'prueba.rota', carril: 'prueba', gravedad: 'dura', cadaTicks: 1, alcance: 'global',
    comprobar: m => [{ id: 'prueba.rota', gravedad: 'dura', tick: m.tick, detalle: 'inyectada' }] });
  const m = createWorld(51926), maximo = 6000, muestreador = new Muestreador({ directorio: dir, maxBitacoraBytes: maximo });
  try {
    for (let i = 1; i <= 400; i++) { m.tick = i; muestreador.paso(m, 1000); if (i % 20 === 0) await muestreador.vaciar(); }
    await muestreador.vaciar();
    const ficheros = readdirSync(join(dir, 'diagnostico')).filter(f => f.startsWith('invariantes.jsonl'));
    assert.ok(ficheros.length >= 2 && ficheros.length <= 8, ficheros.join());
    assert.ok(existsSync(muestreador.fichero) && existsSync(`${muestreador.fichero}.1`));
    for (const f of ficheros) assert.ok(statSync(join(dir, 'diagnostico', f)).size <= maximo, f);
  } finally { quitar(); rmSync(dir, { recursive: true, force: true }); }
});

test('los errores de escritura de bitácora son visibles y no se descartan al cerrar', async () => {
  const dir = temporal(); writeFileSync(join(dir, 'diagnostico'), 'bloqueo');
  const m = createWorld(51926), sampler = new Muestreador({ directorio: dir });
  m.technology.ledger.imported.wood++;
  try {
    for (let i = 0; i < 80 && !sampler.resumen().comprobacionesPorInvariante['balances.actuales']; i++) { m.tick = i; sampler.paso(m, 1000); }
    await assert.rejects(sampler.vaciar());
    assert.ok(sampler.resumen().errorBitacora);
    assert.ok(sampler.resumen().registrosSinBitacora > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('los invariantes por región avanzan por regiones distintas dentro del presupuesto', () => {
  const dir = temporal(), regiones = new Set<string>();
  const quitar = registrar({ id: 'prueba.regiones', carril: 'prueba', gravedad: 'dura', cadaTicks: 1, alcance: 'region',
    comprobar: (_m, r) => { regiones.add(`${r!.chunkX},${r!.chunkY}`); return []; } });
  const m = createWorld(51926), muestreador = new Muestreador({ directorio: dir });
  try {
    const total = new Set(m.tiles.map(t => `${Math.floor(t.x / CHUNK_SIZE)},${Math.floor(t.y / CHUNK_SIZE)}`)).size;
    for (let i = 1; i <= 200 && regiones.size < total; i++) { m.tick = i; muestreador.paso(m, 1000); }
    assert.equal(regiones.size, total);
  } finally { quitar(); rmSync(dir, { recursive: true, force: true }); }
});

test('la reproducción de un fallo sembrado T=1 ocurre en N de N', async () => {
  const quitar = registrar({ id: 'prueba.reproduccion', carril: 'prueba', gravedad: 'dura', cadaTicks: 1, alcance: 'global',
    comprobar: m => m.tick < 2 ? [] : [{ id: 'prueba.reproduccion', gravedad: 'dura', tick: m.tick, detalle: 'inyectada' }] });
  try {
    const resultados = [];
    for (let i = 0; i < 3; i++) resultados.push(await ejecutarIntento({ semilla: 51926, hastaTick: 4, hilos: 1, invariante: 'prueba.reproduccion' }));
    const resumen = resumirIntentos(resultados);
    assert.equal(resumen.k, 3); assert.equal(resumen.n, 3); assert.equal(resumen.reproducible, true);
    assert.ok(resultados.every(r => r.tick === 2));
    assert.ok(resumen.intervalo95[0] > 0 && resumen.intervalo95[1] >= 0.99);
    assert.equal(intervaloWilson(0, 12)[0], 0);
    assert.throws(() => intervaloWilson(1, 0));
  } finally { quitar(); }
});

test('panel sin horizonte no aprueba y la permutación respeta las semillas', () => {
  const veredicto = evaluarPanel([]);
  assert.ok(Object.values(veredicto).every(v => v.estado === 'desconocido'));
  assert.equal(veredicto.M1.puerta, false);
  assert.throws(() => configurarPanel({ M4: { desde: 30, hasta: 15 } }));
  const grupos = [{ semilla: 1, valores: [2, 3, 4] }, { semilla: 2, valores: [100, 101, 102] }];
  const resultado = permutacionEstratificada(grupos, grupos, { iteraciones: 100, semilla: 23 });
  assert.equal(resultado.estado, 'desconocido');
  assert.equal('p' in resultado && resultado.p, 1);
  const a = new AzarPropiedades(23), b = new AzarPropiedades(23);
  for (let i = 0; i < 20; i++) assert.equal(a.siguiente(), b.siguiente());
});

test('las réplicas idénticas no inflan la significación de la permutación', () => {
  const a = [1, 2, 3, 4].map(semilla => ({ semilla, valores: [100, 100, 100] }));
  const b = [1, 2, 3, 4].map(semilla => ({ semilla, valores: [110, 110, 110] }));
  const resultado = permutacionEstratificada(a, b);
  assert.equal(resultado.estado, 'desconocido');
  assert.ok('p' in resultado && resultado.p! > 0.1);
});

test('las réplicas independientes sí permiten detectar una diferencia clara', () => {
  const a = [1, 2, 3, 4].map(semilla => ({ semilla, valores: [100, 101, 102] }));
  const b = [1, 2, 3, 4].map(semilla => ({ semilla, valores: [140, 141, 142] }));
  const resultado = permutacionEstratificada(a, b, { semilla: 7 });
  assert.equal(resultado.estado, 'falla');
  assert.ok('p' in resultado && resultado.p! < 0.001);
});
