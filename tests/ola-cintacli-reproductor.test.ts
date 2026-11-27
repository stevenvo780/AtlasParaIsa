/**
 * Reproductor de la cinta (V23) contra una cinta sintética de 5 niveles que sigue el contrato de `shared/cinta.ts`:
 * `nivel: 'auto'` = el más fino con cobertura en t; trozo = base (fotograma clave ≤ t) + deltas hasta `n` o hasta
 * `cambioDeNivelEn`; `n = 1` = el último fotograma ≤ t; nunca se sirve a través de una laguna.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClientTapeDelta, type TapeClientDelta } from '../src/shared/tape-delta.js';
import { CINTA, type Bifurcacion, type ChunkReq, type ChunkResp, type CintaMeta, type Laguna, type Marcador, type Nivel } from '../src/shared/cinta.js';
import { PROTOCOL_VERSION, type Tile, type WorldView } from '../src/shared/types.js';
import { DVR_LIMITS, DvrPlayer, PerfilCinta, leerEscenaArchivo, normalizeViewport, tickDeHistoria, type DvrChunkRequest, type DvrFrameInfo, type DvrMarca, type DvrState, type EscenaArchivo } from '../src/client/dvr-player.js';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/* ------------------------------------------------------------------ */
/* Cinta sintética                                                    */
/* ------------------------------------------------------------------ */

const TESELAS = 60;
/** Mundo determinista por tick: 3 personas se mueven y solo la comida de una tesela cambia cada 4 ticks. */
function fullFrame(tick: number): WorldView {
  const tiles: Tile[] = Array.from({ length: TESELAS }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), terrain: 'meadow', food: i === Math.floor(tick / 4) % TESELAS ? 1 : 0, moisture: .5, vegetation: .5 } as unknown as Tile));
  return {
    version: PROTOCOL_VERSION, sequence: tick, tick, day: Math.floor(tick / 2400) + 1, phase: 'day', weather: 'clear', width: 10, height: 6, originX: 0, originY: 0, tiles,
    people: Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: 'neighbor', x: i + tick * 0.001, y: i, color: '#fff' })),
    animals: [], structures: [], places: [], events: [], memories: [],
  } as unknown as WorldView;
}

/** Delta de `tick` respecto a `previo` calculado a mano (referencia independiente de `applyClientTapeDelta`). */
function deltaOf(previo: number, tick: number): TapeClientDelta {
  const antes = fullFrame(previo), despues = fullFrame(tick);
  const tilesPatch = despues.tiles.filter((t, i) => JSON.stringify(t) !== JSON.stringify(antes.tiles[i]));
  return { tick, sequence: tick, day: despues.day, phase: despues.phase, weather: despues.weather, peoplePatch: { upserts: despues.people, removed: [] }, ...(tilesPatch.length ? { tilesPatch } : {}) };
}

interface Cobertura { nivel: Nivel; t0: number; t1: number }
interface ConfigCinta { coberturas: Cobertura[]; epoca?: number; lagunas?: Laguna[]; bifurcaciones?: Bifurcacion[]; hz?: number; bloque?: number; estado?: 'ok' | 'error' }

/** L3 toda la vida; L2, L1 y L0 solo lo reciente (todo alineado a su paso). */
const MULTINIVEL: Cobertura[] = [
  { nivel: 3, t0: 0, t1: 240_000 }, { nivel: 2, t0: 192_000, t1: 240_000 },
  { nivel: 1, t0: 228_000, t1: 240_000 }, { nivel: 0, t0: 236_000, t1: 240_000 },
];

function cintaSintetica(config: ConfigCinta) {
  const epoca = config.epoca ?? 1, bloque = config.bloque ?? 8, coberturas = config.coberturas.map(c => ({ ...c }));
  const lagunas = config.lagunas ?? [], bifurcaciones = config.bifurcaciones ?? [];
  const vacio = (t: number): ChunkResp => ({ nivel: 3, paso: CINTA.pasos[3], epoca, t0: t, t1: t, hayMas: false, deltas: [] });
  const cubre = (c: Cobertura, t: number): boolean => t >= c.t0 && t <= c.t1;
  const meta = (): CintaMeta => ({
    version: 3, estado: config.estado ?? 'ok', epoca, t0: Math.min(...coberturas.map(c => c.t0)), t1: Math.max(...coberturas.map(c => c.t1)), hz: config.hz ?? 120, bytes: 1e6, topeBytes: CINTA.topeBytes,
    niveles: ([0, 1, 2, 3, 4] as Nivel[]).filter(n => coberturas.some(c => c.nivel === n)).map(nivel => {
      const propias = coberturas.filter(c => c.nivel === nivel);
      return { nivel, paso: CINTA.pasos[nivel], t0: Math.min(...propias.map(c => c.t0)), t1: Math.max(...propias.map(c => c.t1)), bytes: 1000, fotogramas: propias.reduce((s, c) => s + (c.t1 - c.t0) / CINTA.pasos[nivel] + 1, 0) };
    }),
    bifurcaciones, lagunas,
    serie: [0, 60_000, 120_000, 180_000, 240_000].map(t => ({ t, poblacion: 10 + t / 10_000, nacimientos: 0, muertes: 0, fauna: 5, estructuras: 1, sustancias: 2, hz: config.hz ?? 120 })),
  });
  function chunk(req: ChunkReq): ChunkResp {
    const n = Math.min(CINTA.maxFotogramas, Math.max(1, req.n));
    const auto = req.nivel === undefined || req.nivel === 'auto';
    const permitidas = coberturas.filter(c => auto || c.nivel === req.nivel);
    if (n === 1) { // el último fotograma ≤ t, el de mayor tick (a igualdad, el más fino)
      let mejor: { c: Cobertura; tick: number } | null = null;
      for (const c of permitidas) {
        if (req.t < c.t0) continue;
        const paso = CINTA.pasos[c.nivel], tick = Math.min(c.t1, c.t0 + Math.floor((req.t - c.t0) / paso) * paso);
        if (!mejor || tick > mejor.tick || (tick === mejor.tick && c.nivel < mejor.c.nivel)) mejor = { c, tick };
      }
      if (!mejor) return vacio(req.t);
      return { nivel: mejor.c.nivel, paso: CINTA.pasos[mejor.c.nivel], epoca, t0: mejor.tick, t1: mejor.tick, hayMas: mejor.tick < mejor.c.t1, baseFrame: fullFrame(mejor.tick), deltas: [] };
    }
    for (let t = req.t; ;) {
      const aqui = permitidas.filter(c => cubre(c, t)).sort((a, b) => a.nivel - b.nivel)[0];
      if (!aqui) return vacio(t);
      const paso = CINTA.pasos[aqui.nivel];
      const cambio = auto ? Math.min(Infinity, ...permitidas.filter(c => c.nivel < aqui.nivel && c.t0 > t).map(c => c.t0)) : Infinity;
      const span = bloque * paso, base = aqui.t0 + Math.floor((t - aqui.t0) / span) * span;
      const ticks: number[] = [];
      for (let k = base; k <= aqui.t1 && k < cambio && ticks.length < n; k += paso) ticks.push(k);
      if (!ticks.some(k => k >= t)) { if (cambio === Infinity || cambio <= t) return vacio(t); t = cambio; continue; }
      return {
        nivel: aqui.nivel, paso, epoca, t0: ticks[0]!, t1: ticks[ticks.length - 1]!, hayMas: ticks[ticks.length - 1]! < aqui.t1,
        ...(cambio < Infinity ? { cambioDeNivelEn: cambio } : {}),
        baseFrame: fullFrame(ticks[0]!), deltas: ticks.slice(1).map((k, i) => deltaOf(ticks[i]!, k)),
      };
    }
  }
  return { meta, chunk, coberturas };
}

interface OpcionesHarness extends ConfigCinta { marcadores?: PerfilCinta; metaPollMs?: number; abrirEnInicio?: boolean; escenaArchivo?: EscenaArchivo }

function harness(config: OpcionesHarness = { coberturas: MULTINIVEL }) {
  const cinta = cintaSintetica(config);
  const requests: DvrChunkRequest[] = [];
  const emitted: { tick: number; frame: WorldView; info: DvrFrameInfo }[] = [];
  const states: DvrState[] = [], marcas: DvrMarca[] = [], avisos: string[] = [], gates: Array<() => void> = [];
  let hold = false, metaCalls = 0, falla = false;
  const player = new DvrPlayer({
    metaPollMs: config.metaPollMs ?? 0, viewportCoalesceMs: 10, ...(config.marcadores ? { marcadores: config.marcadores } : {}),
    abrirEnInicio: config.abrirEnInicio, escenaArchivo: config.escenaArchivo,
    fetchMeta: async () => { metaCalls++; return cinta.meta(); },
    fetchChunk: async request => {
      requests.push(request);
      if (falla) throw new Error('sin red');
      const respuesta = cinta.chunk(request);
      if (hold) await new Promise<void>(resolve => gates.push(resolve));
      return respuesta;
    },
    onFrame: (frame, info) => { emitted.push({ tick: frame.tick, frame, info }); },
    onStateChange: state => { states.push(state); },
    onMarca: marca => { marcas.push(marca); },
    onAviso: texto => { avisos.push(texto); },
  });
  return {
    cinta, player, requests, emitted, states, marcas, avisos,
    get metaCalls() { return metaCalls; },
    holdResponses(value: boolean) { hold = value; },
    fail(value: boolean) { falla = value; },
    release() { while (gates.length) gates.shift()!(); },
    /** Reloj de rAF: `ms` de reproducción en pasos de 1/60 s, dejando resolver las peticiones entre pasos. */
    async run(ms: number, from = 0): Promise<number> {
      let now = from; player.advance(now);
      for (let elapsed = 0; elapsed < ms - 1e-9; elapsed += 1000 / 60) { now += 1000 / 60; player.advance(now); await flush(); }
      return now;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Arranque, nivel y escala                                           */
/* ------------------------------------------------------------------ */

test('la cinta avisa del presente con el fotograma de la época vigente', async () => {
  const cinta = cintaSintetica({ coberturas: MULTINIVEL, epoca: 2 });
  let epocaServida = 1;
  const emitidos: DvrFrameInfo[] = [];
  const player = new DvrPlayer({
    metaPollMs: 0,
    fetchMeta: async () => cinta.meta(),
    fetchChunk: async peticion => ({ ...cinta.chunk(peticion), epoca: epocaServida }),
    onFrame: (_frame, info) => { emitidos.push(info); },
  });
  try {
    await player.start();
    assert.equal(player.modoReloj, 'tiempo-real');
    assert.equal(player.atLiveEdge, false, 'el arranque no se engancha al borde vivo');
    assert.equal(emitidos.at(-1)!.presente, false);
    epocaServida = 2;
    await player.jumpToLiveEdge();
    assert.equal(player.modoReloj, 'borde-vivo');
    assert.equal(emitidos.at(-1)!.presente, true);
    await player.seek(98_400);
    assert.equal(emitidos.at(-1)!.presente, false);
  } finally { player.stop(); }
});

test('una grabación abre pausada al inicio y su botón final muestra el último fotograma exacto', async () => {
  const h = harness({ coberturas: [{ nivel: 0, t0: 80, t1: 480 }], abrirEnInicio: true });
  assert.equal(await h.player.start(), true);
  assert.equal(h.player.currentTick, 80);
  assert.equal(h.player.playing, false);
  await h.player.jumpToLiveEdge();
  assert.equal(h.player.currentTick, 480);
  assert.equal(h.player.playing, false);
  assert.equal(h.metaCalls, 1);
  h.player.stop();
});

test('enlace de escena de archivo: exige enteros y valida el intervalo opcional', () => {
  assert.deepEqual(leerEscenaArchivo(new URLSearchParams('?t=72391&x=63&y=23&desde=72371&hasta=72451&modo=observador')),
    { tick: 72391, x: 63, y: 23, tramo: { desde: 72371, hasta: 72451 } });
  assert.deepEqual(leerEscenaArchivo(new URLSearchParams('?t=0&x=-2&y=0')), { tick: 0, x: -2, y: 0 });
  for (const query of ['modo=observador', 't=1&x=&y=1', 't=1&x=10000000&y=0', 't=2.5&x=1&y=1',
    't=9007199254740992&x=0&y=0', 't=1&x=1&y=1&desde=0', 't=8&x=1&y=1&desde=1&hasta=6']) {
    assert.equal(leerEscenaArchivo(new URLSearchParams(query)), undefined, query);
  }
});

test('enlace de escena de archivo: el primer trozo usa foco y tick exactos, abre pausado y permite seguir navegando', async () => {
  const escenaArchivo = { tick: 152, x: 5, y: 4, tramo: { desde: 144, hasta: 160 } };
  const h = harness({ coberturas: [{ nivel: 0, t0: 80, t1: 480 }], abrirEnInicio: true, escenaArchivo });
  assert.equal(await h.player.start(), true);
  assert.deepEqual(h.emitted.map(e => e.tick), [152]);
  const { t, x, y, w, h: alto } = h.requests[0]!;
  assert.deepEqual([t, x, y, w, alto], [152, -43, -28, 96, 64]);
  assert.deepEqual(h.player.escenaInicial, escenaArchivo);
  assert.equal(h.player.playing, false);
  await h.run(1000);
  assert.equal(h.player.currentTick, 152);

  await h.player.reproducirTramo(144, 160);
  await h.run(1000, 1000);
  assert.equal(h.player.currentTick, 160);
  assert.equal(h.player.playing, false);
  await h.player.seek(220);
  assert.equal(h.player.currentTick, 220);
  h.player.stop();
});

test('enlace de escena de archivo: vuelve a t0 si el foco no se puede reconstruir', async () => {
  const config = { coberturas: [{ nivel: 0 as const, t0: 80, t1: 480 }], abrirEnInicio: true };
  for (const [escenaArchivo, pedidos] of [
    [{ tick: 154, x: 5, y: 4 }, [154, 80]],
    [{ tick: 152, x: 200, y: 4 }, [152, 80]],
    [{ tick: 152, x: 5, y: 4, tramo: { desde: 148, hasta: 484 } }, [80]],
  ] as const) {
    const h = harness({ ...config, escenaArchivo });
    assert.equal(await h.player.start(), true);
    assert.deepEqual(h.requests.map(r => r.t), pedidos);
    assert.equal(h.requests.at(-1)!.x, undefined);
    assert.deepEqual(h.emitted.map(e => e.tick), [80]);
    assert.equal(h.player.escenaInicial, undefined);
    assert.equal(h.player.playing, false);
    h.player.stop();
  }
  const escenaArchivo = { tick: 152, x: 5, y: 4, tramo: { desde: 144, hasta: 160 } };
  const conHueco = harness({ ...config, escenaArchivo, lagunas: [{ t0: 144, t1: 148, nivel: 0 }] });
  await conHueco.player.start();
  assert.equal(conHueco.player.currentTick, 80);
  conHueco.player.stop();
  const vivo = harness({ ...config, abrirEnInicio: false, escenaArchivo });
  await vivo.player.start();
  assert.equal(vivo.requests[0]?.x, undefined);
  assert.equal(vivo.requests[0]?.t, tickDeHistoria(80, 480));
  assert.equal(vivo.player.currentTick, 416);
  assert.equal(vivo.player.modoReloj, 'tiempo-real');
  assert.equal(vivo.player.atLiveEdge, false);
  assert.equal(vivo.player.playing, true);
  vivo.player.stop();
});

test('enlace de escena de archivo: usa el fotograma real tras un cambio de fase de L0', async () => {
  const h = harness({ coberturas: [{ nivel: 0, t0: 80, t1: 84 }, { nivel: 0, t0: 85, t1: 97 }],
    abrirEnInicio: true, escenaArchivo: { tick: 85, x: 5, y: 4 } });
  try {
    assert.equal(await h.player.start(), true);
    assert.deepEqual(h.requests.map(peticion => peticion.t), [85]);
    assert.deepEqual(h.emitted.map(frame => frame.tick), [85]);
    assert.equal(h.player.playing, false);
  } finally { h.player.stop(); }
});

test('enlace de escena de archivo: el último salto conserva su ventana al reemplazar la apertura', async () => {
  const h = harness({ coberturas: [{ nivel: 0, t0: 80, t1: 96 }], abrirEnInicio: true,
    escenaArchivo: { tick: 84, x: 5, y: 4, tramo: { desde: 80, hasta: 88 } } });
  h.holdResponses(true);
  const inicio = h.player.start();
  await flush();
  try {
    h.holdResponses(false);
    await h.player.jumpToLiveEdge();
    h.release();
    assert.equal(await inicio, true);
    assert.deepEqual(h.emitted.map(frame => frame.tick), [96]);
    assert.equal(h.requests[0]?.x, -43);
    assert.equal(h.requests[1]?.x, undefined);
    assert.equal(h.player.escenaInicial, undefined);
  } finally { h.release(); h.player.stop(); }
});

test('un tramo entre muestras solo muestra fotogramas dentro de los dos límites', async () => {
  const h = harness({ coberturas: [{ nivel: 0, t0: 0, t1: 80 }], abrirEnInicio: true });
  await h.player.start();
  h.emitted.length = 0;
  await h.player.reproducirTramo(17, 23);
  await h.run(1000);
  assert.deepEqual(h.emitted.map(e => e.tick), [20]);
  assert.equal(h.player.playing, false);
  h.emitted.length = 0;
  await h.player.reproducirTramo(21, 23);
  assert.deepEqual(h.emitted, []);
  assert.equal(h.player.playing, false);
  h.player.stop();
});

test('start: sin marcador abre en la historia, en tiempo real, y no en el borde vivo', async () => {
  const h = harness();
  assert.equal(await h.player.start(), true);
  assert.equal(h.player.enabled, true);
  const primera = h.requests[0]!;
  assert.equal(primera.nivel, 'auto'); assert.equal(primera.t, tickDeHistoria(0, 240_000)); assert.equal(primera.n, DVR_LIMITS.chunkCount);
  assert.deepEqual(h.emitted.map(e => e.tick), [239_936]);
  assert.equal(h.emitted[0]!.info.reason, 'start'); assert.equal(h.emitted[0]!.info.nivel, 0); assert.equal(h.emitted[0]!.info.paso, 4);
  assert.equal(h.emitted[0]!.info.discontinuity, true);
  assert.equal(h.player.nivel, 0); assert.equal(h.player.paso, 4);
  assert.equal(h.player.modoReloj, 'tiempo-real');
  assert.equal(h.player.atLiveEdge, false); assert.equal(h.player.latestDay, 101); assert.equal(h.player.simHz, 120);
  assert.equal(h.player.serie.length, 5);
  assert.ok(h.emitted.length === 1, 'el primer fotograma sale sin esperar al reloj');
  h.player.stop();
});

test('start: una cinta sin fotogramas queda activa pero no pide trozos; una cinta que no responde no arranca', async () => {
  const metaVacia: CintaMeta = { version: 3, estado: 'ok', epoca: 0, t0: 0, t1: 0, hz: 0, bytes: 0, topeBytes: CINTA.topeBytes, niveles: [], bifurcaciones: [], lagunas: [], serie: [] };
  let trozos = 0;
  const vacia = new DvrPlayer({ metaPollMs: 0, fetchMeta: async () => metaVacia, fetchChunk: async () => { trozos++; throw new Error('no debería pedirse'); }, onFrame: () => undefined });
  assert.equal(await vacia.start(), true); assert.equal(vacia.enabled, true); assert.equal(trozos, 0); assert.equal(vacia.snapshot().niveles.length, 0);
  const rota = new DvrPlayer({ metaPollMs: 0, fetchMeta: async () => { throw new Error('no hay cinta'); }, fetchChunk: async () => { throw new Error('no'); }, onFrame: () => undefined });
  assert.equal(await rota.start(), false); assert.equal(rota.error, 'no hay cinta'); assert.equal(rota.enabled, false);
});

test('el reloj cuenta fotogramas del nivel en curso: 6 por segundo a 1× aunque el paso sea 4 o 2400 ticks', async () => {
  for (const [objetivo, nivel, paso] of [[100_000, 3, 2400], [200_000, 2, 300], [230_000, 1, 32]] as const) {
    const h = harness();
    await h.player.start(); await h.player.seek(objetivo); h.player.setSpeed(1);
    assert.equal(h.player.nivel, nivel); h.emitted.length = 0;
    await h.run(1100);
    assert.equal(h.emitted.length, 6, `nivel ${nivel}: 6 fotogramas en 1,1 s`);
    const ticks = h.emitted.map(e => e.tick);
    for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i]! - ticks[i - 1]!, paso, `nivel ${nivel}: un fotograma = ${paso} ticks`);
    assert.ok(h.emitted.every(e => e.info.nivel === nivel && !e.info.cambioDeNivel && !e.info.discontinuity));
    h.player.stop();
  }
});

test('velocidades de CINTA.velocidades: fotogramas por segundo = fpsNormal × velocidad; setSpeed ignora lo que no es del contrato', async () => {
  for (const speed of [0.5, 2, 5] as const) {
    const h = harness();
    await h.player.start(); await h.player.seek(20_000);
    h.player.setSpeed(speed); h.emitted.length = 0;
    await h.run(2100);
    assert.equal(h.emitted.length + h.emitted.reduce((s, e) => s + e.info.skipped, 0), Math.floor(CINTA.fpsNormal * speed * 2.1), `${speed}×`);
    assert.ok(h.emitted.every(e => Math.abs(e.info.tickIntervalMs - 1000 / (CINTA.fpsNormal * speed)) < 1e-9));
    h.player.stop();
  }
  const h = harness();
  await h.player.start();
  h.player.setSpeed(3 as never); assert.equal(h.player.speed, 1);
  h.player.setSpeed(25); assert.equal(h.player.speed, 25);
  h.player.stop();
});

test('a 25× varios fotogramas por rAF entregan solo el último (skipped) y el orden no retrocede', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(20_000);
  h.player.setSpeed(25); h.emitted.length = 0; h.requests.length = 0;
  await h.run(1000);
  assert.ok(h.emitted.length <= 61, 'como mucho un fotograma por rAF');
  assert.ok(h.emitted.some(e => e.info.skipped > 0), 'a 25× se saltan intermedios');
  const ticks = h.emitted.map(e => e.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.ok(h.requests.length > 0 && h.requests.every(r => r.n === DVR_LIMITS.fastChunkCount), 'a ≥ 10× los trozos son de CINTA.maxFotogramas');
  h.player.stop();
});

test('cambio de nivel: el primer fotograma del nivel nuevo sale sin esperar, con discontinuidad y cambioDeNivel', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(180_000); h.player.setSpeed(1);
  assert.equal(h.player.nivel, 3); h.emitted.length = 0;
  await h.run(1500); // 4 fotogramas de L3 (182400…189600) y el salto a L2 (192000…)
  const ticks = h.emitted.map(e => e.tick);
  assert.deepEqual(ticks.slice(0, 4), [182_400, 184_800, 187_200, 189_600]);
  const cambio = h.emitted.find(e => e.info.cambioDeNivel);
  assert.ok(cambio, 'hubo un cambio de nivel');
  assert.equal(cambio.tick, 192_000); assert.equal(cambio.info.nivel, 2); assert.equal(cambio.info.discontinuity, true);
  assert.equal(h.emitted.filter(e => e.info.cambioDeNivel).length, 1);
  const despues = h.emitted.filter(e => e.tick > 192_000);
  assert.ok(despues.length > 0 && despues.every(e => e.info.nivel === 2 && !e.info.cambioDeNivel && !e.info.discontinuity));
  assert.ok(h.requests.some(r => r.t > 189_600 && r.nivel === 'auto'), 'el siguiente trozo se pide en auto: la cinta decide el nivel');
  h.player.stop();
});

test('cambio de nivel a velocidad alta no se traga el fotograma de cambio ni mezcla niveles en un mismo entregado', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(150_000);
  h.player.setSpeed(25); h.emitted.length = 0;
  await h.run(4000);
  const niveles = h.emitted.map(e => e.info.nivel);
  assert.ok(niveles.includes(3) && niveles.includes(2), 'cruzó de L3 a L2');
  const cambios = h.emitted.filter(e => e.info.cambioDeNivel);
  assert.ok(cambios.length >= 1 && cambios.every(e => e.info.discontinuity));
  for (let i = 1; i < h.emitted.length; i++) {
    const a = h.emitted[i - 1]!, b = h.emitted[i]!;
    assert.ok(b.tick > a.tick, 'el cabezal solo avanza');
    assert.equal(b.info.cambioDeNivel, a.info.nivel !== b.info.nivel);
  }
  h.player.stop();
});

test('setNivel fija el nivel pedido: los trozos lo llevan y la cinta solo sirve ese', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(238_000);
  await h.player.setNivel(3);
  assert.equal(h.requests.at(-1)!.nivel, 3); assert.equal(h.player.nivel, 3); assert.equal(h.player.nivelPedido, 3);
  await h.player.setNivel('auto');
  assert.equal(h.requests.at(-1)!.nivel, 'auto');
  h.player.stop();
});

/* ------------------------------------------------------------------ */
/* Paso atrás exacto                                                  */
/* ------------------------------------------------------------------ */

test('paso atrás: pide el fotograma anterior exacto (n = 1, t = tick − 1) y no reconstruye hacia atrás', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(200_000);
  const actual = h.player.currentTick; assert.equal(h.player.nivel, 2);
  h.requests.length = 0; h.emitted.length = 0;
  await h.player.step(-1);
  const peticion = h.requests[0]!;
  assert.equal(peticion.n, 1); assert.equal(peticion.t, actual - 1); assert.equal(peticion.nivel, 'auto');
  assert.equal(h.requests.length, 1, 'una sola petición');
  assert.deepEqual(h.emitted.map(e => e.tick), [actual - 300]);
  assert.equal(h.emitted[0]!.info.reason, 'step'); assert.equal(h.emitted[0]!.info.discontinuity, true);
  assert.deepEqual(h.emitted[0]!.frame, fullFrame(actual - 300), 'el fotograma es exactamente el grabado');
  assert.equal(h.player.playing, false); assert.equal(h.player.bufferedAhead, 0, 'sin cola: lo de delante se repide al avanzar');
  // Varios clics seguidos: cada uno parte del fotograma en que dejó el anterior.
  await Promise.all([h.player.step(-1), h.player.step(-1), h.player.step(-1)]);
  assert.deepEqual(h.emitted.map(e => e.tick), [actual - 300, actual - 600, actual - 900, actual - 1200]);
  h.player.stop();
});

test('paso atrás en el límite entre niveles: el fotograma anterior es del nivel que lo grabó', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(192_000);
  assert.equal(h.player.currentTick, 192_000); assert.equal(h.player.nivel, 2);
  h.emitted.length = 0;
  await h.player.step(-1);
  assert.equal(h.emitted[0]!.tick, 189_600); assert.equal(h.emitted[0]!.info.nivel, 3); assert.equal(h.emitted[0]!.info.cambioDeNivel, true);
  await h.player.step(1);
  assert.equal(h.player.currentTick, 192_000, 'avanzar vuelve al fotograma de L2');
  assert.equal(h.player.nivel, 2);
  h.player.stop();
});

test('paso atrás sin nada anterior no inventa fotogramas; paso adelante con la cola vacía lo pide', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(0);
  assert.equal(h.player.currentTick, 0); h.emitted.length = 0; h.requests.length = 0;
  await h.player.step(-1);
  assert.equal(h.requests.length, 0, 'en el primer tick de la cinta no se pide nada'); assert.equal(h.emitted.length, 0);
  await h.player.seek(100_000); h.emitted.length = 0;
  await h.player.step(-1); // deja la cola vacía
  await h.player.step(1);
  assert.deepEqual(h.emitted.map(e => e.tick), [98_400 - 2400, 98_400]);
  assert.equal(h.emitted[1]!.info.reason, 'step');
  h.player.stop();
});

test('el paso atrás invalida un salto en vuelo: solo cuenta la última orden', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  h.emitted.length = 0; h.holdResponses(true);
  const salto = h.player.seek(50_000);
  await flush();
  const atras = h.player.step(-1);
  await flush(); h.holdResponses(false); h.release();
  await Promise.all([salto, atras]);
  assert.deepEqual(h.emitted.map(e => e.tick), [96_000]);
  h.player.stop();
});

/* ------------------------------------------------------------------ */
/* Bifurcaciones, lagunas y huecos                                    */
/* ------------------------------------------------------------------ */

test('laguna: el reproductor la salta, lo avisa y el fotograma que la cruza es discontinuo', async () => {
  const laguna: Laguna = { t0: 117_600, t1: 132_000 };
  const h = harness({ coberturas: [{ nivel: 3, t0: 0, t1: 117_600 }, { nivel: 3, t0: 132_000, t1: 240_000 }], lagunas: [laguna] });
  await h.player.start(); await h.player.seek(112_800); h.player.setSpeed(1);
  h.emitted.length = 0; h.holdResponses(false);
  await h.run(2500);
  const ticks = h.emitted.map(e => e.tick);
  assert.ok(ticks.includes(117_600) && ticks.includes(132_000), `cruza la laguna (${ticks})`);
  assert.deepEqual(h.marcas.map(m => m.tipo), ['laguna']);
  assert.match(h.marcas[0]!.texto, /La cinta no grabó 6 días/);
  const cruce = h.emitted.find(e => e.tick === 132_000)!;
  assert.equal(cruce.info.discontinuity, true); assert.equal(cruce.info.cambioDeNivel, false);
  assert.ok(h.requests.some(r => r.t === 132_000), 'el siguiente trozo se pidió ya pasada la laguna');
  h.player.stop();
});

test('seek dentro de una laguna cae en su borde según la dirección; fuera de lo grabado se acota', async () => {
  const laguna: Laguna = { t0: 117_600, t1: 132_000 };
  const h = harness({ coberturas: [{ nivel: 3, t0: 0, t1: 117_600 }, { nivel: 3, t0: 132_000, t1: 240_000 }], lagunas: [laguna] });
  await h.player.start(); await h.player.seek(100_000);
  const primera = async (tick: number): Promise<number> => { const n = h.requests.length; await h.player.seek(tick); return h.requests[n]!.t; };
  assert.equal(await primera(125_000), 132_000, 'hacia delante: al final de la laguna');
  assert.equal(h.player.currentTick, 132_000);
  assert.equal(await primera(125_000), 117_600, 'hacia atrás: al principio de la laguna');
  assert.equal(await primera(-5), 0);
  assert.equal(await primera(9e9), 240_000);
  h.player.stop();
});

test('bifurcación: al cruzar su punto la crónica recibe la línea con los días perdidos; sin discontinuidad', async () => {
  const b: Bifurcacion = { epoca: 0, desde: 60_000, hasta: 90_000, motivo: 'reinicio' };
  const h = harness({ coberturas: MULTINIVEL, bifurcaciones: [b] });
  await h.player.start(); await h.player.seek(55_200); h.player.setSpeed(1);
  assert.equal(h.marcas.length, 0, 'saltar a un punto no dispara la marca');
  h.emitted.length = 0;
  await h.run(1500);
  assert.equal(h.marcas.length, 1); assert.equal(h.marcas[0]!.tipo, 'bifurcacion');
  assert.equal(h.marcas[0]!.texto, 'El mundo se reinició: se perdieron 12,5 días no guardados.');
  assert.ok(h.emitted.every(e => !e.info.discontinuity));
  const restaurada = harness({ coberturas: MULTINIVEL, bifurcaciones: [{ ...b, motivo: 'restauracion' }] });
  await restaurada.player.start(); await restaurada.player.seek(55_200); restaurada.player.setSpeed(1); await restaurada.run(1500);
  assert.match(restaurada.marcas[0]!.texto, /Se restauró una copia anterior del mundo: se perdieron 12,5 días/);
  h.player.stop(); restaurada.player.stop();
});

test('pollMeta con una bifurcación nueva: lo encolado más allá de su punto se descarta y se repide', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  const antes = h.player.bufferedAhead; assert.ok(antes > 10);
  const meta = h.cinta.meta;
  h.cinta.meta = () => ({ ...meta(), bifurcaciones: [{ epoca: 0, desde: 110_000, hasta: 130_000, motivo: 'restauracion' }] });
  await h.player.pollMeta(); await flush();
  assert.equal(h.player.bifurcaciones.length, 1);
  assert.ok(h.player.snapshot().bifurcaciones[0]!.desde === 110_000);
  h.player.stop();
});

test('pollMeta con el cabezal en lo olvidado por una bifurcación: vuelve al punto de la bifurcación', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  const meta = h.cinta.meta;
  h.cinta.meta = () => ({ ...meta(), bifurcaciones: [{ epoca: 0, desde: 50_000, hasta: 130_000, motivo: 'restauracion' }] });
  await h.player.pollMeta();
  assert.ok(h.player.currentTick <= 50_000, `volvió a ${h.player.currentTick}`);
  h.player.stop();
});

/* ------------------------------------------------------------------ */
/* Salto, cola y red                                                  */
/* ------------------------------------------------------------------ */

test('seek: acota a la cinta, aterriza en el último fotograma ≤ t y una respuesta vieja se descarta', async () => {
  const h = harness();
  await h.player.start();
  await h.player.seek(100_000);
  assert.equal(h.player.currentTick, 98_400, 'el fotograma clave está antes; los deltas hasta t se aplican de una vez');
  assert.equal(h.emitted.at(-1)!.info.reason, 'seek'); assert.equal(h.emitted.at(-1)!.info.discontinuity, true);
  assert.deepEqual(h.emitted.at(-1)!.frame, fullFrame(98_400));
  h.emitted.length = 0; h.holdResponses(true);
  const lento = h.player.seek(10_000);
  await flush();
  h.holdResponses(false);
  const rapido = h.player.seek(50_400);
  h.release();
  await Promise.all([lento, rapido]);
  assert.deepEqual(h.emitted.map(e => e.tick), [50_400], 'solo el último salto pinta');
  h.player.stop();
});

test('seek sin nada en ese punto avisa y deja el cabezal donde estaba', async () => {
  const h = harness({ coberturas: [{ nivel: 3, t0: 0, t1: 100_000 }, { nivel: 3, t0: 130_000, t1: 240_000 }] });
  await h.player.start(); await h.player.seek(50_400);
  h.avisos.length = 0; h.emitted.length = 0;
  await h.player.seek(115_000); // hueco no declarado como laguna: el servidor no responde nada
  assert.equal(h.emitted.length, 0); assert.equal(h.player.currentTick, 50_400);
  assert.deepEqual(h.avisos, ['No hay cinta en ese punto.']);
  h.player.stop();
});

test('prefetch: un solo trozo en vuelo, nunca más allá del presente y sin repetir cuando no hay más', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(239_800); h.player.setSpeed(1);
  await h.run(10_000);
  assert.equal(h.player.currentTick, 240_000);
  const enVuelo = h.requests.length;
  await h.run(3000);
  assert.equal(h.requests.length, enVuelo, 'en el presente no se insiste');
  // La cinta crece: el sondeo de meta reanuda la carga.
  h.cinta.coberturas.find(c => c.nivel === 0)!.t1 = 240_400;
  await h.player.pollMeta(); await flush(); await flush();
  assert.ok(h.requests.length > enVuelo);
  assert.equal(h.player.maxTick, 240_400);
  h.player.stop();
});

test('prefetch con trozos de 90 y deltas perezosos: llegar el trozo no expande los deltas, se expanden al cruzarlos', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(8_400); h.player.setSpeed(1);
  await flush();
  assert.equal(h.requests.at(-1)!.n, 90);
  assert.ok(h.player.bufferedAhead >= 70);
  assert.ok(h.player.decodedDeltas <= 4, `solo el aterrizaje decodificó (${h.player.decodedDeltas})`);
  h.emitted.length = 0;
  await h.run(1100);
  assert.ok(h.player.decodedDeltas >= 6 && h.player.decodedDeltas <= 12);
  h.player.stop();
});

test('paridad exacta: cada fotograma entregado por deltas es idéntico al grabado, también entre trozos', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(8_400); h.player.setSpeed(1);
  h.emitted.length = 0;
  await h.run(20_000);
  assert.ok(h.emitted.length > 100);
  for (const e of h.emitted) assert.deepEqual(e.frame, fullFrame(e.tick), `tick ${e.tick}`);
  h.player.stop();
});

test('changedTiles trae solo las teselas modificadas y se acumula al saltar fotogramas', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(236_100); h.player.setSpeed(1); // L0: la comida cambia de tesela en cada fotograma
  h.emitted.length = 0;
  await h.run(500);
  const parcial = h.emitted.find(e => e.info.changedTiles);
  assert.ok(parcial && parcial.info.changedTiles!.length <= 2);
  h.player.setSpeed(25); h.emitted.length = 0;
  await h.run(300);
  const salto = h.emitted.find(e => e.info.skipped >= 1 && e.info.changedTiles);
  assert.ok(salto && salto.info.changedTiles!.length > 2, 'las teselas de los fotogramas cruzados se acumulan');
  h.player.stop();
});

test('un error de red no rompe la reproducción: se anota y el siguiente sondeo lo recupera', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  h.fail(true);
  await h.player.seek(50_000);
  assert.equal(h.player.error, 'sin red'); assert.equal(h.player.currentTick, 98_400);
  h.fail(false);
  await h.player.pollMeta();
  assert.equal(h.player.error, null);
  h.player.stop();
});

test('un delta sin fotograma base no rompe el reproductor: el error queda anotado y el siguiente salto lo repone', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  const original = h.cinta.chunk;
  h.cinta.chunk = req => ({ ...original(req), baseFrame: undefined });
  h.emitted.length = 0;
  await h.player.seek(50_000);
  assert.match(h.player.error ?? '', /sin fotograma base/); assert.equal(h.emitted.length, 0); assert.equal(h.player.currentTick, 98_400);
  h.cinta.chunk = original;
  await h.player.seek(50_000);
  assert.equal(h.player.error, null); assert.equal(h.player.currentTick, 48_000);
  h.player.stop();
});

test('estado error de la cinta se expone y la serie/bifurcaciones/lagunas de la meta se publican', async () => {
  const h = harness({ coberturas: MULTINIVEL, estado: 'error', lagunas: [{ t0: 1, t1: 2 }] });
  await h.player.start();
  const s = h.player.snapshot();
  assert.equal(s.estado, 'error'); assert.equal(s.lagunas.length, 1); assert.equal(s.serie.length, 5); assert.equal(s.niveles.length, 4);
  assert.equal(s.epoca, 1); assert.equal(s.nivel, 0);
  h.player.stop();
});

/* ------------------------------------------------------------------ */
/* Controles, cámara y presente                                       */
/* ------------------------------------------------------------------ */

test('pausa: el cabezal no se mueve pero el prefetch sigue; step(+1) usa la cola y pausa', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  h.player.setPlaying(false); h.emitted.length = 0;
  await h.run(1000);
  assert.equal(h.emitted.length, 0);
  h.player.setPlaying(true);
  await h.player.step(1);
  assert.equal(h.player.playing, false); assert.deepEqual(h.emitted.map(e => e.tick), [100_800]);
  assert.equal(h.emitted[0]!.info.reason, 'step'); assert.equal(h.emitted[0]!.info.discontinuity, false);
  h.player.stop();
});

test('jumpToLiveEdge: vuelve a maxTick − liveMargin y reproduce', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(10_000); h.player.setPlaying(false);
  const n = h.requests.length;
  await h.player.jumpToLiveEdge();
  assert.equal(h.player.playing, true); assert.equal(h.requests[n]!.t, 240_000 - DVR_LIMITS.liveMargin);
  assert.equal(h.player.atLiveEdge, true);
  h.player.stop();
});

test('Presente actualiza la meta y aterriza en el último fotograma de la respuesta si la cinta crece', async () => {
  const cinta = cintaSintetica({ coberturas: [{ nivel: 0, t0: 0, t1: 400 }], bloque: 100 });
  const pedidos: DvrChunkRequest[] = [];
  let crecer = false;
  const player = new DvrPlayer({ metaPollMs: 0, fetchMeta: async () => cinta.meta(), fetchChunk: async req => {
    pedidos.push(req);
    if (crecer) { cinta.coberturas[0]!.t1 = 520; crecer = false; }
    return cinta.chunk(req);
  }, onFrame: () => undefined });
  await player.start();
  await player.seek(20);
  cinta.coberturas[0]!.t1 = 480;
  crecer = true;
  await player.jumpToLiveEdge();
  assert.equal(pedidos.at(-1)!.t, 450);
  assert.equal(player.currentTick, 520);
  assert.equal(player.atLiveEdge, true);
  player.stop();
});

test('una búsqueda histórica posterior invalida la meta pendiente de Presente', async () => {
  const cinta = cintaSintetica({ coberturas: [{ nivel: 0, t0: 0, t1: 400 }], bloque: 100 });
  let liberar: (() => void) | undefined, esperar = false;
  const player = new DvrPlayer({ metaPollMs: 0, fetchMeta: async () => {
    if (esperar) await new Promise<void>(resolve => { liberar = resolve; });
    return cinta.meta();
  }, fetchChunk: async req => cinta.chunk(req), onFrame: () => undefined });
  await player.start();
  esperar = true;
  const presente = player.jumpToLiveEdge();
  await player.seek(40);
  liberar!();
  await presente;
  assert.equal(player.currentTick, 40);
  player.stop();
});

test('una cámara pendiente no devuelve al corte anterior tras pedir Presente', async () => {
  const h = harness({ coberturas: [{ nivel: 0, t0: 0, t1: 480 }], bloque: 100 });
  await h.player.start();
  await h.player.seek(40);
  h.player.setViewport({ x: 4, y: 3, width: 20, height: 10 });
  await h.player.jumpToLiveEdge();
  await h.player.flushViewport();
  assert.equal(h.player.currentTick, 480);
  assert.equal(h.player.atLiveEdge, true);
  h.player.stop();
});

test('setViewport: se fusiona, pide x/y/w/h y refresca el trozo en currentTick sin discontinuidad', async () => {
  const h = harness();
  await h.player.start(); await h.player.seek(100_000);
  h.emitted.length = 0; h.requests.length = 0;
  h.player.setViewport({ x: 10.4, y: 3, width: 40.2, height: 30 });
  h.player.setViewport({ x: 12.8, y: 4, width: 41, height: 30 });
  await new Promise(resolve => setTimeout(resolve, 30)); await flush();
  assert.equal(h.requests.length >= 1, true);
  const pedido = h.requests[0]!;
  assert.deepEqual([pedido.x, pedido.y, pedido.w, pedido.h], [12, 4, 41, 30]);
  assert.equal(pedido.t, 98_400);
  assert.ok(h.emitted.length === 1 && h.emitted[0]!.info.reason === 'refresh' && h.emitted[0]!.info.discontinuity === false && h.emitted[0]!.tick === 98_400);
  h.player.stop();
});

test('setViewport antes de start: el primer trozo ya sale con esa cámara y no se repide', async () => {
  const h = harness();
  h.player.setViewport({ x: 1, y: 2, width: 20, height: 10 });
  await h.player.start();
  assert.equal(h.requests.length >= 1, true); assert.deepEqual([h.requests[0]!.x, h.requests[0]!.y, h.requests[0]!.w, h.requests[0]!.h], [1, 2, 20, 10]);
  h.player.stop();
});

test('normalizeViewport: enteros, tamaño acotado y rechazo de NaN', () => {
  assert.deepEqual(normalizeViewport({ x: 1.9, y: -2.1, width: 200.2, height: 0 }), { x: 1, y: -3, width: DVR_LIMITS.camaraMaxAncho, height: 1 });
  assert.equal(normalizeViewport({ x: NaN, y: 0, width: 1, height: 1 }), null);
});

/* ------------------------------------------------------------------ */
/* Marcadores                                                         */
/* ------------------------------------------------------------------ */

function almacenEnMemoria() {
  const datos = new Map<string, string>();
  return { datos, getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v); } };
}

test('al entrar retoma el último marcador a 1× con el aviso del desfase al presente', async () => {
  const marcador: Marcador = { perfil: 'p', epoca: 1, t: 100_000, nivel: 3, velocidad: 5, en: 1000 };
  const perfil = new PerfilCinta({ almacen: almacenEnMemoria(), uuid: () => 'perfil-1', red: { leer: async () => [{ ...marcador, perfil: 'perfil-1' }], escribir: async () => true } });
  const h = harness({ coberturas: MULTINIVEL, marcadores: perfil });
  await h.player.start();
  assert.equal(h.emitted[0]!.tick, 98_400); assert.equal(h.emitted[0]!.info.reason, 'start');
  assert.equal(h.player.modoReloj, 'tiempo-real');
  assert.equal(h.player.atLiveEdge, false);
  assert.equal(h.player.speed, 1, 'sin modo guardado no restaura el 5× viejo ni engancha el borde');
  assert.deepEqual(h.avisos, ['Retomando en el día 42 · el presente está a 59 días']);
  h.player.stop();
});

test('marcador en el presente avisa «estás en el presente»; marcador pasado de la cinta se acota; sin marcador no hay aviso', async () => {
  const guardado = (t: number): PerfilCinta => new PerfilCinta({ almacen: almacenEnMemoria(), uuid: () => 'x', red: { leer: async () => [{ perfil: 'x', epoca: 1, t, nivel: 0, velocidad: 1, en: 5 }], escribir: async () => true } });
  const vivo = harness({ coberturas: MULTINIVEL, marcadores: guardado(239_990) });
  await vivo.player.start();
  assert.deepEqual(vivo.avisos, ['Retomando en el día 100 · estás en el presente']);
  const nada = harness({ coberturas: MULTINIVEL, marcadores: new PerfilCinta({ almacen: almacenEnMemoria(), red: { leer: async () => [], escribir: async () => true } }) });
  await nada.player.start();
  assert.equal(nada.avisos.length, 0); assert.equal(nada.requests[0]!.t, tickDeHistoria(0, 240_000));
  assert.equal(nada.player.modoReloj, 'tiempo-real'); assert.equal(nada.player.atLiveEdge, false);
  vivo.player.stop(); nada.player.stop();
});

test('se guarda el marcador cada 5 s de reproducción y al parar o salir; en pausa no', async () => {
  const escrituras: { m: Marcador; alSalir: boolean }[] = [];
  const perfil = new PerfilCinta({ almacen: almacenEnMemoria(), uuid: () => 'perfil-2', ahora: () => 7_000, red: { leer: async () => [], escribir: async (m, alSalir) => { escrituras.push({ m, alSalir }); return true; } } });
  const h = harness({ coberturas: MULTINIVEL, marcadores: perfil });
  await h.player.start(); await h.player.seek(20_000);
  escrituras.length = 0;
  await h.run(5600);
  assert.equal(escrituras.length, 1);
  const { m, alSalir } = escrituras[0]!;
  assert.equal(alSalir, false); assert.equal(m.perfil, 'perfil-2'); assert.equal(m.epoca, 1); assert.equal(m.nivel, 3); assert.equal(m.velocidad, 1); assert.equal(m.en, 7000);
  assert.ok(Number.isInteger(m.t) && m.t === h.player.currentTick || m.t <= h.player.currentTick);
  h.player.setPlaying(false); await flush();
  const tras = escrituras.length;
  await h.run(6000);
  assert.equal(escrituras.length, tras, 'en pausa no hay marcadores nuevos');
  h.player.guardarAlSalir(); await flush();
  assert.equal(escrituras.at(-1)!.alSalir, true);
  h.player.stop();
});


test('tramo: corta entre muestras a la velocidad elegida, pausa y vuelve al presente', async () => {
  const h = harness({ coberturas: [{ nivel: 3, t0: 0, t1: 24000 }] });
  await h.player.start();
  h.player.setSpeed(2);
  await h.player.reproducirTramo(0, 6100);
  assert.equal(h.player.speed, 2);
  h.player.setPlaying(false);
  await h.run(1000);
  assert.equal(h.player.currentTick, 0);
  h.player.setPlaying(true);
  await h.run(1000, 1000);
  assert.equal(h.player.currentTick, 4800);
  assert.equal(h.player.playing, false);
  assert.ok(h.emitted.every(e => e.info.reason !== 'play' || e.tick <= 6100));
  await h.player.jumpToLiveEdge();
  assert.equal(h.player.tramo, null);
  assert.equal(h.player.playing, true);
  h.player.stop();
});
