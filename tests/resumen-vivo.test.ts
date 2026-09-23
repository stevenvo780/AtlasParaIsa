import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { demographicTraits } from '../src/world/demography.js';
import { paramsOf } from '../src/world/params.js';
import { RAZON_CORTEJO, RAZON_PREPARA, RAZON_REUNION, RESERVA_PARA_CRIAR, aQuienBusca, fertilidad, resumenNatalidad, resumenVivo } from '../src/server/resumen-vivo.js';
import { enriquecerPersona } from '../src/server/persona-extra.js';

function mundo(ticks: number): World { const world = createWorld(51926); for (let i = 0; i < ticks; i++) stepWorld(world); return world; }

/** Recuento independiente de la ley corporal (demography.ts `eligible` + enfriamiento de family.ts). */
function fertilesAMano(world: World): number {
  let n = 0;
  for (const p of world.people) {
    if (p.role !== 'neighbor') continue;
    const t = demographicTraits(p.genome, paramsOf(world).cuerpo), d = p.demography;
    if (d.age >= t.maturityAge && d.age < t.senescenceStart && world.tick - p.lastBirth >= t.fertilityCooldown && d.health >= 0.55 && d.vitality >= 0.5
      && p.hunger <= 0.45 && p.thirst <= 0.45 && p.energy >= 0.6 && p.fatigue <= 0.65) n++;
  }
  return n;
}

test('M4: el resumen de natalidad coincide con un recuento a mano y su tamaño no depende de la población', () => {
  const world = mundo(300);
  const n = resumenNatalidad(world);
  assert.equal(n.tick, world.tick);
  assert.equal(n.fertiles, fertilesAMano(world));
  assert.equal(n.cortejando, world.people.filter(p => p.action === 'approach' && p.reason.startsWith(RAZON_CORTEJO)).length);
  const ley = paramsOf(world).poblacion;
  assert.deepEqual(n.ley, { radioPareja: ley.radioPareja, radioLugar: ley.radioLugar, radioCortejo: ley.cortejo > 0 ? ley.radioCortejo : 0, exigeComunidad: ley.exigeComunidad, reserva: RESERVA_PARA_CRIAR });
  // Cada ficha explica su bloqueo; «ahora» o un bloqueo posterior a la ley corporal = fértil.
  for (const p of world.people.filter(p => p.role === 'neighbor')) {
    const f = fertilidad(world, p);
    assert.equal(f.ahora || ['reserva', 'comunidad', 'techo'].includes(String(f.bloqueo)), fertilesAMano({ ...world, people: [p] } as World) === 1, `${p.id}: ${f.bloqueo}`);
  }
  assert.equal(fertilidad(world, world.people.find(p => p.role === 'S')!).bloqueo, 'no-vecino');
  const bytes = Buffer.byteLength(JSON.stringify(resumenVivo(world)));
  assert.ok(bytes < 220, `el resumen pesa ${bytes} B`);
});

test('M4: consultar la natalidad y las fichas no cambia el mundo ni su trayectoria', () => {
  const a = mundo(120), b = mundo(120);
  for (let i = 0; i < 80; i++) {
    stepWorld(a); stepWorld(b);
    if (i % 10 === 0) { resumenVivo(a); for (const p of a.people) { fertilidad(a, p); aQuienBusca(a, p); enriquecerPersona(a, p.id); } }
  }
  assert.equal(digestoCanonico(a), digestoCanonico(b));
});

test('M4: los prefijos de intención son los que escribe la ley (contrato con world/index.ts)', () => {
  const source = readFileSync(new URL('../src/world/index.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('reason: `' + RAZON_CORTEJO + '${'), 'el cortejo empieza así en decide()');
  assert.ok(source.includes('reason: `' + RAZON_REUNION + '${'), 'la reunión para criar empieza así');
  assert.ok(source.includes('reason: `' + RAZON_PREPARA + '${'), 'la preparación de reservas empieza así');
  assert.match(source, /function fertile\(world: World, person: Person\): boolean \{\n\s+return person\.inventory >= 0\.1 &&/, `la reserva para criar es ${RESERVA_PARA_CRIAR}`);
});

test('M4: en un mundo sembrado real, dos vecinos fértiles con vínculo mutuo y lejos se cortejan, y la ficha dice a quién', () => {
  const world = createWorld(51926);
  assert.ok(paramsOf(world).poblacion.cortejo > 0, 'reglas 10: el cortejo está activo en mundos nuevos');
  // Cuerpos descansados y nutridos; la edad de cada fundador la decide su genoma, así que se eligen dos
  // que ya estén en edad fértil según la propia ley.
  for (const p of world.people.filter(p => p.role === 'neighbor')) {
    Object.assign(p, { hunger: 0.05, thirst: 0.05, energy: 0.95, fatigue: 0.05, inventory: 0.2, lastBirth: -1_000_000, communityId: null, decisionAt: 0 });
    p.demography.health = 1; p.demography.vitality = 1;
  }
  const [a, b] = world.people.filter(p => p.role === 'neighbor' && fertilidad(world, p).ahora);
  assert.ok(a && b, 'hay dos fundadores en edad fértil');
  const radio = paramsOf(world).poblacion.radioPareja;
  const lejos = world.tiles.find(t => t.terrain !== 'water' && Math.hypot(t.x - a!.x, t.y - a!.y) > radio + 2 && Math.hypot(t.x - a!.x, t.y - a!.y) < 20)!;
  assert.ok(lejos, 'hay tierra a media distancia');
  b!.x = lejos.x; b!.y = lejos.y; b!.target = { x: lejos.x, y: lejos.y };
  a!.bonds[b!.id] = 0.9; b!.bonds[a!.id] = 0.9;
  stepWorld(world);
  const who = [a!, b!].find(p => p.reason.startsWith(RAZON_CORTEJO));
  assert.ok(who, `alguno corteja: «${a!.reason}» / «${b!.reason}»`);
  assert.equal(who.action, 'approach');
  const other = who === a ? b! : a!;
  assert.deepEqual(aQuienBusca(world, who), { id: other.id, name: other.name, motivo: 'cortejo' });
  assert.equal(enriquecerPersona(world, who.id)!.busca?.id, other.id);
  assert.ok(resumenNatalidad(world).cortejando >= 1);
});
