import { createHash } from 'node:crypto';
// Digest-only stress control: does not simulate or certify a physically valid world.
import { constants } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [root, mode, output] = process.argv.slice(2);
if (!root || !output || !['old', 'new'].includes(mode!)) throw new Error('root old|new output');
const { createWorld } = await import(pathToFileURL(root + '/src/world/index.ts').href);
const { paramsOf } = await import(pathToFileURL(root + '/src/world/params.ts').href);
const { digestoCanonico } = await import(pathToFileURL(root + '/src/world/digesto.ts').href);
const canonical = (v: unknown): unknown => v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(canonical)
  : Object.fromEntries(Object.entries(v).filter(([, n]) => n !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, n]) => [k, canonical(n)]));
const world = createWorld(51926), marker = '__digest_scale_placeholder__';
world.digestProbe = marker;
const small = JSON.stringify(canonical({ world, params: paramsOf(world) }));
const at = small.indexOf(JSON.stringify(marker)); if (at < 0) throw new Error('missing marker');
const token = 'á🌱'.repeat(16384), quoted = JSON.stringify(token), count = Math.ceil(constants.MAX_STRING_LENGTH / quoted.length) + 4;
const before = small.slice(0, at), after = small.slice(at + JSON.stringify(marker).length);
const chars = before.length + after.length + 2 + quoted.length * count + count - 1;
const expected = createHash('sha256').update(before).update('[');
for (let i = 0; i < count; i++) { if (i) expected.update(','); expected.update(quoted); }
expected.update(']').update(after); const expectedHash = expected.digest('hex');
world.digestProbe = Array(count).fill(token);
const started = performance.now(); let result: string | undefined, error: string | undefined;
try { result = digestoCanonico(world); } catch (e) { error = `${e}`; }
const report = { mode, scope: 'Synthetic digest-only sequence of valid Unicode strings, not a validated/persisted world or a server performance gate.',
  count, canonicalCharacters: chars, maxStringLength: constants.MAX_STRING_LENGTH, exceedsStringLimit: chars > constants.MAX_STRING_LENGTH,
  expectedHash, result, error, elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS,
  digestSourceSha256: createHash('sha256').update(readFileSync(root + '/src/world/digesto.ts')).digest('hex') };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report));
if (mode === 'old' ? !error?.includes('Invalid string length') : result !== expectedHash || error !== undefined) process.exitCode = 1;
