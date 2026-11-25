import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CINTA, type Corte } from '../src/shared/cinta.js';
import { enlaceCinta } from '../src/shared/fotograma.js';
import { ClaseSustancia, type SustanciaVista } from '../src/shared/materia.js';
import { applyClientTapeDelta } from '../src/shared/tape-delta.js';
import { INDICE_CINTA, NIVELES, rutaSegmento, type BloqueCinta } from '../src/server/cinta/catalogo.js';
import { EscritorCinta } from '../src/server/cinta/escritor.js';
import { decodificarBloque } from '../src/server/cinta/formato.js';
import { reducir } from '../src/server/cinta/reducir.js';
import type { PersonView, Tile, WorldView } from '../src/shared/types.js';
import { ajustarCadencia, crearEnlaceCortes } from '../src/server/tape-worker.js';

function directorio(t: TestContext) {
  const raiz = '/tmp/atlas-v23-c1a';
  mkdirSync(raiz, { recursive: true });
  const temporal = mkdtempSync(join(raiz, 'escritor-'));
  t.after(() => rmSync(temporal, { recursive: true, force: true }));
  return join(temporal, 'cinta');
}

const sustancia: SustanciaVista = { id: 1, clase: ClaseSustancia.Molecula, atomos: [1], enlaces: [], masa: 1,
  prop: { r: 0, dMedia: 0, tFusion: 0, tEbullicion: 0, qOxidacion: 0, dureza: 0, tenacidad: 0,
    flexibilidad: 0, polaridad: 0, densidad: 0, color: 0 } };

function corte(seq: number, epoca: number, t: number, completo = false): Corte {
  return { seq, epoca, t, hz: 123, vista: { version: 10, sequence: t, tick: t, day: 1, phase: 'dawn', weather: 'clear',
    width: 40, height: 28, tiles: [{ x: 0, y: 0, terrain: 'soil', food: t / 1000, moisture: 1, vegetation: 0 }],
    people: [], places: [], events: [], memories: [] }, tilesCambiadas: completo ? 'todas' : [], hitos: [], catalogo: [],
  serie: { poblacion: 13, nacimientos: 0, muertes: 0, fauna: 2, estructuras: 0, sustancias: 0, hz: 123 } };
}

test('I2: la cinta mantiene ticks estrictos, las bases y los flujos sin adelgazamiento', t => {
  const path = directorio(t);
  const escritor = new EscritorCinta({ directorio: path });
  try {
    escritor.abrir({ instanciaId: 'mundo', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    assert.throws(() => escritor.registrar(corte(0, 0, 0)), /Corte fuera de época/);
    const inicial = corte(1, 0, 0, true);
    escritor.registrar(inicial);
    assert.throws(() => escritor.registrar(corte(2, 0, 0)), /Corte fuera de época/);
    assert.throws(() => escritor.registrar(corte(2, 1, 4)), /Corte fuera de época/);
    assert.throws(() => escritor.registrar(corte(2, 0, 4, true)), /Corte fuera de época/);
    for (let tick = 4; tick <= 400; tick += 4) {
      const c = corte(1 + tick / 4, 0, tick);
      c.tilesCambiadas = c.vista.tiles;
      if (tick === 200) {
        c.hitos.push({ t: tick, tipo: 'suceso', importancia: 0, suceso: { id: 'e1', tick, kind: 'ecology',
          actors: [], text: 'Prueba', cause: 'Fixture', source: 'simulation' } });
        c.catalogo.push({ t: tick, sustancia });
      }
      c.serie.nacimientos = Math.floor(tick / 200);
      c.serie.muertes = Math.floor(tick / 400);
      c.serie.poblacion += c.serie.nacimientos - c.serie.muertes;
      escritor.registrar(c);
    }
    escritor.registrar(corte(102, 0, 500));
  } finally { escritor.close(); }

  const db = new DatabaseSync(join(path, INDICE_CINTA), { readOnly: true });
  try {
    const filas = db.prepare('SELECT * FROM bloques ORDER BY nivel,t0').all() as unknown as BloqueCinta[];
    const ticks = new Map(NIVELES.map(n => [n, [] as number[]]));
    for (const f of filas) {
      const datos = readFileSync(rutaSegmento(path, f.nivel, f.segmento)).subarray(f.offset, f.offset + f.bytes);
      const bloque = decodificarBloque(datos);
      ticks.get(f.nivel)!.push(bloque.t0, ...bloque.deltas.map(d => d.tick));
      if (f.nivel === 0 && f.t0 === 0) {
        const actual = applyClientTapeDelta(bloque.baseFrame, bloque.deltas[0]!).frame;
        assert.equal(actual.tiles[0]?.food, 0.004);
      }
    }
    assert.deepEqual(ticks.get(0), [...Array.from({ length: 101 }, (_, i) => i * 4), 500]);
    assert.deepEqual(ticks.get(1), [...Array.from({ length: 13 }, (_, i) => i * 32), 500]);
    assert.deepEqual(ticks.get(2), [0, 300]);
    assert.deepEqual(ticks.get(3), [0]);
    assert.deepEqual(ticks.get(4), [0]);
    assert.deepEqual(db.prepare('SELECT t,poblacion,nacimientos,muertes,hz FROM serie ORDER BY t').all()
      .map(r => Object.values(r)), [[0, 13, 0, 0, 123], [200, 14, 1, 0, 123], [400, 14, 2, 1, 123]]);
    assert.deepEqual(db.prepare('SELECT t0,t1 FROM lagunas').all().map(r => Object.values(r)), [[400, 500]]);
    assert.equal(db.prepare("SELECT id FROM hitos WHERE tipo='suceso'").get()?.id, 'e1');
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT sustancia FROM catalogo').get()?.sustancia)), sustancia);
  } finally { db.close(); }
});

test('I7: cinta perdida, restauración, reinicio sin retroceso y otra instancia', t => {
  const path = directorio(t);
  let escritor = new EscritorCinta({ directorio: path });
  try {
    assert.equal(escritor.abrir({ instanciaId: 'a', epoca: 0, tMundo: 40, motivo: 'reinicio' }), 0);
    escritor.registrar(corte(1, 0, 40, true));
  } finally { escritor.close(); }
  escritor = new EscritorCinta({ directorio: path });
  try {
    assert.equal(escritor.abrir({ instanciaId: 'a', epoca: 0, tMundo: 44, motivo: 'reinicio' }), 1);
    escritor.registrar(corte(1, 0, 44, true));
    const hitoPrevio = { tipo: 'suceso' as const, importancia: 0, t: 48, suceso: { id: 'e1', tick: 48,
      kind: 'ecology' as const, actors: [], text: 'Prueba', cause: 'Fixture', source: 'simulation' as const } };
    assert.equal(escritor.abrir({ instanciaId: 'a', epoca: 1, tMundo: 32, motivo: 'restauracion' }, [hitoPrevio]), 2);
    escritor.registrar(corte(2, 1, 32, true));
    assert.equal(escritor.abrir({ instanciaId: 'a', epoca: 2, tMundo: 32, motivo: 'reinicio' }), 3);
    escritor.registrar(corte(3, 2, 32, true));
    assert.equal(escritor.abrir({ instanciaId: 'b', epoca: 0, tMundo: 0, motivo: 'reinicio' }), 0);
    escritor.registrar(corte(4, 0, 0, true));
  } finally { escritor.close(); }

  const padre = join(path, '..');
  const huerfanas = readdirSync(padre).filter(n => n.startsWith('cinta.huerfana-'));
  assert.equal(huerfanas.length, 1);
  const antigua = new DatabaseSync(join(padre, huerfanas[0]!, INDICE_CINTA), { readOnly: true });
  const nueva = new DatabaseSync(join(path, INDICE_CINTA), { readOnly: true });
  try {
    assert.deepEqual(antigua.prepare('SELECT epoca,t0,t1 FROM lagunas ORDER BY epoca').all()
      .map(r => Object.values(r)), [[0, 0, 40], [1, 40, 44]]);
    assert.deepEqual(antigua.prepare('SELECT * FROM bifurcaciones').all().map(r => Object.values(r)), [[1, 32, 48, 'restauracion']]);
    assert.deepEqual(antigua.prepare('SELECT visibleHasta FROM epocas ORDER BY id').all()
      .map(r => r.visibleHasta), [32, 32, null, null]);
    assert.deepEqual(antigua.prepare("SELECT tipo,epoca FROM hitos ORDER BY epoca,tipo").all()
      .map(r => Object.values(r)), [['laguna', 0], ['laguna', 1], ['suceso', 1], ['bifurcacion', 2]]);
    assert.equal(nueva.prepare('SELECT instanciaId FROM epocas').get()?.instanciaId, 'b');
    assert.equal(nueva.prepare('SELECT count(*) AS n FROM bloques').get()?.n, 5);
  } finally { antigua.close(); nueva.close(); }
});

test('I2/I7: una serie confirmada por delante del último bloque deja una laguna visual', t => {
  const path = directorio(t);
  let fallar = false;
  let escritor = new EscritorCinta({ directorio: path, puntoEscritura: p => {
    if (fallar && p === 'mitad de bloque') throw new Error('Corte de prueba.');
  } });
  escritor.abrir({ instanciaId: 'a', epoca: 0, tMundo: 0, motivo: 'reinicio' });
  escritor.registrar(corte(1, 0, 0, true));
  escritor.flush();
  escritor.registrarSerie(0, { t: 200, ...corte(2, 0, 200).serie });
  escritor.registrar(corte(2, 0, 200));
  fallar = true;
  assert.throws(() => escritor.flush(), /Corte de prueba/);
  escritor.close(false);

  escritor = new EscritorCinta({ directorio: path });
  try { escritor.abrir({ instanciaId: 'a', epoca: 1, tMundo: 200, motivo: 'reinicio' }); }
  finally { escritor.close(); }
  const db = new DatabaseSync(join(path, INDICE_CINTA), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT max(t) AS t FROM serie WHERE epoca=0').get()?.t, 200);
    assert.equal(db.prepare('SELECT max(t1) AS t FROM bloques WHERE epoca=0 AND nivel=0').get()?.t, 0);
    assert.deepEqual(db.prepare('SELECT t0,t1 FROM lagunas WHERE epoca=1').all().map(r => Object.values(r)), [[0, 200]]);
  } finally { db.close(); }
});

test('I4: una ráfaga a dos veces la capacidad del consumidor sube y luego devuelve la cadencia', () => {
  const enlace = enlaceCinta(crearEnlaceCortes());
  let atraso = 0;
  for (let i = 0; i < 18; i++) {
    Atomics.add(enlace.entregados, 0, 2n);
    atraso = ajustarCadencia(enlace, BigInt(i), i, atraso);
  }
  assert.equal(Atomics.load(enlace.cadencia, 0), 32);
  const leidos = Atomics.load(enlace.entregados, 0);
  atraso = ajustarCadencia(enlace, leidos, atraso + 1999, atraso);
  assert.equal(Atomics.load(enlace.cadencia, 0), 32);
  for (const paso of [16, 8, CINTA.pasos[0]]) {
    atraso = ajustarCadencia(enlace, leidos, atraso + 2000, atraso);
    assert.equal(Atomics.load(enlace.cadencia, 0), paso);
  }
});

test('I1/I3: el escritor conserva el orden de las teselas entre sectores y reconstruye reducir(k, L0) al cruzar bloques', t => {
  const path = directorio(t);
  const teselas = new Map<string, Tile>();
  const tesela = (x: number, y: number, food: number): Tile => ({ x, y, terrain: 'meadow', moisture: 0.5, vegetation: 0.3, food });
  for (let i = 0; i < 20; i++) teselas.set(`${i},0`, tesela(i, 0, 0.1));
  const dispersas = [[140, 0], [-500, -1], [150, 0], [0, 145], [-499, -1]] as const;
  for (const [x, y] of dispersas) teselas.set(`${x},${y}`, tesela(x, y, 0.1));
  const persona = (t: number): PersonView => ({ id: 'p', name: 'p', role: 'neighbor', x: t % 40 < 20 ? -145 : 145, y: 0, color: '#fff',
    action: 'rest', reason: 'r', energy: 1, hunger: t / 2000, fatigue: 0, need: 'n', recentMemory: null });
  const estados = new Map<number, Pick<WorldView, 'tiles' | 'people'>>();
  const escritor = new EscritorCinta({ directorio: path });
  try {
    escritor.abrir({ instanciaId: 'mundo', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    for (let tick = 0, seq = 1; tick <= 1300; tick += 4, seq++) {
      const cambiadas: Tile[] = [];
      if (tick > 0) {
        // Un cambio pequeño dentro de la banda de L1, uno grande y altas en dos sectores.
        const k = tick / 4;
        cambiadas.push({ ...teselas.get(`${k % 20},0`)!, food: 0.1 + (k % 3) * 0.01 });
        cambiadas.push({ ...teselas.get(`${(k * 7) % 20},0`)!, food: (k % 10) / 10 });
        if (k % 9 === 0) cambiadas.push(tesela(100 + k, 1, 0.2), tesela(-100 - k, -1, 0.4));
        for (const c of cambiadas) teselas.set(`${c.x},${c.y}`, c);
      }
      const c = corte(seq, 0, tick, tick === 0);
      c.vista.tiles = [...teselas.values()];
      c.vista.people = [persona(tick)];
      estados.set(tick, { tiles: c.vista.tiles, people: c.vista.people });
      if (tick > 0) c.tilesCambiadas = cambiadas;
      escritor.registrar(c);
    }
  } finally { escritor.close(); }

  const db = new DatabaseSync(join(path, INDICE_CINTA), { readOnly: true });
  try {
    const fotogramas = new Map(NIVELES.map(n => [n, new Map<number, WorldView>()]));
    for (const f of db.prepare('SELECT * FROM bloques ORDER BY nivel,t0').all() as unknown as BloqueCinta[]) {
      const bloque = decodificarBloque(readFileSync(rutaSegmento(path, f.nivel, f.segmento)).subarray(f.offset, f.offset + f.bytes));
      let frame = bloque.baseFrame;
      fotogramas.get(f.nivel)!.set(frame.tick, frame);
      for (const delta of bloque.deltas) {
        frame = applyClientTapeDelta(frame, delta).frame;
        fotogramas.get(f.nivel)!.set(frame.tick, frame);
      }
    }
    const l0 = fotogramas.get(0)!;
    assert.deepEqual([...l0].map(([tick, { tiles, people }]) => [tick, { tiles, people }]), [...estados]);
    assert.ok(db.prepare('SELECT count(*) AS n FROM bloques WHERE nivel=0').get()!.n as number > 1, 'L0 cruza varios bloques');
    assert.equal(l0.get(1300)!.tiles.length, 20 + dispersas.length + 2 * Math.floor(325 / 9));
    for (const nivel of [1, 2, 3, 4] as const) {
      const esperados = [...l0.keys()].filter(tick => tick % CINTA.pasos[nivel] < 4);
      assert.deepEqual([...fotogramas.get(nivel)!.keys()], esperados, `ticks de L${nivel}`);
      for (const tick of esperados) {
        assert.deepEqual(fotogramas.get(nivel)!.get(tick), reducir(nivel, l0.get(tick)!, new Set()), `L${nivel} en el tick ${tick}`);
      }
    }
  } finally { db.close(); }
});
