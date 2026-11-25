import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { crc32, gunzipSync, gzipSync } from 'node:zlib';
import { createWorkerGateway } from '../src/server/gateway.js';
import { createApp, createReadOnlyApp, DIAGNOSTICO_VACIO, type ReadOnlyBackend } from '../src/server/app.js';
import { CatalogoCinta, INDICE_CINTA, MAX_SEGMENTO, NIVELES } from '../src/server/cinta/catalogo.js';
import { clientDelta, decodificarBloque } from '../src/server/cinta/formato.js';
import { reducir, reducirTesela } from '../src/server/cinta/reducir.js';
import { EscritorCinta } from '../src/server/cinta/escritor.js';
import { LectorCinta, type Fondo } from '../src/server/cinta/lector.js';
import { LectoresCinta, MAX_ESPERA } from '../src/server/cinta/lector-worker.js';
import { projectMirrorTile, projectMirrorWorld } from '../src/server/sim-worker.js';
import { Store } from '../src/server/store.js';
import { CINTA, type ChunkResp, type CintaMeta, type Corte, type Nivel } from '../src/shared/cinta.js';
import { applyClientTapeDelta, type TapeChunkResponse, type TapeMetaResponse } from '../src/shared/tape.js';
import type { Salud } from '../src/shared/salud.js';
import type { Tile, Viewport, WorldView } from '../src/shared/types.js';
import { initializeEcosystem } from '../src/world/ecosystem.js';
import { createWorld, type World } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { CHUNK_SIZE, generateChunk } from '../src/world/terrain.js';

const params = parseParams('motor.hilos=1,persistencia.cadaTicks=200');
const plantilla = JSON.parse(JSON.stringify(projectMirrorWorld(createWorld(42, params)))) as WorldView;
const clon = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function directorio(t: TestContext, raiz = '/tmp/atlas-v23-c1b') {
  mkdirSync(raiz, { recursive: true });
  const temporal = mkdtempSync(join(raiz, 'lector-'));
  t.after(() => rmSync(temporal, { recursive: true, force: true }));
  return temporal;
}

/** Teselas reales de los chunks [0, lado)², como las proyecta el espejo. */
function teselas(lado: number): Tile[] {
  const out: Tile[] = [];
  for (let cy = 0; cy < lado; cy++) for (let cx = 0; cx < lado; cx++) {
    for (const t of generateChunk(42, cx, cy).tiles) out.push(projectMirrorTile(initializeEcosystem(42, t)));
  }
  return clon(out);
}

/**
 * Historia sintética de una época: los habitantes se mueven, entran y salen, y cambian unas teselas en cada corte.
 * Devuelve lo que un lector exacto debe reconstruir en cada tick de L0.
 */
function grabar(escritor: EscritorCinta, epoca: number, ticks: number[], estado: { seq: number; mundo: Map<string, Tile> }) {
  const esperado = new Map<number, WorldView>();
  ticks.forEach((t, i) => {
    const vista = clon(plantilla);
    Object.assign(vista, { tick: t, sequence: t, day: Math.floor(t / 2400) + 1 });
    vista.people = vista.people.slice(0, 10 + i % 5).map((p, k) => ({ ...p, x: (p.x + k + Math.floor(t / 8)) % 40, y: (p.y + k) % 40,
      energy: Math.round(((t + k) % 100)) / 100 }));
    const cambiadas: Tile[] = [];
    if (i === 0) for (const tesela of [...estado.mundo.values()]) cambiadas.push(tesela);
    else for (let k = 0; k < 6; k++) {
      const clave = `${(t * 7 + k * 13) % 40},${(t * 3 + k * 5) % 40}`;
      const previa = estado.mundo.get(clave);
      if (previa) cambiadas.push({ ...previa, food: ((t + k) % 50) / 50, vegetation: ((t * k) % 30) / 30 });
    }
    for (const tesela of cambiadas) estado.mundo.set(`${tesela.x},${tesela.y}`, tesela);
    const corte: Corte = { seq: ++estado.seq, epoca, t, vista: { ...vista, tiles: i === 0 ? cambiadas : [] },
      tilesCambiadas: i === 0 ? 'todas' : cambiadas, hitos: [], catalogo: [], hz: 50,
      serie: { poblacion: vista.people.length, nacimientos: i, muertes: 0, fauna: vista.animals?.length ?? 0, estructuras: 0, sustancias: 0, hz: 50 } };
    escritor.registrar(corte);
    const completo = clon({ ...vista, tiles: [...estado.mundo.values()] }) as WorldView & { seed?: number };
    delete completo.seed;
    esperado.set(t, completo);
  });
  return esperado;
}

const porCoordenada = (a: Tile, b: Tile) => a.y - b.y || a.x - b.x;
function igualFotograma(real: WorldView, esperado: WorldView, mensaje: string) {
  assert.deepEqual({ ...clon(real), tiles: [...real.tiles].sort(porCoordenada) }, { ...esperado, tiles: [...esperado.tiles].sort(porCoordenada) }, mensaje);
}

/** Lo que un lector exacto entrega recortado a la cámara (misma regla que `/api/world`). */
function recortar(vista: WorldView, camara: Viewport, fondo: Fondo): WorldView {
  const dentro = (p: { x: number; y: number }, m = 0) => p.x >= camara.x - m && p.y >= camara.y - m
    && p.x < camara.x + camara.width + m && p.y < camara.y + camara.height + m;
  const mapa = new Map(vista.tiles.map(t => [`${t.x},${t.y}`, t]));
  const tiles: Tile[] = [];
  for (let y = camara.y; y < camara.y + camara.height; y++) for (let x = camara.x; x < camara.x + camara.width; x++) {
    const t = mapa.get(`${x},${y}`) ?? fondo(x, y, vista.tick);
    if (t) tiles.push(t);
  }
  const people = vista.people.filter(p => dentro(p, 1)), ids = new Set(people.map(p => p.id));
  return clon({ ...vista, originX: camara.x, originY: camara.y, width: camara.width, height: camara.height, tiles, people,
    animals: vista.animals?.filter(a => dentro(a)), places: vista.places.filter(p => dentro(p)),
    structures: vista.structures?.filter(s => dentro(s, 1)),
    blueprints: vista.blueprints?.filter(b => vista.structures?.some(s => s.blueprintId === b.id && dentro(s, 1))),
    communities: vista.communities?.map(c => ({ ...c, members: c.members.filter(id => ids.has(id)) })),
    ...(vista.technology ? { technology: { ...vista.technology, items: vista.technology.items.filter(i => ids.has(i.ownerId)),
      ...(vista.technology.knowledge ? { knowledge: vista.technology.knowledge.filter(k => ids.has(k.actorId)) } : {}) } } : {}) });
}

/** Aplica una respuesta de tramo y devuelve los fotogramas por tick. */
function reproducir(base: WorldView | undefined, deltas: TapeChunkResponse['deltas']): WorldView[] {
  if (!base) return [];
  const out = [base];
  for (const d of deltas ?? []) out.push(applyClientTapeDelta(out.at(-1)!, d).frame);
  return out;
}

test('I1 lector: los tramos reconstruyen cada fotograma de L0, cruzando bloques, con y sin cámara', t => {
  const dir = directorio(t);
  const escritor = new EscritorCinta({ directorio: join(dir, 'cinta') });
  const ticks = Array.from({ length: 150 }, (_, i) => i * 4);
  let esperado: Map<number, WorldView>;
  try {
    escritor.abrir({ instanciaId: 'lector', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    esperado = grabar(escritor, 0, ticks, { seq: 0, mundo: new Map(teselas(2).map(t => [`${t.x},${t.y}`, t])) });
  } finally { escritor.close(); }
  const lector = new LectorCinta(join(dir, 'cinta'));
  t.after(() => lector.close());
  const meta = lector.meta();
  assert.equal(meta.epoca, 0); assert.equal(meta.estado, 'ok');
  assert.deepEqual(meta.niveles.map(n => n.nivel), [0, 1, 2, 3, 4]);
  assert.equal(meta.niveles[0]!.t0, 0); assert.equal(meta.niveles[0]!.t1, ticks.at(-1));
  assert.equal(meta.niveles[0]!.fotogramas, ticks.length);
  assert.ok(meta.serie.length > 0 && meta.serie.every((p, i) => i === 0 || p.t > meta.serie[i - 1]!.t));

  // Sin cámara: la base es el fotograma clave ≤ t y las deltas siguen hasta n fotogramas en total.
  const tramo = JSON.parse(lector.chunk({ t: 130, n: 100 })) as ChunkResp;
  assert.equal(tramo.nivel, 0); assert.equal(tramo.paso, 4); assert.equal(tramo.epoca, 0);
  assert.equal(tramo.t0, 128, 'el fotograma clave del bloque que contiene t');
  const frames = reproducir(tramo.baseFrame, tramo.deltas);
  assert.equal(frames.length, 100, 'n cuenta la base y las deltas');
  assert.equal(tramo.t1, frames.at(-1)!.tick); assert.equal(tramo.hayMas, true);
  for (const f of frames) igualFotograma(f, esperado.get(f.tick)!, `tick ${f.tick}`);
  // Entre dos bloques, la base sigue siendo la clave ≤ t, y lo que lleva hasta el primer fotograma ≥ t entra aunque pase de n.
  const entre = JSON.parse(lector.chunk({ t: 126, n: 2 })) as ChunkResp;
  assert.equal(entre.t0, 0);
  assert.deepEqual(reproducir(entre.baseFrame, entre.deltas).map(f => f.tick), Array.from({ length: 33 }, (_, i) => i * 4));

  // Con cámara: recorte exacto, fondo donde la cinta no grabó y deltas que cruzan bloques.
  const camara = { x: 20, y: 8, w: 24, h: 30 }, vista = { x: 20, y: 8, width: 24, height: 30 };
  const fondo: Fondo = (x, y) => ({ x, y, terrain: 'meadow', food: 0.123, moisture: 0.5, vegetation: 0.5 });
  const cortado = JSON.parse(lector.chunk({ t: 0, n: 120, ...camara }, fondo)) as ChunkResp;
  const recortados = reproducir(cortado.baseFrame, cortado.deltas);
  assert.equal(recortados.length, 120);
  assert.ok(recortados[0]!.tiles.some(t => t.food === 0.123), 'fuera de los chunks grabados pinta el fondo');
  for (const f of recortados) igualFotograma(f, recortar(esperado.get(f.tick)!, vista, fondo), `cámara, tick ${f.tick}`);

  // Alias del reproductor actual: primer fotograma ≥ fromTick, full y delta con la misma historia.
  const antigua = JSON.parse(lector.metaAntigua({ observerOnly: true, turbo: true })) as TapeMetaResponse;
  assert.deepEqual([antigua.minTick, antigua.maxTick, antigua.totalFrames, antigua.observerOnly], [0, ticks.at(-1), ticks.length, true]);
  assert.ok(antigua.timeline.length > 0 && antigua.timeline.length <= 240);
  const delta = JSON.parse(lector.chunkAntiguo(130, 90, vista, 'delta', fondo)) as TapeChunkResponse;
  assert.equal(delta.fromTick, 132); assert.equal(delta.encoding, 'delta'); assert.deepEqual(delta.frames, []);
  const completos = JSON.parse(lector.chunkAntiguo(130, 90, vista, 'full', fondo)) as TapeChunkResponse;
  const reproducidos = reproducir(delta.baseFrame, delta.deltas);
  assert.equal(reproducidos.length, 90); assert.equal(delta.toTick, 132 + 89 * 4);
  reproducidos.forEach(f => igualFotograma(f, recortar(esperado.get(f.tick)!, vista, fondo), `alias, tick ${f.tick}`));
  // Los fotogramas completos llegan al tope de bytes de una respuesta antes que a `count`: siguen en la próxima.
  assert.ok(completos.frames.length > 10 && completos.frames.length <= 90, String(completos.frames.length));
  completos.frames.forEach((f, i) => igualFotograma(f, reproducidos[i]!, `delta = full en ${f.tick}`));
  assert.equal(completos.toTick, completos.frames.at(-1)!.tick); assert.equal(completos.hasMore, true);
});

test('I7 lector: la época del catálogo, lo huérfano y las lagunas nunca se sirven como historia continua', t => {
  const dir = directorio(t), cinta = join(dir, 'cinta');
  const escritor = new EscritorCinta({ directorio: cinta });
  const estado = { seq: 0, mundo: new Map(teselas(1).map(t => [`${t.x},${t.y}`, t])) };
  try {
    // El servidor numera sus épocas desde 0 en cada proceso; el catálogo sigue la suya.
    escritor.abrir({ instanciaId: 'lector', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    grabar(escritor, 0, Array.from({ length: 101 }, (_, i) => i * 4), estado);
    escritor.abrir({ instanciaId: 'lector', epoca: 0, tMundo: 200, motivo: 'reinicio' });
    grabar(escritor, 0, [...Array.from({ length: 101 }, (_, i) => 200 + i * 4), ...Array.from({ length: 26 }, (_, i) => 700 + i * 4)], estado);
  } finally { escritor.close(); }
  const lector = new LectorCinta(cinta);
  t.after(() => lector.close());
  const meta = lector.meta();
  assert.equal(meta.epoca, 1, 'el número de época es el del catálogo, no el contador del proceso');
  assert.deepEqual(meta.bifurcaciones, [{ epoca: 0, desde: 200, hasta: 400, motivo: 'reinicio' }]);
  assert.deepEqual(meta.lagunas, [{ t0: 600, t1: 700 }]);
  assert.ok(meta.serie.every((p, i) => i === 0 || p.t > meta.serie[i - 1]!.t), 'la serie no repite lo huérfano');

  const leer = (req: Parameters<LectorCinta['chunk']>[0]) => {
    const r = JSON.parse(lector.chunk(req)) as ChunkResp;
    return { ...r, ticks: reproducir(r.baseFrame, r.deltas).map(f => f.tick) };
  };
  const antes = leer({ t: 100, n: 120 });
  assert.equal(antes.epoca, 0); assert.ok(antes.ticks.at(-1)! < 200, 'lo visible de la época 0 termina donde empieza la 1');
  assert.equal(antes.hayMas, true);
  const despues = leer({ t: antes.t1 + 1, n: 120 });
  assert.equal(despues.epoca, 1); assert.equal(despues.t0, 200);
  const hastaLaguna = leer({ t: 560, n: 120 });
  assert.equal(hastaLaguna.t1, 600, 'un tramo no salta la laguna'); assert.equal(hastaLaguna.hayMas, true);
  const trasLaguna = leer({ t: 601, n: 10 });
  assert.equal(trasLaguna.t0, 700);
  // Con `epoca` se sirve la historia entera de esa época, también lo huérfano: es continua y la respuesta dice de quién es.
  const huerfano = leer({ t: 250, n: 120, epoca: 0 });
  assert.equal(huerfano.epoca, 0); assert.equal(huerfano.t0, 128, 'la clave ≤ t de la época pedida');
  assert.deepEqual(huerfano.ticks, Array.from({ length: 69 }, (_, i) => 128 + i * 4)); assert.equal(huerfano.hayMas, false);
  for (const t of [197, 199]) {
    const cruce = leer({ t, n: 120, epoca: 0 });
    assert.equal(cruce.epoca, 0, `t=${t}`); assert.deepEqual(cruce.ticks, Array.from({ length: 69 }, (_, i) => 128 + i * 4), `t=${t}`);
  }
  assert.equal(leer({ t: 100, n: 120, epoca: 9 }).deltas.length, 0, 'una época que no existe no sirve nada');

  const alias = JSON.parse(lector.chunkAntiguo(150, 240, undefined, 'full')) as TapeChunkResponse;
  assert.ok(alias.toTick < 200 && alias.hasMore);
  const siguiente = JSON.parse(lector.chunkAntiguo(alias.toTick + 1, 240, undefined, 'full')) as TapeChunkResponse;
  assert.equal(siguiente.fromTick, 200);
  assert.equal(siguiente.toTick, 600);
});

test('nivel auto: el más fino con cobertura y el corte donde empieza uno más fino', t => {
  const dir = directorio(t), cinta = join(dir, 'cinta');
  const escritor = new EscritorCinta({ directorio: cinta });
  try {
    escritor.abrir({ instanciaId: 'lector', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    grabar(escritor, 0, Array.from({ length: 501 }, (_, i) => i * 4), { seq: 0, mundo: new Map(teselas(1).map(t => [`${t.x},${t.y}`, t])) });
  } finally { escritor.close(); }
  // Como la poda: L0 ya no tiene lo anterior a 1000.
  const db = new DatabaseSync(join(cinta, INDICE_CINTA));
  try { db.prepare('DELETE FROM bloques WHERE nivel=0 AND t0<1000').run(); } finally { db.close(); }
  const lector = new LectorCinta(cinta);
  t.after(() => lector.close());
  const inicioL0 = lector.meta().niveles[0]!.t0;
  assert.ok(inicioL0 >= 1000);
  const grueso = JSON.parse(lector.chunk({ t: 100, n: 120 })) as ChunkResp;
  assert.equal(grueso.nivel, 1); assert.equal(grueso.paso, 32);
  assert.equal(grueso.cambioDeNivelEn, inicioL0); assert.ok(grueso.t1 < inicioL0);
  assert.equal((JSON.parse(lector.chunk({ t: 1500, n: 4 })) as ChunkResp).nivel, 0);
  const pedido = JSON.parse(lector.chunk({ t: 100, n: 3, nivel: 3 })) as ChunkResp;
  assert.equal(pedido.nivel, 3); assert.equal(pedido.cambioDeNivelEn, undefined);
});

/** Graba épocas seguidas: cada una es [apertura, ticks]. */
function cinta(t: TestContext, epocas: [Partial<Parameters<EscritorCinta['abrir']>[0]>, number[]][], lado = 1): string {
  const ruta = join(directorio(t), 'cinta');
  const escritor = new EscritorCinta({ directorio: ruta });
  const estado = { seq: 0, mundo: new Map(teselas(lado).map(x => [`${x.x},${x.y}`, x])) };
  try {
    for (const [a, ticks] of epocas) {
      const apertura = { instanciaId: 'lector', epoca: 0, tMundo: ticks[0] ?? 0, motivo: 'reinicio' as const, ...a };
      escritor.abrir(apertura);
      if (ticks.length) grabar(escritor, apertura.epoca, ticks, estado);
    }
  } finally { escritor.close(); }
  return ruta;
}
const cada = (desde: number, hasta: number, paso = 4) => Array.from({ length: (hasta - desde) / paso + 1 }, (_, i) => desde + i * paso);
const borrarBloques = (ruta: string, donde: string) => {
  const db = new DatabaseSync(join(ruta, INDICE_CINTA));
  try { db.prepare(`DELETE FROM bloques WHERE ${donde}`).run(); } finally { db.close(); }
};
const ticksDe = (r: ChunkResp) => reproducir(r.baseFrame, r.deltas).map(f => f.tick);

test('un hueco de la poda corta el tramo, otro nivel lo cubre y el alias salta al otro lado', t => {
  const ruta = cinta(t, [[{}, cada(0, 2000)]]);
  // Como una poda que conserva un segmento fijado: faltan los bloques de L0 entre 508 y 1024.
  borrarBloques(ruta, 'nivel=0 AND t0>=512 AND t0<1024');
  const lector = new LectorCinta(ruta);
  t.after(() => lector.close());
  assert.deepEqual([lector.meta().niveles[0]!.t0, lector.meta().niveles[0]!.t1], [0, 2000]);
  const antes = JSON.parse(lector.chunk({ t: 400, n: 120 })) as ChunkResp;
  assert.equal(antes.nivel, 0); assert.equal(antes.t1, 508, 'el tramo no cruza el hueco');
  assert.equal(antes.cambioDeNivelEn, 509); assert.equal(antes.hayMas, true);
  assert.deepEqual(ticksDe(antes), cada(384, 508));
  const hueco = JSON.parse(lector.chunk({ t: 700, n: 120 })) as ChunkResp;
  assert.equal(hueco.nivel, 1, 'L1 cubre el hueco de L0'); assert.equal(hueco.cambioDeNivelEn, 1024);
  assert.ok(ticksDe(hueco).every(x => x < 1024) && hueco.t0 <= 700);
  const alias = JSON.parse(lector.chunkAntiguo(400, 240)) as TapeChunkResponse;
  assert.deepEqual([alias.fromTick, alias.toTick, alias.hasMore], [400, 508, true]);
  const otroLado = JSON.parse(lector.chunkAntiguo(509, 240)) as TapeChunkResponse;
  assert.equal(otroLado.fromTick, 1024);
});

test('auto: un tick con cobertura en su época no salta a una época futura', t => {
  const ruta = cinta(t, [[{}, cada(0, 400)], [{ tMundo: 600 }, cada(600, 800)]]);
  borrarBloques(ruta, 'nivel=0 AND epoca=0');
  const lector = new LectorCinta(ruta);
  t.after(() => lector.close());
  const r = JSON.parse(lector.chunk({ t: 50, n: 10 })) as ChunkResp;
  assert.deepEqual([r.nivel, r.epoca], [1, 0]); assert.ok(r.t0 <= 50);
});

test('bifurcación sin fotogramas nuevos: maxTick es el último fotograma visible y no hay tramo vacío con hayMas', t => {
  const ruta = cinta(t, [[{}, cada(0, 200)], [{ tMundo: 198 }, []]]);
  const lector = new LectorCinta(ruta);
  t.after(() => lector.close());
  assert.equal(lector.meta().niveles[0]!.t1, 196);
  const meta = JSON.parse(lector.metaAntigua({ observerOnly: false, turbo: true })) as TapeMetaResponse;
  assert.equal(meta.maxTick, 196, 'el reproductor no pide lo que no puede recibir');
  const alias = JSON.parse(lector.chunkAntiguo(197, 60)) as TapeChunkResponse;
  assert.deepEqual([alias.frames.length, alias.hasMore], [0, false]);
  const nuevo = JSON.parse(lector.chunk({ t: 197, n: 10 })) as ChunkResp;
  assert.deepEqual([nuevo.deltas.length, nuevo.hayMas, nuevo.baseFrame], [0, false, undefined]);
  const viejo = JSON.parse(lector.chunk({ t: 197, n: 120, epoca: 0 })) as ChunkResp;
  assert.equal(ticksDe(viejo).at(-1), 200, 'lo huérfano sigue a la vista pidiendo su época');
});

test('una restauración más atrás que la época anterior: se ve la época más nueva que empezó antes de t', t => {
  const lector = new LectorCinta(cinta(t, [[{}, cada(0, 400)], [{ tMundo: 300 }, cada(300, 500)], [{ tMundo: 100 }, cada(100, 400)]]));
  t.after(() => lector.close());
  for (const [tick, epoca] of [[50, 0], [200, 2], [350, 2], [450, 2]] as const) {
    const r = JSON.parse(lector.chunk({ t: tick, n: 1 })) as ChunkResp;
    assert.equal(r.epoca, epoca, `t=${tick}`);
  }
  assert.deepEqual(lector.meta().bifurcaciones.map(b => [b.epoca, b.desde, b.hasta]), [[0, 300, 400], [1, 100, 500]]);
});

test('épocas con números enormes no mezclan sus niveles', t => {
  const epoca = 2e15;
  const lector = new LectorCinta(cinta(t, [[{ epoca }, cada(0, 400)]]));
  t.after(() => lector.close());
  for (const nivel of [0, 1] as const) {
    const r = JSON.parse(lector.chunk({ t: 0, n: 120, nivel })) as ChunkResp;
    assert.equal(r.epoca, epoca);
    const ticks = ticksDe(r);
    assert.ok(ticks.length > 2 && ticks.every((x, i) => !i || x - ticks[i - 1]! === CINTA.pasos[nivel]), `nivel ${nivel}: ${ticks}`);
  }
});

test('una clave mayor que el tope de bytes no deja la paginación sin avanzar', { timeout: 300_000 }, t => {
  const lector = new LectorCinta(cinta(t, [[{}, cada(0, 40)]], 17));
  t.after(() => lector.close());
  let desde = 1;
  for (const esperado of [4, 8, 12]) {
    const r = JSON.parse(lector.chunk({ t: desde, n: 120 })) as ChunkResp;
    assert.equal(r.t0, 0); assert.equal(r.t1, esperado, 'un fotograma ≥ t más que la vez anterior'); assert.equal(r.hayMas, true);
    desde = r.t1 + 1;
  }
  const completos = JSON.parse(lector.chunkAntiguo(0, 240)) as TapeChunkResponse;
  assert.deepEqual([completos.frames.length, completos.toTick, completos.hasMore], [1, 0, true]);
});

test('otra instancia del mundo se lee como vacía y un bloque que no es el del catálogo no se sirve', t => {
  const ruta = cinta(t, [[{}, cada(0, 200)]]);
  const lector = new LectorCinta(ruta, 1);
  t.after(() => lector.close());
  assert.equal(lector.meta({}, 'ok', 1e9, 'otra').niveles.length, 0);
  assert.equal((JSON.parse(lector.chunk({ t: 0, n: 10 }, undefined, 'otra')) as ChunkResp).baseFrame, undefined);
  assert.equal((JSON.parse(lector.chunkAntiguo(0, 10, undefined, 'full', undefined, 'otra')) as TapeChunkResponse).frames.length, 0);
  assert.ok((JSON.parse(lector.chunk({ t: 0, n: 10 }, undefined, 'lector')) as ChunkResp).baseFrame);
  assert.equal((lector as unknown as { cache: Map<string, unknown> }).cache.size, 0, 'un bloque que no cabe en la caché no se guarda');
  // Un catálogo que describe otro bloque que el que hay en el segmento (como el de una cinta apartada en mitad de la lectura).
  const db = new DatabaseSync(join(ruta, INDICE_CINTA));
  try { db.prepare('UPDATE bloques SET crc=crc+1 WHERE nivel=0 AND t0=128').run(); } finally { db.close(); }
  const otro = new LectorCinta(ruta);
  t.after(() => otro.close());
  assert.throws(() => otro.chunk({ t: 130, n: 10 }), /no es el del catálogo/);
  assert.ok(JSON.parse(otro.chunk({ t: 0, n: 10 })).baseFrame, 'lo demás se sigue leyendo');
});

test('el fondo se pinta en el tick del fotograma y lo huérfano sobre el archivo de su bifurcación', t => {
  const lector = new LectorCinta(cinta(t, [[{}, cada(0, 400)], [{ tMundo: 200 }, cada(200, 300)]]));
  t.after(() => lector.close());
  const vistos = new Set<number>();
  const fondo: Fondo = (x, y, tick) => { vistos.add(tick); return { x, y, terrain: 'meadow', food: 0, moisture: 0.5, vegetation: 0.5 }; };
  const camara = { x: 0, y: 0, w: 40, h: 40 };
  lector.chunk({ t: 0, n: 120, ...camara }, fondo);
  assert.deepEqual([...vistos].sort((a, b) => a - b), [0, 128], 'la clave de cada bloque, en su tick');
  vistos.clear();
  lector.chunk({ t: 130, n: 120, epoca: 0, ...camara }, fondo);
  assert.deepEqual([...vistos].sort((a, b) => a - b), [128, 200], 'lo posterior a la bifurcación, sobre el archivo de 200');
});

test('los hilos lectores: metadatos sin esperar a los tramos, espera acotada y cancelable', { timeout: 300_000 }, async t => {
  const ruta = cinta(t, [[{}, cada(0, 636)]], 10);
  const lectores = new LectoresCinta({ directorio: ruta, topeBytes: 1e9, observerOnly: false, turbo: true, hilos: 1 });
  t.after(() => lectores.close());
  const ctx = { gzip: false, estado: 'ok' as const };
  await Promise.all([lectores.leer({ tipo: 'meta' }, ctx), lectores.leer({ tipo: 'chunk', req: { t: 0, n: 1 } }, ctx)]);
  const fin: string[] = [];
  const largo = lectores.leer({ tipo: 'chunk', req: { t: 0, n: 120 } }, ctx).then(() => fin.push('tramo'));
  const cancelar = new AbortController();
  const esperando = Array.from({ length: MAX_ESPERA }, (_, i) =>
    lectores.leer({ tipo: 'chunk', req: { t: i * 4, n: 120 } }, ctx, cancelar.signal).then(() => 'servida', e => (e as Error).name));
  await assert.rejects(lectores.leer({ tipo: 'chunk', req: { t: 0, n: 1 } }, ctx), /demasiadas peticiones/);
  const meta = JSON.parse((await lectores.leer({ tipo: 'meta' }, ctx)).cuerpo.toString()) as CintaMeta;
  fin.push('meta');
  assert.equal(meta.niveles[0]!.t1, 636);
  cancelar.abort();
  assert.deepEqual(new Set(await Promise.all(esperando)), new Set(['AbortError']), 'lo que esperaba hilo se retira');
  await largo;
  assert.deepEqual(fin, ['meta', 'tramo'], 'los metadatos no esperan detrás de un tramo');
});

test('los hilos lectores sirven JSON o gzip, el estado de error y el fondo del mundo', { timeout: 120_000 }, async t => {
  const dir = directorio(t), cinta = join(dir, 'cinta');
  const escritor = new EscritorCinta({ directorio: cinta });
  try {
    escritor.abrir({ instanciaId: 'lector', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    grabar(escritor, 0, Array.from({ length: 40 }, (_, i) => i * 4), { seq: 0, mundo: new Map(teselas(1).map(t => [`${t.x},${t.y}`, t])) });
  } finally { escritor.close(); }
  const lectores = new LectoresCinta({ directorio: cinta, topeBytes: 1e9, observerOnly: false, turbo: true });
  t.after(() => lectores.close());
  const plano = await lectores.leer({ tipo: 'meta' }, { gzip: false, estado: 'error' });
  const meta = JSON.parse(plano.cuerpo.toString()) as CintaMeta;
  assert.equal(plano.gzip, false); assert.equal(meta.estado, 'error'); assert.equal(meta.topeBytes, 1e9);
  const comprimido = await lectores.leer({ tipo: 'chunk', req: { t: 0, n: 10, x: -10, y: -10, w: 40, h: 40 } },
    { gzip: true, estado: 'ok', fondo: { seed: 42, cuencas: 1 } });
  const tramo = JSON.parse(gunzipSync(comprimido.cuerpo).toString()) as ChunkResp;
  assert.equal(tramo.baseFrame!.tiles.length, 1600, 'el fondo cubre la cámara entera');
  const generada = projectMirrorTile(initializeEcosystem(42, generateChunk(42, -1, -1).tiles[CHUNK_SIZE * CHUNK_SIZE - 1]!));
  assert.deepEqual(tramo.baseFrame!.tiles.find(t => t.x === -1 && t.y === -1), clon(generada));
});

/** Pasarela mínima sobre los lectores: el transporte HTTP real con un backend sin simulación. */
function pasarelaDeCinta(t: TestContext, lectores: LectoresCinta): Server {
  const sesiones = new Set<string>();
  const salud: Salud = { estado: 'ok', tick: 0, ticksPorSegundo: 0, segundosDesdeUltimoPaso: 0, ultimoGuardado: null, gpu: [],
    recargas: 0, diagnostico: DIAGNOSTICO_VACIO, operacion: null };
  const backend = {
    sessions: { sessionValid: (h: string) => sesiones.has(h), addSession: (h: string) => { sesiones.add(h); }, revoke: (h?: string) => { if (h) sesiones.delete(h); } },
    salud: () => salud, ready: true, runtime: {}, deltas: false, failed: false, respaldo: undefined,
    cinta: { leer: (p, gzip) => lectores.leer(p, { gzip, estado: 'ok' }) } satisfies ReadOnlyBackend['cinta'],
  } as unknown as ReadOnlyBackend;
  const app = createReadOnlyApp({ origin: 'https://carta.test', secure: true, password: 'lector-c1b-password' }, backend);
  t.after(() => app.close());
  return app.server;
}

function cliente(server: Server) {
  let puerto = 0, cookie = '';
  return {
    async escuchar() { server.listen(0, '127.0.0.1'); await once(server, 'listening'); puerto = (server.address() as { port: number }).port; },
    pedir(path: string, cuerpo?: unknown, cabeceras: Record<string, string> = {}) {
      return new Promise<{ status: number; headers: IncomingHttpHeaders; texto: string; ms: number }>((ok, mal) => {
        const inicio = performance.now();
        const req = request({ host: '127.0.0.1', port: puerto, path, method: cuerpo ? 'POST' : 'GET', headers: { Host: 'carta.test',
          Origin: 'https://carta.test', ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...cabeceras } }, res => {
          const partes: Buffer[] = [];
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0]!.split(';')[0]!;
          res.on('data', p => partes.push(p));
          res.on('end', () => {
            const crudo = Buffer.concat(partes);
            ok({ status: res.statusCode!, headers: res.headers, ms: performance.now() - inicio,
              texto: (res.headers['content-encoding'] === 'gzip' ? gunzipSync(crudo) : crudo).toString() });
          });
        });
        req.on('error', mal); if (cuerpo) req.write(JSON.stringify(cuerpo)); req.end();
      });
    },
  };
}

test('un tramo largo no retrasa /health ni un meta que llega a la vez', { timeout: 300_000 }, async t => {
  const dir = directorio(t), cinta = join(dir, 'cinta');
  const escritor = new EscritorCinta({ directorio: cinta });
  try {
    escritor.abrir({ instanciaId: 'lector', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    grabar(escritor, 0, Array.from({ length: 160 }, (_, i) => i * 4), { seq: 0, mundo: new Map(teselas(10).map(t => [`${t.x},${t.y}`, t])) });
  } finally { escritor.close(); }
  const lectores = new LectoresCinta({ directorio: cinta, topeBytes: 1e9, observerOnly: false, turbo: true });
  t.after(() => lectores.close());
  const http = cliente(pasarelaDeCinta(t, lectores));
  await http.escuchar();
  assert.equal((await http.pedir('/api/login', { password: 'lector-c1b-password' })).status, 200);
  await http.pedir('/api/cinta/meta'); // arranca los hilos
  const vacio: number[] = [];
  for (let i = 0; i < 20; i++) vacio.push((await http.pedir('/health')).ms);
  let enCurso = true;
  const largo = (async () => {
    const tramos: number[] = [];
    while (tramos.length < 6) tramos.push((await http.pedir('/api/cinta/chunk?t=0&n=120&nivel=0', undefined, { 'Accept-Encoding': 'gzip' })).ms);
    enCurso = false;
    return tramos;
  })();
  const salud: number[] = [], metas: number[] = [];
  while (enCurso) {
    salud.push((await http.pedir('/health')).ms);
    if (salud.length % 10) continue;
    const meta = await http.pedir('/api/cinta/meta');
    assert.equal(meta.status, 200, meta.texto);
    assert.equal((JSON.parse(meta.texto) as CintaMeta).niveles[0]!.t1, 636);
    metas.push(meta.ms);
  }
  const tramos = await largo;
  const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)]!;
  t.diagnostic(JSON.stringify({ tramoMs: tramos.map(Math.round), saludVacioP95: p95(vacio).toFixed(1), saludP95: p95(salud).toFixed(1),
    saludMax: Math.max(...salud).toFixed(1), salud: salud.length, metaMax: Math.max(...metas).toFixed(1) }));
  assert.ok(salud.length >= 20, 'hubo /health mientras se servía el tramo');
  assert.ok(Math.min(...tramos) > 4 * p95(salud), 'el tramo es mucho más largo que /health');
  assert.ok(p95(salud) < 50, `/health p95 ${p95(salud)} ms durante el tramo`);
  assert.ok(metas.length >= 2 && Math.max(...metas) < Math.min(...tramos), 'un meta nunca espera detrás de un tramo');
});

test('createApp directo: rutas de la cinta, alias, validación y sesión', { timeout: 120_000 }, async t => {
  const dir = directorio(t);
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, origin: 'https://carta.test', secure: true, password: 'lector-c1b-password', seed: 42, params,
    manual: true, turbo: true });
  t.after(async () => { try { await app.close(); } finally { store.close(); } });
  const http = cliente(app.server);
  await http.escuchar();
  assert.equal((await http.pedir('/api/cinta/meta')).status, 401);
  assert.equal((await http.pedir('/api/login', { password: 'lector-c1b-password' })).status, 200);
  const tick0 = app.world.tick;
  app.start();
  await new Promise(r => setTimeout(r, 2500));
  const meta = JSON.parse((await http.pedir('/api/cinta/meta')).texto) as CintaMeta;
  assert.equal(meta.version, 3); assert.equal(meta.estado, 'ok'); assert.equal(meta.epoca, 0);
  assert.equal(meta.niveles[0]?.t0, tick0); assert.ok(meta.niveles[0]!.fotogramas > 2, JSON.stringify(meta.niveles));
  const r = await http.pedir(`/api/cinta/chunk?t=${tick0}&n=20&x=10&y=6&w=24&h=16`, undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(r.status, 200, r.texto); assert.equal(r.headers['content-encoding'], 'gzip');
  const tramo = JSON.parse(r.texto) as ChunkResp;
  const frames = reproducir(tramo.baseFrame, tramo.deltas);
  assert.ok(frames.length > 2);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i]!.tick - frames[i - 1]!.tick >= CINTA.pasos[0]);
  assert.ok(frames.every(f => f.tiles.length === 24 * 16 && f.tiles.every(t => t.x >= 10 && t.x < 34 && t.y >= 6 && t.y < 22)));
  const antigua = JSON.parse((await http.pedir('/api/tape/meta')).texto) as TapeMetaResponse;
  assert.equal(antigua.minTick, tick0); assert.equal(antigua.turbo, true); assert.ok(antigua.maxTick > tick0);
  const alias = JSON.parse((await http.pedir(`/api/tape/chunk?fromTick=${tick0}&count=10&encoding=delta&x=10&y=6&width=24&height=16`)).texto) as TapeChunkResponse;
  assert.equal(alias.fromTick, tick0); assert.equal(alias.baseFrame!.originX, 10); assert.ok(alias.deltas!.length > 0);
  for (const malo of ['/api/cinta/chunk?n=10', '/api/cinta/chunk?t=0&n=0', '/api/cinta/chunk?t=0&n=121', '/api/cinta/chunk?t=0&n=1&nivel=5',
    '/api/cinta/chunk?t=0&n=1&x=0&y=0&w=200&h=10', '/api/cinta/chunk?t=0&n=1&x=0', '/api/cinta/meta?t0=-1',
    '/api/tape/chunk?count=241', '/api/tape/chunk?encoding=DELTA', '/api/tape/chunk?x=1&y=2']) {
    assert.equal((await http.pedir(malo)).status, 400, malo);
  }
});

test('createApp directo: recargar tras un fallo de paso abre una época con su bifurcación', { timeout: 120_000 }, async t => {
  const dir = directorio(t);
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, origin: 'https://carta.test', secure: true, password: 'lector-c1b-password', seed: 51926,
    params: parseParams('motor.hilos=1,persistencia.cadaTicks=40'), manual: true, turbo: true, turboSaveIntervalMs: 0 });
  t.after(async () => { try { await app.close(); } finally { store.close(); } });
  for (let n = 0; n < 60; n++) app.stepOnce();
  const guardado = store.load()!.world.tick, grabado = app.world.tick;
  assert.ok(guardado < grabado - 4, `el guardado (${guardado}) va por detrás del mundo (${grabado})`);
  // Como en recuperacion.test.ts: los habitantes pisan terreno no residente y su carga falla a mitad de paso.
  for (const p of (app.world as World).people) { p.x += 40; p.y += 40; p.target = { x: p.x, y: p.y }; }
  const leer = store.loadChunk.bind(store);
  let armado = true;
  store.loadChunk = (key, atTick) => {
    if (armado) { armado = false; throw new Error('fallo sintético a mitad de paso'); }
    return leer(key, atTick);
  };
  app.stepOnce();
  assert.equal(app.failed, false); assert.equal(app.world.tick, guardado, 'volvió al guardado');
  for (let n = 0; n < 30; n++) app.stepOnce();
  await app.close();
  const lector = new LectorCinta(join(dir, 'cinta'));
  t.after(() => lector.close());
  const meta = lector.meta();
  assert.equal(meta.epoca, 1);
  assert.equal(meta.bifurcaciones.length, 1);
  assert.equal(meta.bifurcaciones[0]!.desde, guardado);
  // Sin crédito la cinta se salta cortes (el mundo no la espera): lo grabado de la época 0 llega hasta `hasta` ≤ `grabado`.
  assert.ok(meta.bifurcaciones[0]!.hasta > guardado && meta.bifurcaciones[0]!.hasta <= grabado);
  const nuevo = JSON.parse(lector.chunk({ t: guardado, n: 5 })) as ChunkResp;
  assert.equal(nuevo.epoca, 1); assert.equal(nuevo.t0, guardado, 'los ticks repetidos se graban en la época nueva');
  const viejo = JSON.parse(lector.chunk({ t: guardado + 1, n: 120, epoca: 0 })) as ChunkResp;
  const descartado = reproducir(viejo.baseFrame, viejo.deltas).filter(f => f.tick > guardado);
  assert.equal(viejo.epoca, 0); assert.ok(descartado.length > 0, 'lo descartado sigue accesible');
  const hitos = new DatabaseSync(join(dir, 'cinta', INDICE_CINTA), { readOnly: true });
  try { assert.ok(hitos.prepare("SELECT 1 FROM hitos WHERE epoca=1 AND tipo='bifurcacion'").get()); } finally { hitos.close(); }
});

test('pasarela: la cinta perdida en el hilo de la simulación se muestra con estado error', { timeout: 180_000 }, async t => {
  const dir = directorio(t);
  const pasarela = createWorkerGateway({ worldPath: join(dir, 'world.sqlite'), origin: 'https://carta.test', secure: true,
    password: 'lector-c1b-password', seed: 42, params, manual: true, turbo: true, tape: true });
  t.after(() => pasarela.close());
  await pasarela.ready;
  const http = cliente(pasarela.server);
  await http.escuchar();
  assert.equal((await http.pedir('/api/login', { password: 'lector-c1b-password' })).status, 200);
  pasarela.start();
  const meta = async () => JSON.parse((await http.pedir('/api/cinta/meta')).texto) as CintaMeta;
  let antes = await meta();
  for (let i = 0; i < 200 && !(antes.niveles[0]?.fotogramas > 1); i++) { await new Promise(r => setTimeout(r, 100)); antes = await meta(); }
  assert.equal(antes.estado, 'ok');
  // Sin su directorio, el siguiente bloque de L0 no se puede escribir: el hilo de la cinta cae.
  renameSync(join(dir, 'cinta', 'n0'), join(dir, 'n0-fuera'));
  let despues = antes;
  for (let i = 0; i < 300 && despues.estado === 'ok'; i++) { await new Promise(r => setTimeout(r, 100)); despues = await meta(); }
  assert.equal(despues.estado, 'error');
  await assert.rejects(pasarela.flushTape(), 'la simulación ya no tiene cinta que vaciar');
  assert.equal((await http.pedir('/api/tape/meta')).status, 200, 'lo grabado sigue a la vista');
});

// Cabecera CNT1 (formato.ts): magia, nivel, fotogramas, t0, t1, crc y longitud de la clave; cada delta lleva tick y longitud.
const CABECERA = 33, CRC = 25, LONGITUD_KF = 29;

/**
 * Cinta sintética de unos `bytes` con bloques de tamaño real: 700 habitantes, 3.000 animales y 16.384 teselas por clave,
 * 31 deltas con 210 habitantes que se mueven y 200 teselas que cambian, reducidos por nivel como los graba el
 * escritor. El tick va en su propio miembro gzip, así un bloque nuevo cuesta un CRC y no una compresión.
 */
function volumenSintetico(directorio: string, bytes: number, [personas, animales, lado] = [700, 3000, 8]) {
  const vista = clon(plantilla);
  vista.people = Array.from({ length: personas }, (_, i) => ({ ...plantilla.people[i % plantilla.people.length]!, id: `p${i}`,
    x: i % 128, y: Math.floor(i / 128) * 3 }));
  vista.animals = Array.from({ length: animales }, (_, i) => ({ ...plantilla.animals![i % plantilla.animals!.length]!, id: `a${i}`,
    x: (i * 7) % 128, y: (i * 13) % 128 }));
  vista.tiles = teselas(lado);
  const notables = new Set(vista.people.slice(0, 60).map(p => p.id));
  const gz = (texto: string) => gzipSync(texto, { level: 1 });
  const restos = NIVELES.map(nivel => {
    let previa = reducir(nivel, { ...vista, tick: 0, sequence: 0 }, notables);
    const { tick: _, ...resto } = previa;
    const base = JSON.stringify({ tick: 0, ...resto });
    const deltas: Buffer[] = [];
    for (let i = 1; i < 32; i++) {
      const siguiente = clon(vista);
      Object.assign(siguiente, { tick: 0, sequence: 0 });
      siguiente.people.forEach((p, k) => { if (k % 10 < 3) p.x += i; });
      siguiente.animals!.forEach((a, k) => { if (k % 2) a.y += i; });
      const actual = reducir(nivel, siguiente, notables);
      const delta = clientDelta({ ...previa, tiles: [] }, { ...actual, tiles: [] });
      if (nivel <= 2) delta.tilesPatch = vista.tiles.slice(i * 200, i * 200 + 200).map(t => reducirTesela(nivel, { ...t, food: i / 40 })!);
      const json = JSON.stringify(delta);
      assert.ok(json.startsWith('{"tick":0,'));
      deltas.push(gz(json.slice('{"tick":0,'.length)));
      previa = actual;
    }
    return { base: gz(base.slice('{"tick":0,'.length)), crudo: base.length, deltas };
  });
  function bloque(nivel: Nivel, t0: number): Buffer {
    const paso = CINTA.pasos[nivel], { base, deltas } = restos[nivel]!;
    const clave = Buffer.concat([gz(`{"tick":${t0},`), base]);
    const partes = [Buffer.alloc(CABECERA), clave];
    deltas.forEach((resto, i) => {
      const cuerpo = Buffer.concat([gz(`{"tick":${t0 + (i + 1) * paso},`), resto]), cabecera = Buffer.alloc(12);
      cabecera.writeDoubleLE(t0 + (i + 1) * paso, 0); cabecera.writeUInt32LE(cuerpo.length, 8);
      partes.push(cabecera, cuerpo);
    });
    const datos = Buffer.concat(partes);
    datos.write('CNT1', 0, 'ascii'); datos.writeUInt8(nivel, 4); datos.writeUInt32LE(32, 5);
    datos.writeDoubleLE(t0, 9); datos.writeDoubleLE(t0 + 31 * paso, 17); datos.writeUInt32LE(clave.length, LONGITUD_KF);
    datos.writeUInt32LE(crc32(datos.subarray(LONGITUD_KF), crc32(datos.subarray(0, CRC))), CRC);
    return datos;
  }
  const tamanos = NIVELES.map(n => bloque(n, 0).length);
  assert.equal(decodificarBloque(bloque(0, 0)).baseFrame.people.length, personas);
  // Todos los niveles cubren el mismo tiempo de mundo, como en una cinta grabada de corrido.
  const porTick = NIVELES.reduce<number>((s, n) => s + tamanos[n]! / (32 * CINTA.pasos[n]), 0);
  const fin = Math.ceil(bytes / porTick);
  const catalogo = new CatalogoCinta(directorio);
  let escritos = 0, bloques = 0;
  try {
    const epoca = catalogo.abrir({ instanciaId: 'salto', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    const siguiente = NIVELES.map(() => 0);
    for (;;) {
      const nivel = NIVELES.filter(n => siguiente[n]! <= fin).sort((a, b) => siguiente[a]! - siguiente[b]!)[0];
      if (nivel === undefined) break;
      const datos = bloque(nivel, siguiente[nivel]!);
      const ultimo = catalogo.segmentos().filter(s => s.nivel === nivel).at(-1);
      catalogo.escribirBloque(epoca, datos, ultimo && ultimo.bytes + datos.length <= MAX_SEGMENTO ? ultimo : undefined);
      siguiente[nivel]! += 32 * CINTA.pasos[nivel];
      escritos += datos.length; bloques++;
    }
  } finally { catalogo.db.close(); }
  return { escritos, bloques, fin, bloquePorNivel: tamanos, claveCruda: restos.map(r => r.crudo) };
}
test('I5: salto a un tick cualquiera en una cinta de 5 GB con p95 < 100 ms en cada nivel', {
  skip: process.env.ATLAS_V23_CINTA_SALTO !== '1', timeout: 3_600_000,
}, async t => {
  const dir = directorio(t);
  const inicio = performance.now();
  // `ATLAS_V23_CINTA_SALTO_MUNDO=personas,animales,lado` cambia el mundo sintético (lado en chunks, ≥ 6 para la cámara de
  // 96×64); el de I5 es el de omisión.
  const objetivo = Number(process.env.ATLAS_V23_CINTA_SALTO_BYTES ?? 5e9), mundo = process.env.ATLAS_V23_CINTA_SALTO_MUNDO?.split(',').map(Number);
  const resumen = volumenSintetico(join(dir, 'cinta'), objetivo, mundo as [number, number, number] | undefined);
  t.diagnostic(`escritura: ${((performance.now() - inicio) / 1000).toFixed(0)} s`);
  t.diagnostic(JSON.stringify(resumen));
  assert.ok(resumen.escritos >= objetivo * 0.99, `cinta de ${resumen.escritos} bytes`);
  const lector = new LectorCinta(join(dir, 'cinta'), 1);
  t.after(() => lector.close());
  const meta = lector.meta();
  assert.deepEqual(meta.niveles.map(n => n.nivel), [0, 1, 2, 3, 4]);
  const camara = { x: 0, y: 0, w: 96, h: 64 };
  const azar = (() => { let s = 12345; return () => (s = Math.imul(s, 1664525) + 1013904223 >>> 0) / 2 ** 32; })();
  // La CPU del hilo separa el coste del lector de la espera: las pruebas corren en SCHED_IDLE con la torre cargada.
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(0.95 * (v.length - 1))]!;
  const lentos: string[] = [];
  for (const n of meta.niveles) {
    const pared: number[] = [], cpus: number[] = [], sinCamara: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const tick = n.t0 + Math.floor(azar() * (n.t1 - n.t0 + 1));
      let inicio = performance.now();
      const c = cpu();
      const r = JSON.parse(lector.chunk({ t: tick, n: 1, nivel: n.nivel, ...camara })) as ChunkResp;
      pared.push(performance.now() - inicio); cpus.push(cpu() - c);
      // Los bloques del volumen empiezan en múltiplos de 32 pasos: la clave ≤ t y el primer fotograma ≥ t son exactos.
      const paso = CINTA.pasos[n.nivel], clave = Math.floor(tick / (32 * paso)) * 32 * paso;
      assert.ok(r.baseFrame && r.nivel === n.nivel && r.t0 === clave && r.baseFrame.tick === clave && r.t1 === Math.ceil(tick / paso) * paso
        && r.baseFrame.tiles.length === (n.nivel <= 2 ? 96 * 64 : 0), JSON.stringify({ tick, nivel: r.nivel, t0: r.t0, t1: r.t1, teselas: r.baseFrame?.tiles.length }));
      if (i % 10 === 0) { inicio = performance.now(); lector.chunk({ t: tick, n: 1, nivel: n.nivel }); sinCamara.push(performance.now() - inicio); }
    }
    const orden = [...pared].sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ nivel: n.nivel, bytes: n.bytes, fotogramas: n.fotogramas, p50: orden[499]!.toFixed(1), p95: p95(pared).toFixed(1),
      max: orden.at(-1)!.toFixed(1), cpuP95: p95(cpus).toFixed(1), sinCamaraP95: p95(sinCamara).toFixed(1), carga: loadavg()[0]!.toFixed(0) }));
    if (p95(pared) >= 100) lentos.push(`nivel ${n.nivel}: p95 ${p95(pared).toFixed(1)} ms`);
  }
  assert.deepEqual(lentos, []);
});
