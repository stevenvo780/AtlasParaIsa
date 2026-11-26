import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telemetriaEnJson, type SaludServidor } from '../src/server/app.js';
import { saludDelEspejo } from '../src/server/gateway.js';
import { descriptorCinta } from '../src/server/sim-worker.js';
import { enlaceCinta } from '../src/shared/fotograma.js';
import type { TelemetriaMotor } from '../src/world/motor/contratos.js';

test('el enlace binario arranca con un crédito por ranura y un anillo separado', () => {
  const binario = enlaceCinta(descriptorCinta(true));
  assert.equal(binario.creditos[0], binario.ranuras.length);
  assert.ok(binario.ranuras.length > 0 && binario.ranuras.every(ranura => ranura.growable));
  assert.ok(binario.sucesos?.byteLength);
  assert.equal(binario.entregados[0], 0n);
  assert.equal(binario.sucesosLeidos[0], 0n);
  const porPuerto = enlaceCinta(descriptorCinta(true, 1024));
  assert.equal(porPuerto.creditos[0], porPuerto.ranuras.length);
  assert.equal(porPuerto.sucesos, null);
  assert.equal(porPuerto.sucesosDirectosBytes, 1024);
  const clasico = enlaceCinta(descriptorCinta(false));
  assert.equal(clasico.ranuras.length, 0);
  assert.equal(clasico.sucesos, null);
});

test('la ocupación se convierte en una lista JSON independiente del buffer del motor', () => {
  const telemetria: TelemetriaMotor = {
    tick: 10, hz: 20, diasPorMinuto: 0.5, hilos: 2, desequilibrio: 1,
    faseMs: { F0: 0, eco: 0, percibir: 0, actuar: 0, aplicar: 0 }, esperaBarreraMs: 0,
    ocupacion: new Float32Array([1, 0.5]), gpuMs: [], gpuBytes: [], gpuEstado: [],
    intentos: 0, rechazados: 0, migraciones: 0, fotogramasSaltados: 0,
  };
  const json = telemetriaEnJson(telemetria);
  telemetria.ocupacion[0] = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(json)).ocupacion, [1, 0.5]);
});

test('el guardado confirmado se publica sin esperar a la siguiente vista', () => {
  const salud: SaludServidor = {
    estado: 'ok', tick: 30, ticksPorSegundo: 20, segundosDesdeUltimoPaso: 0,
    ultimoGuardado: 100, ultimoTickGuardado: 20, epoca: 3, gpu: [], recargas: 0,
    diagnostico: { duras24h: 0, blandas24h: 0, ultimaViolacion: null, errorBitacora: null, registrosSinBitacora: 0 },
    operacion: null,
  };
  const guardado = { epoca: 3, ultimoTickGuardado: 35, ultimoGuardado: 200 };
  const avance = { type: 'operacion' as const, operacion: null, guardado, medidaEn: 200 };
  assert.equal(saludDelEspejo({ salud, saludMedidaEn: 150 }, avance, false, 201).ultimoTickGuardado, 35);
  assert.equal(saludDelEspejo({ salud, saludMedidaEn: 201 }, avance, false, 201).ultimoTickGuardado, 20);
});
