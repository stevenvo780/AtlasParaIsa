import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { tileLookup } from '../src/world/tile-index.js';
import { residentFastAccess } from '../src/world/soa/terreno.js';
import { distance } from '../src/world/mundo/geometria.js';
import { RADIUS } from '../src/world/mundo/tipos.js';
import { evaluatePolicySingle } from '../src/world/politica.js';
import { ErrorDispositivo, REF_NULA, slotDe, type LotePercepcion, type Percepcion, type Percibidor, type Plan } from '../src/world/motor/contratos.js';
import { CELDAS_VENTANA, FUERA, LADO_VENTANA, PercepcionDelPaso, PercibidorCpu, VistaMundo, percepcionDe, type PercepcionCpu } from '../src/world/decision/percepcion.js';
import { CONSULTA, ORGANISMO, PLAN, UMBRAL, planesPersonas } from '../src/world/decision/planes.js';
import { decideConCerebro, ensurePersonPolicy, localPolicyObservation, prepararCerebros } from '../src/world/decision/politica-persona.js';
import type { Tile } from '../src/shared/types.js';
import { PercibidorHilos } from './v23-decision-hilos.js';

/** El régimen abierto del panel con un hilo: SoA residente, política activa, química y obras modulares. */
const ABIERTO = parseParams({ motor: { ...hostOpenWorldParams().motor, hilos: 1, gpu: [] } }, hostOpenWorldParams());

function mundo(seed: number, pasos: number, params: WorldParams = DEFAULT_PARAMS): World {
  const world = createWorld(seed, params);
  for (let i = 0; i < pasos; i++) stepWorld(world);
  return world;
}

/** Lote de todas las personas, con cerebro para quien decidiría con él, sobre el estado de ahora. */
function percibirTodos(world: World): { vista: VistaMundo; lote: LotePercepcion; salida: PercepcionCpu } {
  const vista = VistaMundo.nueva(), tileIn = tileLookup(world.tiles);
  const slots = Int32Array.from(world.people, (_, s) => s);
  const lote: LotePercepcion = { tick: world.tick, slots, plan: Uint16Array.from(world.people, () => PLAN.conCerebro) };
  vista.capturar(world.people, world.tick, slots, tileIn, residentFastAccess(world.tiles));
  prepararCerebros(world, vista, lote, tileIn);
  const cpu = new PercibidorCpu(vista);
  cpu.lanzar(lote, planesPersonas(vista.terreno.campos, vista.frente.columnas));
  return { vista, lote, salida: cpu.esperar() };
}

/** Lo que `choose` buscaba antes de partirse, escrito directamente sobre las teselas: ventana, BFS y argmin. */
function referencia(world: World, x: number, y: number) {
  const tileIn = tileLookup(world.tiles);
  const pasos = new Map<string, number>([[`${x},${y}`, 0]]), cola = [{ x, y }];
  const tierra = (px: number, py: number) => (px - x) ** 2 + (py - y) ** 2 <= RADIUS ** 2 && (tileIn(px, py)?.terrain ?? 'water') !== 'water';
  for (let i = 0; i < cola.length; i++) {
    const p = cola[i]!, n = pasos.get(`${p.x},${p.y}`)! + 1;
    for (const q of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }])
      if (tierra(q.x, q.y) && !pasos.has(`${q.x},${q.y}`)) { pasos.set(`${q.x},${q.y}`, n); cola.push(q); }
  }
  const disco: { tile: Tile; pasos: number | undefined; d: number }[] = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++)
    if (tierra(x + dx, y + dy)) { const tile = tileIn(x + dx, y + dy)!; disco.push({ tile, pasos: pasos.get(`${tile.x},${tile.y}`), d: distance({ x, y }, tile) }); }
  const argmin = (ok: (t: Tile) => boolean, clave: (e: typeof disco[number]) => number, alcanzable: boolean) => {
    let mejor: Tile | undefined, k = 0;
    for (const e of disco) {
      if ((alcanzable && e.pasos === undefined) || !ok(e.tile)) continue;
      const c = clave(e);
      if (!mejor || c < k) { mejor = e.tile; k = c; }
    }
    return mejor;
  };
  const descubierta = (t: Tile) => t.terrain !== 'shelter';
  return {
    pasos, disco,
    consultas: {
      [CONSULTA.comida]: argmin(t => t.food > UMBRAL.comida, e => e.d - e.tile.food * 2, true),
      [CONSULTA.agua]: argmin(t => (t.drinkingWater ?? 0) > UMBRAL.agua, e => e.d, true),
      [CONSULTA.madera]: argmin(t => (t.wood ?? 0) >= 1, e => e.d, false),
      [CONSULTA.piedra]: argmin(t => (t.stone ?? 0) >= 1, e => e.d, false),
      [CONSULTA.maderaYPiedra]: argmin(t => (t.wood ?? 0) >= 1 && (t.stone ?? 0) >= 1, e => e.d, false),
      [CONSULTA.cultivo]: argmin(t => descubierta(t) && t.moisture > 0.25 && t.vegetation < 0.8, e => e.d, false),
      [CONSULTA.obra]: argmin(t => descubierta(t) && t.moisture > 0.2 && t.vegetation > 0.15, e => e.d, false),
    } as Record<number, Tile | undefined>,
  };
}

test('la ventana, las consultas y los organismos percibidos son los de la búsqueda de siempre', () => {
  for (const [seed, params] of [[7, DEFAULT_PARAMS], [42, DEFAULT_PARAMS], [51926, ABIERTO]] as const) {
    const world = mundo(seed, 900, params);
    const { vista, salida } = percibirTodos(world);
    assert.ok(world.people.length > 0);
    let celdasConsultadas = 0;
    world.people.forEach((person, i) => {
      const ref = referencia(world, person.x, person.y), base = i * CELDAS_VENTANA;
      for (let k = 0; k < CELDAS_VENTANA; k++) {
        const x = person.x + k % LADO_VENTANA - RADIUS, y = person.y + Math.floor(k / LADO_VENTANA) - RADIUS;
        const esperado = ref.disco.some(e => e.tile.x === x && e.tile.y === y) ? ref.pasos.get(`${x},${y}`) ?? -1 : FUERA;
        if (k === Math.floor(CELDAS_VENTANA / 2)) continue;   // el centro vale 0 aunque sea agua
        assert.equal(salida.ventana[base + k], esperado, `semilla ${seed}, ${person.id}, (${x},${y})`);
      }
      for (const [consulta, tile] of Object.entries(ref.consultas)) {
        const c = salida.celda[i * salida.q + Number(consulta)]!;
        assert.equal(c >= 0 ? vista.terreno.teselas[c] : undefined, tile, `semilla ${seed}, ${person.id}, consulta ${consulta}`);
        if (tile) celdasConsultadas++;
      }
      const pareja = world.people.find(o => o !== person && person.role !== 'neighbor' && o.role !== 'neighbor' && distance(person, o) <= RADIUS);
      const refPareja = salida.organismo[i * salida.v + ORGANISMO.pareja]!;
      if (person.role !== 'neighbor') assert.equal(refPareja === REF_NULA ? undefined : world.people[slotDe(refPareja)], pareja);
      let hambre: typeof person | undefined;
      for (const o of world.people) if (o !== person && distance(person, o) <= UMBRAL.radioCompartir && o.hunger > UMBRAL.hambreAjena && (!hambre || o.hunger > hambre.hunger)) hambre = o;
      const refHambre = salida.organismo[i * salida.v + ORGANISMO.hambriento]!;
      assert.equal(refHambre === REF_NULA ? undefined : world.people[slotDe(refHambre)], hambre);
    });
    assert.ok(celdasConsultadas > 0, 'alguna consulta encontró celda');
  }
});

test('las utilidades del cerebro son las de la red de política redondeadas a f32', () => {
  const world = mundo(51926, 600, ABIERTO), tileIn = tileLookup(world.tiles);
  const { salida } = percibirTodos(world);
  world.people.forEach((person, i) => {
    const { genome, plasticity } = ensurePersonPolicy(world, person);
    const esperado = evaluatePolicySingle(localPolicyObservation(world, person, tileIn), genome.weights, plasticity.bias);
    for (let a = 0; a < esperado.length; a++) assert.equal(salida.utilidad[i * salida.a + a], Math.fround(esperado[a]!), `${person.id} acción ${a}`);
  });
  assert.equal(typeof decideConCerebro(world, world.people[0]!), 'boolean');
});

test('repartir el lote en 32 hilos da la misma percepción que un hilo', async () => {
  const world = mundo(42, 900);
  const { vista, lote, salida } = percibirTodos(world);
  const hilos = new PercibidorHilos(vista, 32);
  try {
    hilos.lanzar(lote, planesPersonas(vista.terreno.campos, vista.frente.columnas));
    const repartida = hilos.esperar(60_000);
    const n = lote.slots.length, ancho = { celda: salida.q, pasos: salida.q, valor: salida.q, organismo: salida.v, utilidad: salida.a, ventana: CELDAS_VENTANA, ventanaCelda: CELDAS_VENTANA };
    for (const [campo, w] of Object.entries(ancho) as [keyof typeof ancho, number][])
      assert.deepEqual(Array.from(repartida[campo].subarray(0, n * w)), Array.from(salida[campo].subarray(0, n * w)), campo);
  } finally { await hilos.cerrar(); }
});

/** Doble de tarjeta: percibe en CPU sobre la vista, pero devuelve solo lo que pide el contrato (sin ventanas) y,
 * si `falla(llamada)`, lanza `ErrorDispositivo` en `esperar`, como una tarjeta que cae o vence a media fase. */
class TarjetaDoble implements Percibidor {
  readonly dispositivo = 'gpu0' as const;
  llamadas = 0; fallos = 0;
  readonly #cpu: PercibidorCpu;
  constructor(vista: VistaMundo, private readonly falla: (llamada: number) => boolean) { this.#cpu = new PercibidorCpu(vista); }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void { this.#cpu.lanzar(lote, planes); }
  esperar(): Percepcion {
    if (this.falla(++this.llamadas)) { this.fallos++; throw new ErrorDispositivo(this.dispositivo, 'plazo vencido'); }
    const { q, v, a, celda, pasos, valor, organismo, utilidad } = this.#cpu.esperar();
    return { q, v, a, celda, pasos, valor, organismo, utilidad };
  }
}

test('con una tarjeta que no da ventanas, o que cae a media fase, el mundo acaba igual que en CPU', () => {
  const pasos = 600, uno = digestoCanonico(mundo(7, pasos));
  for (const falla of [() => false, (llamada: number) => llamada % 3 === 0]) {
    const world = createWorld(7, DEFAULT_PARAMS), percepcion = percepcionDe(world);
    const tarjeta = new TarjetaDoble(percepcion.vista, falla);
    percepcion.percibidor = tarjeta;
    for (let i = 0; i < pasos; i++) stepWorld(world);
    assert.equal(tarjeta.llamadas, pasos);
    assert.equal(tarjeta.fallos > 0, falla(3));
    assert.equal(digestoCanonico(world), uno);
  }
});

test('el terreno sube la versión de cada página que reasigna, también en la vista de otro hilo', () => {
  const world = mundo(42, 300), tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
  const vista = VistaMundo.nueva(), a = world.people[0]!;
  vista.capturar(world.people, world.tick, [0], tileIn, fast);
  const antes = Array.from(vista.terreno.versionPagina.subarray(0, vista.terreno.paginas));
  assert.ok(antes.length > 0 && antes.every(v => v > 0));
  const tierra = world.tiles.filter(t => t.terrain !== 'water');
  const lejos = tierra.reduce((m, t) => distance(t, a) > distance(m, a) ? t : m, tierra[0]!);
  assert.ok(distance(lejos, a) > 2 * RADIUS);
  const [x, y] = [a.x, a.y];
  a.x = lejos.x; a.y = lejos.y;
  try { vista.capturar(world.people, world.tick + 1, [0], tileIn, fast); } finally { a.x = x; a.y = y; }
  const { terreno } = vista;
  for (let c = 0; c < terreno.paginas; c++) assert.ok(terreno.versionPagina[c]! > (antes[c] ?? 0), `página ${c}`);
  const otra = VistaMundo.desde(vista.descriptor()).terreno;
  assert.equal(otra.paginas, terreno.paginas);
  for (let c = 0; c < terreno.paginas; c++) {
    assert.equal(otra.versionPagina[c], terreno.versionPagina[c]);
    assert.ok(otra.duenoChunk[c]! >= 0);
  }
});

test('quien decide fuera del lote se percibe donde está sin escribir en el frente', () => {
  const world = mundo(7, 900), tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles) ?? undefined;
  const percepcion = new PercepcionDelPaso(), persona = world.people[0]!;
  const lote: LotePercepcion = { tick: world.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) };
  percepcion.percibir(world.people, world.tick, lote, tileIn, fast, () => {});
  const { datos } = percepcion.vista.frente;
  const soloLectura = (c: ArrayBufferView) => new Proxy(c, { set: () => { throw new Error('escritura en el frente'); } });
  const [x, y] = [datos.x!, datos.y!];
  const destino = [{ x: persona.x + 1, y: persona.y }, { x: persona.x - 1, y: persona.y }, { x: persona.x, y: persona.y + 1 }]
    .find(p => (tileIn(p.x, p.y)?.terrain ?? 'water') !== 'water')!;
  const origen = { x: persona.x, y: persona.y };
  Object.assign(persona, destino);
  datos.x = soloLectura(x) as Float32Array; datos.y = soloLectura(y) as Float32Array;
  try {
    const { salida, fila, terreno } = percepcion.filaDe(world.people, world.tick, persona, 0, tileIn, fast);
    const ref = referencia(world, persona.x, persona.y);
    for (const [consulta, tile] of Object.entries(ref.consultas)) {
      const c = salida.celda[fila * salida.q + Number(consulta)]!;
      assert.equal(c >= 0 ? terreno.teselas[c] : undefined, tile, `consulta ${consulta}`);
    }
  } finally { datos.x = x; datos.y = y; Object.assign(persona, origen); percepcion.cerrar(); }
});

test('un mundo que percibe en 32 hilos acaba igual que el de un hilo', async () => {
  const pasos = 600;
  const uno = mundo(7, pasos);
  const world = createWorld(7, DEFAULT_PARAMS), percepcion = percepcionDe(world);
  const hilos = new PercibidorHilos(percepcion.vista, 32);
  percepcion.percibidor = hilos;
  try {
    for (let i = 0; i < pasos; i++) stepWorld(world);
  } finally { await hilos.cerrar(); }
  assert.equal(digestoCanonico(world), digestoCanonico(uno));
});
