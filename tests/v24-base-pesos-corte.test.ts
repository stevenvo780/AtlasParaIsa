import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { encodePolicyWeightPage, POLICY_UIDS_PER_PAGE } from '../src/server/snapshot-policy-pages.js';
import {
  abrirLectorBasePesos, aceptarRefPesos, BYTES_PESOS_PERSONA, compararPesosF64BitABit,
  construirBasePesosDesdeFilasWgp1, construirBasePesosDesdePaginasWgp1, ESTADO_BASE_PESOS,
  evaluarCandidatoRefPesos, PESOS_POR_PERSONA, verificarIntegridadBasePesos, VERSION_BASE_PESOS_CORTE,
  type ContextoBasePesos, type DescriptorBasePesosCorte, type FilaWgp1Comprobada,
} from '../src/world/motor/base-pesos-corte.js';

function vectorPesos(base: number, ajustes: Record<number, number> = {}): number[] {
  const pesos = Array.from({ length: PESOS_POR_PERSONA }, (_, i) => {
    const v = ((base * 31 + i * 17) % 2001) / 1000 - 1;
    return v === 0 ? 0 : v;
  });
  for (const [k, v] of Object.entries(ajustes)) pesos[Number(k)] = v;
  return pesos;
}

function bytesDePesos(pesos: readonly number[]): Uint8Array {
  const out = new Uint8Array(BYTES_PESOS_PERSONA);
  const vista = new DataView(out.buffer);
  for (let i = 0; i < PESOS_POR_PERSONA; i++) vista.setFloat64(i * 8, pesos[i]!, true);
  return out;
}

function publicarDesdePaginas(
  entradasPorCubeta: readonly (readonly { uid: number; weights: readonly number[] }[])[],
  meta = { instancia: 'pers-1', epoca: 3, secuencia: 12 },
  filasPorSlab = 2,
) {
  const paginas = entradasPorCubeta.map(entradas => ({
    body: encodePolicyWeightPage(entradas.map(({ uid, weights }) => ({ uid, weights: { weights } }))),
    count: entradas.length,
  }));
  const publicador = construirBasePesosDesdePaginasWgp1(paginas, meta, { filasPorSlab });
  const descriptor = publicador.publicarTrasAcuse({ ...publicador.identidad, confirmado: true });
  const contexto: ContextoBasePesos = {
    publicacion: descriptor.publicacion, ...meta, digesto: descriptor.digesto,
  };
  return { publicador, descriptor, contexto };
}

test('construcción WGP1, publicación tras acuse, -0 exacto y ausencia de vistas mutables del SAB', () => {
  const w1 = vectorPesos(1, { 0: -0, 1: 0, 2: Number.MIN_VALUE, 3: -1, 4: 1 });
  const w2 = vectorPesos(2, { 0: 0, 10: -0 });
  const pag0 = encodePolicyWeightPage([
    { uid: 5, weights: { weights: w1 } },
    { uid: 20, weights: { weights: w2 } },
  ]);
  const pag1 = encodePolicyWeightPage([
    { uid: POLICY_UIDS_PER_PAGE + 7, weights: { weights: vectorPesos(3, { 5: -0 }) } },
  ]);

  const publicador = construirBasePesosDesdePaginasWgp1(
    [{ body: pag0, count: 2 }, { body: pag1, count: 1 }],
    { instancia: 'pers-A', epoca: 2, secuencia: 15 },
    { filasPorSlab: 2 },
  );
  assert.equal(publicador.estado(), ESTADO_BASE_PESOS.PENDIENTE_ACUSE);

  // Antes del acuse durable no se emite ni acepta ninguna REF ni se permite copiar.
  const lectorPendiente = abrirLectorBasePesos(publicador.descriptorSinPublicar());
  const ctx: ContextoBasePesos = { ...publicador.identidad };
  assert.deepEqual(evaluarCandidatoRefPesos(lectorPendiente, ctx, 5, w1), { modo: 'FULL', motivo: 'base_no_publicada' });
  assert.deepEqual(
    aceptarRefPesos(lectorPendiente, ctx, 5, { ...publicador.identidad, uid: 5, indice: 0 }),
    { aceptada: false, motivo: 'base_no_publicada' },
  );
  assert.throws(() => lectorPendiente.copiarPesosEn(0, new Uint8Array(BYTES_PESOS_PERSONA), 0), /no está publicada/);
  assert.equal(lectorPendiente.copiarPesosPorUid(5, new Uint8Array(BYTES_PESOS_PERSONA), 0), false);

  // Acuse con secuencia o publicación incorrecta no publica.
  assert.throws(() => publicador.publicarTrasAcuse({ ...publicador.identidad, secuencia: 16, confirmado: true }), /acuse/i);
  assert.throws(() => publicador.publicarTrasAcuse({ ...publicador.identidad, publicacion: 'otra', confirmado: true }), /acuse/i);
  assert.equal(publicador.estado(), ESTADO_BASE_PESOS.PENDIENTE_ACUSE);

  // Publicación tras acuse durable.
  const descriptor = publicador.publicarTrasAcuse({ ...publicador.identidad, confirmado: true });
  assert.equal(descriptor.version, VERSION_BASE_PESOS_CORTE);
  assert.equal(descriptor.slabs.length, 2);
  assert.equal(descriptor.slabs[0]!.byteLength, 2 * BYTES_PESOS_PERSONA);
  assert.equal(descriptor.slabs[1]!.byteLength, 1 * BYTES_PESOS_PERSONA);
  verificarIntegridadBasePesos(descriptor);
  assert.throws(() => publicador.publicarTrasAcuse({ ...publicador.identidad, confirmado: true }), /ya fue publicada/);

  const lector = abrirLectorBasePesos(descriptor);
  assert.equal('vistaBytesEn' in lector, false);
  assert.equal('vistaBytesPorUid' in lector, false);
  assert.equal(lector.buscarIndicePorUid(5), 0);
  assert.equal(lector.buscarIndicePorUid(20), 1);
  assert.equal(lector.buscarIndicePorUid(POLICY_UIDS_PER_PAGE + 7), 2);
  assert.equal(lector.buscarIndicePorUid(19), -1);

  // Emite REF con number[], Float64Array y vista Uint8Array (alineada y desalineada) sin copiar por fila.
  const dArr = evaluarCandidatoRefPesos(lector, ctx, 5, w1);
  assert.equal(dArr.modo, 'REF');
  const dF64 = evaluarCandidatoRefPesos(lector, ctx, 5, Float64Array.from(w1));
  assert.equal(dF64.modo, 'REF');
  const desalineado = new Uint8Array(BYTES_PESOS_PERSONA + 3);
  desalineado.set(bytesDePesos(w1), 3);
  const dU8 = evaluarCandidatoRefPesos(lector, ctx, 5, desalineado.subarray(3));
  assert.equal(dU8.modo, 'REF');

  // La aceptación NO devuelve ninguna vista mutable del SAB; el consumidor copia a su propio destino.
  const aceptada = aceptarRefPesos(lector, ctx, 5, dArr.referencia);
  assert.deepEqual(aceptada, { aceptada: true, uid: 5, indice: 0 });
  const destino = new Uint8Array(BYTES_PESOS_PERSONA + 16);
  let llamadasSet = 0, llamadasFill = 0;
  Object.defineProperty(destino, 'set', {
    value(fuente: Uint8Array) { llamadasSet++; fuente.fill(0); },
  });
  Object.defineProperty(destino, 'fill', {
    value() { llamadasFill++; return destino; },
  });
  lector.copiarPesosEn(aceptada.indice, destino, 8);
  assert.equal(llamadasSet, 0);
  assert.equal(llamadasFill, 0);
  assert.equal(new DataView(destino.buffer, 8, 8).getBigUint64(0, true), 0x8000_0000_0000_0000n);
  assert.equal(compararPesosF64BitABit(destino.subarray(8, 8 + BYTES_PESOS_PERSONA), w1), true);
  // Mutar el destino del consumidor jamás altera la base SAB.
  Uint8Array.prototype.fill.call(destino, 0xff);
  verificarIntegridadBasePesos(descriptor);
  const materializados = lector.materializarPesosEn(aceptada.indice);
  assert.ok(Object.is(materializados[0], -0) && Object.is(materializados[1], 0) && Object.is(materializados[2], Number.MIN_VALUE));

  // Un solo giro -0 -> +0 debe caer a FULL y fallar compararPesosF64BitABit.
  const w1MasCero = w1.slice();
  w1MasCero[0] = +0;
  assert.equal(compararPesosF64BitABit(w1, w1MasCero), false);
  assert.equal(compararPesosF64BitABit(w1, w1.slice()), true);
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, w1MasCero), { modo: 'FULL', motivo: 'pesos_modificados' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, Float64Array.from(w1MasCero)), { modo: 'FULL', motivo: 'pesos_modificados' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, bytesDePesos(w1MasCero)), { modo: 'FULL', motivo: 'pesos_modificados' });

  // NaN / Inf / huecos / getters / proxies -> FULL (pesos_invalidos), y NaN != NaN en comparador.
  const conNaN = w1.slice(); conNaN[7] = NaN;
  const conInf = w1.slice(); conInf[7] = Infinity;
  const conHueco = w1.slice(); delete conHueco[7];
  const conGetter = w1.slice();
  let lecturasGetter = 0;
  Object.defineProperty(conGetter, 7, { enumerable: true, get() { lecturasGetter++; return w1[7]!; } });
  assert.equal(compararPesosF64BitABit(conNaN, conNaN), false);
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, conNaN), { modo: 'FULL', motivo: 'pesos_invalidos' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, conInf), { modo: 'FULL', motivo: 'pesos_invalidos' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, conHueco), { modo: 'FULL', motivo: 'pesos_invalidos' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, conGetter), { modo: 'FULL', motivo: 'pesos_invalidos' });
  assert.equal(lecturasGetter, 0);
  assert.deepEqual(evaluarCandidatoRefPesos(lector, ctx, 5, new Proxy(w1, {})), { modo: 'FULL', motivo: 'pesos_invalidos' });
});

test('dos bases con mismos UID/bytes/instancia/época/secuencia no cruzan REFs tras revocar la primera', () => {
  const w10 = vectorPesos(10, { 0: -0, 4: 0.5 });
  const w20 = vectorPesos(20, { 2: -0.25 });
  const meta = { instancia: 'pers-dup', epoca: 5, secuencia: 20 };

  const base1 = publicarDesdePaginas([[{ uid: 10, weights: w10 }, { uid: 20, weights: w20 }]], meta);
  const lector1 = abrirLectorBasePesos(base1.descriptor);
  const dec1 = evaluarCandidatoRefPesos(lector1, base1.contexto, 10, w10);
  assert.equal(dec1.modo, 'REF');
  assert.deepEqual(aceptarRefPesos(lector1, base1.contexto, 10, dec1.referencia), { aceptada: true, uid: 10, indice: 0 });

  // Se revoca la primera base y se construye una segunda idéntica en UID, bytes, instancia, época y secuencia.
  base1.publicador.revocar();
  assert.deepEqual(aceptarRefPesos(lector1, base1.contexto, 10, dec1.referencia), { aceptada: false, motivo: 'base_revocada' });
  assert.throws(() => lector1.copiarPesosEn(0, new Uint8Array(BYTES_PESOS_PERSONA), 0), /revocada/);

  const base2 = publicarDesdePaginas([[{ uid: 10, weights: w10 }, { uid: 20, weights: w20 }]], meta);
  assert.equal(base2.descriptor.digesto, base1.descriptor.digesto);
  assert.notEqual(base2.descriptor.publicacion, base1.descriptor.publicacion);

  const lector2 = abrirLectorBasePesos(base2.descriptor);
  // La REF de base1 es rechazada por base2 pese a tener mismos UID/bytes/instancia/época/secuencia/digesto.
  assert.deepEqual(aceptarRefPesos(lector2, base2.contexto, 10, dec1.referencia), { aceptada: false, motivo: 'publicacion_distinta' });
  // Un contexto con la publicación vieja también cae a FULL contra lector2.
  assert.deepEqual(evaluarCandidatoRefPesos(lector2, base1.contexto, 10, w10), { modo: 'FULL', motivo: 'publicacion_distinta' });
  // Una REF nueva contra base2 sí se acepta y copia exactamente -0 al buffer destino.
  const dec2 = evaluarCandidatoRefPesos(lector2, base2.contexto, 10, w10);
  assert.equal(dec2.modo, 'REF');
  const ok2 = aceptarRefPesos(lector2, base2.contexto, 10, dec2.referencia);
  assert.deepEqual(ok2, { aceptada: true, uid: 10, indice: 0 });
  const destino = new Uint8Array(BYTES_PESOS_PERSONA);
  lector2.copiarPesosEn(ok2.indice, destino, 0);
  assert.equal(compararPesosF64BitABit(destino, w10), true);
});

test('orden, duplicados, cotas, filas WGP1 inválidas y mutación fuera de contrato sobre el SAB', () => {
  const w1 = bytesDePesos(vectorPesos(1));
  const w2 = bytesDePesos(vectorPesos(2));
  const meta = { instancia: 'pers-B', epoca: 1, secuencia: 1 };

  const duplicadas: FilaWgp1Comprobada[] = [
    { uid: 10, body: w1, offset: 0 },
    { uid: 10, body: w2, offset: 0 },
  ];
  assert.throws(() => construirBasePesosDesdeFilasWgp1(duplicadas, meta), /crecientes|duplicados/i);
  assert.throws(() => construirBasePesosDesdeFilasWgp1([
    { uid: 20, body: w1, offset: 0 },
    { uid: 10, body: w2, offset: 0 },
  ], meta), /crecientes/i);
  assert.throws(() => construirBasePesosDesdeFilasWgp1([{ uid: 0, body: w1, offset: 0 }], meta), /UID/i);

  const pag0 = { body: encodePolicyWeightPage([{ uid: 1, weights: { weights: vectorPesos(1) } }]), count: 1 };
  const pag1 = { body: encodePolicyWeightPage([{ uid: POLICY_UIDS_PER_PAGE + 1, weights: { weights: vectorPesos(2) } }]), count: 1 };
  assert.throws(() => construirBasePesosDesdePaginasWgp1([pag1, pag0], meta), /cubetas/i);
  assert.throws(() => construirBasePesosDesdePaginasWgp1([pag0, pag0], meta), /cubetas/i);

  const corrupto = bytesDePesos(vectorPesos(1));
  new DataView(corrupto.buffer).setFloat64(0, NaN, true);
  assert.throws(() => construirBasePesosDesdeFilasWgp1([{ uid: 1, body: corrupto, offset: 0 }], meta), /Peso F64/i);
  new DataView(corrupto.buffer).setFloat64(0, 1.5, true);
  assert.throws(() => construirBasePesosDesdeFilasWgp1([{ uid: 1, body: corrupto, offset: 0 }], meta), /Peso F64/i);

  assert.throws(() => construirBasePesosDesdeFilasWgp1([{ uid: 1, body: w1, offset: 0 }, { uid: 2, body: w2, offset: 0 }],
    meta, { maxFilas: 1 }), /cotas/i);
  assert.throws(() => construirBasePesosDesdeFilasWgp1([{ uid: 1, body: w1, offset: 0 }],
    meta, { maxBytesPesos: BYTES_PESOS_PERSONA - 1 }), /cotas/i);

  const vacia = construirBasePesosDesdeFilasWgp1([], meta);
  const descVacia = vacia.publicarTrasAcuse({ ...vacia.identidad, confirmado: true });
  verificarIntegridadBasePesos(descVacia);
  const lectorVacio = abrirLectorBasePesos(descVacia);
  assert.deepEqual(
    evaluarCandidatoRefPesos(lectorVacio, { publicacion: descVacia.publicacion, ...meta, digesto: descVacia.digesto }, 1, vectorPesos(1)),
    { modo: 'FULL', motivo: 'uid_ausente' },
  );

  // Límite del SAB: un escritor fuera de contrato con acceso al buffer crudo es detectado por verificarIntegridadBasePesos.
  const { descriptor } = publicarDesdePaginas([[{ uid: 7, weights: vectorPesos(1, { 0: 0 }) }]]);
  new DataView(descriptor.slabs[0]!).setFloat64(0, -0, true);
  assert.throws(() => verificarIntegridadBasePesos(descriptor), /SHA-256/);
});

test('fallback FULL, rechazo de REF vieja/con buffers embebidos y cambio de época/UID', () => {
  const w10 = vectorPesos(10, { 0: -0 });
  const w20 = vectorPesos(20);
  const { publicador, descriptor, contexto } = publicarDesdePaginas([[
    { uid: 10, weights: w10 },
    { uid: 20, weights: w20 },
  ]], { instancia: 'pers-1', epoca: 4, secuencia: 9 });

  const lector = abrirLectorBasePesos(descriptor);
  const emitida = evaluarCandidatoRefPesos(lector, contexto, 10, w10);
  assert.equal(emitida.modo, 'REF');
  const refVieja = emitida.referencia;

  assert.deepEqual(evaluarCandidatoRefPesos(undefined, contexto, 10, w10), { modo: 'FULL', motivo: 'sin_base' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, undefined, 10, w10), { modo: 'FULL', motivo: 'identidad_ausente' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, { ...contexto, publicacion: '' }, 10, w10), { modo: 'FULL', motivo: 'identidad_ausente' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, { ...contexto, epoca: 5 }, 10, w10), { modo: 'FULL', motivo: 'epoca_cambiada' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, { ...contexto, instancia: 'pers-2' }, 10, w10), { modo: 'FULL', motivo: 'instancia_distinta' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, { ...contexto, secuencia: 10 }, 10, w10), { modo: 'FULL', motivo: 'secuencia_distinta' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, { ...contexto, digesto: '0'.repeat(64) }, 10, w10), { modo: 'FULL', motivo: 'digesto_distinto' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, contexto, 999, w10), { modo: 'FULL', motivo: 'uid_ausente' });
  assert.deepEqual(evaluarCandidatoRefPesos(lector, contexto, -1, w10), { modo: 'FULL', motivo: 'uid_invalido' });

  // Una REF que intente colar buffers/descriptor como autoridad se rechaza de inmediato.
  assert.deepEqual(
    aceptarRefPesos(lector, contexto, 10, { ...refVieja, slabs: descriptor.slabs }),
    { aceptada: false, motivo: 'referencia_invalida' },
  );
  assert.deepEqual(
    aceptarRefPesos(lector, contexto, 10, { ...descriptor, uid: 10, indice: 0 }),
    { aceptada: false, motivo: 'referencia_invalida' },
  );
  assert.deepEqual(aceptarRefPesos(lector, contexto, 20, refVieja), { aceptada: false, motivo: 'uid_no_coincide' });
  assert.deepEqual(aceptarRefPesos(lector, contexto, 10, { ...refVieja, indice: 1 }), { aceptada: false, motivo: 'indice_invalido' });
  assert.deepEqual(aceptarRefPesos(lector, contexto, 10, { ...refVieja, secuencia: 8 }), { aceptada: false, motivo: 'secuencia_distinta' });
  assert.deepEqual(aceptarRefPesos(lector, contexto, 10, { ...refVieja, epoca: 3 }), { aceptada: false, motivo: 'epoca_cambiada' });
  assert.deepEqual(aceptarRefPesos(lector, contexto, 10, { ...refVieja, instancia: 'pers-0' }), { aceptada: false, motivo: 'instancia_distinta' });
  assert.deepEqual(aceptarRefPesos(lector, contexto, 10, { ...refVieja, digesto: 'f'.repeat(64) }), { aceptada: false, motivo: 'digesto_distinto' });

  publicador.revocar();
  assert.equal(lector.estado(), ESTADO_BASE_PESOS.REVOCADA);
  assert.deepEqual(evaluarCandidatoRefPesos(lector, contexto, 10, w10), { modo: 'FULL', motivo: 'base_revocada' });
  assert.deepEqual(aceptarRefPesos(lector, contexto, 10, refVieja), { aceptada: false, motivo: 'base_revocada' });
});

test('clonado del descriptor SAB por MessagePort y Worker real conserva identidad, -0 y revocación Atomics', async () => {
  const w1 = vectorPesos(11, { 0: -0, 211: Number.MIN_VALUE });
  const w2 = vectorPesos(22, { 1: -0.75 });
  const { publicador, descriptor, contexto } = publicarDesdePaginas([[
    { uid: 101, weights: w1 },
    { uid: 202, weights: w2 },
  ]], { instancia: 'pers-sab', epoca: 7, secuencia: 3 }, 1);

  let lectorRemoto: ReturnType<typeof abrirLectorBasePesos>;
  const { port1, port2 } = new MessageChannel();
  try {
    port1.postMessage(descriptor);
    const recibido = receiveMessageOnPort(port2)?.message as DescriptorBasePesosCorte;
    assert.ok(recibido);
    assert.equal(recibido.publicacion, descriptor.publicacion);
    assert.ok(recibido.uids instanceof SharedArrayBuffer && recibido.control instanceof SharedArrayBuffer);
    assert.ok(recibido.slabs[0] instanceof SharedArrayBuffer && recibido.slabs[1] instanceof SharedArrayBuffer);
    verificarIntegridadBasePesos(recibido);

    lectorRemoto = abrirLectorBasePesos(recibido);
    const decision = evaluarCandidatoRefPesos(lectorRemoto, contexto, 101, w1);
    assert.equal(decision.modo, 'REF');
    const aceptada = aceptarRefPesos(lectorRemoto, contexto, 101, decision.referencia);
    assert.deepEqual(aceptada, { aceptada: true, uid: 101, indice: 0 });
    const copia = new Uint8Array(BYTES_PESOS_PERSONA);
    lectorRemoto.copiarPesosEn(aceptada.indice, copia, 0);
    assert.equal(new DataView(copia.buffer, 0, 8).getBigUint64(0, true), 0x8000_0000_0000_0000n);
    assert.equal(compararPesosF64BitABit(copia, w1), true);
  } finally {
    port1.close();
    port2.close();
  }

  assert.throws(() => abrirLectorBasePesos({ ...descriptor, slabs: [descriptor.slabs[0]!, descriptor.slabs[0]!] }), /repetido/);
  assert.throws(() => abrirLectorBasePesos({ ...descriptor, slabs: [new SharedArrayBuffer(8), descriptor.slabs[1]!] }), /inválido/);
  assert.throws(() => abrirLectorBasePesos({ ...descriptor, control: new SharedArrayBuffer(8) }), /no sellado/);

  const listo = new SharedArrayBuffer(4);
  const listoI32 = new Int32Array(listo);
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { descriptor, listo } = workerData;
    const control = new Int32Array(descriptor.control);
    const uids = new Float64Array(descriptor.uids);
    const slab0 = new DataView(descriptor.slabs[0]);
    const estadoInicial = Atomics.load(control, 0);
    const uid0 = uids[0];
    const uid1 = uids[1];
    const peso0Bits = slab0.getBigUint64(0, true);
    const peso211 = slab0.getFloat64(211 * 8, true);
    const listoI32 = new Int32Array(listo);
    Atomics.store(listoI32, 0, 1);
    Atomics.notify(listoI32, 0);
    Atomics.wait(control, 0, estadoInicial, 5000);
    const estadoFinal = Atomics.load(control, 0);
    parentPort.postMessage({ estadoInicial, estadoFinal, uid0, uid1, peso0Bits: peso0Bits.toString(16), peso211 });
    `,
    { eval: true, workerData: { descriptor, listo } },
  );
  try {
    const resultado = new Promise<{
      estadoInicial: number; estadoFinal: number; uid0: number; uid1: number; peso0Bits: string; peso211: number;
    }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    Atomics.wait(listoI32, 0, 0, 5000);
    publicador.revocar();
    assert.equal(lectorRemoto.estado(), ESTADO_BASE_PESOS.REVOCADA);
    assert.deepEqual(evaluarCandidatoRefPesos(lectorRemoto, contexto, 101, w1), { modo: 'FULL', motivo: 'base_revocada' });
    assert.throws(() => lectorRemoto.copiarPesosEn(0, new Uint8Array(BYTES_PESOS_PERSONA), 0), /revocada/);
    const datos = await resultado;
    assert.equal(datos.estadoInicial, ESTADO_BASE_PESOS.PUBLICADA);
    assert.equal(datos.estadoFinal, ESTADO_BASE_PESOS.REVOCADA);
    assert.equal(datos.uid0, 101);
    assert.equal(datos.uid1, 202);
    assert.equal(datos.peso0Bits, '8000000000000000');
    assert.ok(Object.is(datos.peso211, Number.MIN_VALUE));
  } finally {
    await worker.terminate();
  }
});
