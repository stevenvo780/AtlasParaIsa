/**
 * Reloj del visor. Tiempo real: 1 s de mundo por 1 s de pared, con el día de 2400 ticks (36 s/tick)
 * y el hueco real entre fotogramas. El borde vivo y los ritmos 0,5×…25× siguen disponibles.
 * El recorrido usa el mismo cableado que `startTape` en `game.ts` (barra + reproductor + perfil).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CINTA, type ChunkResp, type CintaMeta, type Nivel } from '../src/shared/cinta.js';
import { PROTOCOL_VERSION, type WorldView } from '../src/shared/types.js';
import {
  DvrPlayer, PerfilCinta, SEGUNDOS_POR_TICK,
  type DvrChunkRequest, type DvrFrameInfo, type DvrState,
} from '../src/client/dvr-player.js';
import { desfaseLabel, horaVisible, mountDvrBar, renderDvrBar, sigueBorde, type DvrBarHandlers } from '../src/client/dvr-bar.js';
import { CadenceEstimator, MotionTracker } from '../src/client/visual-state.js';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function frame(tick: number): WorldView {
  return {
    version: PROTOCOL_VERSION, sequence: tick, tick, day: Math.floor(tick / 2400) + 1, phase: 'day', weather: 'clear',
    width: 2, height: 2, originX: 0, originY: 0,
    tiles: [{ x: 0, y: 0, terrain: 'meadow', food: 0, moisture: 0.5, vegetation: 0.5 }],
    people: [{ id: 'p', name: 'P', role: 'neighbor', x: 0, y: 0, color: '#fff' }],
    animals: [], structures: [], places: [], events: [], memories: [],
  } as unknown as WorldView;
}

interface CintaOpts { t1?: number; hz?: number; pasoReal?: number; nominal?: number; nivel?: Nivel }

function cintaDe(opts: CintaOpts = {}) {
  const nivel = opts.nivel ?? 0;
  const nominal = opts.nominal ?? CINTA.pasos[nivel];
  const pasoReal = opts.pasoReal ?? nominal;
  const fin = { t1: opts.t1 ?? 400 };
  const ticksHasta = (hasta: number): number[] => {
    const ticks: number[] = [];
    for (let t = 0; t <= hasta; t += pasoReal) ticks.push(t);
    return ticks;
  };
  const meta = (): CintaMeta => ({
    version: 3, estado: 'ok', epoca: 1, t0: 0, t1: fin.t1, hz: opts.hz ?? 120, bytes: 1, topeBytes: CINTA.topeBytes,
    niveles: [{ nivel, paso: nominal, t0: 0, t1: fin.t1, bytes: 1, fotogramas: ticksHasta(fin.t1).length }],
    bifurcaciones: [], lagunas: [],
    serie: [{ t: 0, poblacion: 3, nacimientos: 0, muertes: 0, fauna: 0, estructuras: 0, sustancias: 0, hz: opts.hz ?? 120 }],
  });
  const chunk = (req: { t: number; n: number }): ChunkResp => {
    const ticks = ticksHasta(fin.t1);
    let i0 = 0;
    for (let i = 0; i < ticks.length; i++) if (ticks[i]! <= req.t) i0 = i;
    const elegidos = ticks.slice(i0, i0 + Math.max(1, req.n));
    const primero = elegidos[0]!;
    return {
      nivel, paso: nominal, epoca: 1, t0: primero, t1: elegidos.at(-1)!, hayMas: elegidos.at(-1)! < fin.t1,
      baseFrame: frame(primero),
      deltas: elegidos.slice(1).map(t => ({ tick: t, sequence: t, day: frame(t).day, phase: 'day' as const, weather: 'clear' as const })),
    };
  };
  return { meta, chunk, fin };
}

function abrir(opts: CintaOpts & { abrirEnInicio?: boolean; perfil?: PerfilCinta } = {}) {
  const cinta = cintaDe(opts);
  const emitted: { tick: number; info: DvrFrameInfo }[] = [];
  const states: DvrState[] = [];
  const player = new DvrPlayer({
    metaPollMs: 0,
    abrirEnInicio: opts.abrirEnInicio,
    ...(opts.perfil ? { marcadores: opts.perfil } : {}),
    fetchMeta: async () => cinta.meta(),
    fetchChunk: async (req: DvrChunkRequest) => cinta.chunk(req),
    onFrame: (vista, info) => { emitted.push({ tick: vista.tick, info }); },
    onStateChange: state => { states.push(state); },
  });
  return { cinta, player, emitted, states, fin: cinta.fin };
}

/** `ms` de pared en pasos ≤ 100 ms: el tope del reloj no se traga el tiempo que sí queremos contar. */
function bombear(player: DvrPlayer, ms: number, paso: number, desde = 0): number {
  let now = desde;
  player.advance(now);
  for (let hecho = 0; hecho < ms; hecho += paso) {
    now += Math.min(paso, ms - hecho);
    player.advance(now);
  }
  return now;
}

const mundo = (ticks: number): number => ticks * SEGUNDOS_POR_TICK;

test('el contrato del día es 2400 ticks y 36 s por tick', () => {
  assert.equal(SEGUNDOS_POR_TICK, 36);
  assert.equal(86_400 / 2400, 36);
});

test('el arranque muestra un fotograma de la historia ya, en tiempo real, sin enganchar el borde', async () => {
  const h = abrir({ t1: 400 });
  assert.equal(await h.player.start(), true);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]!.info.reason, 'start');
  assert.equal(h.player.modoReloj, 'tiempo-real');
  assert.equal(h.player.currentTick, 336);
  assert.equal(h.player.atLiveEdge, false);
  assert.ok(h.player.aheadOfPlayhead > 60);
  h.player.stop();
});

test('1 s de pared avanza 1 s de mundo, con cualquier paso, Hz o tamaño de fotograma de monitor', async () => {
  for (const hz of [1, 120, 4000]) {
    for (const pasoMonitor of [10, 16, 50, 100]) {
      for (const nivel of [0, 3] as const) {
        const h = abrir({ hz, nivel, t1: nivel === 0 ? 400 : 48_000 });
        await h.player.start();
        await h.player.seek(0);
        const antes = h.player.playTick;
        h.emitted.length = 0;
        bombear(h.player, 10_000, pasoMonitor);
        const ticks = h.player.playTick - antes;
        assert.ok(Math.abs(mundo(ticks) - 10) < 1e-4, `hz ${hz} nivel ${nivel} paso ${pasoMonitor}: ${mundo(ticks)} s`);
        assert.equal(h.emitted.filter(e => e.info.reason === 'play').length, 0, '10 s no cruzan un fotograma');
        assert.equal(h.player.simHz, hz);
        h.player.stop();
      }
    }
  }
});

test('el hueco real entre fotogramas manda, no el paso nominal ni 6 fps', async () => {
  const h = abrir({ pasoReal: 8, nominal: 4, t1: 80 });
  await h.player.start();
  await h.player.seek(0);
  h.emitted.length = 0;
  bombear(h.player, 1000, 100);
  assert.equal(h.emitted.filter(e => e.info.reason === 'play').length, 0, '1 s de pared no es un fotograma');
  bombear(h.player, 8 * SEGUNDOS_POR_TICK * 1000 + 500 - 1000, 100, 1000);
  const plays = h.emitted.filter(e => e.info.reason === 'play');
  assert.deepEqual(plays.map(e => e.tick), [8]);
  assert.ok(h.player.playTick - 8 < 0.02, 'la fracción que sobra del tick se conserva');
  h.player.stop();
});

test('con la pestaña visible, 200 ms y 500 ms acumulan lo mismo que 60 Hz', async () => {
  for (const modo of ['tiempo-real', 'paseo'] as const) {
    const deltas: number[] = [];
    for (const paso of [1000 / 60, 200, 500]) {
      const h = abrir({ t1: 4_800, nivel: 3 });
      await h.player.start();
      await h.player.seek(0);
      if (modo === 'paseo') h.player.entrarEnPaseo();
      const antes = h.player.playTick;
      bombear(h.player, 10_000, paso);
      deltas.push(h.player.playTick - antes);
      h.player.stop();
    }
    const esperado = modo === 'paseo' ? 10 : 10 / SEGUNDOS_POR_TICK;
    for (const delta of deltas) assert.ok(Math.abs(delta - esperado) < 1e-4, `${modo} ${delta} frente a ${esperado}`);
    assert.ok(Math.abs(deltas[0]! - deltas[1]!) < 1e-4 && Math.abs(deltas[0]! - deltas[2]!) < 1e-4);
  }
});

test('ocultar la pestaña y volver no salta; el reloj visible sigue después', async () => {
  for (const modo of ['tiempo-real', 'paseo'] as const) {
    const h = abrir();
    await h.player.start();
    await h.player.seek(0);
    if (modo === 'paseo') h.player.entrarEnPaseo();
    const now = bombear(h.player, 2_000, 200);
    const antes = h.player.playTick;
    h.player.setPaginaVisible(false);
    h.player.advance(now + 60_000);
    assert.equal(h.player.playTick, antes, `${modo}: la suspensión no cuenta`);
    h.player.setPaginaVisible(true);
    h.player.advance(now + 60_000);
    assert.equal(h.player.playTick, antes, `${modo}: la reactivación no salta`);
    bombear(h.player, 1_000, 200, now + 60_000);
    const seguido = modo === 'paseo' ? 1 : 1 / SEGUNDOS_POR_TICK;
    assert.ok(Math.abs(h.player.playTick - antes - seguido) < 1e-4, modo);
    h.player.stop();
  }
});

test('Paseo avanza un tick por segundo en cualquier nivel y una foto cada 4 s en detalle', async () => {
  const detalle = abrir({ pasoReal: 4, nominal: 4, t1: 80 });
  await detalle.player.start();
  await detalle.player.seek(0);
  detalle.player.entrarEnPaseo();
  detalle.emitted.length = 0;
  bombear(detalle.player, 4_000, 200);
  assert.deepEqual(detalle.emitted.filter(e => e.info.reason === 'play').map(e => e.tick), [4]);
  assert.equal(detalle.player.tickIntervalMs, 4_000);
  const diario = abrir({ nivel: 3, t1: 48_000 });
  await diario.player.start();
  await diario.player.seek(0);
  diario.player.entrarEnPaseo();
  const antes = diario.player.playTick;
  diario.emitted.length = 0;
  bombear(diario.player, 4_000, 500);
  assert.equal(diario.emitted.filter(e => e.info.reason === 'play').length, 0, 'L3 no fabrica fotogramas');
  assert.ok(Math.abs(diario.player.playTick - antes - 4) < 1e-4, 'la cadencia es 1 tick/s también en L3');
  const hueco = abrir({ pasoReal: 8, nominal: 4, t1: 80 });
  await hueco.player.start();
  await hueco.player.seek(0);
  hueco.player.entrarEnPaseo();
  hueco.emitted.length = 0;
  bombear(hueco.player, 4_000, 200);
  assert.equal(hueco.emitted.filter(e => e.info.reason === 'play').length, 0, 'un hueco de 8 ticks no se rellena a los 4 s');
  bombear(hueco.player, 4_000, 200, 4_000);
  assert.deepEqual(hueco.emitted.filter(e => e.info.reason === 'play').map(e => e.tick), [8]);
  detalle.player.stop(); diario.player.stop(); hueco.player.stop();
});

test('buscar, cambiar de nivel y el primer fotograma no esperan al hueco entre fotogramas', async () => {
  const h = abrir({ t1: 4_800 });
  const t0 = Date.now();
  await h.player.start();
  assert.ok(Date.now() - t0 < 1000, 'el arranque no espera un tick de 36 s');
  h.emitted.length = 0;
  await h.player.seek(80);
  assert.equal(h.emitted.at(-1)!.tick, 80);
  assert.equal(h.emitted.at(-1)!.info.reason, 'seek');
  await h.player.setNivel(0);
  assert.equal(h.player.currentTick, 80);
  h.player.stop();
});

test('0,5× sigue siendo el ritmo de fotogramas y es mucho más rápido que el tiempo real', async () => {
  const real = abrir();
  await real.player.start();
  await real.player.seek(0);
  real.emitted.length = 0;
  bombear(real.player, 2100, 20);
  assert.equal(real.emitted.filter(e => e.info.reason === 'play').length, 0);
  assert.ok(Math.abs(mundo(real.player.playTick) - 2.1) < 1e-3);

  const ritmo = abrir();
  await ritmo.player.start();
  await ritmo.player.seek(0);
  ritmo.player.setSpeed(0.5);
  ritmo.emitted.length = 0;
  bombear(ritmo.player, 2100, 20);
  const cruzados = ritmo.emitted.filter(e => e.info.reason === 'play');
  const fotogramas = cruzados.length + cruzados.reduce((s, e) => s + e.info.skipped, 0);
  assert.equal(fotogramas, Math.floor(CINTA.fpsNormal * 0.5 * 2.1));
  assert.ok(ritmo.player.currentTick - 0 >= 4, '0,5× ya cruzó fotogramas que el tiempo real no toca');
  real.player.stop(); ritmo.player.stop();
});

test('el borde vivo es optativo, un solo salto si la cinta se fue lejos, y buscar lo suelta', async () => {
  const h = abrir({ t1: 400 });
  await h.player.start();
  await h.player.jumpToLiveEdge();
  assert.equal(h.player.modoReloj, 'borde-vivo');
  assert.equal(h.player.atLiveEdge, true);
  h.fin.t1 = 20_000;
  await h.player.pollMeta();
  await flush();
  // La cinta creció miles de ticks. Un avance no repasa los fotogramas intermedios.
  h.emitted.length = 0;
  h.player.advance(0);
  h.player.advance(50);
  for (let i = 0; i < 6; i++) await flush();
  assert.ok(h.emitted.length <= 3, `saltos: ${h.emitted.map(e => e.tick).join(',')}`);
  assert.ok(h.emitted.length >= 1);
  await h.player.seek(40);
  assert.equal(h.player.modoReloj, 'tiempo-real');
  assert.equal(h.player.currentTick, 40);
  h.player.advance(100);
  h.player.advance(200);
  assert.equal(h.player.modoReloj, 'tiempo-real');
  assert.equal(h.player.currentTick, 40);
  h.player.stop();
});

test('el modo se restaura: ritmo, tiempo real y borde vivo, cada uno en su sitio', async () => {
  const datos = new Map<string, string>();
  const almacen = { getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v); } };
  const red = { leer: async () => [] as [], escribir: async () => true };
  const perfil = new PerfilCinta({ almacen, uuid: () => 'reloj', ahora: () => 50, red });
  const primero = abrir({ perfil, t1: 400 });
  await primero.player.start();
  await primero.player.seek(80);
  primero.player.setSpeed(0.5);
  await flush();
  primero.player.stop();

  const ritmo = abrir({ perfil: new PerfilCinta({ almacen, uuid: () => 'reloj', ahora: () => 60, red }), t1: 400 });
  await ritmo.player.start();
  assert.equal(ritmo.player.modoReloj, 'ritmo');
  assert.equal(ritmo.player.speed, 0.5);
  assert.equal(ritmo.player.currentTick, 80);
  assert.equal(ritmo.player.atLiveEdge, false);
  ritmo.player.entrarEnTiempoReal();
  await flush();
  ritmo.player.stop();

  const real = abrir({ perfil: new PerfilCinta({ almacen, uuid: () => 'reloj', ahora: () => 70, red }), t1: 400 });
  await real.player.start();
  assert.equal(real.player.modoReloj, 'tiempo-real');
  assert.equal(real.player.currentTick, 80);
  await real.player.jumpToLiveEdge();
  await flush();
  real.player.stop();

  const borde = abrir({ perfil: new PerfilCinta({ almacen, uuid: () => 'reloj', ahora: () => 80, red }), t1: 400 });
  await borde.player.start();
  assert.equal(borde.player.modoReloj, 'borde-vivo');
  assert.equal(borde.player.atLiveEdge, true);
  borde.player.stop();
});

test('archivo: abre pausado en el origen, a ritmo 1×, y el último fotograma no sigue un borde vivo', async () => {
  const h = abrir({ abrirEnInicio: true, t1: 80 });
  await h.player.start();
  assert.equal(h.player.playing, false);
  assert.equal(h.player.currentTick, 0);
  assert.equal(h.player.modoReloj, 'ritmo');
  assert.equal(h.player.speed, 1);
  await h.player.jumpToLiveEdge();
  assert.equal(h.player.playing, false);
  assert.equal(h.player.currentTick, 80);
  assert.equal(h.player.modoReloj, 'ritmo');
  h.player.stop();
});

class Boton {
  constructor(private readonly attributes: Record<string, string>) {}
  hasAttribute(name: string): boolean { return name in this.attributes; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  closest(selector: string): Boton | null { return selector === 'button' ? this : null; }
}
class Caja {
  innerHTML = '';
  listeners = new Map<string, (event: unknown) => void>();
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  querySelector(): null { return null; }
  contains(): boolean { return true; }
  click(attributes: Record<string, string>): void { this.listeners.get('click')!({ target: new Boton(attributes) }); }
}

test('recorrido desde el cableado de startTape: tiempo real, 0,5×, borde vivo, scrub y reloj visible', async () => {
  const cinta = cintaDe({ t1: 400, hz: 2500 });
  const emitted: { tick: number; info: DvrFrameInfo }[] = [];
  const caja = new Caja();
  let player!: DvrPlayer;
  let borde: Promise<unknown> = Promise.resolve();
  const handlers: DvrBarHandlers = {
    togglePlay: () => player.togglePlaying(),
    step: delta => void player.step(delta),
    setSpeed: speed => player.setSpeed(speed),
    setTiempoReal: () => player.entrarEnTiempoReal(),
    setPaseo: () => player.entrarEnPaseo(),
    seek: tick => void player.seek(tick),
    jumpLive: () => { borde = player.jumpToLiveEdge(); },
  };
  const barra = mountDvrBar(caja as unknown as HTMLElement, handlers);
  player = new DvrPlayer({
    metaPollMs: 0,
    fetchMeta: async () => cinta.meta(),
    fetchChunk: async req => cinta.chunk(req),
    onFrame: (vista, info) => { emitted.push({ tick: vista.tick, info }); },
    onStateChange: state => { barra.update({ ...state, archivo: false }); },
  });
  assert.equal(await player.start(), true);
  assert.match(caja.innerHTML, /data-dvr-tiempo-real aria-pressed="true"/);
  assert.match(caja.innerHTML, /1 s = 1 s de mundo/);
  assert.match(caja.innerHTML, /cada tick son 36 s · el terreno espera/);
  caja.click({ 'data-dvr-paseo': '' });
  assert.equal(player.modoReloj, 'paseo');
  assert.match(caja.innerHTML, /data-dvr-paseo aria-pressed="true"/);
  assert.match(caja.innerHTML, /fotograma cada 4 s/);
  caja.click({ 'data-dvr-tiempo-real': '' });
  assert.match(caja.innerHTML, />Borde vivo</);
  assert.equal(player.modoReloj, 'tiempo-real');
  assert.equal(player.atLiveEdge, false);
  assert.equal(player.currentTick, 336);

  caja.click({ 'data-dvr-speed': '0.5' });
  assert.equal(player.modoReloj, 'ritmo');
  assert.equal(player.speed, 0.5);
  assert.match(caja.innerHTML, /data-dvr-speed="0.5" aria-pressed="true"/);
  assert.match(caja.innerHTML, /data-dvr-tiempo-real aria-pressed="false"/);

  caja.click({ 'data-dvr-tiempo-real': '' });
  assert.equal(player.modoReloj, 'tiempo-real');
  await player.seek(0);
  emitted.length = 0;
  bombear(player, 5000, 100);
  assert.equal(emitted.filter(e => e.info.reason === 'play').length, 0);
  assert.match(horaVisible(player.snapshot()), /00:00:0[45]/);
  assert.match(caja.innerHTML, /00:00:0[45]/);

  caja.click({ 'data-dvr-live': '' });
  await borde;
  assert.equal(player.modoReloj, 'borde-vivo');
  assert.equal(player.atLiveEdge, true);
  assert.match(caja.innerHTML, /Borde vivo · la imagen sigue el presente/);

  const attrs: Record<string, string> = {};
  caja.listeners.get('input')!({
    target: { value: '40', hasAttribute: (name: string) => name === 'data-dvr-range', setAttribute: (name: string, value: string) => { attrs[name] = value; } },
  });
  assert.equal(attrs['aria-valuetext'], horaVisible({ currentTick: 40, modoReloj: 'borde-vivo' }));
  await player.seek(40);
  assert.equal(player.currentTick, 40);
  assert.equal(player.modoReloj, 'tiempo-real');
  player.stop();
  barra.destroy();
});

test('Paseo se restaura en el mismo tick, sin pasar al borde vivo', async () => {
  const datos = new Map<string, string>();
  const almacen = { getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v); } };
  const red = { leer: async () => [] as [], escribir: async () => true };
  const perfil = new PerfilCinta({ almacen, uuid: () => 'paseo', ahora: () => 10, red });
  const primero = abrir({ perfil, t1: 400 });
  await primero.player.start();
  await primero.player.seek(40);
  primero.player.entrarEnPaseo();
  await flush();
  primero.player.stop();
  const segundo = abrir({ perfil: new PerfilCinta({ almacen, uuid: () => 'paseo', ahora: () => 20, red }), t1: 400 });
  await segundo.player.start();
  assert.equal(segundo.player.modoReloj, 'paseo');
  assert.equal(segundo.player.currentTick, 40);
  assert.equal(segundo.player.atLiveEdge, false);
  segundo.player.stop();
});

class NodoBarra {
  tag = '';
  attrs: Record<string, string> = {};
  children: NodoBarra[] = [];
  text = '';
  style = { left: '' };
  value = '';
  min = '';
  max = '';
  get textContent(): string { return this.text; }
  set textContent(valor: string) { this.text = valor; }
  get classList() {
    const nodo = this;
    return { toggle(token: string, force?: boolean): void {
      const clases = new Set((nodo.attrs.class ?? '').split(/\s+/).filter(Boolean));
      if (force ?? !clases.has(token)) clases.add(token); else clases.delete(token);
      nodo.attrs.class = [...clases].join(' ');
    } };
  }
  getAttribute(nombre: string): string | null { return this.attrs[nombre] ?? null; }
  setAttribute(nombre: string, valor: string): void {
    this.attrs[nombre] = valor;
    if (nombre === 'value') this.value = valor;
  }
  querySelector(sel: string): NodoBarra | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): NodoBarra[] {
    const sale: NodoBarra[] = [];
    const visita = (nodo: NodoBarra, raiz: boolean): void => {
      if (!raiz && coincideBarra(nodo, sel)) sale.push(nodo);
      for (const hijo of nodo.children) visita(hijo, false);
    };
    visita(this, true);
    return sale;
  }
}
function coincideBarra(nodo: NodoBarra, sel: string): boolean {
  if (sel.startsWith('.')) return (nodo.attrs.class ?? '').split(/\s+/).includes(sel.slice(1));
  const attr = /^\[([^\]]+)\]$/.exec(sel);
  return !!attr && attr[1]! in nodo.attrs;
}
function analizarBarra(html: string): NodoBarra {
  const raiz = new NodoBarra();
  const pila = [raiz];
  const re = /<\/([a-zA-Z0-9]+)>|<([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let encontrado: RegExpExecArray | null;
  while ((encontrado = re.exec(html))) {
    if (encontrado[1]) {
      while (pila.length > 1 && pila.at(-1)!.tag !== encontrado[1]) pila.pop();
      if (pila.length > 1) pila.pop();
    } else if (encontrado[2]) {
      const nodo = new NodoBarra();
      nodo.tag = encontrado[2];
      for (const attr of (encontrado[3] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) nodo.attrs[attr[1]!] = attr[2] ?? '';
      pila.at(-1)!.children.push(nodo);
      if (encontrado[4] !== '/' && !['input', 'br', 'img', 'path', 'line', 'rect'].includes(nodo.tag)) pila.push(nodo);
    } else if (encontrado[5]?.trim()) pila.at(-1)!.text += encontrado[5].trim();
  }
  return raiz;
}
class CajaIncremental {
  private raiz = new NodoBarra();
  listeners = new Map<string, (event: unknown) => void>();
  set innerHTML(html: string) { this.raiz = analizarBarra(html); }
  get innerHTML(): string { return ''; }
  querySelector(sel: string): NodoBarra | null { return this.raiz.querySelector(sel); }
  querySelectorAll(sel: string): NodoBarra[] { return this.raiz.querySelectorAll(sel); }
  addEventListener(tipo: string, listener: (event: unknown) => void): void { this.listeners.set(tipo, listener); }
  removeEventListener(tipo: string): void { this.listeners.delete(tipo); }
  contains(): boolean { return true; }
}

test('cinta de 16 ticks: Tiempo real no pulsa Borde vivo; elegirlo y volver sí, en el HTML y al actualizar', async () => {
  const cinta = cintaDe({ t1: 16, pasoReal: 4 });
  const caja = new CajaIncremental();
  let player!: DvrPlayer;
  const barra = mountDvrBar(caja as unknown as HTMLElement, {
    togglePlay: () => player.togglePlaying(),
    step: delta => void player.step(delta),
    setSpeed: speed => player.setSpeed(speed),
    setTiempoReal: () => player.entrarEnTiempoReal(),
    setPaseo: () => player.entrarEnPaseo(),
    seek: tick => void player.seek(tick),
    jumpLive: () => void player.jumpToLiveEdge(),
  });
  player = new DvrPlayer({
    metaPollMs: 0,
    fetchMeta: async () => cinta.meta(),
    fetchChunk: async req => cinta.chunk(req),
    onFrame: () => undefined,
    onStateChange: state => { barra.update({ ...state, archivo: false }); },
  });
  await player.start();
  assert.equal(player.currentTick, 0);
  assert.equal(player.maxTick, 16);
  assert.equal(player.modoReloj, 'tiempo-real');
  assert.equal(player.atLiveEdge, true, 'la cinta entera cabe en el margen, pero eso no es el modo');
  const vivo = () => caja.querySelector('[data-dvr-live]')!;
  const pintado = renderDvrBar({ ...player.snapshot(), archivo: false });
  assert.match(pintado, /class="dvr-live" data-dvr-live aria-pressed="false"/);
  assert.doesNotMatch(pintado, /en el presente/);
  assert.equal(vivo().getAttribute('aria-pressed'), 'false');
  assert.equal(vivo().attrs.class.includes('is-live'), false);
  barra.update({ ...player.snapshot(), archivo: false });
  assert.equal(vivo().getAttribute('aria-pressed'), 'false');
  assert.equal(caja.querySelector('[data-dvr-desfase]')!.textContent, desfaseLabel({ ...player.snapshot(), archivo: false }));
  assert.equal(sigueBorde({ ...player.snapshot(), archivo: false }), false);

  await player.jumpToLiveEdge();
  assert.equal(player.modoReloj, 'borde-vivo');
  barra.update({ ...player.snapshot(), archivo: false });
  assert.equal(vivo().getAttribute('aria-pressed'), 'true');
  assert.equal(vivo().attrs.class.includes('is-live'), true);
  assert.equal(caja.querySelector('[data-dvr-desfase]')!.textContent, 'en el presente');
  assert.match(caja.querySelector('[data-dvr-escala]')!.textContent, /Borde vivo/);
  assert.match(renderDvrBar({ ...player.snapshot(), archivo: false }), /class="dvr-live is-live" data-dvr-live aria-pressed="true"/);

  player.entrarEnTiempoReal();
  barra.update({ ...player.snapshot(), archivo: false });
  assert.equal(player.modoReloj, 'tiempo-real');
  assert.equal(player.atLiveEdge, true);
  assert.equal(vivo().getAttribute('aria-pressed'), 'false');
  assert.equal(vivo().attrs.class.includes('is-live'), false);
  assert.equal(caja.querySelector('[data-dvr-desfase]')!.textContent, 'en la última foto');
  assert.equal(caja.querySelector('[data-dvr-tiempo-real]')!.getAttribute('aria-pressed'), 'true');
  const archivoLejos = renderDvrBar({ ...player.snapshot(), archivo: true, aheadOfPlayhead: 8, atLiveEdge: false, modoReloj: 'ritmo' });
  assert.match(archivoLejos, />Último fotograma</);
  assert.match(archivoLejos, /class="dvr-live" data-dvr-live aria-pressed="false"/);
  assert.match(archivoLejos, /de mundo hasta el final/);
  const archivoFin = renderDvrBar({ ...player.snapshot(), archivo: true, aheadOfPlayhead: 0, atLiveEdge: true, modoReloj: 'ritmo' });
  assert.match(archivoFin, /class="dvr-live is-live" data-dvr-live aria-pressed="true"/);
  assert.match(archivoFin, /Fin de la grabación/);
  player.stop();
  barra.destroy();
});

test('el deslizamiento existente se alarga en un paso corto y no cruza un salto', () => {
  const corto = new MotionTracker(new CadenceEstimator());
  corto.ingest([{ id: 'a', x: 0, y: 0 }], 0);
  corto.ingest([{ id: 'a', x: 1, y: 0 }], 1_000);
  corto.prolongar(4_000, 1_000);
  const medio = corto.sample('a', 3_000);
  assert.ok(medio && medio.x > 0.2 && medio.x < 0.95, `x=${medio?.x}`);
  const lejos = new MotionTracker(new CadenceEstimator());
  lejos.ingest([{ id: 'b', x: 0, y: 0 }], 0);
  lejos.ingest([{ id: 'b', x: 20, y: 0 }], 1_000);
  lejos.prolongar(4_000, 1_000);
  assert.equal(lejos.sample('b', 1_500)?.x, 20);
});
