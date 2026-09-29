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
 * COM-D′ (crítica adversarial de COM-D, `datos-lab/critica-com-d-20260928.md`; el diseño original,
 * `datos-lab/DISENO-COM-D-20260928.md`, NO se implementa tal cual). `social.disolucion` ∈ {0,1},
 * default 0 (mundo bit a bit igual, incluso con `social.radioConvivencia > 0`). Con 1 y
 * `radioConvivencia > 0`:
 * · R0. Un solo predicado: S e I nunca cuentan para fundar, fisionar ni disolver (sólo mortales,
 *   `role === 'neighbor'`); siguen la regla de mayoría como cualquiera.
 * · R1. Arreglo en origen: la fisión exige ≥ 3 mortales en el grupo NUEVO y que el de ORIGEN
 *   conserve ≥ 3 mortales (antes bastaba con que el origen conservara a alguien, cualquiera).
 * · R2. Histéresis sin estado: fundar exige 3 mortales, disolver ocurre con ≤ 1; con exactamente 2
 *   no pasa nada, así que se evita el bucle fundar↔disolver↔refundar de la crítica.
 * · R3. Los miembros de una comunidad disuelta (mortales, S e I por igual) se unen a la mayoría de
 *   sus vecinos de confianza ENTRE LAS COMUNIDADES QUE NO SE DISUELVEN esta misma revisión, o
 *   quedan sin comunidad.
 * · R4. Orden fisión → mayoría → disolución → reagrupar → fundación; una comunidad no se disuelve
 *   en la revisión en que nace (`formedAt === tick`).
 */

const COM_D = 'social.radioConvivencia=12,social.disolucion=1';

function emit(w: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => { const result = recordChronicleEvent(w, event); w.events.push(result); return result; };
}
/** Escena sintética: todos lejos (sin vínculos ni comunidad) y sin lugares, salvo lo que el test coloca. */
function escena(): World {
  const w = createWorld(51926);
  w.places = [];
  for (const p of w.people) {
    p.x = 20; p.y = 26; p.target = { x: 20, y: 26 }; p.action = 'rest'; p.decisionAt = 999; p.bonds = {}; p.communityId = null;
    p.culture = { sharing: 0.6, stewardship: 0.6, openness: 0.6 };
  }
  w.tick = 120;
  return w;
}
function en(personas: readonly Person[], x: number, y: number) { for (const p of personas) { p.x = x; p.y = y; p.target = { x, y }; } }
function confian(personas: readonly Person[]) { for (const a of personas) for (const b of personas) if (a !== b) a.bonds[b.id] = 0.5; }
function comunidad(w: World, miembros: readonly Person[], id: string, formedAt = 0) {
  for (const p of miembros) p.communityId = id;
  w.communityCounter++;
  w.communities.push({ id, name: id, x: miembros[0]!.x, y: miembros[0]!.y, color: '#aaccee', members: miembros.map(p => p.id), culture: { sharing: 0.6, stewardship: 0.6, openness: 0.6 }, formedAt, cooperation: 0, disputes: 0 });
}
const con = (w: World, clave: string) => setParams(w, parseParams(clave));

// ── (0) Puerta de identidad ────────────────────────────────────────────────────────────────────
/**
 * Digesto del mundo medido con la FORMA de params de ANTES de esta ley (sin `social.disolucion`):
 * `digestoCanonico` hashea también los params, así que declarar la clave mueve el hash completo
 * aunque el estado físico sea idéntico (T102, mismo mecanismo que `digestoSinLaClave` de
 * `tests/comunidades-vivas.test.ts`). Quitarla reproduce el digesto de antes byte a byte.
 */
function digestoSinDisolucion(world: World): string {
  const vigentes = paramsOf(world);
  const antes = structuredClone(vigentes) as unknown as { social: Record<string, unknown> };
  assert.equal(antes.social.disolucion, 0);
  delete antes.social.disolucion;
  setParams(world, antes as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

/** Réplica mínima de laboratorio (Store temporal guardado ANTES del primer paso, como
 * `scripts/lab/replica.ts` y `poda-digestos.mts`): `DEFAULT_PARAMS` + `persistencia.cadaTicks=300`,
 * guardando cada corte. `extra` se aplica ENCIMA (p. ej. `social.radioConvivencia=12`). */
function replicaIdentidad(seed: number, extra?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-com-d-'));
  const store = new Store(join(directory, 'world.sqlite'));
  try {
    const base = parseParams('persistencia.cadaTicks=300', DEFAULT_PARAMS);
    const params = extra ? parseParams(extra, base) : base;
    const world = createWorld(seed, params);
    store.save(world);
    for (let n = 1; n <= 1200; n++) {
      stepWorld(world);
      if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) store.save(world);
    }
    return digestoSinDisolucion(world);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

/**
 * Referencia medida el 2026-09-28 en ESTE worktree (`sprint/com-d-20260928`), ANTES de tocar
 * `src/world/params.ts`/`society.ts` (commit base `main` @005b877), con
 * `scripts` ad hoc equivalentes a `replicaIdentidad` de arriba (`digestoCanonico` sin ninguna
 * clave nueva, porque esa base no la declara):
 *   npx tsx com-d-digestos.mts --arbol <worktree pre-edición> --semillas 61001,...,61006 \
 *     --pasos 1200 --salida pre.json
 * y reproducida BYTE A BYTE tras la implementación con `--sin social.disolucion` (`post.json`),
 * en los dos carriles: `control` (DEFAULT_PARAMS puros) y `com` (+ `social.radioConvivencia=12`,
 * que ejercita las ramas `else` nuevas de `reviseByCohabitation` con `disolver=false`).
 */
const SEMILLAS_REFERENCIA: Readonly<Record<number, { control: string; com: string }>> = {
  61001: { control: '52858e78267bdbc739b474e05896591bfd6b77b68b7f1286858f730d8305eb07', com: '125f8633b9bf48e7e7139c0ded454ab15a0e955806395c295fdea3fb35ce22ce' },
  61002: { control: '702235957626744907a30109c65898dd6f6c1a892a59c9c1f3ab0f9569091ce9', com: '5f1b3a5e9aeb7fb45a05bca60ccefd26f27936e10ab2c25ffa753d9a7c7f254e' },
  61003: { control: 'f79f3d6f033334bf10005999b4cd468efdd4d787eeba2af59f1eeb7b91fc72fd', com: 'cb2ed6e811e206d1bc027eadf29fd01a17f8a3cedf69cfdcf1a269f53f1ca1f7' },
  61004: { control: '26fbd00eed190527ff6753bb3c484445aa3914f338f2ef109d29e075b3a3aad6', com: '761dc31f9d3d2b94c33d050e2d181095c216791040fcc36b196d6af94fe6885b' },
  61005: { control: '8b5569aa14c5c50cc8928983d5cef544bb99798c50f5be863af8f4289ad2f24e', com: 'be58b4c5ab59e7f3e2c4aea35bfe22cbec249cb4c34e0f5c7969a3c76169ecf3' },
  61006: { control: '9e09df116fac3b307400bfe5f47ecc4ee1abc509fe45ca723a0a5bc0f87134c3', com: 'a301b7bdf1f6147e7ebabf4f7e4b0f9c0509dfcdfc69c9399baa8957bd8f9a28' },
};

test('(0) identidad: con disolucion=0 (default) el mundo es idéntico a antes de esta ley, en 6 semillas nuevas, con y sin COM activo', { timeout: 600_000 }, () => {
  assert.equal(DEFAULT_PARAMS.social.disolucion, 0, 'default = hoy');
  assert.equal(HISTORICAL_PARAMS.social.disolucion, 0);
  for (const [seedText, referencia] of Object.entries(SEMILLAS_REFERENCIA)) {
    const seed = Number(seedText);
    assert.equal(replicaIdentidad(seed), referencia.control, `semilla ${seed}, DEFAULT_PARAMS`);
    assert.equal(replicaIdentidad(seed, 'social.radioConvivencia=12'), referencia.com, `semilla ${seed}, radioConvivencia=12 (COM activo, disolucion=0)`);
  }
});

test('(0b) parseParams acota social.disolucion a {0, 1}', () => {
  assert.deepEqual(PARAM_RANGES['social.disolucion'], [0, 1]);
  assert.equal(parseParams('social.disolucion=1').social.disolucion, 1);
  assert.equal(parseParams('social.disolucion=0').social.disolucion, 0);
  assert.throws(() => parseParams('social.disolucion=2'), /rango/i);
  assert.throws(() => parseParams('social.disolucion=-1'), /rango/i);
  assert.throws(() => parseParams('social.disolucion=0.5'), /entero/i);
  assert.throws(() => parseParams('social.disolucion=si'), /num[ée]ric/i);
});

// ── R0 + R2: disolución ─────────────────────────────────────────────────────────────────────────

test('(i) R0+R2: una comunidad con ≤ 1 mortal se disuelve aunque tenga a S y a I; ninguno la sostiene solo', () => {
  const w = escena();
  const s = w.people.find(p => p.role === 'S')!, i = w.people.find(p => p.role === 'I')!, m = w.people.slice(2, 3)[0]!;
  confian([s, i, m]);
  comunidad(w, [s, i, m], 'origen');
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 0, 'sólo tenía 1 mortal (S e I no cuentan): se disuelve');
  for (const p of [s, i, m]) assert.equal(p.communityId, null, `${p.id} queda sin comunidad: nadie más cerca`);
  assert.ok(w.events.some(e => e.text.includes('quedó sin comunidad al disolverse origen')));
  // Sin bucle fundación-disolución en la misma revisión: fundar exige 3 mortales libres y aquí
  // sólo queda 1 (m); ni una fundación ni otra fisión ocurren para este trío en este paso.
  const ids = new Set([s.id, i.id, m.id]);
  assert.ok(!w.events.some(e => (e.text.includes('tomó forma') || e.text.includes('se separó de')) && e.actors.some(a => ids.has(a))));
});

test('(ii) R2: histéresis — una comunidad con exactamente 2 mortales NO se disuelve (disolver exige ≤ 1)', () => {
  const w = escena(), [m1, m2] = w.people.slice(2, 4) as Person[];
  confian([m1, m2]);
  comunidad(w, [m1, m2], 'origen');
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 1, '2 mortales no disparan la disolución');
  assert.equal(m1.communityId, 'origen'); assert.equal(m2.communityId, 'origen');
  assert.ok(!w.events.some(e => e.text.includes('disuelta')));
});

test('(iii) R4: una comunidad no se disuelve en la revisión en que nace, aunque tenga ≤ 1 mortal', () => {
  const w = escena(), m1 = w.people.slice(2, 3)[0]!;
  comunidad(w, [m1], 'recien-nacida', w.tick);
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 1, 'exenta de disolverse en su propia revisión de nacimiento');
  assert.equal(m1.communityId, 'recien-nacida');
});

test('(iv) R3: al disolverse, sus miembros se unen a la mayoría de vecinos de confianza entre comunidades que NO se disuelven (basta un solo vecino; la mayoría ORDINARIA exige 2)', () => {
  const w = escena();
  const [a1, b1, b2, b3] = w.people.slice(2, 6) as Person[];
  en([a1!, b1!, b2!, b3!], 8, 14);
  comunidad(w, [a1!], 'A'); comunidad(w, [b1!, b2!, b3!], 'B');
  confian([b1!, b2!, b3!]);
  a1!.bonds[b1!.id] = 0.5; // un solo vecino de confianza de B: la mayoría ORDINARIA (≥ 2) no lo movería sola
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(a1!.communityId, 'B', 'A (1 mortal) se disuelve y su único miembro se une a la mayoría de B');
  assert.equal(w.communities.length, 1);
  assert.ok(w.events.some(e => e.text.includes('dejó A, disuelta, y se unió a B')));
});

// ── R1: la fisión cuenta MORTALES, no a todos ──────────────────────────────────────────────────

test('(v) R1: sin 3 mortales reales no hay fisión aunque S complete el grupo (hoy, sin R1, sí fisionaría)', () => {
  const w = escena(), s = w.people.find(p => p.role === 'S')!;
  const gente = w.people.slice(2, 9) as Person[]; // 7 mortales
  const cerca = gente.slice(0, 5), lejosMortales = gente.slice(5); // 2 mortales lejos
  const todos = [...gente, s];
  en(cerca, 8, 14); en([...lejosMortales, s], 34, 14); confian(todos); comunidad(w, todos, 'origen');
  w.places.push({ id: 'lugar-lejano', x: 34, y: 14, name: 'Lugar lejano', description: 'Sintético', gatherings: 0 });

  const hoy = cloneWorld(w); con(hoy, 'social.radioConvivencia=12'); // COM sin D′: el umbral de fisión cuenta a S
  updateCommunities(hoy, emit(hoy));
  assert.equal(hoy.communities.length, 2, 'hoy (sin disolucion) S cuenta para el umbral y SÍ fisiona con 2 mortales + S');

  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 1, 'con R1, S no cuenta: sólo 2 mortales lejos, no fisiona');
});

test('(vi) R1: la fisión SÍ ocurre con 3 mortales reales; S puede sumarse sin ser necesario ni contar', () => {
  const w = escena(), s = w.people.find(p => p.role === 'S')!;
  const gente = w.people.slice(2, 10) as Person[], cerca = gente.slice(0, 5), lejosMortales = gente.slice(5); // 3 mortales lejos
  const todos = [...gente, s];
  en(cerca, 8, 14); en([...lejosMortales, s], 34, 14); confian(todos); comunidad(w, todos, 'origen');
  w.places.push({ id: 'lugar-lejano', x: 34, y: 14, name: 'Lugar lejano', description: 'Sintético', gatherings: 0 });
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 2, '3 mortales lejos bastan (R1); S se suma de más');
  const nueva = w.communities.find(c => c.id !== 'origen')!;
  assert.ok(lejosMortales.every(p => p.communityId === nueva.id), 'los 3 mortales lejanos fisionan juntos');
  assert.equal(s.communityId, nueva.id, 'S se separa con el núcleo con el que convive y confía, sin ser exigido');
  const origen = w.communities.find(c => c.id === 'origen')!;
  assert.equal(origen.members.length, 5, 'el origen conserva a los 5 mortales cercanos (≥ 3, R1)');
});

test('(vii-a) R1: la fisión SÍ ocurre si el origen retiene exactamente 3 mortales', () => {
  const w = escena();
  const seis = w.people.slice(2, 8) as Person[], cerca3 = seis.slice(0, 3), lejos3 = seis.slice(3);
  en(cerca3, 8, 14); en(lejos3, 34, 14); confian(seis); comunidad(w, seis, 'origen');
  w.places.push({ id: 'lugar-lejano', x: 34, y: 14, name: 'Lugar lejano', description: 'Sintético', gatherings: 0 });
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 2, 'origen retiene exactamente 3 mortales tras la fisión: SÍ ocurre');
  const origen = w.communities.find(c => c.id === 'origen')!;
  assert.equal(origen.members.length, 3);
});

test('(vii-b) R1: la fisión NO ocurre si el origen quedaría con menos de 3 mortales', () => {
  const w = escena();
  const cinco = w.people.slice(2, 7) as Person[], cerca2 = cinco.slice(0, 2), lejos3 = cinco.slice(2); // origen: 2 cerca + 3 lejos
  en(cerca2, 8, 14); en(lejos3, 34, 14); confian(cinco); comunidad(w, cinco, 'origen');
  w.places.push({ id: 'lugar-lejano', x: 34, y: 14, name: 'Lugar lejano', description: 'Sintético', gatherings: 0 });
  con(w, COM_D);
  updateCommunities(w, emit(w));
  assert.equal(w.communities.length, 1, 'fisionar dejaría sólo 2 mortales en el origen (< 3): R1 lo bloquea');
});

// ── Determinismo y validez tras una simulación real ────────────────────────────────────────────

function replicaCorta(seed: number, params: string, pasos: number): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-com-d-corta-'));
  const store = new Store(join(directory, 'world.sqlite'));
  try {
    const world = createWorld(seed, parseParams(params, DEFAULT_PARAMS));
    store.save(world);
    for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
    return world;
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('(viii) determinismo: la misma semilla con COM-D′ produce el mismo mundo dos veces, y el mundo es válido', { timeout: 300_000 }, () => {
  const params = `${COM_D},social.maxComunidades=64`;
  const a = replicaCorta(61101, params, 240), b = replicaCorta(61101, params, 240);
  assert.equal(digestoCanonico(a), digestoCanonico(b), 'misma semilla y params: mismo mundo');
  assertWorld(a);
});

// ── T100: la admisión no rompe con más de 8 comunidades ────────────────────────────────────────

test('(ix) T100: limites.comunidades admite > 8 comunidades cuando se declara igual o mayor que social.maxComunidades', () => {
  // Mundo recién creado (válido de por sí, sin las mutaciones sintéticas de `escena()`, que sólo
  // sirven para ejercitar `updateCommunities` y no pretenden pasar el resto de `assertWorld`).
  const w = createWorld(51926);
  const mortales = w.people.filter(p => p.role === 'neighbor'); // 14 mortales founders
  assert.ok(mortales.length >= 9, 'createWorld debe dar al menos 9 mortales founders');
  for (let n = 0; n < 9; n++) comunidad(w, [mortales[n]!], `c${n}`, w.tick);
  assert.equal(w.communities.length, 9);
  con(w, 'limites.comunidades=64,social.maxComunidades=64');
  assertWorld(w);
  con(w, 'limites.comunidades=8');
  assert.throws(() => assertWorld(w), 'w.communities.length (9) > limites.comunidades (8) debe rechazarse');
});
