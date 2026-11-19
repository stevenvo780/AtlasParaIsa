/** AUTHORING ONLY. Invoke solely inside ROOT's newly released native capsule.
 * No CLI auto-main, subprocess, service, network, host DBus or implicit tests. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../../../src/server/store.js';
import { createWorld, stepWorld, attachDecisionObserverV1, decisionBitsV1, type World } from '../../../src/world/index.js';
import { digestoCanonico } from '../../../src/world/digesto.js';
import { technologyJournalNearCapacity } from '../../../src/world/technology-journal.js';
import { chronicleJournalNearCapacity } from '../../../src/world/chronicle-journal.js';
import { technologyCatalogueNearCapacity } from '../../../src/world/technology-catalogue.js';
import { aplicarPlacebo, mortalMenorId } from '../placebo.js';
import { FirstFlipObserver, hash, type Binding } from './observer.js';
import type { WorldParams } from '../../../src/world/params.js';

const check = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
export function worldSourceHash(root: string): string {
  const h = createHash('sha256');
  for (const name of readdirSync(join(root, 'src/world')).filter(n => n.endsWith('.ts')).sort())
    h.update(name).update('\0').update(readFileSync(join(root, 'src/world', name)));
  return h.digest('hex');
}
export function runtimeHash(): string {
  return hash(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    executable: hash(readFileSync(process.execPath)) }));
}
export interface NativeRequest { root: string; output: string; preregPath: string; identityPath: string; paramsPath: string; }
/** Same original Store/catalogue binding and save cadence. No hostParams sampling;
 * all resolved original params are supplied and pinned before first data. */
export function runNativePair(request: NativeRequest): void {
  check(process.env.ATLAS_FIRST_FLIP_NATIVE_CAPSULE === '1', 'Native capsule required; never run on host');
  const root = resolve(request.root), output = resolve(request.output);
  check(output.startsWith(root + '/.orchestration/placebo-first-flip-v1/'), 'Output outside owned capsule path');
  const raw = readFileSync(request.preregPath), p = JSON.parse(raw.toString());
  const identity = JSON.parse(readFileSync(request.identityPath, 'utf8'));
  const paramsRaw = readFileSync(request.paramsPath), params: WorldParams = JSON.parse(paramsRaw.toString());
  check(p.dataKind === 'NATIVE' && p.status === 'SEALED' && p.sealedBeforeData === true, 'Draft cannot produce data');
  check(p.seed === 18107 && p.firstTick === 1 && p.lowerInclusive === 4807 && Number.isSafeInteger(p.endTick)
    && p.endTick >= 1 && p.endTick <= 7200, 'Only NI/diagnostic window authorized in this runner');
  check(p.mode === 'NI' ? p.endTick === 1200 : p.mode === 'DIAGNOSTIC' && p.endTick >= 4807, 'Mode/window mismatch');
  for (const k of ['sourceSHA','worldSourceHash','harnessHash']) check(p[k] === identity[k], 'Source prereg binding');
  check(hash(readFileSync(join(root, 'src/world/index.ts'))) === p.sourceSHA, 'Instrumented sourceSHA mismatch');
  check(worldSourceHash(root) === p.worldSourceHash, 'World source mismatch');
  // Harness inventory checked by byte hash, not inherited git HEAD.
  const harness = createHash('sha256');
  for (const name of identity.harnessFiles as string[]) {
    harness.update(name).update('\0').update(readFileSync(join(root, name)));
  }
  check(harness.digest('hex') === p.harnessHash, 'Harness mismatch');
  check(hash(paramsRaw) === p.paramsHash && runtimeHash() === p.runtimeHash, 'Input/runtime mismatch');
  check(p.actor === 'descendant-1' && p.thirstBeforeBits === '3fc3f8dd73b519d9' && p.thirstAfterBits === '3fc3f8dd73b519d8', 'Original actor/bit receipt required');
  check(p.originalHEAD === '6516c62e06fe2b22493e029022fab7f32388b674', 'Original epoch mismatch');
  check(params.material.desgasteDormido === 0 && params.persistencia.cadaTicks === 300, 'Original CTRL physics required');
  check(p.mode === 'NI' || p.parityReceiptSHA && p.calibrationReceiptSHA, 'New parity and measured cost receipts required');
  if (p.mode !== 'NI') {
    // ROOT seals these only after original/current, hook-off/on parity + cost measurements.
    check(p.sourceSHA !== identity.originalIndexSHA, 'New instrumented epoch required');
    const parityBytes = readFileSync(join(output, 'parity.json'));
    const calibrationBytes = readFileSync(join(output, 'calibration.json'));
    check(hash(parityBytes) === p.parityReceiptSHA && hash(calibrationBytes) === p.calibrationReceiptSHA, 'Gate receipt pins');
    const parity = JSON.parse(parityBytes.toString()), calibration = JSON.parse(calibrationBytes.toString());
    check(parity.archiveParity === true && parity.originalSourcePinned === true, 'Original engine/archive witnesses required');
    check(parity.sourceSHA === p.sourceSHA && parity.originalSHA === identity.originalIndexSHA
      && parity.ticks === 1200 && parity.originalCurrentEqual === true && parity.hookOffOnEqual === true,
    'New epoch parity incomplete');
    check(calibration.sourceSHA === p.sourceSHA && calibration.measured === true, 'Measured cost missing');
  }
  mkdirSync(output, { recursive: true });
  const summaries: unknown[] = [];
  for (const arm of ['CTRL','PLAC'] as const) {
    const armDir = join(output, arm); mkdirSync(armDir); // Refuse reused arm directories.
    const store = new Store(join(armDir, 'world.sqlite'));
    let observer: FirstFlipObserver | undefined;
    let hook: ReturnType<typeof attachDecisionObserverV1> | undefined;
    let receipt: unknown = null;
    try {
      const world = createWorld(p.seed, params); store.save(world);
      check(digestoCanonico(world) === p.initialHash && world.tick === 0, 'Initial state mismatch');
      const binding: Binding = { version:1, dataKind:'NATIVE', pairId:p.pairId, runId:`${p.pairId}/${arm}`,
        pairedRunId:`${p.pairId}/${arm === 'CTRL' ? 'PLAC' : 'CTRL'}`, arm, seed:p.seed,
        initialHash:p.initialHash, paramsHash:p.paramsHash, runtimeHash:p.runtimeHash,
        sourceSHA:p.sourceSHA, worldSourceHash:p.worldSourceHash, harnessHash:p.harnessHash,
        preregSHA:hash(raw), firstTick:1, endTick:p.endTick, lowerInclusive:4807 };
      observer = new FirstFlipObserver(join(armDir, 'gates.jsonl'), binding);
      hook = attachDecisionObserverV1(world, observer.observe);
      const stepMs: number[] = [];
      // Original replica governor=no uses in-place steps even with motor.clonPorPaso=true.
      for (let tick = 1; tick <= p.endTick; tick++) {
        if (tick === 4807 && arm === 'PLAC' && p.mode === 'DIAGNOSTIC') {
          const actor = mortalMenorId(world);
          check(actor.id === p.actor && decisionBitsV1(actor.thirst) === p.thirstBeforeBits, 'Original intervention opening mismatch');
          const kick = aplicarPlacebo(world, p.seed, tick); // Unmodified original implementation.
          check(kick.variable === 'thirst' && kick.direccion === 'down' && decisionBitsV1(kick.despues) === p.thirstAfterBits, 'Original intervention mismatch');
          receipt = { tick, personaId:kick.personaId, variable:kick.variable, direccion:kick.direccion,
            beforeBits:decisionBitsV1(kick.antes), afterBits:decisionBitsV1(kick.despues) };
        }
        const started = performance.now(); // Cost measurement only in harness, never decision callbacks.
        stepWorld(world); stepMs.push(performance.now() - started);
        if (tick % params.persistencia.cadaTicks === 0 || technologyJournalNearCapacity(world.technology)
          || chronicleJournalNearCapacity(world) || technologyCatalogueNearCapacity(world.technology)) store.save(world);
      }
      store.save(world);
      observer.finish(hook.faulted(), receipt); observer = undefined;
      const bytes = statSync(join(armDir,'gates.jsonl')).size;
      summaries.push({ arm, ticks:p.endTick, finalHash:digestoCanonico(world), sourceSHA:p.sourceSHA, bytes, stepMs,
        ScientificAcceptance:false, R0:'UNKNOWN' });
    } finally {
      if (observer) observer.finish(true, receipt);
      hook?.detach(); store.close();
    }
  }
  writeFileSync(join(output,'native-summary.json'), JSON.stringify(summaries,null,2)+'\n', {flag:'wx',mode:0o600});
}

/** Native NI helper: ROOT supplies an independently loaded pinned original engine.
 * No simulated equality, no inherited G2, no scoring injections. */
export function measureNativeParity(params: WorldParams, baseline: {
  createWorld: typeof createWorld; stepWorld: typeof stepWorld; digestoCanonico: typeof digestoCanonico;
  saveDue: (world: World, tick: number, params: WorldParams) => boolean;
}, makeStore: (lane: string) => Store, observe: (world: World) => { detach(): void; faulted(): boolean },
archiveDigest: (store: Store) => string): object {
  check(process.env.ATLAS_FIRST_FLIP_NATIVE_CAPSULE === '1', 'Native capsule required');
  const lanes = ['original','current-off','current-on'];
  const results = lanes.map(lane => {
    const store = makeStore(lane), engine = lane === 'original' ? baseline : { createWorld, stepWorld, digestoCanonico,
      saveDue: (world: World, tick: number, params: WorldParams) => tick % params.persistencia.cadaTicks === 0
        || technologyJournalNearCapacity(world.technology) || chronicleJournalNearCapacity(world)
        || technologyCatalogueNearCapacity(world.technology) };
    let hook: ReturnType<typeof observe> | undefined;
    try {
      const world = engine.createWorld(18107, params); store.save(world);
      if (lane === 'current-on') hook = observe(world);
      const initialHash = engine.digestoCanonico(world), times: number[] = [];
      for (let tick=1; tick<=1200; tick++) {
        const start = performance.now(); engine.stepWorld(world); times.push(performance.now()-start);
        if (engine.saveDue(world, tick, params)) store.save(world);
      }
      store.save(world);
      check(!hook?.faulted(), 'Observer fault invalidates parity');
      const archiveHash = archiveDigest(store);
      check(/^[0-9a-f]{64}$/.test(archiveHash), 'Archive hash witness required');
      return {lane,initialHash,finalHash:engine.digestoCanonico(world),archiveHash,times};
    } finally {hook?.detach();store.close();}
  });
  return { ticks:1200, results, archiveParity:results[0]!.archiveHash === results[1]!.archiveHash && results[1]!.archiveHash === results[2]!.archiveHash, originalCurrentEqual:results[0]!.initialHash === results[1]!.initialHash && results[0]!.finalHash === results[1]!.finalHash,
    hookOffOnEqual:results[1]!.initialHash === results[2]!.initialHash && results[1]!.finalHash === results[2]!.finalHash,
    ScientificAcceptance:false, R0:'UNKNOWN' };
}
