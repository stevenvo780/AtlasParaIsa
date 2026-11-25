import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { tileLookup } from '../src/world/tile-index.js';
import { residentFastAccess } from '../src/world/soa/terreno.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { bindWorldContext, worldContext } from '../src/world/spatial.js';
import { distance } from '../src/world/mundo/geometria.js';
import { RADIUS, type Person } from '../src/world/mundo/tipos.js';
import { evaluatePolicySingle, founderPolicy } from '../src/world/politica.js';
import { CAMPOS_CUERPO, CEREBRO, COLUMNAS_CEREBRO, CUERPO_ANCHO, Clase, ErrorDispositivo, REF_NULA, slotDe, type Col, type LotePercepcion, type Percepcion,
  type Percibidor, type Plan } from '../src/world/motor/contratos.js';
import { CELDAS_VENTANA, FUERA, LADO_VENTANA, PercepcionDelPaso, PercibidorCpu, VistaMundo, percepcionDe, type DescriptorVista, type Vencidos,
  type PercepcionCpu } from '../src/world/decision/percepcion.js';
import { TerrenoPercepcion } from '../src/world/decision/terreno-percepcion.js';
import { OrganismosMundo, organismosDe } from '../src/world/soa/organismos-mundo.js';
import { marcarTesela } from '../src/world/soa/barrera-percepcion.js';
import { CONSULTA, PLAN, UMBRAL, f32Abajo, f32Arriba, planesPersonas } from '../src/world/decision/planes.js';
import { decideConCerebro, ensurePersonPolicy, localPolicyObservation, prepararCerebros, puntuacionesPercibidas } from '../src/world/decision/politica-persona.js';
import { choose } from '../src/world/decision/personas.js';
import type { Tile } from '../src/shared/types.js';
import { PercibidorHilos } from './v23-decision-hilos.js';

/** El régimen abierto del panel con un hilo: política activa, química y obras modulares (terreno en teselas). */
const ABIERTO = parseParams({ motor: { ...hostOpenWorldParams().motor, hilos: 1, gpu: [] } }, hostOpenWorldParams());
/** El mismo con el SoA residente, como lo arma `sim-worker`: dueño de topología y ecología en 2 hilos. */
const RESIDENTE = parseParams({ motor: { ...ABIERTO.motor, hilos: 2 } }, ABIERTO);
const conDepuracion = (p: WorldParams) => parseParams({ motor: { ...p.motor, depuracion: true } }, p);
const RESIDENTES = new Set([RESIDENTE]);
const RESIDENTE_DEPURADO = conDepuracion(RESIDENTE);
RESIDENTES.add(RESIDENTE_DEPURADO);

/** Las primeras `n` filas de una columna del frente. */
const filas = (c: Col, n: number) => Array.from({ length: n }, (_, i) => c[i]!);

function crear(seed: number, params: WorldParams = DEFAULT_PARAMS): World {
  const world = createWorld(seed, params);
  if (RESIDENTES.has(params)) {
    const dueno = new ResidentTopologyOwner();
    world.tiles = dueno.tiles(world.tiles.map(t => dueno.tile(t)));
    bindWorldContext(world, { ...worldContext(world), tileOwnership: dueno });
  }
  return world;
}

function mundo(seed: number, pasos: number, params: WorldParams = DEFAULT_PARAMS): World {
  const world = crear(seed, params);
  for (let i = 0; i < pasos; i++) stepWorld(world);
  if (RESIDENTES.has(params)) assert.ok(residentFastAccess(world.tiles)?.exact, 'el SoA es residente');
  return world;
}

/** `n` personas: las del mundo y copias suyas repartidas por la tierra (solo para percibir: no entran en el mundo). */
function multitud(world: World, n: number): Person[] {
  const tierra = world.tiles.filter(t => t.terrain !== 'water'), personas = world.people.slice();
  for (let i = 0; personas.length < n; i++) {
    const base = world.people[i % world.people.length]!, t = tierra[(i * 7919) % tierra.length]!;
    personas.push({ ...structuredClone(base), id: `${base.id}-copia-${i}`, x: t.x, y: t.y, uid: undefined });
  }
  return personas;
}

/** Una tabla propia que da uid a partir del siguiente del mundo, sin gastárselos: las personas que trae ya tienen el suyo. */
const organismosPropios = (world: World | undefined, depuracion = false) => {
  let uid = world?.siguienteUid ?? 1;
  return new OrganismosMundo(depuracion, () => uid++);
};

/** Una vista propia (tabla y terreno nuevos): en ella la ranura de cada persona es su índice en la primera captura. */
const vistaNueva = (world?: World) => VistaMundo.de(organismosPropios(world), new TerrenoPercepcion(false));

/** Lote de `personas` (todas las del mundo por defecto), con cerebro para quien decidiría con él, sobre el estado de ahora. */
function percibirTodos(world: World, personas: readonly Person[] = world.people): { vista: VistaMundo; lote: LotePercepcion; salida: PercepcionCpu; planes: Plan[] } {
  const vista = vistaNueva(world), tileIn = tileLookup(world.tiles);
  const slots = Int32Array.from(personas, (_, s) => s);
  const lote: LotePercepcion = { tick: world.tick, despacho: 1, slots, plan: Uint16Array.from(personas, () => PLAN.conCerebro) };
  vista.capturar(personas, world.tick, slots, tileIn, residentFastAccess(world.tiles));
  prepararCerebros(world, vista, lote, tileIn);
  const cpu = new PercibidorCpu(vista), planes = planesPersonas(vista.terreno.campos);
  cpu.lanzar(lote, planes);
  return { vista, lote, salida: cpu.esperar(), planes };
}

/** Lo que `choose` buscaba antes de partirse, escrito directamente sobre las teselas: ventana, BFS y argmin. Los umbrales
 * son los de los planes: la ley redondeada hacia fuera a f32 (la franja la descarta luego el dueño). */
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
      [CONSULTA.comida]: argmin(t => t.food >= f32Abajo(UMBRAL.comida), e => e.d - e.tile.food * 2, true),
      [CONSULTA.agua]: argmin(t => (t.drinkingWater ?? 0) >= f32Abajo(UMBRAL.agua), e => e.d, true),
      [CONSULTA.madera]: argmin(t => (t.wood ?? 0) >= 1, e => e.d, false),
      [CONSULTA.piedra]: argmin(t => (t.stone ?? 0) >= 1, e => e.d, false),
      [CONSULTA.maderaYPiedra]: argmin(t => (t.wood ?? 0) >= 1 && (t.stone ?? 0) >= 1, e => e.d, false),
      [CONSULTA.cultivo]: argmin(t => descubierta(t) && t.moisture >= f32Abajo(0.25) && t.vegetation <= f32Arriba(0.8), e => e.d, false),
      [CONSULTA.obra]: argmin(t => descubierta(t) && t.moisture >= f32Abajo(0.2) && t.vegetation >= f32Abajo(0.15), e => e.d, false),
    } as Record<number, Tile | undefined>,
  };
}

/** Teselas de tierra a distancia 1 de (x, y), en orden de filas (dy, luego dx). */
function vecinasDeTierra(world: World, x: number, y: number): Tile[] {
  const tileIn = tileLookup(world.tiles);
  return [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => tileIn(x + dx!, y + dy!)).filter((t): t is Tile => !!t && t.terrain !== 'water');
}

/** Una persona cuyo disco no tenga cisternas, con al menos dos vecinas de tierra; su slot y esas vecinas. */
function personaConVecinas(world: World): { persona: Person; slot: number; vecinas: Tile[] } {
  for (let slot = 0; slot < world.people.length; slot++) {
    const persona = world.people[slot]!, vecinas = vecinasDeTierra(world, persona.x, persona.y);
    if (vecinas.length >= 2 && !world.structures.some(s => distance(s, persona) <= RADIUS + 3)) return { persona, slot, vecinas };
  }
  throw new Error('ninguna persona sirve');
}

/** Teselas del disco r = 7 (+1) de `p`. */
const disco = (world: World, p: { x: number; y: number }) => world.tiles.filter(t => distance(t, p) <= RADIUS + 1);

test('la ventana y las consultas percibidas son las de la búsqueda de siempre', () => {
  for (const [seed, params] of [[7, DEFAULT_PARAMS], [42, DEFAULT_PARAMS], [51926, ABIERTO], [51926, RESIDENTE], [19104, RESIDENTE]] as const) {
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
    });
    assert.ok(celdasConsultadas > 0, 'alguna consulta encontró celda');
  }
});

test('las personas no llevan consultas de organismos: pareja y hambriento salen de la lista viva', () => {
  const planes = planesPersonas(vistaNueva().terreno.campos);
  assert.deepEqual(planes.map(p => p.organismos.length), [0, 0]);
});

test('una ConsultaOrganismo da el organismo de una búsqueda directa sobre el frente', () => {
  const world = mundo(51926, 900, ABIERTO), tileIn = tileLookup(world.tiles);
  const personas = multitud(world, 300);
  // Hambre de la multitud repartida en [0, 1): el filtro y el criterio 1 tienen donde elegir.
  personas.forEach((p, s) => { p.hunger = ((s * 2654435761) % 1000) / 1000; });
  const vista = vistaNueva(world), slots = Int32Array.from(personas, (_, s) => s);
  vista.capturar(personas, world.tick, slots, tileIn, undefined);
  const { frente } = vista, cuerpo = frente.columnas.indexOf('cuerpo');
  const plan: Plan = {
    id: 0, transitable: Float32Array.of(0, 1, 4), celdas: [], acciones: 0, w: null, organismos: [
      { radio: RADIUS, clase: Clase.Persona, filtros: new Float32Array(0), criterio: 0, columna: 0, componente: 0 },
      { radio: 2 * RADIUS, clase: Clase.Persona, filtros: Float32Array.of(cuerpo, CAMPOS_CUERPO.hambre, f32Abajo(UMBRAL.hambreAjena), Infinity), criterio: 1, columna: cuerpo, componente: CAMPOS_CUERPO.hambre },
    ],
  };
  const cpu = new PercibidorCpu(vista);
  cpu.lanzar({ tick: world.tick, despacho: 1, slots, plan: new Uint16Array(slots.length) }, [plan]);
  const salida = cpu.esperar();
  let encontrados = 0;
  for (let i = 0; i < personas.length; i++) {
    let cerca = -1, dCerca = Infinity, hambre = -1, hMax = -Infinity;
    for (let s = 0; s < personas.length; s++) {
      if (s === i) continue;
      const d = Math.hypot(frente.x[s]! - frente.x[i]!, frente.y[s]! - frente.y[i]!), h = frente.cuerpo[s * CUERPO_ANCHO + CAMPOS_CUERPO.hambre]!;
      if (d <= RADIUS && d < dCerca) { cerca = s; dCerca = d; }
      if (d <= 2 * RADIUS && h >= f32Abajo(UMBRAL.hambreAjena) && h > hMax) { hambre = s; hMax = h; }
    }
    const [a, b] = [salida.organismo[i * salida.v]!, salida.organismo[i * salida.v + 1]!];
    assert.equal(a === REF_NULA ? -1 : slotDe(a), cerca, `actor ${i}, más cercano`);
    assert.equal(b === REF_NULA ? -1 : slotDe(b), hambre, `actor ${i}, más hambriento`);
    if (cerca >= 0) encontrados++;
  }
  assert.ok(encontrados > 0);
});

test('el cerebro aplica softSign(z + sesgo) con sesgo distinto de cero, y sus columnas tienen el ancho del contrato en f64', () => {
  const world = mundo(51926, 600, ABIERTO), tileIn = tileLookup(world.tiles);
  // Plasticidad distinta de cero y distinta por persona y acción, dentro de [−0,5, 0,5].
  world.people.forEach((person, i) => {
    const { plasticity } = ensurePersonPolicy(world, person);
    for (let a = 0; a < CEREBRO.acciones; a++) plasticity.bias[a] = 0.45 * Math.sin(1 + 7 * i + 3 * a);
  });
  const { vista, salida } = percibirTodos(world);
  let distintas = 0;
  world.people.forEach((person, i) => {
    const { genome, plasticity } = ensurePersonPolicy(world, person), obs = localPolicyObservation(world, person, tileIn);
    const esperado = evaluatePolicySingle(obs, genome.weights, plasticity.bias), sinSesgo = evaluatePolicySingle(obs, genome.weights);
    for (let a = 0; a < esperado.length; a++) {
      assert.equal(salida.utilidad[i * salida.a + a], Math.fround(esperado[a]!), `${person.id} acción ${a}`);
      if (Math.fround(sinSesgo[a]! + plasticity.bias[a]!) !== salida.utilidad[i * salida.a + a]) distintas++;
    }
  });
  assert.ok(distintas > 0, 'softSign(z) + sesgo daría otra cosa');
  const { frente } = vista, filas = frente.gen.length;
  for (const [nombre, ancho] of [['observacion', CEREBRO.entradas], ['politica', COLUMNAS_CEREBRO.politica], ['sesgo', CEREBRO.acciones]] as const) {
    const col = frente.col(nombre);
    assert.ok(col instanceof Float64Array, nombre);
    assert.equal(col.length / filas, ancho, nombre);
    assert.equal(ancho, COLUMNAS_CEREBRO[nombre]);
  }
  assert.equal(COLUMNAS_CEREBRO.politica, 212);
  assert.equal(typeof decideConCerebro(world, world.people[0]!), 'boolean');
});

test('las utilidades por persona son vistas de una sola copia por tick', () => {
  const world = mundo(51926, 300, ABIERTO);
  const { lote, salida } = percibirTodos(world), puntuaciones = puntuacionesPercibidas(world, lote, salida);
  const buffers = new Set([...puntuaciones.values()].map(v => v.buffer));
  assert.equal(puntuaciones.size, world.people.length);
  assert.equal(buffers.size, 1);
  world.people.forEach((p, i) => assert.deepEqual(Array.from(puntuaciones.get(p.id)!), Array.from(salida.utilidad.subarray(i * salida.a, (i + 1) * salida.a))));
});

/** Compara las filas de dos percepciones de `n` actores. */
function mismaPercepcion(a: PercepcionCpu, b: PercepcionCpu, n: number): void {
  const ancho = { celda: a.q, pasos: a.q, valor: a.q, organismo: a.v, utilidad: a.a, ventana: CELDAS_VENTANA, ventanaCelda: CELDAS_VENTANA };
  for (const [campo, w] of Object.entries(ancho) as [keyof typeof ancho, number][])
    assert.deepEqual(Array.from(a[campo].subarray(0, n * w)), Array.from(b[campo].subarray(0, n * w)), campo);
}

test('repartir el lote en 32 hilos da la misma percepción que un hilo, con varias tandas en varios hilos', async () => {
  const world = mundo(42, 900);
  for (const [personas, tanda] of [[world.people, 2], [multitud(world, 600), 64]] as const) {
    const { vista, lote, salida, planes } = percibirTodos(world, personas);
    const hilos = new PercibidorHilos(vista, 32, tanda);
    try {
      for (let vuelta = 0; vuelta < 3; vuelta++) {
        hilos.lanzar(lote, planes);
        mismaPercepcion(hilos.esperar(60_000), salida, lote.slots.length);
      }
      assert.ok(lote.slots.length > 4 * tanda, `${lote.slots.length} actores en tandas de ${tanda}`);
      assert.equal(hilos.despachosConVariasTandas, 3);
      assert.ok(hilos.despachosRepartidos > 0, 'algún despacho lo repartieron varios workers');
      assert.ok(hilos.filasPorHilo.filter(f => f > 0).length > 1, `filas por worker: ${hilos.filasPorHilo.join(' ')}`);
    } finally { await hilos.cerrar(); }
  }
});

test('un mundo que percibe en 32 hilos, en tandas de 2, acaba igual que el de un hilo', async () => {
  const pasos = 600;
  const uno = mundo(7, pasos);
  const world = createWorld(7, DEFAULT_PARAMS), percepcion = percepcionDe(world);
  const hilos = new PercibidorHilos(percepcion.vista, 32, 2);
  percepcion.percibidor = hilos;
  try {
    for (let i = 0; i < pasos; i++) stepWorld(world);
  } finally { await hilos.cerrar(); }
  assert.equal(percepcion.respaldos, 0);
  assert.ok(hilos.despachosRepartidos > 0 && hilos.filasPorHilo.filter(f => f > 0).length > 1, `filas por worker: ${hilos.filasPorHilo.join(' ')}`);
  assert.equal(digestoCanonico(world), digestoCanonico(uno));
});

/** Doble de tarjeta: percibe en CPU sobre la vista, pero devuelve solo lo que pide el contrato (sin ventanas)
 * y, si `falla(llamada)`, lanza `ErrorDispositivo` en `esperar`, como una tarjeta que cae o vence a media fase. */
class TarjetaDoble implements Percibidor {
  readonly dispositivo = 'gpu0' as const;
  llamadas = 0; fallos = 0;
  readonly #cpu: PercibidorCpu;
  constructor(vista: VistaMundo, private readonly falla: (llamada: number) => boolean) { this.#cpu = new PercibidorCpu(vista); }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void { this.#cpu.lanzar(lote, planes); }
  esperar(): Percepcion {
    if (this.falla(++this.llamadas)) { this.fallos++; throw new ErrorDispositivo(this.dispositivo, 'plazo vencido'); }
    const { q, v, a, tick, despacho, celda, pasos, valor, organismo, utilidad } = this.#cpu.esperar();
    return { q, v, a, tick, despacho, celda, pasos, valor, organismo, utilidad };
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
    assert.equal(percepcion.respaldos, tarjeta.fallos);
    assert.equal(digestoCanonico(world), uno);
  }
});

/** Copia de la salida de CPU (con su sello), para devolverla un despacho después. */
function copiar(p: PercepcionCpu): PercepcionCpu {
  return { ...p, celda: p.celda.slice(), pasos: p.pasos.slice(), valor: p.valor.slice(), organismo: p.organismo.slice(), utilidad: p.utilidad.slice(),
    ventana: p.ventana.slice(), ventanaCelda: p.ventanaCelda.slice() };
}

/** Tarjeta que responde con la salida del despacho anterior, como una respuesta tardía. Con `ecoDelLote` la sella con el
 * despacho que espera el dueño (una tarjeta que copia bien el eco y mal las filas); sin él, con el que la produjo. */
class TarjetaAtrasada implements Percibidor {
  readonly dispositivo = 'gpu0' as const;
  llamadas = 0;
  readonly #cpu: PercibidorCpu;
  #anterior: PercepcionCpu | undefined; #actual: PercepcionCpu | undefined;
  #lote = { tick: -1, despacho: -1 };
  constructor(vista: VistaMundo, private readonly ecoDelLote: boolean) { this.#cpu = new PercibidorCpu(vista); }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#cpu.lanzar(lote, planes); this.#actual = copiar(this.#cpu.esperar()); this.#lote = { tick: lote.tick, despacho: lote.despacho };
  }
  esperar(): Percepcion {
    this.llamadas++;
    const p = this.#anterior ?? this.#actual!;
    this.#anterior = this.#actual;
    if (!this.ecoDelLote) return p;
    const { q, v, a, celda, pasos, valor, organismo, utilidad } = p;
    return { q, v, a, ...this.#lote, celda, pasos, valor, organismo, utilidad };
  }
}

test('una respuesta de otro despacho se rechaza y el lote se percibe en CPU', () => {
  const pasos = 600, uno = digestoCanonico(mundo(7, pasos));
  const world = createWorld(7, DEFAULT_PARAMS), percepcion = percepcionDe(world);
  const tarjeta = new TarjetaAtrasada(percepcion.vista, false);
  percepcion.percibidor = tarjeta;
  for (let i = 0; i < pasos; i++) stepWorld(world);
  assert.equal(percepcion.respaldos, tarjeta.llamadas - 1);
  assert.equal(digestoCanonico(world), uno);
  // Con el eco bien y las filas de otro despacho, la guardia de coherencia reconoce casi todas: no casan con las posiciones de ahora.
  const sinEco = createWorld(7, DEFAULT_PARAMS), otra = percepcionDe(sinEco), muda = new TarjetaAtrasada(otra.vista, true);
  otra.percibidor = muda;
  for (let i = 0; i < 300; i++) stepWorld(sinEco);
  assert.ok(otra.respaldos > 0, 'la guardia rechazó respuestas atrasadas');
});

test('la vista se comparte por SAB que crecen en su sitio: entre despachos, los mismos búferes', () => {
  const world = createWorld(42, DEFAULT_PARAMS), percepcion = percepcionDe(world);
  const cpu = new PercibidorCpu(percepcion.vista), descriptores: DescriptorVista[] = [];
  percepcion.percibidor = {
    dispositivo: 'gpu0',
    lanzar(lote, planes) { descriptores.push(percepcion.vista.descriptor()); cpu.lanzar(lote, planes); },
    esperar() { return cpu.esperar(); },
  };
  for (let i = 0; i < 400; i++) stepWorld(world);
  assert.equal(percepcion.respaldos, 0);
  const sab = (d: DescriptorVista) => [d.frente.estado, ...d.frente.columnas.flatMap(c => c.lados), d.terreno.topologia.buffer,
    ...d.terreno.arena.columnas.map(c => c.memoria)];
  const primero = sab(descriptores[0]!);
  for (const d of descriptores) assert.deepEqual(sab(d).map((b, k) => b === primero[k]), primero.map(() => true));
  // Otro hilo lee el frente publicado ahora mismo, del lado y del tick que toque.
  const otra = VistaMundo.desde(descriptores.at(-1)!), frente = percepcion.vista.frente;
  assert.equal(otra.frente.tick, frente.tick);
  assert.deepEqual(filas(otra.frente.x, frente.alta), filas(frente.x, frente.alta));
});

test('una página solo sube de versión si cambia lo que lleva, también vista desde otro hilo', () => {
  const world = mundo(42, 300), tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
  const vista = vistaNueva(world), a = world.people[0]!, { terreno } = vista;
  vista.capturar(world.people, world.tick, [0], tileIn, fast);
  const versiones = () => Array.from(terreno.versionPagina.subarray(0, terreno.paginas));
  const antes = versiones();
  assert.ok(antes.length > 0 && antes.every(v => v > 0));
  vista.capturar(world.people, world.tick + 1, [0], tileIn, fast);
  assert.deepEqual(versiones(), antes, 'sin cambios, ninguna versión sube');
  const tile = disco(world, a).find(t => t.terrain !== 'water' && distance(t, a) <= RADIUS)!;
  const c = terreno.celda(tile.x, tile.y), pagina = c >> 8;
  tile.vegetation = tile.vegetation / 2 + 0.01;
  vista.capturar(world.people, world.tick + 2, [0], tileIn, fast);
  const despues = versiones();
  despues.forEach((v, k) => assert.equal(v, k === pagina ? antes[k]! + 1 : antes[k], `página ${k}`));
  assert.equal(terreno.valores[6]![c], tile.vegetation);
  const otra = VistaMundo.desde(vista.descriptor()).terreno;
  assert.equal(otra.paginas, terreno.paginas);
  assert.equal(otra.celda(tile.x, tile.y), c);
  for (let k = 0; k < terreno.paginas; k++) assert.equal(otra.versionPagina[k], terreno.versionPagina[k]);
});

test('una persona que sale da de baja su ranura: las demás la conservan y la ranura vuelve tras la cuarentena con otra gen', () => {
  const world = mundo(42, 300), tileIn = tileLookup(world.tiles);
  const organismos = organismosPropios(world, true), vista = VistaMundo.de(organismos, new TerrenoPercepcion(true));
  const antes = world.people.slice();
  assert.ok(antes.length > 3);
  vista.capturar(antes, 1, [], tileIn, undefined);
  const ranura = (p: Person) => vista.slot(p), g1 = antes.map(p => vista.frente.gen[ranura(p)]!);
  assert.deepEqual(antes.map(ranura), antes.map((_, i) => i));
  const sale = antes[1]!, despues = antes.filter(p => p !== sale);
  vista.capturar(despues, 2, [], tileIn, undefined);
  assert.equal(vista.slot(sale), -1);
  despues.forEach(p => assert.equal(vista.frente.gen[ranura(p)], g1[antes.indexOf(p)], p.id));
  assert.equal(vista.frente.vivo[1], 0);
  assert.ok(vista.frente.gen[1]! > g1[1]!, 'la baja sube la gen de la ranura');
  // La cuarentena cuenta frentes publicados (uno por tick al cerrar el paso): quien llega durante ella no hereda la
  // ranura; pasada, sí, con una gen nueva y sin los pesos de la anterior.
  const llegada = (id: string): Person => ({ ...structuredClone(sale), id, uid: undefined });
  const primera = llegada('primera');
  vista.capturar([...despues, primera], 3, [], tileIn, undefined);
  assert.notEqual(vista.slot(primera), 1);
  organismos.publicar(4);
  const segunda = llegada('segunda');
  vista.capturar([...despues, primera, segunda], 5, [], tileIn, undefined);
  assert.equal(vista.slot(segunda), 1);
  assert.ok(vista.frente.gen[1]! > g1[1]!, 'otra gen que la de la anterior');
  assert.equal(vista.frente.uid[1], segunda.uid);
  assert.ok(segunda.uid! > sale.uid! && primera.uid! > sale.uid!, 'uid nuevo, nunca el de la anterior');
  assert.ok(!vista.pesosAlDia(1), 'los pesos de la anterior no valen para la nueva');
});

test('quien llega al sitio de otra no recibe la percepción de la anterior', () => {
  const world = mundo(7, 300), tileIn = tileLookup(world.tiles);
  const percepcion = new PercepcionDelPaso(world), personas = world.people.slice();
  const lote: Vencidos = { tick: world.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) };
  const delLote = percepcion.percibir(personas, world.tick, lote, tileIn, undefined, () => {});
  assert.equal(percepcion.filaDe(world.tick, personas[0]!, tileIn, undefined).salida, delLote);
  const otra: Person = { ...structuredClone(personas[0]!), id: 'sustituta', uid: undefined };
  const fila = percepcion.filaDe(world.tick, otra, tileIn, undefined);
  assert.notEqual(fila.salida, delLote);
  percepcion.cerrar();
});

test('quien decide fuera del lote se percibe donde está sin escribir en el frente', () => {
  const world = mundo(7, 900, conDepuracion(DEFAULT_PARAMS)), tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles) ?? undefined;
  const percepcion = new PercepcionDelPaso(world), persona = world.people[0]!;
  const lote: Vencidos = { tick: world.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) };
  percepcion.percibir(world.people, world.tick, lote, tileIn, fast, () => {});
  const { tabla } = organismosDe(world), frente = tabla.lectura(), x = filas(frente.x, frente.alta);
  const destino = vecinasDeTierra(world, persona.x, persona.y)[0]!;
  const origen = { x: persona.x, y: persona.y };
  Object.assign(persona, { x: destino.x, y: destino.y });
  try {
    const { salida, fila, terreno } = percepcion.filaDe(world.tick, persona, tileIn, fast);
    const ref = referencia(world, persona.x, persona.y);
    for (const [consulta, tile] of Object.entries(ref.consultas)) {
      const c = salida.celda[fila * salida.q + Number(consulta)]!;
      assert.equal(c >= 0 ? terreno.teselas[c] : undefined, tile, `consulta ${consulta}`);
    }
    assert.equal(tabla.lectura(), frente, 'sin publicar otro frente');
    assert.deepEqual(filas(frente.x, frente.alta), x);
    tabla.verificarFrente();
  } finally { Object.assign(persona, origen); percepcion.cerrar(); }
});

test('la fila del lote solo vale mientras su disco no cambie: toda escritura con barrera la percibe de nuevo', () => {
  for (const params of [DEFAULT_PARAMS, RESIDENTE]) {
    const world = mundo(51926, 300, params), tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
    const persona = world.people[0]!, percepcion = new PercepcionDelPaso(world);
    const lote: Vencidos = { tick: world.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) };
    const delLote = percepcion.percibir(world.people, world.tick, lote, tileIn, fast, () => {});
    const fila = () => percepcion.filaDe(world.tick, persona, tileIn, fast).salida;
    assert.equal(fila(), delLote, 'sin cambios, la del lote');
    const lejana = disco(world, persona).filter(t => t.terrain !== 'water' && distance(t, persona) <= RADIUS).at(-1)!;
    const fuera = world.tiles.find(t => Math.abs(t.x - persona.x) > 40 && Math.abs(t.y - persona.y) > 40);
    if (fuera) { marcarTesela(fuera); assert.equal(fila(), delLote, 'una escritura lejos no la toca'); }
    // En una página del disco pero fuera de él: la página sube de versión y la fila sigue valiendo.
    const pagina = (t: { x: number; y: number }) => `${t.x >> 4},${t.y >> 4}`, paginas = new Set(disco(world, persona).map(pagina));
    const vecina = world.tiles.find(t => paginas.has(pagina(t)) && distance(t, persona) > RADIUS + 0.5);
    assert.ok(vecina, 'hay una tesela de una página del disco fuera de él');
    marcarTesela(vecina);
    assert.equal(fila(), delLote, 'una escritura en su página, fuera del disco, no la toca');
    marcarTesela(lejana);
    assert.notEqual(fila(), delLote, 'una escritura en su disco la percibe de nuevo');
    percepcion.cerrar();
  }
});

test('con depuración, una escritura en el disco que no pasa por la barrera se detecta', () => {
  for (const params of [conDepuracion(DEFAULT_PARAMS), RESIDENTE_DEPURADO]) {
    const world = mundo(51926, 300, params);
    const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
    const persona = world.people[0]!, percepcion = new PercepcionDelPaso(world);
    percepcion.percibir(world.people, world.tick, { tick: world.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) }, tileIn, fast, () => {});
    const lejana = disco(world, persona).filter(t => t.terrain !== 'water' && distance(t, persona) <= RADIUS).at(-1)!;
    lejana.vegetation = lejana.vegetation / 2 + 1e-3;
    try { assert.throws(() => percepcion.filaDe(world.tick, persona, tileIn, fast), /Barrera de percepción incompleta/); }
    finally { percepcion.cerrar(); }
  }
});

/** Prepara a `persona` para que solo le importe `necesidad` y deja su disco sin agua ni comida. */
function aislar(world: World, persona: Person, necesidad: 'sed' | 'hambre'): void {
  for (const t of disco(world, persona)) { t.drinkingWater = 0; t.food = 0; }
  Object.assign(persona, { thirst: necesidad === 'sed' ? 0.96 : 0, hunger: necesidad === 'hambre' ? 0.95 : 0, fatigue: 0, energy: 1, inventory: 0 });
  world.animals = world.animals.filter(a => distance(a, persona) > 3 * RADIUS);
}

/** F2 con solo `persona` en el lote; luego `cambio` (lo que hizo alguien antes en el tick) y la decisión de `persona`. */
function decidirTrasCambio(world: World, persona: Person, slot: number, cambio: () => void): void {
  const percepcion = percepcionDe(world), tileIn = tileLookup(world.tiles);
  percepcion.percibir(world.people, world.tick, { tick: world.tick, slots: Int32Array.of(slot), plan: Uint16Array.of(PLAN.sinCerebro) }, tileIn, undefined, () => {});
  try {
    cambio();
    choose(world, persona);
  } finally { percepcion.cerrar(); }
}

test('quien decide después de que otro agotó su fuente no la elige, aunque el trayecto sea asequible', () => {
  const world = mundo(7, 300), { persona, slot, vecinas: [w1, w2] } = personaConVecinas(world);
  aislar(world, persona, 'sed');
  w1!.drinkingWater = 0.0055; w2!.drinkingWater = 0.1;
  decidirTrasCambio(world, persona, slot, () => {});
  assert.deepEqual([persona.action, persona.target], ['drink', { x: w1!.x, y: w1!.y }], 'sin cambios, la primera en orden de filas');
  decidirTrasCambio(world, persona, slot, () => { w1!.drinkingWater = 0; marcarTesela(w1!); });
  assert.deepEqual([persona.action, persona.target], ['drink', { x: w2!.x, y: w2!.y }]);
});

test('si otro come de la mejor fuente y deja de ser la mejor, aunque siga valiendo, se elige la nueva mejor', () => {
  const world = mundo(7, 300), { persona, slot, vecinas: [f1, f2] } = personaConVecinas(world);
  aislar(world, persona, 'hambre');
  f1!.food = 0.5; f2!.food = 0.3;
  decidirTrasCambio(world, persona, slot, () => {});
  assert.deepEqual([persona.action, persona.target], ['eat', { x: f1!.x, y: f1!.y }]);
  decidirTrasCambio(world, persona, slot, () => { f1!.food = 0.05; marcarTesela(f1!); });
  assert.deepEqual([persona.action, persona.target], ['eat', { x: f2!.x, y: f2!.y }], 'la que quedó en 0,05 sigue valiendo, pero ya no es la mejor');
});

test('la comida apenas por encima del umbral se percibe y se elige; la que no lo supera, no', () => {
  const world = mundo(7, 300), { persona, slot, vecinas: [f1] } = personaConVecinas(world);
  aislar(world, persona, 'hambre');
  f1!.food = 0.0250000001;
  const { salida } = percibirTodos(world);
  const c = salida.celda[slot * salida.q + CONSULTA.comida]!;
  assert.ok(c >= 0, 'percibida');
  decidirTrasCambio(world, persona, slot, () => {});
  assert.deepEqual([persona.action, persona.target], ['eat', { x: f1!.x, y: f1!.y }]);
  // En la franja f32 que el filtro deja pasar y la ley no.
  f1!.food = UMBRAL.comida;
  decidirTrasCambio(world, persona, slot, () => {});
  assert.notDeepEqual(persona.target, { x: f1!.x, y: f1!.y });
});

test('quien comparte elige al más hambriento de ahora, no al que lo era cuando se capturó el lote', () => {
  const world = mundo(7, 300), { persona, slot, vecinas: [ca, cb] } = personaConVecinas(world);
  const [a, b] = world.people.filter(p => p !== persona && p.role === 'neighbor');
  assert.ok(a && b && world.places.length > 0, 'hacen falta dos vecinos y un lugar');
  Object.assign(persona, { hunger: 0.1, thirst: 0, fatigue: 0, energy: 1, socialLoad: 0, inventory: 1, generosity: 1, lastShared: -1e9 });
  world.places.push({ ...structuredClone(world.places[0]!), id: 'plaza-de-prueba', x: persona.x, y: persona.y });
  world.animals = world.animals.filter(x => distance(x, persona) > 3 * RADIUS);
  Object.assign(a, { x: ca!.x, y: ca!.y, hunger: 0.86 });
  Object.assign(b, { x: cb!.x, y: cb!.y, hunger: 0.81 });
  decidirTrasCambio(world, persona, slot, () => {});
  assert.deepEqual([persona.action, persona.target], ['share', { x: a.x, y: a.y }], 'sin cambios, el de 0,86');
  // Alguien da de comer a A antes de que decida: ya no es el más hambriento.
  decidirTrasCambio(world, persona, slot, () => { a.hunger = 0.74; });
  assert.deepEqual([persona.action, persona.target], ['share', { x: b.x, y: b.y }]);
});

test('los pesos de un ocupante nuevo se publican con su gen aunque no decida con cerebro, sin crearle la política', () => {
  const world = mundo(51926, 300, ABIERTO), tileIn = tileLookup(world.tiles), vista = vistaNueva(world);
  const vacio: LotePercepcion = { tick: world.tick, despacho: 1, slots: new Int32Array(0), plan: new Uint16Array(0) };
  const pesos = (s: number) => Array.from((vista.frente.col('politica') as Float64Array).subarray(s * COLUMNAS_CEREBRO.politica, (s + 1) * COLUMNAS_CEREBRO.politica));
  vista.capturar(world.people, world.tick, [], tileIn, undefined);
  prepararCerebros(world, vista, vacio, tileIn);
  world.people.forEach((p, s) => { assert.ok(vista.pesosAlDia(s)); assert.deepEqual(pesos(s), Array.from((p.policy ?? founderPolicy(world.seed, p.id)).weights)); });
  const nueva: Person = { ...structuredClone(world.people[1]!), id: 'recien-llegada', uid: undefined };
  delete nueva.policy;
  const personas = [nueva, ...world.people.slice(1)];
  vista.capturar(personas, world.tick + 1, [], tileIn, undefined);
  const s0 = vista.slot(nueva);
  assert.ok(!vista.pesosAlDia(s0) && vista.pesosAlDia(vista.slot(world.people[1]!)));
  prepararCerebros(world, vista, { ...vacio, tick: world.tick + 1 }, tileIn);
  assert.ok(vista.pesosAlDia(s0));
  assert.deepEqual(pesos(s0), Array.from(founderPolicy(world.seed, 'recien-llegada').weights));
  assert.equal(nueva.policy, undefined);
});

test('F2 con revalidación da el mismo mundo que percibir siempre en el estado vivo', () => {
  for (const [seed, params, pasos] of [[51926, ABIERTO, 2400], [7, DEFAULT_PARAMS, 2400]] as const) {
    const lote = crear(seed, params), vivo = crear(seed, params), percepcion = percepcionDe(vivo), original = percepcion.percibir.bind(percepcion);
    // Sin fila activa, cada decisión se percibe en el momento sobre el estado de ese momento.
    percepcion.percibir = (...a: Parameters<typeof original>) => { const s = original(...a); percepcion.cerrar(); return s; };
    for (let i = 0; i < pasos; i++) { stepWorld(lote); stepWorld(vivo); }
    assert.equal(digestoCanonico(lote), digestoCanonico(vivo), `semilla ${seed}`);
  }
});
