import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { deploymentParams } from '../src/server/deployment-params.js';
import { BYTES_PER_ACTIVE_TILE, HEAP_SHARE, HOST_RAM_SHARE, hostLimits, hostMemory, hostParams,
  type HostMemory } from '../src/server/hardware-limits.js';
import { DEFAULT_PARAMS, LEGACY_WORLD_LIMITS, assertWorldLimits, paramsOf } from '../src/world/params.js';

const GiB = 1024 ** 3;
const password = 'synthetic-host-limits-password';
const origin = 'http://127.0.0.1:3000';
function laboratory(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-host-limits-'));
  const path = join(directory, 'world.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}
const chunksFor = (budget: number): number => Math.floor(budget / (BYTES_PER_ACTIVE_TILE * 256));

test('T100/4b: la fórmula sale de la memoria del host y produce regiones enteras', () => {
  const memory: HostMemory = { fisicaBytes: 128 * GiB, heapBytes: 4 * GiB };
  const chunks = chunksFor(Math.min(memory.fisicaBytes * HOST_RAM_SHARE, memory.heapBytes * HEAP_SHARE));
  assert.deepEqual(hostLimits(memory), { teselasActivas: chunks * 256, chunks, comunidades: 8, fauna: chunks * 256 * 6 });
  assert.equal(chunks, 5752);
  assertWorldLimits(hostLimits(memory));
  // La RAM física manda cuando es ella la escasa; el heap, cuando lo es él.
  const pequena: HostMemory = { fisicaBytes: 2 * GiB, heapBytes: 4 * GiB };
  assert.equal(hostLimits(pequena).chunks, chunksFor(2 * GiB * HOST_RAM_SHARE));
  // Un cgroup por debajo de la torre manda sobre la RAM física.
  const acotada: HostMemory = { fisicaBytes: 128 * GiB, heapBytes: 64 * GiB, cgroupBytes: 8 * GiB };
  assert.equal(hostLimits(acotada).chunks, chunksFor(8 * GiB * HOST_RAM_SHARE));
});

test('T100/4b: nunca por debajo de los defaults, ni comunidades derivadas del hardware', () => {
  for (const memory of [{ fisicaBytes: 64 * 1024 ** 2, heapBytes: 64 * 1024 ** 2 },
    { fisicaBytes: 0, heapBytes: 0 }, { fisicaBytes: Number.NaN, heapBytes: Number.POSITIVE_INFINITY },
    { fisicaBytes: -1, heapBytes: -1, cgroupBytes: Number.NaN }] as HostMemory[])
    assert.deepEqual(hostLimits(memory), LEGACY_WORLD_LIMITS, JSON.stringify(memory));
  for (const memory of [{ fisicaBytes: 8 * GiB, heapBytes: 8 * GiB }, { fisicaBytes: 512 * GiB, heapBytes: 512 * GiB }] as HostMemory[])
    assert.equal(hostLimits(memory).comunidades, DEFAULT_PARAMS.limites.comunidades);
  assertWorldLimits(hostLimits(hostMemory()));
});

test('T100/4b: precedencia defaults → límites del host → overrides explícitos', () => {
  const memory: HostMemory = { fisicaBytes: 128 * GiB, heapBytes: 4 * GiB };
  const resolved = hostParams(DEFAULT_PARAMS, memory);
  assert.deepEqual({ ...resolved.limites }, { ...hostLimits(memory), aplicacion: DEFAULT_PARAMS.limites.aplicacion });
  assert.equal(resolved.agua.cuencas, DEFAULT_PARAMS.agua.cuencas, 'el resolver sólo nombra límites');
  const deployed = deploymentParams(resolved, 'limites.chunks=64,agua.cuencas=1');
  assert.equal(deployed.limites.chunks, 64, 'un override explícito manda sobre lo resuelto');
  assert.equal(deployed.limites.teselasActivas, resolved.limites.teselasActivas, 'y sólo sobre lo que nombra');
  assert.equal(deployed.persistencia.cadaTicks, 100);
});

test('T100/4b: el resolver del host corre al crear y jamás al cargar', async t => {
  const path = laboratory(t);
  const memory: HostMemory = { fisicaBytes: 128 * GiB, heapBytes: 4 * GiB };
  let resolutions = 0;
  const factory = () => { resolutions++; return deploymentParams(hostParams(DEFAULT_PARAMS, memory)); };
  const store = new Store(path);
  t.after(() => store.close());
  const app = createApp({ store, password, origin, manual: true, seed: 42, params: factory });
  t.after(async () => { await app.close(); });
  assert.equal(resolutions, 1);
  assert.deepEqual({ ...paramsOf(app.world).limites }, { ...hostLimits(memory), aplicacion: 'parametros' });

  const reopened = new Store(path);
  t.after(() => reopened.close());
  const resumed = createApp({ store: reopened, password, origin, manual: true, seed: 42, params: factory });
  t.after(async () => { await resumed.close(); });
  assert.equal(resolutions, 1, 'un mundo cargado no vuelve a preguntar por la máquina');
  assert.deepEqual(paramsOf(resumed.world).limites, paramsOf(app.world).limites);
});
