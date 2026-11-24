/**
 * Auditoría V15 del servidor: cierre de piscinas y precedencia
 * `CARTA_OPEN_WORLD` → `CARTA_PARAMS`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cerrarPiscinasDeComputo, createApp } from '../src/server/app.js';
import { deploymentParams } from '../src/server/deployment-params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { resumenDespacho, resumenVivo } from '../src/server/resumen-vivo.js';
import { Store } from '../src/server/store.js';
import { ecosystemWorkerDiagnostics } from '../src/world/ecosystem.js';
import { DEFAULT_PARAMS, parseParams, paramsOf } from '../src/world/params.js';
import { POPULATION_HARD_LIMIT } from '../src/shared/life.js';
import { createWorld } from '../src/world/index.js';

const GiB = 1024 ** 3;
const probe = {
  cpuThreads: () => 32,
  totalRamBytes: () => 128 * GiB,
  nvrtcAvailable: () => true,
  nvidiaSmi: () => '0\n1\n',
  memory: () => ({ fisicaBytes: 128 * GiB, heapBytes: 8 * GiB }),
};

function hilosProceso(): number {
  const estado = readFileSync('/proc/self/status', 'utf8');
  return Number(estado.match(/^Threads:\s+(\d+)/m)?.[1] ?? 0);
}

function shmAbiertos(): string[] {
  try {
    return readdirSync('/proc/self/fd').flatMap(fd => {
      try {
        const destino = readlinkSync(join('/proc/self/fd', fd));
        return destino.includes('atlas-policy-') || destino.includes('/dev/shm/') ? [destino] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

test('V15: mundo nuevo fusiona host abierto y CARTA_PARAMS; uno cargado solo cede lo nombrado', () => {
  const abierto = deploymentParams(hostOpenWorldParams(DEFAULT_PARAMS, probe), undefined);
  assert.equal(abierto.motor.hilos, 32);
  assert.deepEqual(abierto.motor.gpu, [0, 1]);
  assert.equal(abierto.motor.soaTerreno, true);
  assert.equal(abierto.motor.particionarPersonas, true);
  assert.equal(abierto.poblacion.natalidadVecindad, true);
  assert.equal(abierto.poblacion.radioVecindadNatalidad, 16);
  assert.equal(abierto.social.maxComunidades, 0);
  assert.ok(abierto.poblacion.maxima >= POPULATION_HARD_LIMIT, 'el modo abierto no añade un tope de población por debajo del anticorrupción');
  assert.equal(abierto.persistencia.cadaTicks, 100);
  assert.equal(abierto.persistencia.ventanaEventosTicks, 24000);

  const carta = deploymentParams(hostOpenWorldParams(DEFAULT_PARAMS, probe), 'social.maxComunidades=64,motor.hilos=8,persistencia.cadaTicks=50,poblacion.radioVecindadNatalidad=32');
  assert.equal(carta.social.maxComunidades, 64, 'CARTA_PARAMS pisa la clave que nombra');
  assert.equal(carta.motor.hilos, 8);
  assert.deepEqual(carta.motor.gpu, [0, 1], 'una clave de motor no nombrada se conserva');
  assert.equal(carta.poblacion.natalidadVecindad, true);
  assert.equal(carta.poblacion.radioVecindadNatalidad, 32);
  assert.equal(carta.persistencia.cadaTicks, 50);
  assert.equal(carta.persistencia.ventanaEventosTicks, 24000, 'PRODUCTION_PARAMS sigue debajo de CARTA_PARAMS');

  const cargado = deploymentParams(parseParams('social.maxComunidades=8,motor.hilos=1,motor.gpu=[],poblacion.natalidadVecindad=false'), undefined);
  assert.equal(cargado.social.maxComunidades, 8);
  assert.equal(cargado.motor.hilos, 1);
  assert.deepEqual(cargado.motor.gpu, []);
  assert.equal(cargado.poblacion.natalidadVecindad, false, 'un mundo cargado no hereda las leyes abiertas');
  assert.equal(cargado.persistencia.cadaTicks, 100, 'la cadencia de producción sí se impone');

  const world = createWorld(51926, abierto);
  const despacho = resumenDespacho(world);
  assert.deepEqual(despacho, {
    hilos: 32, gpu: [0, 1], soaTerreno: true, particionarPersonas: true,
    natalidadVecindad: true, radioVecindadNatalidad: 16, maxComunidades: 0,
  });
  assert.deepEqual(Object.keys(resumenVivo(world)).sort(), ['comidaCompartida', 'conducta', 'natalidad']);
  assert.equal(paramsOf(world).poblacion.natalidadVecindad, true);
});

test('V15: close() suelta las piscinas que abrió el paso y se puede repetir', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-v15-cierre-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const antes = hilosProceso();
  const shmAntes = shmAbiertos();
  let app: ReturnType<typeof createApp> | undefined;
  t.after(async () => {
    try { await app?.close(); } catch { /* la prueba ya cerró */ }
    try { store.close(); } catch { /* idem */ }
    rmSync(dir, { recursive: true, force: true });
  });
  app = createApp({
    store, password: 'synthetic-v15-audit-password', origin: 'http://127.0.0.1:3000', manual: true, seed: 51926,
    params: parseParams('motor.hilos=2,motor.soaTerreno=true,motor.particionarPersonas=true,motor.gpu=[],motor.clonPorPaso=true'),
  });
  for (let n = 0; n < 12; n++) app.stepOnce();
  assert.ok(ecosystemWorkerDiagnostics(), 'doce pasos con hilos=2 abren la piscina de ecología');
  assert.ok(hilosProceso() > antes, 'los workers del paso siguen vivos antes de close()');
  await app.close();
  assert.equal(ecosystemWorkerDiagnostics(), null);
  assert.equal(hilosProceso(), antes, 'close() no deja workers del paso');
  const shmDespues = shmAbiertos();
  assert.deepEqual(shmDespues.filter(fd => !shmAntes.includes(fd)), [], `close() dejó shm abierto: ${shmDespues.join(', ')}`);
  await app.close();
  await cerrarPiscinasDeComputo();
});
