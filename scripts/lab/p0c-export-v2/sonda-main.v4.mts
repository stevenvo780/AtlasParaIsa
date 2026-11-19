import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { attachReturnSink, closingCommunityCensus, createReturnCollector, OFFICES, runReturnSelftests } from './retornos_v2.mts';
import { sourceInventory } from './instrumentation_v2.mts';
import { BASE_COMMIT, CHECKOUT, OWNED, RUNTIME, requireInsideCheckout, runtimeAnchors, verifyRuntime } from './runtime_v2.mts';
import { ExportLedger } from './export-ledger_v2.mts';
import { DAYS, EXPORT_EPOCH, TICKS_PER_DAY as EXPORT_TICKS_PER_DAY } from './schema_v2.mts';
import { attachApproachObserver, captureApproachDecision, createApproachObserver } from './approach-observer_v2.mts';

const ROOT = OWNED.replace(/\/$/, '');
const STORAGE = join(ROOT, 'storage-v2');
const PARAM_SPEC = 'persistencia.cadaTicks=300,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64,limites.comunidades=64';
const ACTIONS = ['explore','eat','forage','drink','hunt','rest','approach','accompany','retreat','share','gather','farm','build','cooperate','invent','repair','research','craft'];
const PROD = ['gather','forage','hunt','farm','build','repair','research','craft'];
export const LEGACY_KEYS = ['dia', 'n', 'pob', 'oficios', 'oficiosSinApproach', 'dom', 'fracApproachDominante', 'approachPorMotivo',
  'ticksPorContexto', 'sharingMedia', 'distCulturalGrupos', 'gruposG3', 'jovenes', 'sigmaHabilidad'] as const;
const cls = (r: string) => r.startsWith('Recuerda el vínculo') ? 'cortejo' : r.startsWith('Tiene reservas') ? 'familia' : r.startsWith('Vuelve a un lugar conocido') ? 'hogar'
  : r.startsWith('Percibe una invitación') ? 'invitacion' : r.startsWith('Recuerda el cuidado') ? 'habito' : r.startsWith('Le apetece') ? 'pareja' : 'otro';
const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

export function literalRequest(executable: string, execArgv: readonly string[], argv: readonly string[], guardLabel: string) {
  assert.ok(argv[1], 'Probe script path required.');
  const args = argv.slice(2);
  return { command: [executable, ...execArgv, resolve(argv[1]!), ...args], argv: args, guardLabel };
}

type Normalization = { ghatPath: string; ghatSha256: string; sealPath: string; sealSha256: string; sealedAt: string };

/** This reads only the sealed files; no World import, normalization, or learning happens here. */
export function readNormalization(purpose: string, args: readonly string[], startAt: string,
  read: (path: string) => Buffer = path => readFileSync(path)): Normalization | null {
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const file = value('--ghat-file'), sha = value('--ghat-sha'), sealFile = value('--ghat-seal');
  if (purpose !== 'p0c') {
    assert.ok(!args.some(arg => ['--ghat-file', '--ghat-sha', '--ghat-seal'].includes(arg)), 'Normalization flags are only for P0.c.');
    return null;
  }
  assert.ok(file && sealFile && /^[0-9a-f]{64}$/.test(sha ?? ''), 'P0.c requires --ghat-file FILE --ghat-sha SHA --ghat-seal FILE.');
  const ghatPath = resolve(file!), sealPath = resolve(sealFile!);
  assert.equal(hash(read(ghatPath)), sha, 'Frozen normalization hash differs.');
  const sealBody = read(sealPath), seal = JSON.parse(sealBody.toString());
  assert.equal(seal.schema, 'c8-ghat-seal-v1', 'Wrong normalization seal schema.');
  assert.equal(seal.ghatPath, ghatPath, 'Seal normalization path differs.');
  assert.equal(seal.ghatSha256, sha, 'Seal normalization hash differs.');
  assert.ok(typeof seal.sealedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(seal.sealedAt), 'Seal time must be ISO UTC.');
  const sealedTime = Date.parse(seal.sealedAt), startTime = Date.parse(startAt);
  assert.ok(Number.isFinite(sealedTime) && Number.isFinite(startTime) && sealedTime < startTime, 'Seal must precede probe startup.');
  return { ghatPath, ghatSha256: sha!, sealPath, sealSha256: hash(sealBody), sealedAt: seal.sealedAt };
}

function requestSealFixtures() {
  const executable = '/owned/copied-node', execArgv = ['--import', 'tsx'];
  const args = ['9501', '60', '/owned/output with space.jsonl', '--purpose', 'p0c', '--params-file', '/owned/params.json',
    '--params-sha', 'a'.repeat(64), '--guard-label', 'fixture-p0c', '--ghat-file', '/owned/ghat.json',
    '--ghat-sha', hash('synthetic frozen normalization'), '--ghat-seal', '/owned/ghat.seal.json'];
  const argv = [executable, './sonda.mts', ...args], request = literalRequest(executable, execArgv, argv, 'fixture-p0c');
  assert.deepEqual(request, { command: [executable, ...execArgv, resolve('./sonda.mts'), ...args], argv: args, guardLabel: 'fixture-p0c' });
  argv[2] = 'altered'; assert.equal(request.argv[0], '9501'); assert.equal(request.command[4], '9501');
  const startAt = '2026-10-01T13:00:00.000Z', ghatBody = Buffer.from('synthetic frozen normalization');
  const seal = { schema: 'c8-ghat-seal-v1', sealedAt: '2026-10-01T12:59:59.000Z', ghatPath: '/owned/ghat.json', ghatSha256: hash(ghatBody) };
  const read = (candidate: unknown = seal, body = ghatBody) => (path: string) => {
    assert.ok(path === '/owned/ghat.json' || path === '/owned/ghat.seal.json', 'Unexpected fixture file read.');
    return path === '/owned/ghat.json' ? body : Buffer.from(JSON.stringify(candidate));
  };
  const actual = readNormalization('p0c', args, startAt, read());
  assert.deepEqual(actual, { ghatPath: '/owned/ghat.json', ghatSha256: hash(ghatBody), sealPath: '/owned/ghat.seal.json',
    sealSha256: hash(JSON.stringify(seal)), sealedAt: seal.sealedAt });
  for (const bad of [{ ...seal, schema: 'old-seal' }, { ...seal, sealedAt: startAt },
    { ...seal, sealedAt: '2026-10-01T13:00:01.000Z' }, { ...seal, sealedAt: 'invalid' },
    { ...seal, sealedAt: '2026-10-01T12:59:59-05:00' }, { ...seal, ghatPath: '/different/ghat.json' },
    { ...seal, ghatSha256: 'b'.repeat(64) }]) assert.throws(() => readNormalization('p0c', args, startAt, read(bad)));
  assert.throws(() => readNormalization('p0c', args, startAt, read(seal, Buffer.from('changed'))));
  assert.throws(() => readNormalization('p0c', [], startAt, read()));
  for (const flag of ['--ghat-file', '--ghat-sha', '--ghat-seal']) {
    const missing = [...args], at = missing.indexOf(flag); missing.splice(at, 2);
    assert.throws(() => readNormalization('p0c', missing, startAt, read()));
  }
  const noRead = () => { throw new Error('Calibration/identity must not read normalization.'); };
  assert.equal(readNormalization('calibration', [], startAt, noRead), null);
  assert.equal(readNormalization('identity', [], startAt, noRead), null);
  assert.throws(() => readNormalization('calibration', args, startAt, noRead));
  return { literalCommand: true, rawArgumentsCopied: true, sealedBeforeStartup: true, invalidSealsRejected: true, normalizationNullWithoutReads: true };
}

/** Arithmetic, traversal, tie order, census and even the old sharing denominator are deliberately unchanged. */
export function createLegacyProbe(world: any, TICKS_PER_DAY = 2400) {
  let dia = new Map<string, Record<string, number>>();
  let apr: Record<string, number> = {}; let ctx: Record<string, number> = {};
  let vivosInicio = new Set(world.people.filter((p: any) => p.role === 'neighbor').map((p: any) => p.id));
  const ent = (counts: Map<string, number>, n: number) => { let e = 0; if (counts.size > 1) { for (const c of counts.values()) { const s = c / n; e -= s * Math.log(s); } e = Math.min(1, e / Math.log(18)); } return e; };
  return {
    record(world: any) {
      for (const p of world.people as any[]) {
        let d = dia.get(p.id); if (!d) { d = {}; dia.set(p.id, d); }
        d[p.action] = (d[p.action] ?? 0) + 1;
        if (p.role === 'neighbor' && p.action !== 'rest') {
          ctx[`${p.intentContext}:${PROD.includes(p.action) ? 'prod' : p.action === 'approach' ? 'approach' : 'otra'}`] = (ctx[`${p.intentContext}:${PROD.includes(p.action) ? 'prod' : p.action === 'approach' ? 'approach' : 'otra'}`] ?? 0) + 1;
          if (p.action === 'approach') { const k = cls(p.reason); apr[k] = (apr[k] ?? 0) + 1; }
        }
      }
    },
    closeDay(world: any) {
      const tick = world.tick;
      const ventana = (world.people as any[]).filter(p => p.role === 'neighbor' && vivosInicio.has(p.id));
      const dom = new Map<string, number>(), domSinAp = new Map<string, number>(), domSoloProd = new Map<string, number>();
      let nProdUsuarios = 0;
      for (const p of ventana) {
        const t = dia.get(p.id) ?? {};
        let best = '', bv = 0, best2 = '', bv2 = 0;
        for (const a of ACTIONS) { if (a === 'rest') continue; const c = t[a] ?? 0; if (c > 0 && c > bv) { best = a; bv = c; } if (a !== 'approach' && c > 0 && c > bv2) { best2 = a; bv2 = c; } }
        dom.set(best, (dom.get(best) ?? 0) + 1); domSinAp.set(best2, (domSinAp.get(best2) ?? 0) + 1);
        if (best !== 'approach') { domSoloProd.set(best, (domSoloProd.get(best) ?? 0) + 1); nProdUsuarios++; }
      }
      const grupos = new Map<string, any[]>();
      for (const p of world.people as any[]) if (p.role === 'neighbor' && p.communityId) { const g = grupos.get(p.communityId) ?? []; g.push(p); grupos.set(p.communityId, g); }
      const medias = [...grupos.values()].filter(g => g.length >= 3).map(g => ['sharing','stewardship','openness'].map(k => g.reduce((s, p) => s + p.culture[k], 0) / g.length));
      let dc = 0, np = 0; for (let i = 0; i < medias.length; i++) for (let j = i + 1; j < medias.length; j++) { dc += medias[i]!.reduce((s: number, x: number, k: number) => s + Math.abs(x - medias[j]![k]!), 0) / 3; np++; }
      const jov = (world.people as any[]).filter(p => p.role === 'neighbor' && world.tick - p.bornAt >= 5 * TICKS_PER_DAY && world.tick - p.bornAt < 8 * TICKS_PER_DAY);
      const sk = ['gather','forage','hunt','farm','build','repair','technology'].map(k => { const v = jov.map(p => p.skills[k] ?? 0); const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length)); });
      const fila = { dia: tick / TICKS_PER_DAY, n: ventana.length, pob: world.people.length,
        oficios: ent(dom, ventana.length), oficiosSinApproach: ent(domSinAp, ventana.length),
        dom: Object.fromEntries([...dom].sort((a, b) => b[1] - a[1])), fracApproachDominante: (dom.get('approach') ?? 0) / Math.max(1, ventana.length),
        approachPorMotivo: apr, ticksPorContexto: ctx, sharingMedia: (world.people as any[]).filter(p => p.role === 'neighbor').reduce((s, p) => s + p.culture.sharing, 0) / Math.max(1, ventana.length),
        distCulturalGrupos: np ? dc / np : null, gruposG3: medias.length, jovenes: jov.length, sigmaHabilidad: jov.length >= 20 ? sk.reduce((a, b) => a + b, 0) / sk.length : null };
      dia = new Map(); apr = {}; ctx = {};
      vivosInicio = new Set((world.people as any[]).filter(p => p.role === 'neighbor').map(p => p.id));
      return fila;
    },
  };
}

export function assertLegacyIdentity(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'Legacy fields, key order or values differ from original P0.');
}

/** The final day gets exactly one export, after finalization has censored/matured its remaining trips. */
export function closeApproachDay<T>(observer: { finish(world: any): void; exportTrips(): unknown[]; exportDay(day: number): T },
  world: any, day: number, final: boolean, appendTrips: (rows: unknown[]) => void): T {
  if (final) { observer.finish(world); appendTrips(observer.exportTrips()); }
  return observer.exportDay(day);
}

function finalDayFixture() {
  const person = (id: string) => ({ id, role: 'neighbor', action: 'rest', reason: '', x: 0, y: 0, decisionAt: 0,
    target: { x: 0, y: 0 }, communityId: 'g', inventory: 0.2, hunger: 0.4, thirst: 0.2, fatigue: 0.2,
    energy: 0.6, genome: { parents: [] as string[] }, bonds: {} });
  const a = person('a'), b = person('b'), input = { tick: 0, people: [a, b], places: [{ id: 'p', x: 0, y: 0 }] };
  const observer = createApproachObserver({ ticksPerDay: 2 }); attachApproachObserver(input, observer);
  let finishCalls = 0;
  const originalFinish = observer.finish.bind(observer);
  observer.finish = world => { finishCalls++; originalFinish(world); };
  const days: ReturnType<typeof observer.exportDay>[] = [], trips: ReturnType<typeof observer.exportTrips> = [];
  for (let tick = 1; tick <= 120; tick++) {
    observer.beginTick(input); input.tick++;
    if (tick === 119) {
      a.action = 'approach'; a.reason = 'Tiene reservas synthetic'; a.decisionAt = 149;
      captureApproachDecision(input, a, { partner: b, placeId: 'p' });
    }
    observer.endTick(input); trips.push(...observer.exportTrips());
    if (tick % 2 === 0) days.push(closeApproachDay(observer, input, tick / 2, tick === 120,
      rows => trips.push(...rows as typeof trips)));
  }
  assert.equal(days.length, 60); assert.deepEqual(days.map(day => day.day), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal(finishCalls, 1); assert.equal(trips.length, 1); assert.equal(trips[0]!.endTick, 120);
  assert.equal(trips[0]!.censored, true); assert.equal(trips[0]!.attributionCensored, true);
  const last = days[59]!; assert.equal(last.pendingTrips, 0); assert.equal(last.activeTrips, 0);
  for (const key of ['familia.closed', 'familia.matured', 'familia.censored']) {
    assert.equal(last.stats[key], 1);
    assert.equal(days.reduce((sum, day) => sum + (day.stats[key] ?? 0), 0), trips.length);
  }
  assert.equal(last.stats['familia.sumTripTicks'], trips[0]!.ticks);
  return { days: days.length, finishCalls, finalCensoredTrips: trips.length, summariesMatchTrips: true };
}

export function realManifestHeader() { return { schema: 'c8-p0c-run-export-v2', synthetic: false as const }; }
export function describeRealOutput(path: string, sha256: string, rows: number) { return { path, sha256, rows, synthetic: false as const }; }

function realHeaderFixture() {
  const header = JSON.parse(JSON.stringify(realManifestHeader()));
  assert.deepEqual(header, { schema: 'c8-p0c-run-export-v2', synthetic: false });
  for (const name of ['legacy', 'returns', 'census', 'coverage', 'approachDays', 'trips']) {
    const descriptor = JSON.parse(JSON.stringify(describeRealOutput(`/owned/${name}.jsonl`, 'a'.repeat(64), 0)));
    assert.equal(descriptor.synthetic, false); assert.equal(typeof descriptor.synthetic, 'boolean');
    assert.deepEqual(descriptor, { path: `/owned/${name}.jsonl`, sha256: 'a'.repeat(64), rows: 0, synthetic: false });
  }
  return { manifestExplicitFalse: true, outputDescriptorsExplicitFalse: 6, rowMarkersAdded: false };
}

function writer(path: string) {
  writeFileSync(path, '', { flag: 'wx' });
  const digest = createHash('sha256'); let rows = 0;
  return {
    append(values: readonly unknown[]) {
      if (!values.length) return;
      const body = values.map(value => JSON.stringify(value) + '\n').join('');
      appendFileSync(path, body); digest.update(body); rows += values.length;
    },
    describe() { return describeRealOutput(path, digest.copy().digest('hex'), rows); },
  };
}

export function runProbeSelftests() {
  const person = (id: string, role = 'neighbor', sharing = 0.4): any => ({ id, role, communityId: 'g', action: 'rest',
    reason: '', intentContext: 'ready', culture: { sharing, stewardship: 0.2, openness: 0.3 }, bornAt: 0, skills: {} });
  const a = person('a'), b = person('b', 'neighbor', 0.6), protectedPerson = person('S', 'S', 0.9);
  const input = { tick: 0, people: [a, b, protectedPerson] }, probe = createLegacyProbe(input);
  a.action = 'approach'; a.reason = 'Tiene reservas y percibe una oportunidad familiar';
  probe.record({ ...input, tick: 1 });
  const newborn = person('c', 'neighbor', 0.8), row = probe.closeDay({ tick: 2400, people: [a, b, protectedPerson, newborn] });
  assert.deepEqual(Object.keys(row), LEGACY_KEYS); assert.equal(row.n, 2); assert.equal(row.pob, 4);
  assert.equal(row.fracApproachDominante, 0.5); assert.equal(row.sharingMedia, 0.9);
  assert.deepEqual(row.dom, { approach: 1, '': 1 }); assert.deepEqual(row.approachPorMotivo, { familia: 1 });
  assert.deepEqual(row.ticksPorContexto, { 'ready:approach': 1 }); assert.equal(row.gruposG3, 1);
  assertLegacyIdentity(row, JSON.parse(JSON.stringify(row)));
  assert.throws(() => assertLegacyIdentity(row, { ...row, oficios: row.oficios + 1e-9 }));
  assert.throws(() => assertLegacyIdentity(row, { ...row, added: true }));
  assert.throws(() => assertLegacyIdentity(row, Object.fromEntries(Object.entries(row).reverse())));
  const next = probe.closeDay({ tick: 4800, people: [a, b, protectedPerson, newborn] });
  assert.equal(next.n, 3); assert.deepEqual(next.approachPorMotivo, {}); assert.deepEqual(next.ticksPorContexto, {});
  return { valid: true, pure: true, engineImported: false, stepWorldCalls: 0,
    legacyKeys: LEGACY_KEYS.length, returns: runReturnSelftests(), instrumentation: { sourceTransformsExecuted: false, requiresStandaloneQA: true },
    finalDay: finalDayFixture(), requestSeal: requestSealFixtures(), realHeader: realHeaderFixture(),
    checks: ['legacy fixed projection/order', 'newborn window', 'legacy sharing denominator unchanged', 'mismatch abort', 'day reset',
      'finish before only final day export', '60 day rows', 'final counters equal raw trips'] };
}

async function main() {
  const startAt = new Date().toISOString();
  process.title = 'codex11sonda';
  const args = process.argv.slice(2);
  if (args[0] === '--selftest' || args[0] === '--check') { console.log(JSON.stringify(runProbeSelftests())); return; }
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!process.env.TMPDIR) throw new Error('Owned TMPDIR required.');
  requireInsideCheckout(process.env.TMPDIR);
  const preview = args[0] === '--params-preview';
  const seed = Number(args[0]), dias = Number(args[1]), out = args[2];
  const paramsPath = value('--params-file'), expectedParamsHash = value('--params-sha'), guardLabel = value('--guard-label');
  const purpose = value('--purpose');
  if (!preview && (!Number.isSafeInteger(seed) || seed < 1 || !Number.isSafeInteger(dias) || dias !== DAYS || !out
    || !['calibration', 'p0c', 'identity'].includes(purpose ?? '') || !paramsPath || !/^[0-9a-f]{64}$/.test(expectedParamsHash ?? '')
    || !/^[A-Za-z0-9_.-]+$/.test(guardLabel ?? '')))
    throw new Error('seed days output --purpose calibration|p0c|identity --params-file frozenJSON --params-sha SHA --guard-label LABEL required.');
  // A P0.c seal is checked before even importing runtime parameter helpers.
  const normalization = preview ? null : readNormalization(purpose!, args, startAt);
  const request = preview ? null : literalRequest(process.execPath, process.execArgv, process.argv, guardLabel!);
  const instrumentation = verifyRuntime();
  const instrumentationPath = join(RUNTIME, 'instrumentation.json');
  const instrumentationBody = readFileSync(instrumentationPath);
  assert.equal(instrumentation.sourceCommit, BASE_COMMIT, 'Wrong control source epoch.');
  const module = (path: string) => import(pathToFileURL(join(RUNTIME, path)).href);
  const { parseParams, paramsOf } = await module('src/world/params.ts');
  if (preview) {
    const { hostParams } = await module('src/server/hardware-limits.ts');
    console.log(JSON.stringify(parseParams(PARAM_SPEC, hostParams()))); return;
  }
  const outputPath = requireInsideCheckout(resolve(out));
  if (!outputPath.startsWith(ROOT + '/') || outputPath.startsWith(RUNTIME + '/') || outputPath.includes('/source-control/'))
    throw new Error('Legacy output must be a new P0.c file outside frozen sources.');
  const paramsBody = readFileSync(paramsPath!);
  if (hash(paramsBody) !== expectedParamsHash) throw new Error('Frozen effective parameters hash differs.');
  const params = parseParams(JSON.parse(paramsBody.toString()));
  if ((params.conducta.utilidadLocal ?? 0) !== 0 || params.persistencia.cadaTicks !== 300 || params.social.radioConvivencia !== 12
    || params.social.disolucion !== 1 || params.social.maxComunidades !== 64 || params.limites.comunidades !== 64)
    throw new Error('Control must be exact V13 and utility OFF.');
  const baselinePath = '/datos/tmp-atlas-lab/balance/codex11/BASELINE-PREVIO.json';
  const runtimePreviousPath = '/datos/tmp-atlas-lab/balance/codex11/RUNTIME-PREVIO.json';
  const captureAnchors = () => ({
    frozen: runtimeAnchors(), runtimeInventory: sourceInventory(join(RUNTIME, 'src')),
    originalSourceSha256: Object.fromEntries([
      ...sourceInventory(join(CHECKOUT, 'src')).map(entry => ['src/' + entry.path, entry.sha256]),
      ...['package.json', 'tsconfig.json', 'tsconfig.server.json'].map(path => [path, hash(readFileSync(join(CHECKOUT, path)))]),
    ]),
    probeSha256: hash(readFileSync(new URL(import.meta.url))), paramsSha256: hash(readFileSync(paramsPath!)),
    instrumentationManifestSha256: hash(readFileSync(instrumentationPath)),
    baselineManifestSha256: hash(readFileSync(baselinePath)), executableSha256: hash(readFileSync(process.execPath)),
    guardSha256: hash(readFileSync('/datos/tmp-atlas-lab/balance/codex11/run_guarded.mjs')),
    runtimeManifestSha256: hash(readFileSync(runtimePreviousPath)),
    normalization: readNormalization(purpose!, args, startAt),
  });
  const beforeAnchors = captureAnchors(), baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert.deepEqual(beforeAnchors.originalSourceSha256, baseline.sourceSha256,
    'Original control export inventory/hash differs from the frozen baseline.');
  assert.deepEqual(beforeAnchors.runtimeInventory, instrumentation.runtimeInventory, 'Instrumental source inventory differs.');
  assert.deepEqual(beforeAnchors.frozen.observerSha256, instrumentation.observerSha256, 'Observer/instrumenter source differs.');
  assert.equal(beforeAnchors.paramsSha256, expectedParamsHash);
  assert.equal(beforeAnchors.instrumentationManifestSha256, hash(instrumentationBody));
  assert.deepEqual(beforeAnchors.normalization, normalization, 'Normalization drift before engine startup.');
  const runtimePrevious = JSON.parse(readFileSync(runtimePreviousPath, 'utf8'));
  assert.equal(beforeAnchors.executableSha256, runtimePrevious.sha256[process.execPath], 'Wrong owned runtime executable hash.');
  assert.equal(beforeAnchors.guardSha256, runtimePrevious.sha256['/datos/tmp-atlas-lab/balance/codex11/run_guarded.mjs'], 'Guard source differs.');
  const originalPath = value('--compare-legacy') ?? (seed >= 9501 && seed <= 9504 ? `/datos/tmp-atlas-lab/datos-lab/c8-p0/s${seed}.jsonl` : undefined);
  const previous = originalPath ? readFileSync(originalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : undefined;
  if (previous && previous.length < dias) throw new Error('Original legacy evidence does not cover requested days.');
  requireInsideCheckout(STORAGE);
  if (!existsSync(STORAGE)) mkdirSync(STORAGE, { mode: 0o700 });
  assert.equal(realpathSync(STORAGE), STORAGE, 'Storage symlink forbidden.');
  const dataDir = mkdtempSync(join(STORAGE, `sonda-c8-${seed}-`));
  process.env.CARTA_DATA_DIR = dataDir;
  const { Store } = await module('src/server/store.ts');
  const { technologyJournalNearCapacity } = await module('src/world/technology-journal.ts');
  const { chronicleJournalNearCapacity } = await module('src/world/chronicle-journal.ts');
  const { technologyCatalogueNearCapacity } = await module('src/world/technology-catalogue.ts');
  const { createWorld, stepWorld, TICKS_PER_DAY } = await module('src/world/index.ts');
  const world = createWorld(seed, params), collector = createReturnCollector({ seed, ticksPerDay: TICKS_PER_DAY });
  assert.equal(TICKS_PER_DAY, EXPORT_TICKS_PER_DAY, 'Export clock differs from scientific epoch.');
  const approach = createApproachObserver({ ticksPerDay: TICKS_PER_DAY });
  const exportLedger = new ExportLedger(approach, TICKS_PER_DAY);
  const detach = attachReturnSink(world, collector.record); attachApproachObserver(world, approach);
  const legacy = createLegacyProbe(world, TICKS_PER_DAY), store = new Store(join(dataDir, 'world.sqlite'));
  const outputs = { legacy: writer(outputPath), returns: writer(join(dataDir, 'retornos.jsonl')),
    census: writer(join(dataDir, 'censo.jsonl')), coverage: writer(join(dataDir, 'cobertura.jsonl')),
    approachDays: writer(join(dataDir, 'approach-dias.jsonl')), ledger: writer(join(dataDir, 'export-ledger.jsonl')), trips: writer(join(dataDir, 'viajes.jsonl')) };
  const manifestPath = outputPath + '.manifest.json';
  if (existsSync(manifestPath)) throw new Error('Preserving existing run manifest.');
  let daysCompleted = 0, previousTotal = collector.summary();
  const manifest: any = { ...realManifestHeader(), status: 'running', startAt, recordedAt: new Date().toISOString(), request, normalization,
    seed, purpose, daysRequested: dias, ticksPerDay: TICKS_PER_DAY,
    exportEpoch: EXPORT_EPOCH, scientificAcceptance: false,
    source: { commit: BASE_COMMIT, instrumentationManifestPath: instrumentationPath,
      instrumentationManifestSha256: hash(instrumentationBody), observerSha256: instrumentation.observerSha256,
      probeSha256: beforeAnchors.probeSha256, before: beforeAnchors, after: null, anchorMatch: false },
    control: { lawFlag: 0, learningStateReadOrWritten: false, observerState: 'external WeakMap and scalar copies',
      globalSourceEffect: 'owned runtime observation only; source-control/main/WT unchanged' },
    params: paramsOf(world), paramsPath, paramsSha256: expectedParamsHash,
    runtime: { executable: process.execPath, nodeVersion: process.version, executableSha256: hash(readFileSync(process.execPath)),
      heapSizeLimit: getHeapStatistics().heap_size_limit, execArgv: process.execArgv },
    dataDir, storeCalendar: { everyTicks: 300, journalCapacityChecks: ['technology', 'chronicle', 'catalogue'], extraDaySaveIfNeeded: true },
    exportTiming: { snapshotAt: 'N=k*2400', days1to59: 'seal and emit after endTick(N+1)', day60: 'finish then seal once at 144000' },
    guard: { receipt: `/datos/tmp-atlas-lab/balance/codex11/${guardLabel}.json`, requireValid: true, evidence: 'external; guard writes after child exit' },
    legacyComparison: originalPath ? { path: originalPath, sha256: hash(readFileSync(originalPath)), checkedDays: 0 } : null };
  const updateManifest = () => {
    manifest.coverage = { firstTick: 1, lastTick: world.tick, daysCompleted, legacyRows: outputs.legacy.describe().rows,
      returnRows: outputs.returns.describe().rows, returnSummary: collector.summary() };
    manifest.outputs = Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, output.describe()]));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  };
  updateManifest();
  try {
    store.save(world);
    const appendSealed = (sealed: ReturnType<typeof exportLedger.emitAfterProcessing>) => {
      if (!sealed) return;
      outputs.approachDays.append([sealed.row]); outputs.ledger.append([sealed.ledger]);
      daysCompleted++; updateManifest();
    };
    for (let tick = 1; tick <= dias * TICKS_PER_DAY; tick++) {
      approach.beginTick(world);
      try { stepWorld(world); approach.endTick(world); }
      catch (error) { approach.discardTick(); throw error; }
      appendSealed(exportLedger.emitAfterProcessing(tick));
      legacy.record(world);
      if (tick % params.persistencia.cadaTicks === 0 || technologyJournalNearCapacity(world.technology) || chronicleJournalNearCapacity(world) || technologyCatalogueNearCapacity(world.technology)) store.save(world);
      if (collector.pendingCount >= 1024 || tick % 300 === 0) outputs.returns.append(collector.drain());
      outputs.trips.append(approach.exportTrips());
      if (tick % TICKS_PER_DAY === 0) {
        if (tick % params.persistencia.cadaTicks !== 0) store.save(world);
        const fila = legacy.closeDay(world);
        if (previous) { assertLegacyIdentity(fila, previous[tick / TICKS_PER_DAY - 1]); manifest.legacyComparison.checkedDays++; }
        outputs.legacy.append([fila]); outputs.returns.append(collector.drain());
        const currentTotal = collector.summary(), day = tick / TICKS_PER_DAY;
        const census = closingCommunityCensus(world, day);
        outputs.census.append([census]);
        const coverage = { schema: 'c8-paid-return-coverage-v1', seed, day, fromTickExclusive: tick - TICKS_PER_DAY,
          throughTickInclusive: tick, observedTicks: TICKS_PER_DAY, complete: true,
          firstSerial: currentTotal.attempts > previousTotal.attempts ? previousTotal.attempts + 1 : null,
          lastSerial: currentTotal.attempts > previousTotal.attempts ? currentTotal.attempts : null,
          attempts: currentTotal.attempts - previousTotal.attempts,
          byOffice: Object.fromEntries(OFFICES.map(office => [office, Object.fromEntries(Object.keys(currentTotal.byOffice[office])
            .map(key => [key, currentTotal.byOffice[office][key as keyof typeof currentTotal.byOffice[typeof office]]
              - previousTotal.byOffice[office][key as keyof typeof previousTotal.byOffice[typeof office]]]))])) };
        outputs.coverage.append([coverage]);
        exportLedger.captureBoundary({ world, demography: { dynamics: world.demographyDynamics,
          people: world.people.map((p: { id: string; demography: unknown }) => ({ id: p.id, demography: p.demography })) },
          legacy: fila, census, coverage });
        if (day === DAYS) {
          approach.finish(world); outputs.trips.append(approach.exportTrips());
          appendSealed(exportLedger.emitAfterProcessing(tick, true));
        }
        previousTotal = currentTotal; updateManifest();
      }
    }
    exportLedger.complete();
    outputs.returns.append(collector.drain());
    store.close();
    manifest.source.after = captureAnchors();
    assert.deepEqual(manifest.source.after, beforeAnchors, 'Source/observer/probe/params/runtime/guard/normalization drift during the run.');
    manifest.source.anchorMatch = true;
    manifest.status = 'complete'; updateManifest();
    console.log(JSON.stringify({ valid: true, seed, daysCompleted, manifestPath, dataDir, outputs: manifest.outputs }));
  } catch (error) {
    outputs.returns.append(collector.drain());
    manifest.status = 'failed'; manifest.error = error instanceof Error ? error.message : String(error);
    try { store.close(); } catch (closeError) { manifest.closeError = String(closeError); }
    updateManifest(); throw error;
  } finally { detach(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
