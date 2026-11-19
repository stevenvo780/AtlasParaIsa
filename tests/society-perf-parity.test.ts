import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createWorld, stepWorld, cloneWorld, type World, type Person } from '../src/world/index.js';
import { updateCommunities, culturalDistance } from '../src/world/society.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams } from '../src/world/params.js';
import { clonarPlantillaSintetica } from '../scripts/lib/curva-techo-fixture.js';

/** Reference O(|G|^2) implementation of the pre-optimization exit trust calculation. */
function referenceExitTrust(person: Person, members: readonly Person[], communityId: string): number {
  const peers = members.filter(p => p !== person && p.communityId === communityId);
  return peers.length ? peers.reduce((sum, p) => sum + (person.bonds[p.id] ?? 0.2), 0) / peers.length : 0.2;
}

test('society O(|G|) exit: matches reference O(|G|^2) decision bit-for-bit including threshold boundary', () => {
  const params = parseParams('social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64,social.confianzaSalida=0.35,social.distanciaAlternativa=0.5');
  const world = createWorld(51926, params);
  const template = world.people.find(p => p.genome.generation === 0 && p.role === 'neighbor')!;
  const communityId = 'community-test';
  world.communities = [
    {
      id: communityId, name: 'Círculo Test', x: template.x, y: template.y,
      members: [], color: '#aa7c52',
      culture: { sharing: 0.95, stewardship: 0.95, openness: 0.95 },
      formedAt: 0, cooperation: 0, disputes: 0,
    },
    {
      id: 'community-alt', name: 'Círculo Alt', x: template.x + 1, y: template.y,
      members: [], color: '#6b8e78',
      culture: { sharing: 0.05, stewardship: 0.05, openness: 0.05 },
      formedAt: 0, cooperation: 0, disputes: 0,
    },
  ];
  // 2 alternative contacts outside community-test
  const altIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = clonarPlantillaSintetica(template);
    p.id = `alt-${i}`; p.name = `Alt${i}`; p.x = template.x + 1; p.y = template.y;
    p.communityId = 'community-alt';
    p.culture = { sharing: 0.05, stewardship: 0.05, openness: 0.05 };
    world.people.push(p);
    altIds.push(p.id);
  }
  // 200 members in community-test with divergent culture and varied bonds (including exact boundary ~0.35)
  const testMembers: Person[] = [];
  for (let i = 0; i < 200; i++) {
    const p = clonarPlantillaSintetica(template);
    p.id = `mem-${i}`; p.name = `Mem${i}`; p.x = template.x; p.y = template.y;
    p.communityId = communityId;
    p.culture = { sharing: 0.05, stewardship: 0.05, openness: 0.05 };
    p.bonds = {};
    for (const a of altIds) p.bonds[a] = 0.8;
    world.people.push(p);
    testMembers.push(p);
  }
  // Craft bonds: some below threshold, some right at 0.35 (exercises MARGEN_MEDIA_CONFIANZA fallback!), some above
  for (let i = 0; i < testMembers.length; i++) {
    const p = testMembers[i]!;
    if (i % 3 === 0) {
      // Sparse low bonds -> well below 0.35
      p.bonds[testMembers[(i + 1) % testMembers.length]!.id] = 0.05;
    } else if (i % 3 === 1) {
      // Boundary: target average ~0.35 across ~199 peers (need extra ~0.15*199 = 29.85 -> 38 peers at 0.985)
      for (let k = 1; k <= 38; k++) p.bonds[testMembers[(i + k) % testMembers.length]!.id] = 0.985;
    } else {
      // Well above 0.35
      for (let k = 1; k <= 120; k++) p.bonds[testMembers[(i + k) % testMembers.length]!.id] = 0.9;
    }
  }
  world.communities[0]!.members = testMembers.map(p => p.id);
  world.communities[1]!.members = altIds;
  world.tick = 120;

  // Compute expected exit sequence using the exact original O(|G|^2) loop
  const refWorld = cloneWorld(world);
  const refInitial = refWorld.people.filter(p => p.communityId === communityId);
  const expectedLeft: string[] = [];
  for (const person of refWorld.people) {
    const group = refWorld.communities.find(c => c.id === person.communityId);
    if (!group || culturalDistance(person.culture, group.culture) < 0.3) continue;
    const trust = referenceExitTrust(person, refInitial, group.id);
    if (trust < 0.35) {
      person.communityId = null;
      expectedLeft.push(person.id);
    }
  }
  assert.ok(expectedLeft.length > 50 && expectedLeft.length < 150, `expected mixed exits/stays, got ${expectedLeft.length}`);

  const emittedLeft: string[] = [];
  updateCommunities(world, (event) => {
    if (event.kind === 'community' && event.text.includes('dejó Círculo Test y buscó')) {
      emittedLeft.push(event.actors[0]!);
    }
    return { id: `ev-${emittedLeft.length}`, tick: world.tick, ...event };
  });
  assert.deepEqual(emittedLeft, expectedLeft, 'optimized O(|G|) exit must leave the exact same people in exact slot order');
});

test('society O(|G|) exit: 2000-member community completes linearly without quadratic blowup', () => {
  const params = parseParams('social.radioConvivencia=0,social.confianzaSalida=0.35,social.distanciaAlternativa=0.5');
  const world = createWorld(7, params);
  const template = world.people.find(p => p.genome.generation === 0 && p.role === 'neighbor')!;
  const communityId = 'community-big';
  world.communities = [{
    id: communityId, name: 'Círculo Grande', x: template.x, y: template.y,
    members: [], color: '#aa7c52',
    culture: { sharing: 0.95, stewardship: 0.95, openness: 0.95 },
    formedAt: 0, cooperation: 0, disputes: 0,
  }];
  for (let i = 0; i < 2000; i++) {
    const p = clonarPlantillaSintetica(template);
    p.id = `big-${i}`; p.name = `Big${i}`; p.x = template.x; p.y = template.y;
    p.communityId = communityId;
    p.culture = { sharing: 0.05, stewardship: 0.05, openness: 0.05 };
    p.bonds = { [`big-${(i + 1) % 2000}`]: 0.5, [`big-${(i + 2) % 2000}`]: 0.1 };
    world.people.push(p);
  }
  world.communities[0]!.members = world.people.filter(p => p.communityId === communityId).map(p => p.id);
  world.tick = 120;

  const t0 = performance.now();
  updateCommunities(world, (event) => ({ id: 'ev', tick: world.tick, ...event }));
  const elapsedMs = performance.now() - t0;
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs < 5000, `2000-member updateCommunities took ${elapsedMs.toFixed(2)}ms`);
});

test('society optimization preserves exact canonical digest on V14 COM+COM-D simulation', () => {
  const params = parseParams('social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64');
  const a = createWorld(51926, params);
  const b = createWorld(51926, params);
  for (let i = 0; i < 600; i++) {
    stepWorld(a, []);
    stepWorld(b, []);
  }
  assert.equal(digestoCanonico(a), digestoCanonico(b));
});
