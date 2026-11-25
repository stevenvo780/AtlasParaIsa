import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { updateCommunities, updateCulturalNormsOnOutcome } from '../src/world/society.js';
import { proceduralPersonName } from '../src/world/terrain.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { tileAt } from '../src/world/spatial.js';
import { HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { clonarPlantillaSintetica } from '../scripts/lib/curva-techo-fixture.js';

/**
 * V18 (carril sociedad): la fisión Dunbar de V17 se deshacía en la misma revisión. En V17 vivo
 * (día 36,83, 661 hab.) «Círculo de Piedra del Oeste» retenía 233 personas y cuatro comunidades
 * nacidas en el paso 88 560 quedaron con UN mortal: los fundadores, aún pegados a la madre,
 * votaban volver a ella en el voto de mayoría que corre justo después de la fisión. Arreglo
 * (sólo con `social.derivaCultural > 0`): gracia de fundación en el voto de mayoría y una
 * segunda pasada de fisión para núcleos densos de más de 96. Con deriva 0 nada se mueve: V23, sin
 * digestos dorados con valor fijo; el control se corre en la propia prueba y se compara con la deriva
 * apagada explícita y con una segunda corrida.
 */
const COM_D = 'social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64';

function emit(w: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => { const result = recordChronicleEvent(w, event); w.events.push(result); return result; };
}
const mortales = (w: World, ids: readonly string[]) => ids.filter(id => w.people.find(p => p.id === id)?.role === 'neighbor').length;

/** Mundo con los habitantes originales aparcados sin vínculos ni comunidad, sin lugares, en tick de revisión. */
function mundoBase(deriva: number): { w: World; plantilla: Person } {
  const w = createWorld(51926, parseParams(`${COM_D},social.derivaCultural=${deriva}`, HISTORICAL_PARAMS));
  w.places = [];
  for (const p of w.people) {
    p.x = 0; p.y = 0; p.target = { x: 0, y: 0 }; p.action = 'rest'; p.decisionAt = 99999; p.bonds = {}; p.communityId = null;
  }
  w.tick = 1200;
  return { w, plantilla: w.people.find(p => p.role === 'neighbor')! };
}
/** Una comunidad `madre` (formada en 0) con quienes se añadan en `colocar`, todos con confianza mutua 0,5. */
function escena(deriva: number, colocar: (add: (id: string, x: number, y: number) => void) => void, lugares: readonly (readonly [number, number])[]): World {
  const { w, plantilla } = mundoBase(deriva);
  const clones: Person[] = [];
  colocar((id, x, y) => {
    const p = clonarPlantillaSintetica(plantilla);
    p.id = id; p.name = `P-${id}`; p.role = 'neighbor';
    p.x = x; p.y = y; p.target = { x, y }; p.action = 'rest'; p.decisionAt = 99999;
    p.bonds = {}; p.communityId = 'madre';
    p.culture = { sharing: 0.6, stewardship: 0.6, openness: 0.6 };
    clones.push(p);
  });
  for (const a of clones) for (const b of clones) if (a !== b) a.bonds[b.id] = 0.5;
  w.people.push(...clones);
  w.communities.push({ id: 'madre', name: 'Madre', x: 40, y: 40, color: '#aaccee', members: clones.map(p => p.id), culture: { sharing: 0.6, stewardship: 0.6, openness: 0.6 }, formedAt: 0, cooperation: 0, disputes: 0 });
  for (const [x, y] of lugares) w.places.push({ id: `lugar-${x}-${y}`, x, y, name: `Lugar ${x},${y}`, description: 'Sintético', gatherings: 0 });
  return w;
}
/** Núcleo de 120 en ±2 alrededor de (40,40). */
const nucleo = (add: (id: string, x: number, y: number) => void) => {
  for (let i = 0; i < 120; i++) add(`n${i}`, 40 + (i % 5) - 2, 40 + (Math.floor(i / 5) % 5) - 2);
};
/** Fisiones de esta revisión: el evento «se separó» con sus fundadores y la comunidad que nació. */
function revisar(w: World): { fundadores: string[][]; nacidas: World['communities'] } {
  const desde = w.events.length;
  updateCommunities(w, emit(w));
  const fundadores = w.events.slice(desde).filter(e => e.kind === 'community' && e.text.includes(' se separó de ')).map(e => [...e.actors]);
  return { fundadores, nacidas: w.communities.filter(c => c.formedAt === w.tick) };
}

/** Escena del fallo de V17: `p` vive a 9 celdas del centro de una madre de 123, y sólo confía de cerca
 * en dos puentes (`a`, `b`) que viven junto al núcleo. La fisión los separa a los tres; en V17 los dos
 * puentes votaban volver a la madre en la misma revisión y `p` quedaba solo: un fantasma de un mortal. */
function escenaPuente(deriva: number): World {
  return escena(deriva, add => { add('p', 49, 40); add('a', 44, 40); add('b', 44, 41); nucleo(add); }, [[40, 40], [48, 40]]);
}

test('(1) fisión Dunbar en una madre de 123: los fundadores no se recapturan y no nace ningún fantasma de 1 mortal', () => {
  const w = escenaPuente(1);
  const { fundadores, nacidas } = revisar(w);
  assert.equal(fundadores.length, 1, 'una fisión: p con sus dos puentes');
  assert.deepEqual([...fundadores[0]!].sort(), ['a', 'b', 'p']);
  assert.equal(nacidas.length, 1);
  const nueva = nacidas[0]!;
  for (const id of fundadores[0]!) assert.equal(w.people.find(p => p.id === id)!.communityId, nueva.id, `${id} sigue en la comunidad que fundó`);
  assert.equal(mortales(w, nueva.members), 3);
  for (const c of nacidas) assert.ok(mortales(w, c.members) >= 3, `${c.name}: ${mortales(w, c.members)} mortal(es) en su revisión de nacimiento`);
  assert.ok(!w.events.some(e => e.text.includes('se unió a Madre')), 'nadie vuelve a la madre en el paso de la fisión');
  assert.equal(w.communities.find(c => c.id === 'madre')!.members.length, 120);
  // Gracia: en las dos revisiones siguientes los puentes, que conviven con alguien de confianza de
  // su comunidad, siguen en ella aunque la madre les rodee.
  for (const tick of [1320, 1440]) {
    w.tick = tick;
    updateCommunities(w, emit(w));
    assert.equal(mortales(w, w.communities.find(c => c.id === nueva.id)?.members ?? []), 3, `tick ${tick}`);
  }
});

test('(1b) el mismo caso con deriva 0 conserva la regla histórica (los puentes vuelven y queda el resto)', () => {
  const w = escenaPuente(0);
  const { fundadores, nacidas } = revisar(w);
  // Con deriva 0 el radio es 12 (nadie está fuera) y no hay fisión: la escena no cambia nada.
  assert.equal(fundadores.length, 0);
  assert.equal(nacidas.length, 0);
  assert.deepEqual(w.communities.map(c => c.members.length), [123]);
});

/** 120 en el núcleo y cuatro satélites de 3 a 7–7,07 celdas: dentro del radio efectivo de la primera
 * pasada (12·√(48/132) ≈ 7,24) y fuera del de núcleo denso (12·√(40/132) ≈ 6,61). */
function escenaDensa(deriva: number): World {
  return escena(deriva, add => {
    nucleo(add);
    for (const [s, dx, dy] of [['e', 1, 0], ['o', -1, 0], ['s', 0, 1], ['n', 0, -1]] as const)
      for (const k of [-1, 0, 1]) add(`sat-${s}${k}`, 40 + dx * 7 + (dy ? k : 0), 40 + dy * 7 + (dx ? k : 0));
  }, [[40, 40], [47, 40], [33, 40], [40, 47], [40, 33]]);
}

test('(2) núcleo urbano denso (> 96): la segunda pasada separa sub-núcleos periféricos con los mismos requisitos', () => {
  const w = escenaDensa(1);
  const { fundadores, nacidas } = revisar(w);
  assert.ok(fundadores.length >= 1 && fundadores.length <= 4, `fisiones: ${fundadores.length} (tope ⌊132/32⌋ = 4)`);
  assert.equal(nacidas.length, fundadores.length);
  for (const c of nacidas) assert.ok(mortales(w, c.members) >= 3, `${c.name}: ${mortales(w, c.members)} mortal(es)`);
  for (const grupo of fundadores) for (const id of grupo)
    assert.ok(nacidas.some(c => c.id === w.people.find(p => p.id === id)!.communityId), `${id} conserva su comunidad nueva`);
  const mayor = Math.max(...w.communities.map(c => c.members.length));
  assert.ok(mayor < 132, `la mayor baja de 132 a ${mayor}`);
  for (const c of w.communities) for (const id of c.members) assert.equal(w.people.find(p => p.id === id)!.communityId, c.id);

  const historico = escenaDensa(0);
  assert.equal(revisar(historico).fundadores.length, 0, 'con deriva 0 el radio es 12 y nadie se separa');
  assert.deepEqual(historico.communities.map(c => c.members.length), [132]);
});

test('(3) con derivaCultural=0 el mundo es el del control y es reproducible', () => {
  const correr = (seed: number, params: string | undefined, pasos: number): string => {
    const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
    for (let i = 0; i < pasos; i++) stepWorld(world);
    return digestoCanonico(world);
  };
  const control = correr(7, undefined, 240);
  assert.equal(correr(7, undefined, 240), control, 'dos corridas del control dan el mismo digesto');
  assert.equal(correr(7, 'social.derivaCultural=0', 240), control, 'deriva=0 explícita = control');
  // COM-D′ (convivencia + disolución) con deriva 0: fisión, mayoría y disolución de siempre.
  const comD = correr(51926, COM_D, 720);
  assert.equal(correr(51926, `${COM_D},social.derivaCultural=0`, 720), comD);
  // Enseñanza por rareza y hogar con trabajo: los caminos optimizados de `practicedRecipeToTeach`
  // (selección lineal en vez de `map` + `sort`) y de `settlementOpportunity` (hogar ya evaluado).
  const rareza = 'social.ensenanzaRareza=0.5,social.hogarTrabajo=0.3';
  assert.equal(correr(42, rareza, 480), correr(42, rareza, 480), 'enseñanza por rareza y hogar: dos corridas');
});

test('(4) proceduralPersonName: sin artículos, determinista, ≤ 70 caracteres y diverso', () => {
  const articulos = /^(El|La|Los|Las|Lo|Un|Una)\b/;
  for (const seed of [1, 42, 51926, 0x7fffffff]) {
    const nombres = new Set<string>(), pila = new Map<string, number>();
    for (let serial = 1; serial <= 4000; serial++) {
      const nombre = proceduralPersonName(seed, serial, serial % 9);
      assert.equal(proceduralPersonName(seed, serial, serial % 9), nombre, 'determinista');
      assert.ok(nombre.length <= 70, nombre);
      assert.doesNotMatch(nombre, articulos, nombre);
      assert.ok(!/\b(El|La|Los|Las)\b/.test(nombre), nombre);
      assert.match(nombre, new RegExp(`^\\p{Lu}\\p{Ll}+ ${serial}$`, 'u'), nombre);
      nombres.add(nombre);
      const nombrePila = nombre.split(' ')[0]!;
      pila.set(nombrePila, (pila.get(nombrePila) ?? 0) + 1);
    }
    assert.equal(nombres.size, 4000, 'el serial hace único el nombre completo');
    assert.ok(pila.size >= 60, `variedad de nombres de pila: ${pila.size}`);
    assert.ok(Math.max(...pila.values()) / 4000 < 0.04, 'ningún nombre de pila domina');
  }
  const porSemilla = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => proceduralPersonName(seed, 389, 2).split(' ')[0]));
  assert.ok(porSemilla.size >= 4, 'la semilla cambia el nombre de pila');
  assert.ok(proceduralPersonName(51926, 1e15, 3).length <= 70);
});

test('(5) stewardship: lo regenerativo sube y lo extractivo baja, con contraste y sin saturar', () => {
  const world = createWorld(51926, parseParams('social.derivaCultural=1', HISTORICAL_PARAMS));
  const plantilla = world.people.find(p => p.role === 'neighbor')!;
  const actor = (stewardship = 0.5) => {
    const p = clonarPlantillaSintetica(plantilla);
    p.genome = structuredClone(p.genome); p.genome.learningRate = 0.5;
    p.culture = { sharing: 0.5, stewardship, openness: 0.5 };
    p.hunger = 0.16; p.thirst = 0.1; p.communityId = 'aldea';
    return p;
  };
  for (const action of ['farm', 'repair', 'build']) {
    const p = actor(); updateCulturalNormsOnOutcome(world, p, action, true);
    assert.ok(p.culture.stewardship > 0.5, `${action} útil sube el cuidado`);
  }
  for (const action of ['hunt', 'gather', 'forage']) {
    const p = actor(); updateCulturalNormsOnOutcome(world, p, action, true);
    assert.ok(p.culture.stewardship < 0.5, `${action} útil con hambre 0,16 baja el cuidado`);
  }
  const saciado = actor(); saciado.hunger = 0.1; updateCulturalNormsOnOutcome(world, saciado, 'forage', true);
  assert.equal(saciado.culture.stewardship, 0.5, 'forrajear sin hambre no cambia el cuidado');
  // Contraste: el mismo paso es mayor cuanto más asentada está la práctica (×1 en 0,5).
  const alto = actor(0.8), medio = actor(0.5);
  updateCulturalNormsOnOutcome(world, alto, 'farm', true); updateCulturalNormsOnOutcome(world, medio, 'farm', true);
  const rate = 0.5 * 0.04;
  assert.equal(medio.culture.stewardship, 0.5 + rate * 1.15 * (0.95 - 0.5) * (1 + 0.4 * (0.5 - 0.5)));
  assert.ok((alto.culture.stewardship - 0.8) / (0.95 - 0.8) > (medio.culture.stewardship - 0.5) / (0.95 - 0.5), 'refuerzo de la práctica');
  // Sin saturar: miles de pasos en un solo sentido se quedan dentro de los topes blandos.
  const constructor = actor(), cazador = actor();
  for (let n = 0; n < 5000; n++) {
    updateCulturalNormsOnOutcome(world, constructor, n % 2 ? 'build' : 'repair', true);
    updateCulturalNormsOnOutcome(world, cazador, n % 2 ? 'hunt' : 'gather', true);
  }
  assert.ok(constructor.culture.stewardship > 0.85 && constructor.culture.stewardship < 0.95, `constructor en ${constructor.culture.stewardship}`);
  assert.ok(cazador.culture.stewardship > 0.08 && cazador.culture.stewardship < 0.2, `cazador en ${cazador.culture.stewardship}`);

  // Con deriva 0, la regla histórica exacta: reparar y construir no tocan el cuidado.
  const historico = createWorld(51926, HISTORICAL_PARAMS);
  for (const action of ['repair', 'build', 'hunt']) {
    const p = actor(); updateCulturalNormsOnOutcome(historico, p, action, true);
    assert.equal(p.culture.stewardship, 0.5, action);
  }
  const agricultor = actor(); updateCulturalNormsOnOutcome(historico, agricultor, 'farm', true);
  assert.equal(agricultor.culture.stewardship, 0.5 + rate);
});

/** Mundo abierto del anfitrión (`hostOpenWorldParams`, motor serial) con una multitud de 150 que
 * comparte comunidad alrededor del primer lugar: la megacomunidad de V17 en pequeño. */
function multitud(seed: number): World {
  const w = createWorld(seed, parseParams('motor.hilos=1,motor.particionarPersonas=false', hostOpenWorldParams()));
  const plantilla = w.people.find(p => p.role === 'neighbor')!;
  const base = w.places[0]!;
  const libres: { x: number; y: number }[] = [];
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    const t = tileAt(w, { x: base.x + dx, y: base.y + dy });
    if (t && t.terrain !== 'water') libres.push({ x: t.x, y: t.y });
  }
  const clones: Person[] = [];
  for (let i = 0; i < 150; i++) {
    const t = libres[(i * 7) % libres.length]!, p = clonarPlantillaSintetica(plantilla);
    p.id = `m-${i}`; p.name = proceduralPersonName(seed, i, 1); p.role = 'neighbor';
    p.x = t.x; p.y = t.y; p.target = { x: t.x, y: t.y }; p.bonds = {}; p.communityId = 'madre';
    p.culture = { sharing: 0.55, stewardship: 0.5, openness: 0.5 };
    clones.push(p);
  }
  for (const a of clones) for (const b of clones) if (a !== b) a.bonds[b.id] = 0.5;
  w.people.push(...clones);
  w.communities.push({ id: 'madre', name: 'Madre', x: base.x, y: base.y, color: '#aaccee', members: clones.map(p => p.id), culture: { sharing: 0.55, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 0, disputes: 0 });
  return w;
}

/** Una revisión por cada 120 pasos durante `dias`: cuenta comunidades nacidas y las de ≤ 1 mortal. */
for (const seed of [51926, 42]) test(`(6) mundo abierto con multitud, semilla ${seed}: 0 fantasmas recién fisionados, megacomunidad acotada y cuidado divergente sin saturar`, () => {
  const w = multitud(seed);
  const dias = 1;
  let nuevas = 0, fantasmas = 0;
  for (let i = 0; i < dias * 2400; i++) {
    stepWorld(w);
    if (w.tick % 120 !== 0) continue;
    for (const c of w.communities) if (c.formedAt === w.tick) {
      nuevas++;
      if (mortales(w, c.members) <= 1) fantasmas++;
    }
  }
  assert.ok(nuevas >= 3, `fisiones y fundaciones: ${nuevas}`);
  assert.equal(fantasmas, 0, 'comunidades de ≤ 1 mortal en su revisión de nacimiento');
  // La multitud empieza toda en una comunidad (150 de ~170, 0,88): al cabo del día ya no domina.
  const share = Math.max(...w.communities.map(c => c.members.length)) / w.people.length;
  assert.ok(share < 0.5, `la mayor retiene ${share.toFixed(3)} de ${w.people.length}`);
  const steward = w.people.map(p => p.culture.stewardship);
  assert.ok(Math.min(...steward) > 0.05 && Math.max(...steward) < 0.98, `cuidado en [${Math.min(...steward).toFixed(3)}, ${Math.max(...steward).toFixed(3)}]`);
  const grupos = w.communities.filter(c => c.members.length >= 3).map(c => c.culture.stewardship);
  const media = grupos.reduce((a, b) => a + b, 0) / grupos.length;
  const sd = Math.sqrt(grupos.reduce((a, b) => a + (b - media) ** 2, 0) / grupos.length);
  assert.ok(grupos.length >= 3 && sd > 0.005, `el cuidado diverge entre ${grupos.length} comunidades (sd ${sd.toFixed(4)})`);
  console.log(JSON.stringify({ seed, poblacion: w.people.length, comunidades: w.communities.length, nuevas, fantasmas, share: +share.toFixed(3), stewInterSd: +sd.toFixed(4) }));
});
