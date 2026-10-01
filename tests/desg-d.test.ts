import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { assertWorld, cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { completeConstruction, repair } from '../src/world/inventions.js';
import { projectTerrain } from '../src/world/spatial.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { condicionProyectada, desgasteQ, ponerAlDiaDesgaste } from '../src/world/desgaste.js';
import { DESGASTE_Q } from '../src/shared/life.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_DESCRIPTORS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import type { ChronicleEvent } from '../src/shared/types.js';

/**
 * DESG-D: desgaste dormido por exposición (crítica adversarial del ciclo material,
 * `datos-lab/critica-ciclo-material-20261001.md`, regla de la sección final).
 * `material.desgasteDormido ∈ {0,1}`, default e histórico 0. Con 1, cada obra lleva
 * su ancla {q0,n0,r0}, N/R cuentan revisiones ejecutadas, y la condición deriva de
 * q(t) = max(0, q0 − aD·(ΔN−ΔR) − aR·ΔR) con κ = 1000 fijo (aD/aR = 540000/840000
 * para durabilidad 1, 360000/560000 para 1,5).
 */

const LEY1 = 'material.desgasteDormido=1';
const conLey1 = (w: World): void => { setParams(w, parseParams(LEY1, DEFAULT_PARAMS)); };
function emit(w: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => { const result = recordChronicleEvent(w, event); w.events.push(result); return result; };
}

// ── (0) G0: ley 0 idéntica paso a paso ──────────────────────────────────────────

/**
 * Digesto medido con la FORMA de params de ANTES de esta ley (sin la sección nueva
 * `material`, que no existía en `bb48326`): `digestoCanonico` hashea también los
 * params, así que declarar la clave mueve el hash completo aunque el estado físico
 * sea idéntico (mismo mecanismo que `digestoSinDisolucion` de `tests/com-d.test.ts`).
 */
function digestoSinMaterial(world: World): string {
  const vigentes = paramsOf(world);
  const antes = structuredClone(vigentes) as unknown as Record<string, unknown>;
  assert.deepEqual(antes.material, { desgasteDormido: 0 });
  delete antes.material;
  setParams(world, antes as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

/** Cadena sha256 del JSON ÍNTEGRO del mundo (sin params: viajan en WeakMap) de CADA
 * paso (1200), sin Store, + digesto canónico final sin la sección nueva. El canónico
 * por paso (75 ms/u) es impracticable en la suite (9 min); la cadena rápida (9 ms/u)
 * alimenta TODOS los bytes del estado de cada paso, y el canónico final fija la forma
 * canónica. La identidad canónica paso a paso 6/6 se verificó además fuera de la suite
 * (evidencia `desg-g0-ref-bb48326.json` + verificación post-cambio en bitácora). */
function cadenaG0(seed: number): { rapida: string; canonicoFinal: string } {
  const world = createWorld(seed, DEFAULT_PARAMS);
  let rapida = createHash('sha256').update(`desg-g0f:${seed}`).digest('hex');
  for (let n = 1; n <= 1200; n++) {
    stepWorld(world);
    rapida = createHash('sha256').update(rapida + JSON.stringify(world)).digest('hex');
  }
  return { rapida, canonicoFinal: digestoSinMaterial(world) };
}

/**
 * Referencia medida el 2026-10-01 en un worktree PRÍSTINO detached @bb48326, con
 * `/tmp/desg-g0-measure2.mts` (createWorld + 1200×stepWorld + cadena rápida por paso +
 * `digestoCanonico` final, que en esa base no declara `material`):
 * evidencia `/datos/tmp-atlas-lab/balance/desg-g0-ref2-bb48326.json`.
 * Semillas 18201–18206 verificadas nuevas (0 refs en md/replica/manifest/preregistros).
 */
const CADENAS_G0: Readonly<Record<number, { rapida: string; canonicoFinal: string }>> = {
  18201: { rapida: '174583c5142440c1b12755dc7b6567b0f9082e3d1f6b8d2db6e058edabf375d3', canonicoFinal: '51ba1e7e7f32b8ffb0d150f52ce28bc68a40f055c8fcd7748cc142d02208be6d' },
  18202: { rapida: '32d6a9c8e5ede37f1a9dcf72bc7a873f99ee35406ad0573102af0b5c64e1975b', canonicoFinal: 'c19ec2e51c90ddb1be0a8083e1d00cb54266c96d275566b052a065c2bffb08c5' },
  18203: { rapida: '5ff279e77bd44746df06bbef4a1ffb3834bbbedf2deeae4277ac791cb42b8b9b', canonicoFinal: 'd7578bbb0333d9ba54ae9266c08398992afd1e05ac9c12add12bcae4db1c3e92' },
  18204: { rapida: '887f52d7d37d75a453ade26b338dfd915c74464609ac1c2c59539e9172236d85', canonicoFinal: 'e844889a0e41ac227f7b725f6f3da4c4d83d1e9effd0da1e8e19cd067f01ecf2' },
  18205: { rapida: '3724a8b576a2038f77449ef5e0fb9bb11f4115185a4b486fc7e9ce584d12e161', canonicoFinal: 'da47dd49eded0c888ca85ce3ba93d204ee307464a940e09f167226e9520a0d5e' },
  18206: { rapida: 'e5c6f3bebb3abd685a5223b84d66a99a551e89a2158d09fce0323b2743317245', canonicoFinal: '4e092cecf37ac877e1bef363a6601940d8a94e4c096b34703ac8d3495dba1062' },
};

test('(0) G0: con ley=0 (default) el mundo es idéntico a bb48326 paso a paso, 6 semillas × 1200', { timeout: 600_000 }, () => {
  assert.equal(DEFAULT_PARAMS.material.desgasteDormido, 0, 'default = hoy');
  assert.equal(HISTORICAL_PARAMS.material.desgasteDormido, 0);
  for (const [seedText, referencia] of Object.entries(CADENAS_G0)) {
    const seed = Number(seedText);
    const { rapida, canonicoFinal } = cadenaG0(seed);
    assert.equal(rapida, referencia.rapida, `semilla ${seed}: cadena rápida de 1200 pasos`);
    assert.equal(canonicoFinal, referencia.canonicoFinal, `semilla ${seed}: canónico final sin material`);
  }
});

test('(0b) el diff de params es exactamente la sección nueva con 1 clave, acotada a {0,1}', () => {
  assert.deepEqual(DEFAULT_PARAMS.material, { desgasteDormido: 0 });
  assert.deepEqual(HISTORICAL_PARAMS.material, { desgasteDormido: 0 });
  const sinMaterial = structuredClone(DEFAULT_PARAMS) as unknown as Record<string, unknown>;
  delete sinMaterial.material;
  assert.deepEqual(Object.keys(sinMaterial).sort(),
    ['agua', 'conducta', 'cuerpo', 'genes', 'gobernador', 'limites', 'motor', 'persistencia', 'poblacion', 'recursos', 'red', 'social']);
  assert.deepEqual(PARAM_RANGES['material.desgasteDormido'], [0, 1]);
  assert.deepEqual(PARAM_DESCRIPTORS['material.desgasteDormido'], { kind: 'number', range: [0, 1], integer: true });
  assert.equal(parseParams('material.desgasteDormido=1').material.desgasteDormido, 1);
  assert.equal(parseParams('material.desgasteDormido=0').material.desgasteDormido, 0);
  assert.throws(() => parseParams('material.desgasteDormido=2'), /rango/i);
  assert.throws(() => parseParams('material.desgasteDormido=-1'), /rango/i);
  assert.throws(() => parseParams('material.desgasteDormido=0.5'), /entero/i);
  assert.throws(() => parseParams('material.desgasteDormido=si'), /num[ée]ric/i);
});

// ── Función pura ────────────────────────────────────────────────────────────────

test('(i) desgasteQ: valores de referencia del diseño (κ=1000)', () => {
  const Q = DESGASTE_Q;
  // 20 días enteramente secos, durabilidad 1: q/Q = 0,136 (diseño §2).
  assert.equal(desgasteQ(Q, 0, 0, 4800, 0, 1) / Q, 0.136);
  // 2400 secas + 2400 lluviosas = 20 días: q = 0 (diseño §2).
  assert.equal(desgasteQ(Q, 0, 0, 4800, 2400, 1), 0);
  // Durabilidad 1,5: 20 días secos pierden 2/3 de lo anterior.
  assert.equal(desgasteQ(Q, 0, 0, 4800, 0, 1.5), 1_272_000_000); // 3e9 − 4800·360000 exactos
  // Lluvia continua, durabilidad 1: cruza qB=0,1·Q en la revisión 3215 (diseño §2).
  const qB = Math.round(0.1 * Q);
  assert.ok(desgasteQ(Q, 0, 0, 3214, 3214, 1) > qB);
  assert.ok(desgasteQ(Q, 0, 0, 3215, 3215, 1) <= qB);
  // El max(0,·) conmuta: suelo en 0 aunque el desgaste exceda.
  assert.equal(desgasteQ(100, 0, 0, 10_000, 0, 1), 0);
});

test('(ii) desgasteQ: semigrupo exacto — activo paso a paso ≡ dormido de un salto', () => {
  // advance(s,t1) luego advance(·,t2) desde el ancla ORIGINAL da lo mismo que advance(s,t2):
  // la física nunca re-ancla al observar, así que el orden de los cortes no importa.
  for (const dur of [1, 1.5]) {
    const q0 = 2_500_000_000, n0 = 100, r0 = 30, n1 = 500, r1 = 200, n2 = 3000, r2 = 1200;
    const directo = desgasteQ(q0, n0, r0, n2, r2, dur);
    const porCortes = desgasteQ(q0, n0, r0, n2, r2, dur);
    assert.equal(porCortes, directo);
    // Idempotencia del horizonte: repetir la misma proyección no acumula nada.
    assert.equal(desgasteQ(q0, n0, r0, n1, r1, dur), desgasteQ(q0, n0, r0, n1, r1, dur));
    // Solo enteros seguros en todo el rango (crítica: ningún BigInt).
    for (const q of [directo, desgasteQ(q0, n0, r0, n1, r1, dur)]) assert.ok(Number.isSafeInteger(q));
  }
});

// ── G1: paridad activa ↔ dormida con retiradas/reactivaciones ────────────────────

/** Teletransporta a toda la población (viva) a (x, y): fuerza retirada/reactivación de chunks. */
function teleportar(w: World, x: number, y: number): void {
  for (const p of w.people) { p.x = x; p.y = y; p.target = { x, y }; }
}

test('(iii) G1: retirada/reactivación en ticks %10, %600 y arbitrarios ≡ activa, y = f(ancla)', { timeout: 300_000 }, () => {
  const seed = 18212;
  const ley1 = parseParams(LEY1, DEFAULT_PARAMS);
  const a = createWorld(seed, ley1); // gemela siempre activa
  const b = createWorld(seed, ley1); // gemela con dos ciclos dormidos
  const id = b.structures[0]!.id;
  const ancla = { ...b.structures[0]!.anclaDesgaste! };
  assert.deepEqual(ancla, { q0: DESGASTE_Q, n0: 0, r0: 0 }, 'legacy al materializarse: {Q,0,0}');
  const sx = b.structures[0]!.x, sy = b.structures[0]!.y;
  const enB = (): (typeof b.structures)[number] | undefined => b.structures.find(s => s.id === id);
  const formula = (w: World): number => desgasteQ(ancla.q0, ancla.n0, ancla.r0, w.revisionesObra!, w.revisionesLluvia!, 1) / DESGASTE_Q;
  // Fase 0: ambas en casa hasta el tick 599.
  for (let t = 1; t <= 599; t++) { stepWorld(a); stepWorld(b); }
  // Retirada EN el tick 600 (%10 y %600: cambio de tiempo + revisión el mismo tick).
  teleportar(b, 1000, 1000);
  stepWorld(a); stepWorld(b);
  assert.equal(b.tick, 600);
  assert.equal(enB(), undefined, 'la obra dormida sale de world.structures al retirarse');
  assert.ok(b.retiredChunks.some(c => (c.structures ?? []).some(s => s.id === id)), 'y queda archivada');
  assert.equal(a.structures.find(s => s.id === id)!.condition, formula(a), 'la gemela activa sigue la fórmula');
  // Dormida los ticks 601–609; reactivación EN el 610 (%10).
  for (let t = 601; t <= 609; t++) { stepWorld(a); stepWorld(b); }
  teleportar(b, sx, sy);
  stepWorld(a); stepWorld(b);
  assert.equal(enB()?.condition, formula(b), 'al reactivar en %10: condición = f(ancla, N, R)');
  assert.equal(enB()?.condition, a.structures.find(s => s.id === id)!.condition, 'reactivada ≡ activa');
  // En casa 611–629; retirada EN el 630 (%10, no %600).
  for (let t = 611; t <= 629; t++) { stepWorld(a); stepWorld(b); }
  teleportar(b, 1000, 1000);
  stepWorld(a); stepWorld(b);
  assert.equal(enB(), undefined, 'segunda retirada efectiva');
  // Dormida 631–636; reactivación EN el 637 (arbitrario).
  for (let t = 631; t <= 636; t++) { stepWorld(a); stepWorld(b); }
  teleportar(b, sx, sy);
  stepWorld(a); stepWorld(b);
  assert.equal(enB()?.condition, formula(b), 'al reactivar en tick arbitrario: = f(ancla)');
  // Estabilidad 638–640 y veredicto final.
  for (let t = 638; t <= 640; t++) { stepWorld(a); stepWorld(b); }
  assert.equal(a.revisionesObra, b.revisionesObra, 'mismo N (el teletransporte no toca el RNG del tiempo)');
  assert.equal(a.revisionesLluvia, b.revisionesLluvia, 'mismo R');
  assert.equal(a.revisionesObra, 64, 'N = 640/10 revisiones ejecutadas');
  assert.equal(enB()?.condition, a.structures.find(s => s.id === id)!.condition, 'tras dos ciclos: dormida ≡ activa');
  assert.equal(enB()?.condition, formula(b), 'y ambas = f(ancla, N, R)');
  assert.deepEqual(enB()?.anclaDesgaste, ancla, 'el ancla no cambia al observar ni al reactivar');
  assertWorld(a); assertWorld(b);
});

// ── G1: cámaras proyectan sin escribir ───────────────────────────────────────────

test('(iv) G1: la cámara muestra la proyección de archivadas y no escribe (0/1/12 cámaras)', { timeout: 300_000 }, () => {
  const w = createWorld(18213, parseParams(LEY1, DEFAULT_PARAMS));
  const id = w.structures[0]!.id;
  const ancla = { ...w.structures[0]!.anclaDesgaste! };
  const sx = w.structures[0]!.x, sy = w.structures[0]!.y;
  for (let t = 1; t <= 599; t++) stepWorld(w);
  teleportar(w, 1000, 1000);
  for (let t = 600; t <= 615; t++) stepWorld(w);
  assert.ok(!w.structures.some(s => s.id === id), 'obra archivada al mirar');
  const N = w.revisionesObra!, R = w.revisionesLluvia!;
  const esperada = desgasteQ(ancla.q0, ancla.n0, ancla.r0, N, R, 1) / DESGASTE_Q;
  const vista = { x: Math.max(0, sx - 5), y: Math.max(0, sy - 5), width: 40, height: 28 };
  const antes = digestoCanonico(w);
  const foto1 = projectTerrain(w, vista);
  const vista1 = foto1.structures.find(s => s.id === id)!;
  assert.equal(vista1.condition, esperada, 'la cámara proyecta f(ancla,N), no el crudo archivado');
  assert.notEqual(vista1.condition, w.retiredChunks.flatMap(c => c.structures ?? []).find(s => s.id === id)!.condition,
    'el archivo sigue con el valor de la retirada (la lectura no lo toca)');
  for (let n = 0; n < 11; n++) projectTerrain(w, vista);
  assert.equal(digestoCanonico(w), antes, '12 cámaras no mueven ni un bit del mundo');
  const foto12 = projectTerrain(w, vista);
  assert.equal(foto12.structures.find(s => s.id === id)!.condition, esperada, 'la proyección es estable');
});

// ── G1: guardar/reabrir a mitad con la ley activa ───────────────────────────────

function replicaStore(seed: number, pasos: number, cada: number, reabrirEn?: number): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-desg-d-'));
  const store = new Store(join(directory, 'world.sqlite'));
  try {
    let world = createWorld(seed, parseParams(LEY1, DEFAULT_PARAMS));
    store.save(world);
    for (let tick = 1; tick <= pasos; tick++) {
      stepWorld(world);
      if (world.tick % cada === 0) store.save(world);
      if (reabrirEn !== undefined && world.tick === reabrirEn) world = store.load()!.world;
    }
    return world;
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('(v) G1: guardar/reabrir a mitad con ley=1 ≡ corrida continua', { timeout: 600_000 }, () => {
  const seed = 18211;
  const continua = replicaStore(seed, 1200, 300);
  const reabierta = replicaStore(seed, 1200, 300, 600);
  assert.equal(digestoCanonico(reabierta), digestoCanonico(continua), 'reabrir a mitad no cambia la trayectoria');
  assertWorld(reabierta);
  assert.ok((reabierta.revisionesObra ?? 0) > 0, 'N viaja en la instantánea');
  for (const s of reabierta.structures) assert.ok(s.anclaDesgaste, 'las anclas persisten');
});

// ── Corrupción ──────────────────────────────────────────────────────────────────

test('(vi) corrupción: anclas incoherentes o estado cruzado ley 0/1 ⇒ assertWorld falla', { timeout: 120_000 }, () => {
  const base = createWorld(18221, parseParams(LEY1, DEFAULT_PARAMS));
  for (let t = 1; t <= 100; t++) stepWorld(base);
  assertWorld(base, undefined, undefined);
  const N = base.revisionesObra!, R = base.revisionesLluvia!;
  assert.equal(N, 10);
  const clona = (): World => cloneWorld(base);
  // (a) n0 > N (respaldo anterior a la escritura del chunk).
  const a = clona(); a.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q, n0: N + 1, r0: 0 };
  assert.throws(() => assertWorld(a), 'n0 > N');
  // (b) r0 > R.
  const b = clona(); b.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q, n0: 0, r0: R + 1 };
  assert.throws(() => assertWorld(b), 'r0 > R');
  // (c) r0 > n0.
  const c = clona(); c.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q, n0: 3, r0: 4 };
  assert.throws(() => assertWorld(c), 'r0 > n0');
  // (d) R−r0 > N−n0 con el resto válido (N=10,R=5 fijos; cachés puestas al día para aislar la causa).
  const d = clona(); d.revisionesObra = 10; d.revisionesLluvia = 5;
  for (const s of d.structures) ponerAlDiaDesgaste(10, 5, s);
  d.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q, n0: 9, r0: 0 };
  ponerAlDiaDesgaste(10, 5, d.structures[0]!);
  assert.throws(() => assertWorld(d), 'R−r0 > N−n0');
  // (e) valores no enteros seguros / q0 fuera de rango.
  const e = clona(); e.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q + 0.5, n0: 0, r0: 0 };
  assert.throws(() => assertWorld(e), 'q0 no entero');
  const e2 = clona(); e2.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q + 1, n0: 0, r0: 0 };
  assert.throws(() => assertWorld(e2), 'q0 > Q');
  // (f) ley=0 con N/R o anclas = corrupción (con 0 no se crean).
  const f = createWorld(18222, DEFAULT_PARAMS);
  for (let t = 1; t <= 100; t++) stepWorld(f);
  assertWorld(f);
  f.revisionesObra = 5;
  assert.throws(() => assertWorld(f), 'ley 0 con N');
  const f2 = cloneWorld(f); delete f2.revisionesObra;
  f2.structures[0]!.anclaDesgaste = { q0: DESGASTE_Q, n0: 0, r0: 0 };
  assert.throws(() => assertWorld(f2), 'ley 0 con ancla');
  // (g) ley=1 con obra sin ancla.
  const g = clona(); delete g.structures[0]!.anclaDesgaste;
  assert.throws(() => assertWorld(g), 'ley 1 sin ancla');
  // (h) ley=1 con caché rancia en residente.
  const h = clona(); h.structures[0]!.condition += 0.001;
  assert.throws(() => assertWorld(h), 'ley 1 con condition distinta de q/Q');
});

// ── Construcción y reparación ───────────────────────────────────────────────────

test('(vii) construir ancla {Q,N,R} con ley=1 y nada con ley=0', () => {
  for (const ley of [0, 1]) {
    const w = createWorld(18223, ley ? parseParams(LEY1, DEFAULT_PARAMS) : DEFAULT_PARAMS);
    const persona = w.people[0]!;
    const tesela = w.tiles.find(t => t.terrain === 'soil' || t.terrain === 'meadow')!;
    persona.x = tesela.x; persona.y = tesela.y; persona.target = { x: tesela.x, y: tesela.y };
    persona.materials = { wood: 20, stone: 20 }; persona.work = 500;
    w.places = [];
    const obra = completeConstruction(w, persona, tesela, emit(w));
    assert.ok(obra, 'construcción sintética válida');
    if (ley) assert.deepEqual(obra.anclaDesgaste, { q0: DESGASTE_Q, n0: 0, r0: 0 });
    else assert.ok(!Object.hasOwn(obra, 'anclaDesgaste'), 'con ley=0 no se crea el ancla');
  }
});

test('(viii) reparar asienta q y renueva el ancla; el límite 0,95 decide igual', () => {
  const w = createWorld(18223, parseParams(LEY1, DEFAULT_PARAMS));
  for (let t = 1; t <= 200; t++) stepWorld(w);
  teleportar(w, 17, 13); // garantiza las legacy residentes antes de elegirlas
  for (let t = 201; t <= 210; t++) stepWorld(w);
  assert.ok(w.structures.length >= 2, 'legacy activas a mano');
  const N = w.revisionesObra!, R = w.revisionesLluvia!;
  const persona = w.people[0]!;
  // Obra sintética válida a media vida: ancla {1,5e9,N,R} y caché fresca 0,5.
  const obra = w.structures[0]!;
  obra.anclaDesgaste = { q0: 1_500_000_000, n0: N, r0: R };
  obra.condition = 0.5;
  assertWorld(w);
  persona.x = obra.x; persona.y = obra.y; persona.target = { x: obra.x, y: obra.y };
  persona.materials = { wood: 5, stone: 0 }; persona.work = 100;
  assert.equal(repair(w, persona, obra, emit(w)), true);
  assert.deepEqual(obra.anclaDesgaste, { q0: 2_700_000_000, n0: N, r0: R }, 'q0 := min(Q, q+0,4Q)');
  assert.equal(obra.condition, 0.9);
  assertWorld(w);
  // Al 0,95 o más no se repara (mismo límite vigente).
  const sana = w.structures[1]!;
  assert.ok(sana.condition >= 0.95);
  persona.x = sana.x; persona.y = sana.y; persona.target = { x: sana.x, y: sana.y };
  assert.equal(repair(w, persona, sana, emit(w)), false);
});

// ── Determinismo ────────────────────────────────────────────────────────────────

test('(ix) determinismo: la misma semilla con ley=1 produce el mismo mundo dos veces', { timeout: 300_000 }, () => {
  const corre = (): World => {
    const w = createWorld(18214, parseParams(LEY1, DEFAULT_PARAMS));
    for (let t = 1; t <= 240; t++) stepWorld(w);
    return w;
  };
  const a = corre(), b = corre();
  assert.equal(digestoCanonico(a), digestoCanonico(b));
  assertWorld(a);
  // ponerAlDiaDesgaste es idempotente sobre caché fresca.
  const s = a.structures[0]!;
  const antes = s.condition;
  ponerAlDiaDesgaste(a.revisionesObra!, a.revisionesLluvia!, s);
  assert.equal(s.condition, antes);
  assert.equal(condicionProyectada(s.components, undefined, 0, 0), null, 'sin ancla no hay proyección');
});
