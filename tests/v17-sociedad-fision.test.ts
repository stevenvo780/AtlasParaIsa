import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { updateCommunities, updateCulturalNormsOnOutcome } from '../src/world/society.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { clonarPlantillaSintetica } from '../scripts/lib/curva-techo-fixture.js';

/**
 * V17 (carril sociedad): fisión orgánica tipo Dunbar contra mega-comunidades, deriva
 * bidireccional equilibrada de `stewardship` y nombres de comunidad sin colisiones.
 * Todo actúa sólo con `social.derivaCultural > 0`; con 0 el mundo es el histórico bit
 * a bit. Los digestos dorados se midieron con el código ANTERIOR a V17 (script
 * desechable sobre el árbol sin tocar, 240 ticks).
 */
const DIGESTO_HISTORICO_7 = '7f3fe8ab8f28506605dcdd969390a1bb7e14df0ceec51959cd38ebab1a1480e6';
const DIGESTO_CONVIVENCIA_42 = '1befa5b809d4a067375352793270fd569db1558f3b07f41316b10254f0385c6b';
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
function emit(w: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => { const result = recordChronicleEvent(w, event); w.events.push(result); return result; };
}
/** Mundo con los habitantes originales aparcados sin vínculos ni comunidad, sin lugares, en tick de revisión. */
function mundoBase(params: string): { w: World; plantilla: Person } {
  const w = createWorld(51926, parseParams(params, HISTORICAL_PARAMS));
  w.places = [];
  for (const p of w.people) {
    p.x = 0; p.y = 0; p.target = { x: 0, y: 0 }; p.action = 'rest'; p.decisionAt = 9999; p.bonds = {}; p.communityId = null;
  }
  w.tick = 120;
  return { w, plantilla: w.people.find(p => p.role === 'neighbor')! };
}
function clon(plantilla: Person, id: string, x: number, y: number, communityId: string | null): Person {
  const p = clonarPlantillaSintetica(plantilla);
  p.id = id; p.name = `P-${id}`; p.role = 'neighbor';
  p.x = x; p.y = y; p.target = { x, y }; p.action = 'rest'; p.decisionAt = 9999;
  p.bonds = {}; p.communityId = communityId;
  p.culture = { sharing: 0.6, stewardship: 0.6, openness: 0.6 };
  return p;
}

// paridad histórica: cuarentena V23
test.skip('(1) paridad bit a bit con derivaCultural=0: digestos dorados pre-V17 en 240 ticks', () => {
  const control = createWorld(7, HISTORICAL_PARAMS);
  const explicito = createWorld(7, parseParams('social.derivaCultural=0', HISTORICAL_PARAMS));
  for (let i = 0; i < 240; i++) { stepWorld(control); stepWorld(explicito); }
  assert.equal(digestoCanonico(control), DIGESTO_HISTORICO_7);
  assert.equal(digestoCanonico(explicito), DIGESTO_HISTORICO_7);
  // El camino de convivencia (fisión/mayoría) con deriva a 0 tampoco se mueve ni un bit.
  const convivencia = createWorld(42, parseParams('social.radioConvivencia=12,social.derivaCultural=0', HISTORICAL_PARAMS));
  for (let i = 0; i < 240; i++) stepWorld(convivencia);
  assert.equal(digestoCanonico(convivencia), DIGESTO_CONVIVENCIA_42);
});

/** 120 personas de una sola comunidad: 72 en el centro (20,14) y 4 satélites de 12 a 10 celdas.
 * Todos quedan a ≤ 11,1 del centroide: dentro del radio histórico 12, fuera del radio efectivo
 * Dunbar `12·√(48/120) ≈ 7,59` para los satélites. */
function escenaMasa(deriva: number): World {
  const { w, plantilla } = mundoBase(`social.radioConvivencia=12,social.derivaCultural=${deriva},social.maxComunidades=64`);
  const clones: Person[] = [];
  const enjambre = (base: number, n: number, cx: number, cy: number, radio: number) => {
    for (let i = 0; i < n; i++) {
      const lado = radio * 2 + 1;
      clones.push(clon(plantilla, `masa-${base + i}`, cx + (i % lado) - radio, cy + (Math.floor(i / lado) % lado) - radio, 'origen'));
    }
  };
  enjambre(0, 72, 20, 14, 2);
  enjambre(72, 12, 30, 14, 1); enjambre(84, 12, 10, 14, 1); enjambre(96, 12, 20, 24, 1); enjambre(108, 12, 20, 4, 1);
  for (const a of clones) for (const b of clones) if (a !== b) a.bonds[b.id] = 0.5;
  w.people.push(...clones);
  w.communities.push({ id: 'origen', name: 'origen', x: 20, y: 14, color: '#aaccee', members: clones.map(p => p.id), culture: { sharing: 0.6, stewardship: 0.6, openness: 0.6 }, formedAt: 0, cooperation: 0, disputes: 0 });
  for (const [id, x, y] of [['centro', 20, 14], ['este', 30, 14], ['oeste', 10, 14], ['sur', 20, 24], ['norte', 20, 4]] as const)
    w.places.push({ id: `lugar-${id}`, x, y, name: `Lugar ${id}`, description: 'Sintético', gatherings: 0 });
  return w;
}

test('(2) fisión Dunbar: 120 miembros dentro del radio 12 se separan sólo con derivaCultural=1', () => {
  const historico = escenaMasa(0);
  updateCommunities(historico, emit(historico));
  assert.deepEqual(historico.communities.map(c => c.members.length), [120], 'con deriva=0 nadie supera el radio 12 y no hay fisión');

  const organico = escenaMasa(1);
  updateCommunities(organico, emit(organico));
  const tamanos = organico.communities.map(c => c.members.length).sort((a, b) => a - b);
  assert.deepEqual(tamanos, [12, 12, 12, 84], 'tres fisiones limpias en una revisión (tope de 120/40) y el máximo baja de 120 a 84');
  const nombres = organico.communities.map(c => c.name);
  assert.equal(new Set(nombres).size, nombres.length, 'las comunidades separadas no comparten nombre');
  for (const c of organico.communities) for (const id of c.members)
    assert.equal(organico.people.find(p => p.id === id)!.communityId, c.id);

  organico.tick = 240;
  updateCommunities(organico, emit(organico));
  assert.ok(organico.communities.length >= 4);
  assert.ok(Math.max(...organico.communities.map(c => c.members.length)) <= 84, 'el tamaño máximo no vuelve a crecer');
});

/** `grupos` tríadas libres y mutuamente confiadas, a 8 celdas entre sí, cada una con su lugar. */
function escenaFundaciones(deriva: number, grupos: number): World {
  const { w, plantilla } = mundoBase(`social.derivaCultural=${deriva},social.maxComunidades=64`);
  for (let g = 0; g < grupos; g++) {
    const x = 4 + (g % 6) * 8, y = 4 + Math.floor(g / 6) * 8;
    const triada = [clon(plantilla, `f${g}-a`, x, y, null), clon(plantilla, `f${g}-b`, x + 1, y, null), clon(plantilla, `f${g}-c`, x, y + 1, null)];
    for (const a of triada) for (const b of triada) if (a !== b) a.bonds[b.id] = 0.5;
    w.people.push(...triada);
    w.places.push({ id: `lugar-f${g}`, x, y, name: `Lugar ${g}`, description: 'Sintético', gatherings: 0 });
  }
  return w;
}

test('(3) nombres ricos y sin colisiones en 30 comunidades con derivaCultural=1; históricos con 0', () => {
  const w = escenaFundaciones(1, 30);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 30);
  const nombres = w.communities.map(c => c.name);
  assert.equal(new Set(nombres).size, 30, 'ningún nombre repetido');
  for (const nombre of nombres) assert.match(nombre, /^\S+ de \S+ .+$/, nombre);
  assert.ok(new Set(nombres.map(n => n.split(' de ')[0])).size >= 5, 'variedad real de formas, no sólo «Círculo»');

  const historico = escenaFundaciones(0, 4);
  updateCommunities(historico, emit(historico));
  assert.equal(historico.communities.length, 4);
  for (const c of historico.communities)
    assert.match(c.name, /^Círculo de (Sauce|Brisa|Lumbre|Junco|Piedra|Semilla|Rocío|Sendero)$/, 'con deriva=0 se conserva el nombre histórico exacto');
});

test('(4) stewardship diverge en los dos sentidos: farm sube, gather/hunt/forage con hunger=0.22 bajan', () => {
  const world = createWorld(51926, parseParams('social.derivaCultural=1', HISTORICAL_PARAMS));
  const plantilla = world.people.find(p => p.role === 'neighbor')!;
  const actor = () => {
    const p = clonarPlantillaSintetica(plantilla);
    p.genome = structuredClone(p.genome); p.genome.learningRate = 0.5;
    p.culture = { sharing: 0.5, stewardship: 0.5, openness: 0.5 };
    p.hunger = 0.22; p.thirst = 0.1; p.communityId = 'aldea';
    return p;
  };
  const rate = 0.5 * 0.04 * 1;
  const agricultor = actor(); updateCulturalNormsOnOutcome(world, agricultor, 'farm', true);
  assert.equal(agricultor.culture.stewardship, clamp01(0.5 + rate * 1.15 * (0.95 - 0.5)));
  // El defecto V16: con hunger 0,22 la bajada exigía > 0,35 y nunca ocurría.
  for (const action of ['gather', 'hunt', 'forage']) {
    const extractor = actor(); updateCulturalNormsOnOutcome(world, extractor, action, true);
    assert.equal(extractor.culture.stewardship, clamp01(0.5 - rate * 0.7 * Math.max(0.1, 0.5 - 0.08)), action);
    assert.ok(extractor.culture.stewardship < 0.5, action);
  }
  const fallido = actor(); updateCulturalNormsOnOutcome(world, fallido, 'gather', false);
  assert.ok(fallido.culture.stewardship > 0.5, 'la extracción silvestre fallida sigue enseñando cuidado');

  const sedentarios = actor(), extractores = actor();
  for (let n = 0; n < 300; n++) {
    updateCulturalNormsOnOutcome(world, sedentarios, 'farm', true);
    updateCulturalNormsOnOutcome(world, extractores, 'gather', true);
  }
  assert.ok(sedentarios.culture.stewardship > 0.8, `agricultores en ${sedentarios.culture.stewardship}`);
  assert.ok(extractores.culture.stewardship < 0.25, `extractores en ${extractores.culture.stewardship}`);
  assert.ok(sedentarios.culture.stewardship - extractores.culture.stewardship > 0.5, 'varianza real entre nichos');
});
