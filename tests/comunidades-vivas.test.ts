import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { assertWorld, cloneWorld, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { updateCommunities } from '../src/world/society.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import type { ChronicleEvent } from '../src/shared/types.js';

/**
 * Hipótesis COM (noche 2026-09-22), ley candidata `social.radioConvivencia`: la pertenencia a una
 * comunidad es con quién convivo y en quién confío, no una etiqueta de nacimiento. Con el default 0
 * `updateCommunities` es la de hoy bit a bit; con > 0 (a) un núcleo de confianza que vive a más de ese
 * radio del centro de su comunidad funda la suya, y (b) cada cual pasa a —o, sin comunidad, se une a—
 * la comunidad de la mayoría de sus vecinos de confianza.
 */

const LAB = 'poblacion.cortejo=1,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';

/** Réplica mínima de laboratorio (Store temporal guardado ANTES del primer paso, como
 * `scripts/lab/replica.ts`). Cuenta, en cada revisión de comunidades, los cambios de pertenencia
 * de una comunidad a otra. Parte de `HISTORICAL_PARAMS` explícitos (reglas 10, etapa 1): la ley se
 * midió sobre el mundo de antes, y con los defaults nuevos `LAB` heredaría además `poblacion.radioCortejo=128`. */
function replica(t: { after(callback: () => void): void }, pasos: number, params: string | undefined, seed: number) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-com-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
  store.save(world);
  let cambios = 0;
  let antes = new Map(world.people.map(p => [p.id, p.communityId]));
  for (let tick = 1; tick <= pasos; tick++) {
    stepWorld(world);
    if (world.tick % 120 !== 0) continue;
    for (const person of world.people) {
      const previa = antes.get(person.id);
      if (previa && person.communityId && previa !== person.communityId) cambios++;
    }
    antes = new Map(world.people.map(p => [p.id, p.communityId]));
  }
  return { world, cambios };
}

/** Digesto del mundo medido con la FORMA de params de antes de esta ley (sin `social.radioConvivencia`):
 * `digestoCanonico` hashea también los params, así que declarar la clave mueve el hash completo aunque
 * el estado físico sea idéntico (T102). Quitarla reproduce el digesto de antes byte a byte. */
function digestoSinLaClave(world: World): string {
  const vigentes = paramsOf(world);
  const antes = structuredClone(vigentes) as unknown as { social: Record<string, unknown> };
  delete antes.social.radioConvivencia;
  // Fusión CONFL (`sprint/noche-lab60c-20260922`): `social.memoriaDisputa` no existía en f2757fa, donde se
  // midieron los hashes; con su valor 0 no actúa, así que también se quita de la forma.
  assert.equal(antes.social.memoriaDisputa, 0);
  delete antes.social.memoriaDisputa;
  assert.equal(antes.social.hogarTrabajo, 0);
  delete antes.social.hogarTrabajo;
  // Campaña C8 (H-A, `conducta.vocacion`/`vocacionTope`): claves posteriores a la medida; con ε = 0 no actúan.
  { const c = (antes as unknown as { conducta: Record<string, unknown> }).conducta; assert.equal(c.vocacion, 0); assert.equal(c.vocacionTope, 0.9); delete c.vocacion; delete c.vocacionTope; }
  setParams(world, antes as unknown as WorldParams);
  const version = world.version;
  // La referencia V10 mide este mismo estado; sólo normalizamos su etiqueta al hashear.
  world.version = 10;
  try { return digestoCanonico(world); } finally { world.version = version; setParams(world, vigentes); }
}

// Los hashes originales se midieron en `sprint/noche-hcom-20260922` @f666226 ANTES de tocar `src/world`,
// antes de la consolidación R2; allí la forma de params y la etiqueta V10 (alias de fundación) aún no
// existían, así que dejaron de corresponder en la propia base f2757fa (6d37cc5a… y a98872e9… fallaban ya
// allí). Regenerados el 2026-09-22 (reglas 10, etapa 1) DESDE UNA EXPORTACIÓN LIMPIA de la base f2757fa,
// nunca desde el árbol modificado, con la misma réplica (seed 42, 1200 pasos), campo `fisico`:
//   git archive f2757fa | tar -x -C /tmp/base-f2757fa && ln -s "$PWD/node_modules" /tmp/base-f2757fa/node_modules \
//     && cp scripts/lab/digesto-control.ts /tmp/base-f2757fa/scripts/lab/ && cd /tmp/base-f2757fa \
//     && npx tsx scripts/lab/digesto-control.ts --seed 42 --pasos 1200 --sin social.radioConvivencia \
//     && npx tsx scripts/lab/digesto-control.ts --seed 42 --pasos 1200 --params "$LAB" --sin social.radioConvivencia
// (en f2757fa `DEFAULT_PARAMS` es exactamente `HISTORICAL_PARAMS`).
const DIGESTO_PREVIO_DEFAULTS = '481e7358b62d0bead6b96848574eb7dbc8992c8226893fea42c6cfd606096a03';
const DIGESTO_PREVIO_LAB = '48e7eacfeb9b2d06f0167ca36f198fcbe0858a980b878f019a978fc93b291751';

test('(i) con radioConvivencia=0 el mundo es el de antes bit a bit, con params históricos y con los params del carril', { timeout: 2_800_000 }, t => {
  assert.equal(DEFAULT_PARAMS.social.radioConvivencia, 0, 'reglas 10 no adopta las comunidades vivas');
  assert.equal(HISTORICAL_PARAMS.social.radioConvivencia, 0);
  const defecto = replica(t, 1200, undefined, 42);
  assert.equal(digestoSinLaClave(defecto.world), DIGESTO_PREVIO_DEFAULTS);
  const carril = replica(t, 1200, LAB, 42);
  assert.equal(digestoSinLaClave(carril.world), DIGESTO_PREVIO_LAB);
  assert.equal(carril.cambios, 0, 'hoy nadie cambia de una comunidad a otra');
});

test('(ii) con radioConvivencia=12 las comunidades cambian en la semilla 42 y el mundo sigue siendo válido', { timeout: 2_800_000 }, t => {
  const vivo = replica(t, 1200, `${LAB},social.radioConvivencia=12`, 42);
  assert.notEqual(digestoSinLaClave(vivo.world), DIGESTO_PREVIO_LAB, 'la ley actúa: el estado físico cambia');
  assert.ok(vivo.cambios > 0, 'alguien pasa a la comunidad de sus vecinos de confianza');
  assertWorld(vivo.world);
  for (const person of vivo.world.people) if (person.communityId)
    assert.ok(vivo.world.communities.find(c => c.id === person.communityId)?.members.includes(person.id), `${person.id} no figura en su comunidad`);
});

function emit(w: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => { const result = recordChronicleEvent(w, event); w.events.push(result); return result; };
}
/** Escena sintética: todos lejos (sin vínculos ni comunidad) y sin lugares, salvo lo que el test coloca. */
function escena() {
  const w = createWorld(51926);
  w.places = [];
  for (const p of w.people) {
    p.x = 20; p.y = 26; p.target = { x: 20, y: 26 }; p.action = 'rest'; p.decisionAt = 999; p.bonds = {}; p.communityId = null;
    p.culture = { sharing: 0.6, stewardship: 0.6, openness: 0.6 };
  }
  w.tick = 120;
  return w;
}
function en(personas: Person[], x: number, y: number) { for (const p of personas) { p.x = x; p.y = y; p.target = { x, y }; } }
function confian(personas: Person[]) { for (const a of personas) for (const b of personas) if (a !== b) a.bonds[b.id] = 0.5; }
function comunidad(w: World, miembros: Person[], id: string) {
  for (const p of miembros) p.communityId = id;
  w.communityCounter++;
  w.communities.push({ id, name: id, x: miembros[0]!.x, y: miembros[0]!.y, color: '#aaccee', members: miembros.map(p => p.id), culture: { sharing: 0.6, stewardship: 0.6, openness: 0.6 }, formedAt: 0, cooperation: 0, disputes: 0 });
}
const con = (w: World, clave: string) => setParams(w, parseParams(clave));

test('(iii) fisión: un núcleo de confianza que vive lejos del centro funda su comunidad; con 0 no pasa nada', () => {
  const w = escena(), gente = w.people.slice(2, 10), cerca = gente.slice(0, 5), lejos = gente.slice(5);
  en(cerca, 8, 14); en(lejos, 34, 14); confian(gente); comunidad(w, gente, 'origen');
  w.places.push({ id: 'lugar-lejano', x: 34, y: 14, name: 'Lugar lejano', description: 'Sintético', gatherings: 0 });
  // Centro del grupo: x = (5·8 + 3·34)/8 = 17,75 → los cinco a 9,75 celdas y los tres a 16,25.
  const hoy = cloneWorld(w);
  updateCommunities(hoy, emit(hoy));
  assert.deepEqual(hoy.communities.map(c => c.members.length), [8], 'con el default la etiqueta no se mueve');

  const amplio = cloneWorld(w); con(amplio, 'social.radioConvivencia=20');
  updateCommunities(amplio, emit(amplio));
  assert.deepEqual(amplio.communities.map(c => c.members.length), [8], 'a 16 celdas con radio 20 todavía conviven');

  con(w, 'social.radioConvivencia=12');
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 2);
  const origen = w.communities.find(c => c.id === 'origen')!, nueva = w.communities.find(c => c.id !== 'origen')!;
  assert.deepEqual([...origen.members].sort(), cerca.map(p => p.id).sort(), 'el grupo de origen conserva a quienes viven cerca de su centro');
  assert.deepEqual([...nueva.members].sort(), lejos.map(p => p.id).sort(), 'el núcleo lejano se separa entero');
  assert.equal(nueva.formedAt, 120);
  const evento = w.events.at(-1)!;
  assert.match(evento.text, /se separó de origen/);
  assert.match(evento.cause, /16\.3 celdas del centro/);
});

test('(iv) fisión: sin lugar cercano, con el tope de comunidades o sin núcleo de tres, no hay fisión', () => {
  const base = escena(), gente = base.people.slice(2, 10);
  en(gente.slice(0, 5), 8, 14); en(gente.slice(5), 34, 14); confian(gente); comunidad(base, gente, 'origen');
  const sinLugar = cloneWorld(base); con(sinLugar, 'social.radioConvivencia=12');
  updateCommunities(sinLugar, emit(sinLugar));
  assert.equal(sinLugar.communities.length, 1);

  base.places.push({ id: 'lugar-lejano', x: 34, y: 14, name: 'Lugar lejano', description: 'Sintético', gatherings: 0 });
  const tope = cloneWorld(base); con(tope, 'social.radioConvivencia=12,social.maxComunidades=1');
  updateCommunities(tope, emit(tope));
  assert.equal(tope.communities.length, 1, 'la fisión es una fundación: respeta social.maxComunidades');

  const todos = escena(), grupo = todos.people.slice(2, 6);
  // Cuatro que se quieren, dos y dos a 30 celdas: los dos lados quedan a 15 del centro, pero ninguno tiene
  // dos vecinos de confianza de su grupo, así que nadie funda (hacen falta tres).
  en(grupo.slice(0, 2), 4, 14); en(grupo.slice(2), 34, 14); confian(grupo); comunidad(todos, grupo, 'pareja');
  todos.places.push({ id: 'l1', x: 4, y: 14, name: 'L1', description: 'Sintético', gatherings: 0 }, { id: 'l2', x: 34, y: 14, name: 'L2', description: 'Sintético', gatherings: 0 });
  con(todos, 'social.radioConvivencia=12');
  updateCommunities(todos, emit(todos));
  assert.deepEqual(todos.communities.map(c => c.members.length), [4]);
});

test('(v) mayoría: quien convive con otra comunidad pasa a ella; la cría sin comunidad se une a la de la mayoría', () => {
  const w = escena(), [p, g1, g2, f1, f2, h1, h2, h3, q] = w.people.slice(2, 11) as Person[];
  en([p!, h1!, h2!, h3!, f1!, q!], 8, 14); en([g1!, g2!], 34, 14); en([f2!], 20, 2);
  comunidad(w, [p!, g1!, g2!], 'G'); comunidad(w, [f1!, f2!], 'F'); comunidad(w, [h1!, h2!, h3!], 'H');
  for (const h of [h1!, h2!, h3!]) p!.bonds[h.id] = 0.5;
  p!.bonds[g1!.id] = p!.bonds[g2!.id] = 0.5;
  // q (sin comunidad) confía en f1, que va antes en `world.people`, y en h1 y h2.
  for (const other of [f1!, h1!, h2!]) q!.bonds[other.id] = 0.5;

  const hoy = cloneWorld(w);
  updateCommunities(hoy, emit(hoy));
  const persona = (mundo: World, id: string) => mundo.people.find(x => x.id === id)!;
  assert.equal(persona(hoy, p!.id).communityId, 'G', 'con el default la etiqueta se conserva aunque viva entre otros');
  assert.equal(persona(hoy, q!.id).communityId, 'F', 'con el default se une a la del primer vecino de confianza');

  con(w, 'social.radioConvivencia=12');
  updateCommunities(w, emit(w));
  assert.equal(p!.communityId, 'H', 'tres vecinos de confianza de H y ninguno de G a su lado');
  assert.equal(q!.communityId, 'H', 'dos de H frente a uno de F');
  assert.equal(g1!.communityId, 'G'); assert.equal(f1!.communityId, 'F');
  assert.ok(w.events.some(e => e.text.includes('se unió a H') && e.cause.includes('3 de sus vecinos de confianza')));
  for (const group of w.communities) for (const id of group.members) assert.equal(w.people.find(x => x.id === id)!.communityId, group.id);
});

test('(vi) mayoría: un par aislado de comunidades distintas no se intercambia (hacen falta dos vecinos)', () => {
  const w = escena(), [a, b, a2, b2] = w.people.slice(2, 6) as Person[];
  en([a!, b!], 8, 14); en([a2!], 34, 2); en([b2!], 34, 26); confian([a!, b!]);
  comunidad(w, [a!, a2!], 'A'); comunidad(w, [b!, b2!], 'B');
  con(w, 'social.radioConvivencia=12');
  updateCommunities(w, emit(w));
  assert.equal(a!.communityId, 'A'); assert.equal(b!.communityId, 'B');
});

test('(vii) parseParams acota social.radioConvivencia a [0, 64]', () => {
  assert.deepEqual(PARAM_RANGES['social.radioConvivencia'], [0, 64]);
  assert.equal(parseParams('social.radioConvivencia=12').social.radioConvivencia, 12);
  assert.throws(() => parseParams('social.radioConvivencia=-1'), /rango/i);
  assert.throws(() => parseParams('social.radioConvivencia=65'), /rango/i);
  assert.throws(() => parseParams('social.radioConvivencia=lejos'), /num[ée]ric/i);
});
