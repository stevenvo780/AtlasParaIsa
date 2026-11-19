import test from 'node:test';
import assert from 'node:assert/strict';
// `.mjs` (no `.mts`): tsx resuelve el especificador ESM contra el fuente `.mts`,
// como `tests/curva-techo.test.ts` con `scripts/curva-techo.mts`.
import { CAMPOS_ACOTADOS, CAMPOS_DESGLOSE, TECHO_STATE_BYTES, desglosePorCampo, ejecutarBanco, parseArgsBanco } from '../scripts/banco-red.mjs';
import { createWorld, projectWorld } from '../src/world/index.js';

test('banco-red: argumentos por defecto y validación', () => {
  const porDefecto = parseArgsBanco(['node', 'banco-red']);
  assert.equal(porDefecto.clientes, 12);
  assert.deepEqual(porDefecto.escalas, [40, 1000, 10000]);
  assert.equal(porDefecto.pasos, 5);
  assert.throws(() => parseArgsBanco(['node', 'banco-red', '--clientes', '13']), /--clientes/);
  assert.throws(() => parseArgsBanco(['node', 'banco-red', '--pasos', '0']), /--pasos/);
});

test('banco-red: el desglose por campo suma el total del state dentro de ±2 %', () => {
  const view = projectWorld(createWorld(51926));
  const desglose = desglosePorCampo(view);
  for (const campo of CAMPOS_DESGLOSE) assert.ok(campo in desglose.campos, `falta el campo ${campo}`);
  assert.ok(desglose.dentroDel2Pct, `diferencia ${desglose.diferenciaPct} %`);
  assert.ok(Math.abs(desglose.sumaCamposBytes - desglose.totalStateBytes) <= desglose.totalStateBytes * 0.02);
});

test('banco-red: escalas 40, 1 000 y 10 000 con desglose, techo y campos acotados', async (t) => {
  const informe = await ejecutarBanco([40, 1000, 10000], { clientes: 3, pasos: 2 });
  assert.equal(informe.escalas.length, 3);
  for (const r of informe.escalas) {
    t.diagnostic(`banco-red · ${r.habitantes} hab. · en vista ${r.habitantesEnVistaMedia} · state ${r.totalStateBytes} B · media/paso/cliente ${r.bytesPorPasoPorCliente.media.toFixed(0)} B · p95 ${r.bytesPorPasoPorCliente.p95} B · egress ${r.egressTotalBytes} B · descartados ${r.mensajesDescartados} · sockets terminados ${r.socketsTerminados}`);
    for (const campo of CAMPOS_DESGLOSE) assert.ok(campo in r.desglose.campos, `${r.habitantes}: falta ${campo}`);
    assert.ok(r.desglose.dentroDel2Pct, `${r.habitantes}: el desglose no suma el total dentro de ±2 % (${r.desglose.diferenciaPct} %)`);
    assert.ok(r.cumpleTecho120KiB, `${r.habitantes}: state medio ${r.totalStateBytes} B >= ${TECHO_STATE_BYTES} B`);
    assert.ok(r.totalStateBytes < TECHO_STATE_BYTES);
    assert.equal(r.mensajesDescartados, 0, `${r.habitantes}: mensajes descartados`);
    assert.equal(r.mensajesRecibidos, r.mensajesEsperados);
    assert.equal(r.socketsTerminados, 0, `${r.habitantes}: sockets terminados`);
    assert.ok(r.bytesPorPasoPorCliente.media > 0 && r.bytesPorPasoPorCliente.p95 >= r.bytesPorPasoPorCliente.media * 0.5);
    assert.ok(r.egressTotalBytes > 0);
  }

  const grande = informe.escalas.find(r => r.habitantes === 10000)!;
  // ~40 visibles en cámara (los inyectados junto a (1,1)); ni uno lejano en el cable.
  assert.ok(grande.habitantesEnVistaMedia >= 30 && grande.habitantesEnVistaMedia < 100,
    `people solo incluye los visibles (${grande.habitantesEnVistaMedia})`);
  assert.equal(grande.contieneIdsLejanos, false, 'ningún id lejano aparece en people ni en communities.members');
  assert.ok(grande.miembrosComunidadTotal >= 9000, `memberCount conserva el total (${grande.miembrosComunidadTotal})`);
  assert.ok(grande.miembrosComunidadEnVista < 100,
    `communities no envía la lista de 10 000 ids (envía ${grande.miembrosComunidadEnVista})`);
  assert.ok(grande.miembrosComunidadEnVista < grande.miembrosComunidadTotal);

  assert.ok(informe.comparacion1000a10000, 'debe comparar 1 000 → 10 000');
  for (const campo of CAMPOS_ACOTADOS) {
    const comparacion = informe.comparacion1000a10000!.camposAcotados[campo]!;
    t.diagnostic(`banco-red · campo acotado ${campo}: ${comparacion.bytes1000} B → ${comparacion.bytes10000} B (ratio ${comparacion.ratio.toFixed(3)})`);
    assert.ok(comparacion.acotado, `${campo} crece con la población total: ${comparacion.bytes1000} → ${comparacion.bytes10000}`);
  }
  assert.equal(informe.comparacion1000a10000!.ningunCampoAcotadoCreceLineal, true);
  assert.equal(informe.comparacion1000a10000!.stateMedioBajoTechoEnAmbas, true);
});
