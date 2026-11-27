import assert from 'node:assert/strict';
import { DvrPlayer } from '../src/client/dvr-player.js';
import { test } from 'node:test';
import { fichaMateriales, inheritedAndLearned, meter } from '../src/client/inspector-view.js';
import {
  DetalleCinta, ETIQUETA_DETALLE, TEXTO_AUSENTE, TEXTO_BUSCANDO, TEXTO_PAUSA, TEXTO_RED,
  claveDetalle, juzgarL0, pedidoChunk, personaDeDetalleExactoParaContexto, personaYaCompleta,
  sePuedePedir, ventanaMinima, type ContextoDetalle,
} from '../src/client/detalle-cinta.js';
import { renderPersonTelemetry } from '../src/client/telemetry-hud.js';
import type { ChunkResp } from '../src/shared/cinta.js';
import type { TapeClientDelta } from '../src/shared/tape-delta.js';
import type { PersonView, WorldView } from '../src/shared/types.js';

/** Lo que `renderInspector` ya hace con la persona: necesidades, telemetría y ficha heredada. */
function panel(p: PersonView): string {
  const world = { version: 1, sequence: 1, tick: 12, day: 1, phase: 'day', weather: 'clear', width: 4, height: 4, tiles: [], people: [p], places: [], events: [], memories: [] } as WorldView;
  const sections = inheritedAndLearned({ ...p, working: false }, world, undefined, undefined, () => undefined, [], { repertorio: 'no-grabado' });
  return `<div class="game-needs">${meter('Energía', p.energy)}${meter('Hambre', p.hunger)}${p.thirst === undefined ? '' : meter('Sed', p.thirst)}${meter('Cansancio', p.fatigue)}</div>${renderPersonTelemetry(p)}${fichaMateriales(p)}${sections.now}${sections.kit}`;
}

function persona(id: string, extra: Partial<PersonView> = {}): PersonView {
  return {
    name: 'Ana', role: 'neighbor', x: 3.2, y: 4.8, color: '#a4805b', action: 'rest', reason: 'descansa',
    energy: 0.2, hunger: 0.4, fatigue: 0.33, need: 'Descanso', recentMemory: null, thirst: 0.15, health: 0.9, vitality: 0.8, age: 120,
    genome: { generation: 3, parents: [], learningRate: 0.5, cooperation: 0.4, mutations: 1 },
    materials: { wood: 4, stone: 2 }, foodReserve: 1.5, foodReserveCapacity: 3, skills: { farm: 0.5 },
    culture: { sharing: 0.7, stewardship: 0.2, openness: 0.1 }, escucha: 0.42,
    cuerpoVisto: { masa: 60, masaAdulta: 70, reserva: 0.5, agua: 0.6, digestivo: 0.1, carga: 0, T: 310, principal: 1 },
    tecnicaVista: { recetas: [{ id: 7, generacion: 1, usada: 10, padres: [] }], omitidas: 0, proceso: null, intentos: 2 },
    ...extra, id,
  };
}

const exacta = persona('ana', { energy: 0.87, hunger: 0 });
const resumida = persona('ana', {
  energy: undefined, hunger: undefined, thirst: undefined, fatigue: undefined, health: undefined, vitality: undefined,
  age: undefined, genome: undefined, materials: undefined, skills: undefined, culture: undefined, escucha: undefined,
  cuerpoVisto: undefined, tecnicaVista: undefined, foodReserve: undefined, foodReserveCapacity: undefined,
});

function marco(tick: number, people: PersonView[]): WorldView {
  return { version: 1, sequence: tick, tick, day: 1, phase: 'day', weather: 'clear', width: 4, height: 4, tiles: [], people, places: [], events: [], memories: [] };
}
function delta(tick: number, peoplePatch: TapeClientDelta['peoplePatch']): TapeClientDelta {
  return { tick, sequence: tick, day: 1, phase: 'day', weather: 'clear', peoplePatch };
}
function trozo(extra: Partial<ChunkResp> = {}): ChunkResp {
  return { nivel: 0, paso: 1, epoca: 1, t0: 0, t1: 40, hayMas: false, deltas: [], baseFrame: marco(12, [exacta]), ...extra };
}
function contexto(partial: Partial<ContextoDetalle> = {}): ContextoDetalle {
  return {
    id: 'ana', x: 3.2, y: 4.8, tick: 12, cabezal: 12, epoca: 1, nivel: 1, completa: false,
    niveles: [{ nivel: 0, t0: 0, t1: 40, fotogramas: 8 }, { nivel: 1, t0: 0, t1: 40, fotogramas: 4 }],
    ...partial,
  };
}

function nodo(): { el: HTMLElement; html: () => string; focos: () => number; dentro: (v: boolean) => void } {
  let html = '', focos = 0, dentro = false;
  const marca = {} as Node;
  const el = {
    hidden: true,
    ownerDocument: { get activeElement() { return dentro ? marca : null; } },
    contains: (n: Node) => n === marca,
    querySelector: () => ({ focus: () => { focos++; } }),
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; },
  };
  return { el: el as unknown as HTMLElement, html: () => html, focos: () => focos, dentro: v => { dentro = v; } };
}

test('el pedido es 1×1 en L0 y no se ofrece si el instante ya está completo o el cabezal no coincide', () => {
  const pedido = pedidoChunk(contexto());
  assert.deepEqual(pedido, { n: 1, nivel: 0, epoca: 1, t: 12, x: 3, y: 4, w: 1, h: 1 });
  assert.equal(ventanaMinima(3.2, 4.8)?.w, 1);
  assert.equal(ventanaMinima(Number.NaN, 1), null);
  assert.equal(sePuedePedir(contexto({ nivel: 0 })), false);
  assert.equal(sePuedePedir(contexto({ completa: true })), false);
  assert.equal(sePuedePedir(contexto({ cabezal: 11 })), false);
  assert.equal(personaYaCompleta(resumida), false);
  assert.equal(personaYaCompleta(exacta), true);
  assert.equal(claveDetalle({ epoca: 1, tick: 12, id: 'ana' }), '1:12:ana');
});

test('juzgar L0 devuelve el PersonView íntegro y solo aplica un delta del mismo trozo si da el tick exacto', () => {
  const base = juzgarL0(trozo(), { epoca: 1, tick: 12, id: 'ana' });
  assert.equal(base.ok && base.persona, exacta);
  const posterior = delta(13, { upserts: [{ id: 'ana', _p: 1, energy: 0.1, hunger: 1 }], removed: [] });
  const quieto = juzgarL0(trozo({ deltas: [posterior] }), { epoca: 1, tick: 12, id: 'ana' });
  assert.equal(quieto.ok && quieto.persona, exacta, 'un delta posterior no pisa el tick del baseFrame');

  const previa = persona('ana', { energy: 0.2, hunger: 0.4 });
  const salto = delta(12, { upserts: [{ id: 'ana', _p: 1, energy: 0.87, hunger: 0 }], removed: [] });
  const llegado = juzgarL0(trozo({ baseFrame: marco(10, [previa, persona('otra', { energy: 0.87 })]), deltas: [salto] }), { epoca: 1, tick: 12, id: 'ana' });
  assert.equal(llegado.ok, true);
  if (!llegado.ok) return;
  assert.equal(llegado.persona.id, 'ana');
  assert.equal(llegado.persona.energy, 0.87);
  assert.equal(llegado.persona.hunger, 0);
  assert.equal(llegado.persona.fatigue, previa.fatigue);
  assert.equal(llegado.persona.thirst, previa.thirst);
  assert.equal(llegado.persona.vitality, previa.vitality);
  assert.equal(llegado.persona.genome, previa.genome);
  assert.equal(llegado.persona.materials, previa.materials);
  assert.equal(llegado.persona.cuerpoVisto, previa.cuerpoVisto);
  assert.equal(llegado.persona.escucha, previa.escucha);
  assert.equal(llegado.persona.tecnicaVista, previa.tecnicaVista);
  assert.equal(llegado.persona.skills, previa.skills);
  assert.equal(llegado.persona.culture, previa.culture);
  assert.notEqual(llegado.persona, persona('otra'));

  const cadena = juzgarL0(trozo({
    baseFrame: marco(10, [previa]),
    deltas: [delta(11, { upserts: [{ id: 'ana', _p: 1, fatigue: 0.5 }], removed: [] }), salto],
  }), { epoca: 1, tick: 12, id: 'ana' });
  assert.equal(cadena.ok && cadena.persona.energy, 0.87);
  assert.equal(cadena.ok && cadena.persona.fatigue, 0.5);

  assert.deepEqual(juzgarL0(trozo({ baseFrame: marco(11, [exacta]), deltas: [] }), { epoca: 1, tick: 12, id: 'ana' }), { ok: false, motivo: 'cercano' });
  assert.deepEqual(juzgarL0(trozo({ nivel: 1 }), { epoca: 1, tick: 12, id: 'ana' }), { ok: false, motivo: 'nivel' });
  assert.deepEqual(juzgarL0(trozo({ epoca: 4 }), { epoca: 1, tick: 12, id: 'ana' }), { ok: false, motivo: 'epoca' });
  assert.deepEqual(juzgarL0(trozo({ baseFrame: undefined }), { epoca: 1, tick: 12, id: 'ana' }), { ok: false, motivo: 'podado' });
  assert.deepEqual(juzgarL0(trozo(), { epoca: 1, tick: 12, id: 'otra' }), { ok: false, motivo: 'ausente' });
  const quitada = juzgarL0(trozo({ baseFrame: marco(10, [previa]), deltas: [delta(12, { upserts: [], removed: ['ana'] })] }), { epoca: 1, tick: 12, id: 'ana' });
  assert.deepEqual(quitada, { ok: false, motivo: 'ausente' });
  const roto = juzgarL0(trozo({
    baseFrame: marco(10, [previa]),
    deltas: [{ tick: 12, sequence: 12, day: 1, phase: 'day', weather: 'clear', peoplePatch: { upserts: [], removed: undefined as unknown as string[] } }],
  }), { epoca: 1, tick: 12, id: 'ana' });
  assert.deepEqual(roto, { ok: false, motivo: 'cercano' });
});

test('el mismo panel pinta la ficha existente con el L0 exacto y, si no se conserva, solo lo conocido', async () => {
  let actual = contexto();
  let cambios = 0;
  const ui = nodo();
  const cinta = new DetalleCinta({
    pedir: async () => trozo(),
    pausar: () => true,
    contexto: () => actual,
    avisar: () => {},
    alCambiar: () => { cambios++; cinta.sincronizar(ui.el); },
  });
  cinta.sincronizar(ui.el);
  assert.equal(personaDeDetalleExactoParaContexto(cinta, actual), null);
  assert.match(ui.html(), new RegExp(ETIQUETA_DETALLE));
  assert.doesNotMatch(ui.html(), /sin dato|Energía|<dl/);
  await cinta.ver();
  const precisa = personaDeDetalleExactoParaContexto(cinta, actual);
  assert.equal(precisa, exacta);
  assert.equal(cambios, 1);
  const ficha = panel(precisa!);
  assert.match(ficha, /aria-label="Energía"[^>]*>87%/);
  assert.match(ficha, /aria-label="Hambre"[^>]*>0%/);
  assert.match(ficha, /aria-label="Sed"/);
  assert.match(ficha, /aria-label="Cansancio"/);
  assert.match(ficha, /Salud<strong>90%/);
  assert.match(ficha, /Vitalidad<strong>80%/);
  assert.match(ficha, /Edad<strong>120 pasos/);
  assert.match(ficha, /Gen<strong>G3/);
  assert.match(ficha, /Madera<strong>4/);
  assert.match(ficha, /Piedra<strong>2/);
  assert.match(ficha, /data-material="wood"/);
  assert.match(ficha, /data-cuerpo-ficha="ok"/);
  assert.match(ficha, /data-escucha="0\.42"/);
  assert.match(ficha, /data-receta="7"/);
  assert.match(ficha, /Cultivo/);
  assert.match(ficha, /Compartir/);
  assert.doesNotMatch(ui.html(), /87%|sin dato|<dl/);
  assert.equal((ui.html().match(/drawer-note/g) ?? []).length, 0);

  actual = contexto({ epoca: 2, tick: 12, cabezal: 12 });
  cinta.sincronizar(ui.el);
  assert.equal(personaDeDetalleExactoParaContexto(cinta, actual), null);
  assert.equal(personaDeDetalleExactoParaContexto(cinta, contexto()), null);
  const conocida = panel(resumida);
  assert.match(conocida, /data-meter="no-grabado"/);
  assert.doesNotMatch(conocida, /87%/);
  assert.doesNotMatch(conocida, /aria-label="Sed"/);
});

test('fallo y carga son una sola nota; no hay pedido automático, la caché cabe 4 y abortar no presta el resultado', async () => {
  let actual = contexto();
  const avisos: string[] = [];
  let senal: AbortSignal | undefined;
  let resolver: ((chunk: ChunkResp) => void) | undefined;
  let llamadas = 0;
  const ui = nodo();
  const cinta = new DetalleCinta({
    pedir: (_req, signal) => {
      llamadas++;
      senal = signal;
      return new Promise(resolve => { resolver = resolve; });
    },
    pausar: () => { cinta.sincronizar(ui.el); return true; },
    contexto: () => actual,
    avisar: texto => avisos.push(texto),
  });
  cinta.sincronizar(ui.el);
  assert.equal(llamadas, 0);
  ui.dentro(true);
  const vuelo = cinta.ver();
  assert.equal(llamadas, 1);
  assert.deepEqual(avisos, [TEXTO_PAUSA]);
  assert.equal(ui.focos(), 1);
  assert.match(ui.html(), new RegExp(TEXTO_BUSCANDO));
  assert.equal((ui.html().match(/drawer-note/g) ?? []).length, 1);
  assert.match(ui.html(), /aria-live="polite"/);
  assert.doesNotMatch(ui.html(), new RegExp(TEXTO_PAUSA));
  assert.equal(senal?.aborted, false);
  cinta.olvidarVista();
  assert.equal(senal?.aborted, true);
  resolver?.(trozo());
  await vuelo;
  assert.equal(personaDeDetalleExactoParaContexto(cinta, actual), null);
  assert.equal(cinta.cacheTamano, 0);

  actual = contexto({ id: 'ana' });
  const cintaRed = new DetalleCinta({
    pedir: async () => { throw new Error('red'); },
    pausar: () => false,
    contexto: () => actual,
  });
  const red = nodo();
  cintaRed.sincronizar(red.el);
  await cintaRed.ver();
  assert.equal((red.html().match(/drawer-note/g) ?? []).length, 1);
  assert.match(red.html(), new RegExp(TEXTO_RED));
  assert.doesNotMatch(red.html(), /sin dato|Energía|<dl/);
  assert.equal(personaDeDetalleExactoParaContexto(cintaRed, actual), null);

  const ids = ['a', 'b', 'c', 'd', 'e'];
  let pedidoId = 'a';
  let extras = 0;
  const host = nodo();
  const cacheada = new DetalleCinta({
    pedir: async () => { extras++; return trozo({ nivel: 1, baseFrame: marco(12, [exacta]) }); },
    pausar: () => false,
    contexto: () => contexto({ id: pedidoId }),
  });
  for (const id of ids) {
    pedidoId = id;
    cacheada.sincronizar(host.el);
    await cacheada.ver();
    assert.match(host.html(), new RegExp(TEXTO_AUSENTE));
    assert.equal((host.html().match(/role="status"/g) ?? []).length, 1);
  }
  assert.equal(extras, 5);
  assert.equal(cacheada.cacheTamano, 4);
  pedidoId = 'e';
  cacheada.sincronizar(host.el);
  await cacheada.ver();
  assert.equal(extras, 5, 'el fallo juzgado se recuerda');
  pedidoId = 'a';
  cacheada.sincronizar(host.el);
  await cacheada.ver();
  assert.equal(extras, 6, 'lo que no cabe en la caché se vuelve a pedir');
  assert.equal(personaDeDetalleExactoParaContexto(cacheada, contexto({ id: 'e' })), null);
});

test('una ficha histórica usa la época del fotograma aunque el catálogo ya esté en otra época', async () => {
  const dvr = new DvrPlayer({
    metaPollMs: 0,
    fetchMeta: async () => ({
      version: 3, estado: 'ok', epoca: 5, t0: 12, t1: 20, hz: 1, bytes: 1, topeBytes: 1000,
      niveles: [{ nivel: 1, paso: 32, t0: 12, t1: 20, bytes: 1, fotogramas: 2 }],
      bifurcaciones: [], lagunas: [], serie: [],
    }),
    fetchChunk: async () => trozo({ nivel: 1, epoca: 3, t0: 12, t1: 12 }),
    onFrame: () => {},
  });
  try {
    assert.equal(await dvr.start(), true);
    assert.equal(dvr.currentTick, 12);
    assert.equal(dvr.epoca, 5);
    assert.equal(dvr.epocaFotograma, 3);
  } finally { dvr.stop(); }
});
