import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { deploymentParams } from '../src/server/deployment-params.js';
import { BYTES_PER_ACTIVE_TILE, HEAP_SHARE, HOST_RAM_SHARE, cgroupMemory, hostLimits, hostMemory, hostParams,
  type HostMemory } from '../src/server/hardware-limits.js';
import { DEFAULT_PARAMS, LEGACY_WORLD_LIMITS, assertWorldLimits, paramsOf } from '../src/world/params.js';
import { type ConLimpieza, directorioTemporal } from './lib/store.js';

const GiB = 1024 ** 3;
const password = 'synthetic-host-limits-password';
const origin = 'http://127.0.0.1:3000';
const laboratory = (t: ConLimpieza) => join(directorioTemporal(t, 'atlas-host-limits-'), 'world.sqlite');
const chunksFor = (budget: number): number => Math.floor(budget / (BYTES_PER_ACTIVE_TILE * 256));

test('T100/4b: la fórmula sale de la memoria del host y produce regiones enteras', () => {
  const memory: HostMemory = { fisicaBytes: 128 * GiB, heapBytes: 4 * GiB };
  const chunks = chunksFor(Math.min(memory.fisicaBytes * HOST_RAM_SHARE, memory.heapBytes * HEAP_SHARE));
  assert.deepEqual(hostLimits(memory), { teselasActivas: chunks * 256, chunks, comunidades: 8, fauna: chunks * 256 * 6 });
  // Caso SINTÉTICO (128 GiB de RAM con heap de 4 GiB), no «los límites de esta torre»: aquí
  // manda el heap, y el heap depende de `NODE_OPTIONS`. Los números reales del host los mide
  // la prueba de abajo, que no los fija porque cambian con la máquina y con el arranque.
  assert.equal(chunks, 5033);
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

/** Árbol cgroup v2 sintético. La raíz NUNCA declara `memory.max` (verificado en esta torre:
 * `cat /sys/fs/cgroup/memory.max` → «No existe el fichero»), así que leerla era leer nada. */
function cgroupTree(t: { after(callback: () => void): void }, own: string, limits: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-cgroup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mount = join(root, 'fs');
  mkdirSync(join(mount, own.slice(1)), { recursive: true });
  for (const [relative, value] of Object.entries(limits)) {
    const directory = join(mount, relative);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'memory.max'), `${value}\n`);
  }
  const self = join(root, 'self-cgroup');
  writeFileSync(self, `0::${own}\n`);
  return { mount, self };
}
const service = '/user.slice/user-1000.slice/user@1000.service/app.slice/atlas-servidor.service';

test('T100/4b: el cgroup del proceso y sus ancestros mandan; la raíz no declara nada', t => {
  // (a) El tope vive en el cgroup del propio proceso y la raíz no tiene el fichero.
  const propio = cgroupTree(t, service, { [service.slice(1)]: String(8 * GiB) });
  assert.equal(cgroupMemory(propio.mount, propio.self), 8 * GiB);
  // (b) El tope vive en una rodaja ANCESTRA: es el caso real de `MemoryMax=` en systemd.
  const ancestro = cgroupTree(t, service, { 'user.slice/user-1000.slice': String(6 * GiB) });
  assert.equal(cgroupMemory(ancestro.mount, ancestro.self), 6 * GiB);
  // (c) Con varios topes en la cadena manda el MÍNIMO, esté donde esté.
  const cadena = cgroupTree(t, service, { 'user.slice': String(16 * GiB),
    'user.slice/user-1000.slice': String(4 * GiB), [service.slice(1)]: String(12 * GiB) });
  assert.equal(cgroupMemory(cadena.mount, cadena.self), 4 * GiB);
});

test('T100/4b: sin cgroup legible manda la RAM física, nunca un tope inventado', t => {
  const libre = cgroupTree(t, service, { 'user.slice': 'max', [service.slice(1)]: 'max' });
  assert.equal(cgroupMemory(libre.mount, libre.self), undefined);
  assert.equal(cgroupMemory(libre.mount, join(libre.mount, 'no-existe')), undefined);
  const basura = cgroupTree(t, service, { [service.slice(1)]: 'ochenta' });
  assert.equal(cgroupMemory(basura.mount, basura.self), undefined);
  const negativo = cgroupTree(t, service, { [service.slice(1)]: '-1' });
  assert.equal(cgroupMemory(negativo.mount, negativo.self), undefined);
  // cgroup v1 (`N:memory:/…`) no se interpreta: se declina en vez de adivinar.
  const v1 = cgroupTree(t, service, { [service.slice(1)]: String(2 * GiB) });
  writeFileSync(v1.self, `12:memory:${service}\n`);
  assert.equal(cgroupMemory(v1.mount, v1.self), undefined);
});

test('T100/4b: en la torre real la lectura es coherente y el resolver la respeta', () => {
  const real = cgroupMemory();
  assert.ok(real === undefined || (Number.isFinite(real) && real > 0), String(real));
  assert.equal(hostMemory().cgroupBytes, real);
  const acotado = hostLimits({ fisicaBytes: 128 * GiB, heapBytes: 64 * GiB, cgroupBytes: 8 * GiB });
  assert.ok(acotado.chunks < hostLimits({ fisicaBytes: 128 * GiB, heapBytes: 64 * GiB }).chunks, 'un cgroup pequeño reduce el mundo admitido');
});

test('T100/4b: los números del host son los de ESTA máquina y ESTE heap, no una cifra fija', () => {
  const memory = hostMemory(), limits = hostLimits(memory);
  const budget = Math.min(Math.min(memory.fisicaBytes, memory.cgroupBytes ?? Infinity) * HOST_RAM_SHARE, memory.heapBytes * HEAP_SHARE);
  assert.equal(limits.chunks, Math.max(DEFAULT_PARAMS.limites.chunks, chunksFor(budget)));
  assert.equal(limits.teselasActivas, limits.chunks * 256);
  assert.equal(limits.fauna, limits.teselasActivas * 6);
  // El techo depende del heap configurado: con `--max-old-space-size` distinto, el MISMO
  // host admite otro mundo. Por eso el contrato registra heap y RAM junto a cada cifra.
  const doble = hostLimits({ ...memory, heapBytes: memory.heapBytes * 2 });
  assert.ok(doble.chunks >= limits.chunks);
  console.log(`Host real: RAM ${memory.fisicaBytes} B, heap ${memory.heapBytes} B, cgroup ${memory.cgroupBytes ?? 'sin tope'} `
    + `⇒ ${limits.chunks} chunks / ${limits.teselasActivas} teselas / ${limits.fauna} de fauna; comunidades ${limits.comunidades}.`);
});
