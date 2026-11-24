import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, projectWorld } from '../src/world/index.js';
import { PROTOCOL_VERSION, type ChronicleEvent, type PersonView, type RuntimeStats, type ServerMessage, type StateDelta, type WorldView } from '../src/shared/types.js';
import { MARCA_POLITICA, decisionFicha, inheritedAndLearned, lecturaDecision, vinculoSI, vinculoSIFicha } from '../src/client/inspector-view.js';
import { comunidadesOrdenadas, divergenciaCultural, ejeDominante, ejesCultura, miembrosNombrados, resumenCultural, ventanaLista } from '../src/client/censo-view.js';
import { fasesMedidas, seccionFases } from '../src/client/rendimiento-view.js';
import { fertilidadFicha } from '../src/client/natalidad-view.js';
import { Connection } from '../src/client/connection.js';
import { rendererProfile } from '../src/client/modo.js';

/* V18 — solo datos que ya viajan en `PersonView`/`WorldView`. En particular: los pesos de
 * `person.policy` y el sesgo de `person.policyPlasticity` NO salen en `projectWorld`; la única
 * señal de la política en el cliente es la marca que la ley deja al final de `reason`. */

function persona(extra: Partial<PersonView> = {}): PersonView {
  return { id: 's', name: 'S', role: 'S', x: 0, y: 0, color: '#a4805b', action: 'drink',
    reason: 'La sed orienta su camino hacia una reserva finita de agua dulce.',
    energy: 0.8, hunger: 0.2, fatigue: 0.1, thirst: 0.6, need: 'Agua dulce', recentMemory: null, ...extra };
}
function mundo(people: PersonView[], extra: Partial<WorldView> = {}): WorldView {
  const tick = extra.tick ?? 5000;
  return { version: PROTOCOL_VERSION, sequence: tick, tick, day: 3, phase: 'day', weather: 'clear',
    width: 40, height: 28, tiles: [], people, places: [], events: [], memories: [], ...extra } as WorldView;
}
const encuentro = (tick: number, actors: string[], text = 'S e I compartieron una pausa.'): ChronicleEvent =>
  ({ id: `e${tick}-${actors.join('-')}`, tick, kind: 'meeting', actors, text, cause: 'Cercanía percibida.', source: 'simulation' });

test('política aprendida: la marca de `reason` separa el empuje aprendido de la causa corporal', () => {
  const base = 'Percibe materiales útiles para cultivar y levantar refugios.';
  const p = persona({ action: 'gather', reason: `${base} ${MARCA_POLITICA}`,
    genome: { generation: 2, parents: [], learningRate: 0.4, cooperation: 0.5, mutations: 1 } });
  const lectura = lecturaDecision(p);
  assert.equal(lectura.inclinadaPorPolitica, true);
  assert.equal(lectura.razonBase, base, 'la razón corporal se muestra sin repetir la marca');
  assert.equal(lectura.distintivo, 'aprendida');
  assert.deepEqual(lectura.presionCorporal, { etiqueta: 'Sed', valor: 0.6 });
  const html = decisionFicha(p, mundo([p]));
  assert.match(html, /Por qué hace esto/);
  assert.match(html, /data-policy="inclinada"/);
  assert.match(html, /inclinó esta elección por encima de la opción que iba primera/);
  assert.match(html, /ese sesgo no pasa a su descendencia/, 'plasticidad Baldwin: adquirida en vida, no heredada');
  assert.match(html, /no se inventa cuánto empujó cada acción/, 'los pesos no viajan: no se finge una cifra');
  assert.ok(!html.startsWith('<details class="person-detail" data-detail="decision" open'), 'cerrado por defecto: no satura el modo ligero');
});

test('sin marca no se afirma política, una orden dirigida manda y la urgencia corporal la apaga', () => {
  const sinMarca = decisionFicha(persona(), mundo([persona()]));
  assert.match(sinMarca, /no consta que su política aprendida la inclinara/);
  assert.match(sinMarca, /no dice que no tenga política/);
  assert.doesNotMatch(sinMarca, /data-policy="inclinada"/);

  const dirigida = lecturaDecision(persona({ controlMode: 'directed' }));
  assert.equal(dirigida.dirigida, true);
  assert.equal(dirigida.distintivo, 'dirigida');
  assert.match(decisionFicha(persona({ controlMode: 'directed' }), mundo([])), /la tarea va por delante de su estrategia aprendida/);

  const urgente = persona({ hunger: 0.9, thirst: undefined });
  assert.equal(lecturaDecision(urgente).urgenciaCorporalSevera, true);
  assert.deepEqual(lecturaDecision(urgente).presionCorporal, { etiqueta: 'Hambre', valor: 0.9 }, 'la sed ausente no se convierte en cero');
  assert.match(decisionFicha(urgente, mundo([])), /esa política ni siquiera participa/);

  const peligro = decisionFicha(persona({ reason: `<img src=x onerror="bad()"> Busca agua. ${MARCA_POLITICA}` }), mundo([]));
  assert.ok(!peligro.includes('<img ') && peligro.includes('&lt;img'), 'la razón recibida nunca entra como HTML');
});

test('una proyección real del mundo alimenta la ficha de decisión y la línea S–I', () => {
  const view = projectWorld(createWorld(51926));
  const s = view.people.find(p => p.role === 'S')!, i = view.people.find(p => p.role === 'I')!;
  assert.ok(s && i, 'la vista inicial trae a S e I en el mismo estado');
  const now = inheritedAndLearned(s, view).now;
  assert.match(now, /data-detail="decision"/);
  assert.match(now, /Por qué hace esto/);
  assert.match(now, /data-vinculo-si/, 'con ambas en el estado recibido sí hay distancia que decir');
  assert.match(now, /S e I están ahora a [\d.,]+ casillas en esta vista/);
  // Privacidad: la decisión sale de `reason` y del cuerpo; ningún texto de `memories` entra en ella.
  for (const memory of view.memories) assert.ok(memory.text === '' || !decisionFicha(s, view).includes(memory.text));
});

test('cultura viva: orden canónico de los tres ejes, dominante y ejes inválidos como ausentes', () => {
  const ejes = ejesCultura({ sharing: 0.38, stewardship: 0.64, openness: 0.81 });
  assert.deepEqual(ejes.map(e => e.clave), ['sharing', 'stewardship', 'openness']);
  assert.deepEqual(ejes.map(e => e.etiqueta), ['Compartir', 'Cuidar el entorno', 'Apertura']);
  assert.equal(ejeDominante({ sharing: 0.38, stewardship: 0.64, openness: 0.81 })!.clave, 'openness');
  assert.equal(ejeDominante({ sharing: 0.5, stewardship: 0.5, openness: 0.2 })!.clave, 'sharing', 'en empate manda el orden canónico');
  const rotos = ejesCultura({ sharing: Number.NaN, stewardship: 1.4, openness: undefined });
  assert.deepEqual(rotos.map(e => e.valor), [null, null, null], 'fuera de rango o ausente: sin dato, nunca cero');
  assert.equal(ejeDominante(undefined), null);
});

test('divergencia cultural: rangos entre comunidades, sin comparar con menos de dos perfiles', () => {
  const comunidades = [
    { culture: { sharing: 0.38, stewardship: 0.64, openness: 0.2 } },
    { culture: { sharing: 0.81, stewardship: 0.64, openness: 0.55 } },
    { culture: { sharing: 0.5, stewardship: Number.NaN, openness: 0.9 } },
  ];
  const d = divergenciaCultural(comunidades)!;
  assert.equal(d.comunidades, 2, 'el perfil incompleto no entra en la comparación');
  assert.deepEqual(d.rangos.map(r => [r.min, r.max]), [[0.38, 0.81], [0.64, 0.64], [0.2, 0.55]]);
  assert.equal(divergenciaCultural(comunidades.slice(0, 1)), null);
  assert.equal(resumenCultural({ communities: [] }), '');
  const html = resumenCultural({ communities: comunidades as WorldView['communities'] });
  assert.match(html, /data-cultural-divergence/);
  assert.match(html, /Compartir<strong>38%–81%<\/strong>/);
  assert.match(html, /promedia la de sus miembros vivos/);
  assert.match(html, /no que estén enfrentadas/);
});

test('comunidades ordenadas por población sin mutar el estado y listas con cota de DOM', () => {
  const entrada = [
    { name: 'Bruma', members: ['a'], memberCount: 3 },
    { name: 'Alba', members: ['a', 'b'], memberCount: 9 },
    { name: 'Ceniza', members: [], memberCount: 9 },
  ];
  assert.deepEqual(comunidadesOrdenadas(entrada).map(c => c.name), ['Alba', 'Ceniza', 'Bruma']);
  assert.deepEqual(entrada.map(c => c.name), ['Bruma', 'Alba', 'Ceniza'], 'el estado recibido no se reordena');
  const ids = Array.from({ length: 350 }, (_, n) => `p${n}`);
  assert.deepEqual(ventanaLista(ids), { visibles: ids.slice(0, 120), restantes: 230 },
    'con 300+ en cuadro la lista crea como mucho 120 filas');
  const nombrados = miembrosNombrados(ids);
  assert.equal(nombrados.nombrados.length, 24);
  assert.equal(nombrados.restantesEnVista, 326);
});

test('vínculo S–I: distancia del mismo estado y último encuentro recibido, sin tocar biografía', () => {
  const s = persona({ id: 's', role: 'S', x: 0, y: 0 });
  const i = persona({ id: 'i', name: 'I', role: 'I', x: 3, y: 4 });
  const secreto = 'TEXTO-PRIVADO-QUE-NO-DEBE-SALIR';
  const view = mundo([s, i], { tick: 5000, memories: [{ id: 'm1', title: secreto, text: secreto, source: 'approved', placeId: 'p1' }] });
  const eventos = [
    encuentro(100, ['s', 'i'], secreto),
    encuentro(2600, ['i', 's'], secreto),
    encuentro(4000, ['s', 'vecina'], secreto),
    { ...encuentro(4800, ['s', 'i'], secreto), kind: 'care' as const },
    encuentro(9000, ['s', 'i'], secreto),
  ];
  const v = vinculoSI(view, eventos)!;
  assert.equal(v.distanciaCasillas, 5);
  assert.equal(v.juntoAhora, false);
  assert.equal(v.ultimoEncuentroTick, 2600, 'solo `meeting` entre ambas y no posterior al estado');
  assert.equal(v.pasosDesdeEncuentro, 2400);
  const ficha = vinculoSIFicha(s, view, eventos);
  assert.match(ficha, /a 5 casillas en esta vista/);
  assert.match(ficha, /hace 2\.400 pasos \(Día 2 · paso 2\.600\)/);
  assert.ok(!ficha.includes(secreto), 'ni el texto del episodio ni el del recuerdo aprobado se copian');
  assert.equal(vinculoSIFicha(persona({ role: 'neighbor', id: 'n' }), view, eventos), '', 'solo aparece en la ficha de S o de I');
  assert.equal(vinculoSI(mundo([s]), eventos), null, 'si I no está en este estado no hay distancia que afirmar');
  assert.equal(vinculoSIFicha(s, mundo([s]), eventos), '');
  assert.match(vinculoSIFicha(s, view, []), /no recibió ningún encuentro entre ambas/);
});

test('la ficha de fertilidad identifica una pausa explícita de los nacimientos', () => {
  const html = fertilidadFicha({ fertil: { ahora: false, bloqueo: 'pausa-manual', reserva: 0, necesita: 0 } }, mundo([]));
  assert.match(html, /data-person-fertility="pausa-manual"/);
  assert.match(html, /los nacimientos están en pausa por orden manual/);
});

const FASES_CERO: RuntimeStats['fases'] = { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0,
  demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 };
function runtime(extra: Partial<RuntimeStats>): RuntimeStats {
  return { stepMs: 24, p95StepMs: 30, saveMs: 1, projectionMs: 1, snapshotBytes: 1024, activeTiles: 1000,
    processRssMiB: 100, tickHz: 10, fases: { ...FASES_CERO }, fraccionSerial: 0.25, ...extra } as RuntimeStats;
}

test('fases medidas: personas, ecología, fauna y guardado siempre legibles con su parte del total', () => {
  const rt = runtime({ fases: { ...FASES_CERO, ecologia: 3, fauna: 2, personas: 6, save: 1, kernel: 12 } });
  const medida = fasesMedidas(rt)!;
  assert.equal(medida.totalMs, 24);
  assert.equal(medida.fases[0]!.clave, 'kernel', 'ordenadas de la más cara a la más barata');
  assert.equal(medida.fases.find(f => f.clave === 'personas')!.parte, 0.25);
  const html = seccionFases(rt);
  for (const [clave, texto] of [['ecologia', 'Ecología'], ['fauna', 'Fauna'], ['personas', 'Personas'], ['save', 'Guardado']] as const)
    assert.match(html, new RegExp(`data-fase="${clave}">${texto}<strong>`));
  assert.match(html, /Personas<strong>6 ms · 25 % de las fases<\/strong>/);
  assert.match(html, /La fase más cara de este paso fue Núcleo \(12 ms\)/);
  assert.match(html, /El resto de fases medidas suma 12 ms/);
  assert.match(html, /Fracción serial de las fases: 25 %/);
  assert.equal(fasesMedidas(runtime({ fases: {} as RuntimeStats['fases'] })), null);
  assert.match(seccionFases(runtime({ fases: {} as RuntimeStats['fases'] })), /no envió el desglose por fases/);
  assert.equal(fasesMedidas(undefined), null);
});

test('modo ligero: el perfil de dibujo no depende de heurísticas releídas y la suscripción sale al abrir', () => {
  assert.deepEqual(rendererProfile('observador'), { dprCeiling: 1, fpsCap: 30 });
  assert.deepEqual(rendererProfile('completo'), { dprCeiling: 3, fpsCap: null });
});

/* ---- Connection + deltas con un socket de navegador simulado (mismo patrón que red-deltas) ---- */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url = '') { FakeSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  send(v: string): void { this.sent.push(v); }
  message(m: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  close(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }
}
const estadoSeq = (sequence: number): WorldView => ({ version: PROTOCOL_VERSION, sequence, tick: sequence, day: 1,
  phase: 'day', weather: 'clear', width: 40, height: 28,
  tiles: [{ x: 0, y: 0, terrain: 'soil', moisture: 0.1, vegetation: 0.2, food: 0.3 }], people: [], places: [], events: [], memories: [] });
const deltaSeq = (baseSequence: number, sequence: number, food = 0.9): StateDelta => ({ type: 'state-delta', baseSequence, sequence,
  tileUpserts: [{ x: 0, y: 0, food }], tileRemovals: [], peopleUpserts: [], peopleRemovals: [], worldPatch: { tick: sequence, sequence } });
const vaciar = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function arrancar(t: TestContext) {
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  FakeSocket.instances = [];
  const worlds: WorldView[] = [], errors: string[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'example.test' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (typeof input === 'string' && input.split('?')[0] === '/api/world') return Response.json(estadoSeq(40));
    throw new Error('ruta inesperada');
  }) as typeof fetch;
  const connection = new Connection({ world: w => worlds.push(w), result: () => {}, status: () => {},
    error: m => errors.push(m), expired: () => {}, pending: () => {} });
  t.after(() => { connection.stop(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  connection.start(); await vaciar();
  const socket = FakeSocket.instances[0]!;
  const enviados = (): { type: string }[] => socket.sent.map(s => JSON.parse(s) as { type: string });
  return { connection, socket, worlds, errors, enviados,
    contar: (type: string): number => enviados().filter(m => m.type === type).length };
}

test('deltas: un delta duplicado o viejo no se reaplica, no se reacusa y no pide resync', async t => {
  const h = await arrancar(t); h.socket.open();
  h.socket.message(deltaSeq(40, 41));
  assert.equal(h.worlds.at(-1)?.tiles[0]?.food, 0.9);
  assert.deepEqual(h.enviados(), [{ type: 'ack', sequence: 41 }]);
  h.socket.message(deltaSeq(40, 41, 0.1));
  h.socket.message(deltaSeq(38, 39, 0.2));
  assert.equal(h.worlds.length, 2, 'sin parpadeo: no llega ningún mundo «nuevo» por un duplicado');
  assert.equal(h.worlds.at(-1)?.tiles[0]?.food, 0.9);
  assert.deepEqual(h.enviados(), [{ type: 'ack', sequence: 41 }], 'un ack viejo forzaría un state completo en el servidor');
  // Pero un delta del MISMO paso que encadena con la base vigente (pausa al mismo tick) no es un
  // duplicado: se aplica, se acusa y la pausa se muestra, como con un `state` de igual secuencia.
  h.socket.message({ type: 'state-delta', baseSequence: 41, sequence: 41, tileUpserts: [], tileRemovals: [],
    peopleUpserts: [], peopleRemovals: [], worldPatch: { paused: true, pauseReason: 'No se pudo guardar.' } });
  assert.equal(h.worlds.at(-1)?.paused, true);
  assert.deepEqual(h.enviados().at(-1), { type: 'ack', sequence: 41 });
});

test('deltas: una tormenta de bases perdidas pide un solo resync y se rearma tras el state', async t => {
  const h = await arrancar(t); h.socket.open();
  h.socket.message(deltaSeq(999, 42));
  h.socket.message(deltaSeq(999, 43));
  h.socket.message(deltaSeq(41, 44));
  assert.equal(h.contar('resync'), 1, 'un enlace lento no debe gastar el cupo de mensajes pidiendo lo mismo');
  assert.equal(h.worlds.length, 1, 'mientras llega el state se queda la última vista buena');
  h.socket.message({ type: 'state', world: estadoSeq(50) });
  assert.equal(h.worlds.at(-1)?.sequence, 50);
  h.socket.message(deltaSeq(999, 60));
  assert.equal(h.contar('resync'), 2, 'tras recuperarse, otra pérdida sí vuelve a pedir');
  h.socket.message({ type: 'state', world: estadoSeq(60) });
  h.socket.message(deltaSeq(60, 61, 0.7));
  assert.equal(h.worlds.at(-1)?.tiles[0]?.food, 0.7);
});

test('deltas: un delta inaplicable no emite mundo a medias ni ack, y la suscripción ligera se recuerda', async t => {
  const h = await arrancar(t);
  h.connection.suscribir(5000);
  h.socket.open();
  assert.deepEqual(h.enviados(), [{ type: 'suscripcion', intervaloMs: 5000 }], 'el modo ligero pide su cadencia al abrir');
  const corrupto = { ...deltaSeq(40, 41), tileRemovals: null } as unknown as StateDelta;
  h.socket.message(corrupto);
  h.socket.message({ ...corrupto, sequence: 42 });
  assert.equal(h.worlds.length, 1);
  assert.equal(h.contar('ack'), 0);
  assert.equal(h.contar('resync'), 1);
  assert.deepEqual(h.errors, [], 'un delta corrupto se recupera en silencio, sin error por delta');
  h.socket.message({ type: 'state', world: estadoSeq(50) });
  h.socket.message(deltaSeq(50, 51, 0.4));
  assert.equal(h.worlds.at(-1)?.tiles[0]?.food, 0.4);
});



