import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize } from 'node:v8';
import { fuenteFotograma } from '../src/server/cinta/fuente.js';
import { estadoVista, fotogramaAVista, leerFotograma } from '../src/server/cinta/vista.js';
import type { Corte } from '../src/shared/cinta.js';
import { CONTROL_ENLACE_BYTES, enlaceCinta, type Fotograma, type Suceso } from '../src/shared/fotograma.js';
import { escalon } from '../src/shared/interruptores.js';
import type { RuntimeStats } from '../src/shared/types.js';
import { ORDEN, duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { EmisorFotoDueno } from '../src/world/motor/fotograma-dueno.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { crearSAB } from '../src/world/soa/arena.js';
import { chunkKey } from '../src/world/terrain.js';

const RUNTIME: RuntimeStats = {
  stepMs: 0, p95StepMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: 0,
  processRssMiB: 0, tickHz: 0, fraccionSerial: 0,
  fases: {
    maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0,
    demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0,
  },
};

function crearDescriptor(bytesAnillo = 16 * 1024 * 1024) {
  return {
    control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES),
    ranuras: [crearSAB(0, 16 * 1024 * 1024)],
    versiones: crearSAB(0, 65536),
    sucesos: new SharedArrayBuffer(bytesAnillo),
  };
}

function decodificarBloques(bloques: readonly Uint8Array[] = []): Suceso[] {
  const salida: Suceso[] = [];
  for (const bloque of bloques) {
    const view = new DataView(bloque.buffer, bloque.byteOffset, bloque.byteLength);
    let offset = 0;
    while (offset < bloque.byteLength) {
      const len = view.getUint32(offset, true);
      offset += 4;
      salida.push(deserialize(bloque.subarray(offset, offset + len)) as Suceso);
      offset += len;
    }
  }
  return salida;
}

function normalizarStats(stats: Corte['vista']['stats']) {
  const {
    meanEnergy, meanHunger, meanFatigue, meanThirst, freshWater,
    giniRecursosPorRegion, fraccionCeldasConComida, distanciaMediaAgua, regionesSinAgua,
    diversidad, statsTick, ...discretos
  } = stats as Corte['vista']['stats'] & {
    giniRecursosPorRegion: number; fraccionCeldasConComida: number;
    distanciaMediaAgua: number; regionesSinAgua: number;
    diversidad: { conducta: number; oficios: number; total: number }; statsTick: number;
  };
  return {
    discretos,
    continuos: {
      meanEnergy, meanHunger, meanFatigue, meanThirst, freshWater,
      giniRecursosPorRegion, fraccionCeldasConComida, distanciaMediaAgua, regionesSinAgua,
      diversidad, statsTick,
    },
  };
}

function assertCerca(a: number, b: number, nombre: string, tol = 1e-12): void {
  assert.ok(Math.abs(a - b) <= tol, `${nombre}: ${a} !== ${b} (dif ${Math.abs(a - b)})`);
}

function assertCortesEquivalentes(actual: Corte, referencia: Corte, comprobarCaras = true): void {
  assert.equal(actual.t, referencia.t);
  assert.equal(actual.epoca, referencia.epoca);
  assert.equal(actual.seq, referencia.seq);
  assert.equal(actual.hz, referencia.hz);
  assert.deepEqual(actual.serie, referencia.serie);
  assert.deepEqual(actual.hitos, referencia.hitos);
  assert.deepEqual(actual.catalogo, referencia.catalogo);
  assert.deepEqual(actual.tilesCambiadas, referencia.tilesCambiadas);

  const { stats: stA, ...vistaA } = actual.vista;
  const { stats: stR, ...vistaR } = referencia.vista;
  assert.deepEqual(vistaA, vistaR);

  const nA = normalizarStats(stA), nR = normalizarStats(stR);
  assert.deepEqual(nA.discretos, nR.discretos);
  assertCerca(nA.continuos.meanEnergy, nR.continuos.meanEnergy, 'meanEnergy');
  assertCerca(nA.continuos.meanHunger, nR.continuos.meanHunger, 'meanHunger');
  assertCerca(nA.continuos.meanFatigue, nR.continuos.meanFatigue, 'meanFatigue');
  assertCerca(nA.continuos.meanThirst, nR.continuos.meanThirst, 'meanThirst');
  assertCerca(nA.continuos.freshWater, nR.continuos.freshWater, 'freshWater');
  if (comprobarCaras) {
    assert.equal(nA.continuos.statsTick, nR.continuos.statsTick);
    assertCerca(nA.continuos.giniRecursosPorRegion, nR.continuos.giniRecursosPorRegion, 'gini');
    assertCerca(nA.continuos.fraccionCeldasConComida, nR.continuos.fraccionCeldasConComida, 'fraccionComida');
    assertCerca(nA.continuos.distanciaMediaAgua, nR.continuos.distanciaMediaAgua, 'distanciaMediaAgua');
    assertCerca(nA.continuos.regionesSinAgua, nR.continuos.regionesSinAgua, 'regionesSinAgua');
    assertCerca(nA.continuos.diversidad.conducta, nR.continuos.diversidad.conducta, 'diversidad.conducta');
    assertCerca(nA.continuos.diversidad.oficios, nR.continuos.diversidad.oficios, 'diversidad.oficios');
    assertCerca(nA.continuos.diversidad.total, nR.continuos.diversidad.total, 'diversidad.total');
  }
}

test('emisionFotogramaDuenos está desactivada por defecto', async t => {
  const mundo = createWorld(7, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, { ...unSoloDueno(7), hilos: 2 });
  t.after(() => motor.cerrar());
  const descriptor = crearDescriptor();
  const enlace = enlaceCinta(descriptor);
  motor.enlazar(descriptor, fuenteFotograma(mundo, 0, 'inst', RUNTIME, () => 10, () => undefined));
  Atomics.store(enlace.cadencia, 0, 1);
  // Un paso de calentamiento para poblar filas de fauna heredada antes de dar crédito (igual que v23-motor-fotograma-retirada).
  motor.paso([]);
  Atomics.store(enlace.creditos, 0, 1);
  motor.paso([]);
  assert.equal(Atomics.load(enlace.entregados, 0), 1n);
  assert.equal(motor.trazaFotogramaDuenos?.emitidos, 0);
  assert.equal(motor.trazaFotogramaDuenos?.reunionesEvitadas, 0);
});

test('paridad exacta de Corte entre emisión por dueños y camino reunido sobre los mismos fotogramas', async t => {
  const params = parseParams({ v23: { ...escalon('duenos'), fotograma: true } });
  const mundo = createWorld(17, params);
  const motor = crearMotor(mundo, { ...unSoloDueno(17), hilos: 2, emisionFotogramaDuenos: true });
  t.after(() => motor.cerrar());
  const descriptor = crearDescriptor();
  const enlace = enlaceCinta(descriptor);
  const fuenteDuenos = fuenteFotograma(mundo, 0, 'paridad', RUNTIME, () => 12, () => undefined);
  const fuenteRef = fuenteFotograma(mundo, 0, 'paridad', RUNTIME, () => 12, () => undefined);
  const estadoDuenos = estadoVista(0);
  const estadoRef = estadoVista(0);
  let seq = 0;
  let comparados = 0;

  // Oráculo síncrono: sobre el mismo fotograma binario y el mismo estado de mundo, compara `cortePorDuenos` vs `corte` reunido.
  motor.enlazar(descriptor, {
    corte: (c, f, paginas, reunido) => fuenteDuenos.corte(c, f, paginas, reunido),
    cortePorDuenos: (c, f, paginas, lote) => {
      const salida = fuenteDuenos.cortePorDuenos!(c, f, paginas, lote);
      assert.ok(salida, 'la emisión por dueños no debe caer a fallback en el caso limpio');
      return salida;
    },
    confirmar: f => fuenteDuenos.confirmar(f),
  });

  Atomics.store(enlace.creditos, 0, 1);
  Atomics.store(enlace.cadencia, 0, 1);

  for (let paso = 1; paso <= 6; paso++) {
    if (paso === 5) Atomics.store(enlace.pedirCompleto, 0, 1);
    motor.paso([]);
    const leidosAntes = BigInt(seq);
    assert.equal(Atomics.load(enlace.entregados, 0), leidosAntes + 1n);
    const reunido = motor.instantanea().world;
    const d = duenoSi(mundo)!;

    const ok = leerFotograma(enlace, leidosAntes, (frame: Fotograma, sucesosDuenos: readonly Suceso[]) => {
      seq++;
      const corteDuenos = fotogramaAVista(estadoDuenos, frame, sucesosDuenos, seq);
      const fCurso = {
        ranura: descriptor.ranuras[Number(leidosAntes % BigInt(descriptor.ranuras.length))]!,
        completo: frame.completo,
        tick: frame.tick,
        epoca: frame.epoca,
        versiones: enlace.versiones!,
      };
      const refSalida = fuenteRef.corte(d, fCurso, frame.paginas, reunido);
      const refSucesos = [...refSalida.sucesos, ...decodificarBloques(refSalida.bloques)];
      const corteRef = fotogramaAVista(estadoRef, frame, refSucesos, seq);
      fuenteRef.confirmar(fCurso);

      // En fotogramas completos (paso 1 y paso 5), las métricas caras también se recalculan y deben coincidir.
      assertCortesEquivalentes(corteDuenos, corteRef, frame.completo);
      comparados++;
    });
    assert.ok(ok);
  }

  assert.equal(comparados, 6);
  const traza = motor.trazaFotogramaDuenos!;
  assert.equal(traza.emitidos, 6);
  assert.equal(traza.reunionesEvitadas, 6);
  assert.equal(traza.fallbacksLimite, 0);
  assert.equal(traza.fallbacksCompat, 0);
  assert.equal(traza.abortos, 0);
});

test('conserva páginas archivadas si siguen en mundo.chunks y excluye fauna y estructuras al archivar', async t => {
  const mundo = createWorld(7, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, { ...unSoloDueno(7), hilos: 2, emisionFotogramaDuenos: true });
  t.after(() => motor.cerrar());
  const descriptor = crearDescriptor();
  const enlace = enlaceCinta(descriptor);
  const fuente = fuenteFotograma(mundo, 0, 'archivo', RUNTIME, () => 10, () => undefined);
  const vista = estadoVista(0);
  let leidos = 0n;

  motor.enlazar(descriptor, fuente);
  Atomics.store(enlace.cadencia, 0, 1);
  motor.paso([]);
  Atomics.store(enlace.creditos, 0, 1);

  // Fotograma 1 (completo): todas las páginas entran en CacheVista.
  motor.paso([]);
  assert.equal(Atomics.load(enlace.entregados, 0), 1n);
  let corteInicial!: Corte;
  assert.ok(leerFotograma(enlace, leidos++, (f, s) => { corteInicial = fotogramaAVista(vista, f, s, 1); }));
  assert.ok(corteInicial.vista.tiles.length > 0);

  // Fotograma 2 (incremental sin retiros): ninguna página activa debe recibir baja `pagina: null`.
  motor.paso([]);
  assert.equal(Atomics.load(enlace.entregados, 0), 2n);
  assert.ok(leerFotograma(enlace, leidos++, (f, s) => {
    const bajasPagina = s.filter(e => e.tipo === 'pagina' && e.vista === null);
    assert.equal(bajasPagina.length, 0);
    fotogramaAVista(vista, f, s, 2);
  }));

  // Retiro real de un chunk desocupado por personas (con fauna): se archiva y la cinta emite `pagina: null` + sin fauna fantasma.
  const { world: antes } = motor.instantanea();
  const ocupadas = new Set(antes.people.map(p => chunkKey(p.x, p.y)));
  const animal = antes.animals.find(a => !ocupadas.has(chunkKey(a.x, a.y)));
  assert.ok(animal);
  const claveRetiro = chunkKey(animal.x, animal.y);
  const d = duenoSi(mundo)!, terreno = d.terreno;
  const chunk = terreno.chunkDe(terreno.celda(animal.x, animal.y));
  d.ordenar(terreno.duenoChunk[chunk]!, [ORDEN.ceder, chunk, -1]);

  motor.paso([]);
  assert.equal(Atomics.load(enlace.entregados, 0), 3n);
  let corteRetiro!: Corte;
  let bajasPaginaRetiro: string[] = [];
  assert.ok(leerFotograma(enlace, leidos++, (f, s) => {
    bajasPaginaRetiro = s.flatMap(e => e.tipo === 'pagina' && e.vista === null ? [e.id] : []);
    corteRetiro = fotogramaAVista(vista, f, s, 3);
  }));
  assert.ok(bajasPaginaRetiro.includes(claveRetiro), `debe emitir baja de página para ${claveRetiro}`);
  assert.equal(corteRetiro.vista.animals?.some(a => a.id === animal.id), false);

  const archivado = motor.instantanea().world.retiredChunks.find(c => c.key === claveRetiro);
  assert.ok(archivado?.animals?.some(a => a.uid === animal.uid));
  assert.equal(motor.trazaFotogramaDuenos?.reunionesEvitadas, 3);
});

test('cortePorDuenos conserva el registro de página si sigue presente en clavesActivas aunque no esté en f.paginas', () => {
  const mundo = createWorld(11, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, unSoloDueno(11));
  const descriptor = crearDescriptor();
  const enlace = enlaceCinta(descriptor);
  motor.enlazar(descriptor);
  motor.cargar({ world: mundo, materia: null }, 0);
  const d = duenoSi(mundo)!;
  const fuente = fuenteFotograma(mundo, 0, 'paginas', RUNTIME, () => 10, () => undefined);
  const emisor = new EmisorFotoDueno(mundo);
  const ranura = descriptor.ranuras[0]!;
  const f1 = { ranura, completo: true, tick: 1, epoca: 0, versiones: enlace.versiones! };
  const claves = Object.keys(mundo.chunks);
  assert.ok(claves.length >= 2);
  const paginasTodas = Int32Array.from(claves.flatMap(k => k.split(',').map(Number)));
  const chunks = Array.from(d.chunks);
  const parte1 = emisor.emitir(d, f1, chunks, d.organismos, (px, py) => d.terrenoPercibido.paginaDe(px, py), 0, 0, true);
  const lote1 = {
    hilos: 1, cabecera: mundo, partes: [parte1], clavesActivas: new Set(claves),
    chunksActivos: chunks, conCaras: true, limiteBytesTotal: 64 * 1024 * 1024, bajasConfirmadas: [],
  };
  const s1 = fuente.cortePorDuenos!(d, f1, paginasTodas, lote1);
  assert.ok(s1);
  fuente.confirmar(f1);

  // Segundo fotograma incremental: `paginas` vacío (ninguna página sucia), pero TODAS siguen en `clavesActivas`.
  const f2 = { ranura, completo: false, tick: 2, epoca: 0, versiones: enlace.versiones! };
  const parte2 = emisor.emitir(d, f2, [], d.organismos, (px, py) => d.terrenoPercibido.paginaDe(px, py), 1, 0, false);
  const lote2 = {
    hilos: 1, cabecera: mundo, partes: [parte2], clavesActivas: new Set(claves),
    chunksActivos: chunks, conCaras: false, limiteBytesTotal: 64 * 1024 * 1024, bajasConfirmadas: [],
  };
  const s2 = fuente.cortePorDuenos!(d, f2, new Int32Array(0), lote2);
  assert.ok(s2);
  assert.equal(s2.sucesos.some(e => e.tipo === 'pagina' && e.vista === null), false);
  fuente.confirmar(f2);

  // Tercer fotograma incremental: solo cuando una clave sale de `clavesActivas` (ya no está en `mundo.chunks`), se emite su baja.
  const retirada = claves[0]!;
  const restantes = new Set(claves.slice(1));
  const f3 = { ranura, completo: false, tick: 3, epoca: 0, versiones: enlace.versiones! };
  const parte3 = emisor.emitir(d, f3, [], d.organismos, (px, py) => d.terrenoPercibido.paginaDe(px, py), 2, 0, false);
  const lote3 = {
    hilos: 1, cabecera: mundo, partes: [parte3], clavesActivas: restantes,
    chunksActivos: chunks.slice(1), conCaras: false, limiteBytesTotal: 64 * 1024 * 1024, bajasConfirmadas: [],
  };
  const s3 = fuente.cortePorDuenos!(d, f3, new Int32Array(0), lote3);
  assert.ok(s3);
  assert.deepEqual(
    s3.sucesos.flatMap(e => e.tipo === 'pagina' && e.vista === null ? [e.id] : []),
    [retirada],
  );
  void motor.cerrar();
});

test('cesión de chunk (destino >= 0) transfiere estado confirmado sin emitir bajas espurias', async t => {
  const mundo = createWorld(23, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, { ...unSoloDueno(23), hilos: 2, emisionFotogramaDuenos: true });
  t.after(() => motor.cerrar());
  const descriptor = crearDescriptor();
  const enlace = enlaceCinta(descriptor);
  const fuente = fuenteFotograma(mundo, 0, 'migracion', RUNTIME, () => 10, () => undefined);
  const vista = estadoVista(0);
  let leidos = 0n;

  motor.enlazar(descriptor, fuente);
  Atomics.store(enlace.creditos, 0, 1);
  Atomics.store(enlace.cadencia, 0, 1);

  // Fotograma 1 completo.
  motor.paso([]);
  assert.equal(Atomics.load(enlace.entregados, 0), 1n);
  assert.ok(leerFotograma(enlace, leidos++, (f, s) => { fotogramaAVista(vista, f, s, 1); }));

  // Ceder un chunk del dueño 0 al dueño 1 (o viceversa).
  const d = duenoSi(mundo)!, terreno = d.terrenoPercibido;
  let chunkCedido = -1, origen = -1, destino = -1;
  for (let c = 0; c < terreno.paginas; c++) {
    const h = terreno.duenoChunk[c]!;
    if (h === 0 || h === 1) { chunkCedido = c; origen = h; destino = 1 - h; break; }
  }
  assert.ok(chunkCedido >= 0);
  const claveCedida = `${terreno.paginaX[chunkCedido]},${terreno.paginaY[chunkCedido]}`;
  d.ordenar(origen, [ORDEN.ceder, chunkCedido, destino]);
  terreno.duenoSiguiente[chunkCedido] = destino;

  // Tick de cesión + tick siguiente tras adopción en F1.
  for (let i = 0; i < 2; i++) {
    motor.paso([]);
    assert.equal(Atomics.load(enlace.entregados, 0), leidos + 1n);
    assert.ok(leerFotograma(enlace, leidos++, (f, s) => {
      const bajaCedida = s.find(e => e.tipo === 'pagina' && e.id === claveCedida && e.vista === null);
      assert.equal(bajaCedida, undefined, 'una cesión (destino >= 0) jamás debe emitir pagina: null');
      fotogramaAVista(vista, f, s, Number(leidos));
    }));
  }

  assert.ok(motor.trazaFotogramaDuenos!.migrantesTransferidos >= 1);
  assert.equal(motor.trazaFotogramaDuenos!.reunionesEvitadas, 3);

  // Contrato de cesión + demolición posterior en el receptor (y con aborto del tick de cesión):
  // B hereda la firma confirmada de la estructura y emite su baja `null` al demolerla antes del siguiente fotograma.
  const mundoM = createWorld(29, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motorM = crearMotor(mundoM, unSoloDueno(29));
  t.after(() => motorM.cerrar());
  const descM = crearDescriptor();
  const enlM = enlaceCinta(descM);
  motorM.enlazar(descM);
  motorM.cargar({ world: mundoM, materia: null }, 0);
  const dM = duenoSi(mundoM)!;
  const estCedidaId = 'est-cedida-1';
  const claveChunk = chunkKey(mundoM.people[0]!.x, mundoM.people[0]!.y);
  mundoM.structures.push({
    id: estCedidaId, x: mundoM.people[0]!.x, y: mundoM.people[0]!.y,
    blueprintId: 'bp-cedida', name: 'Cobertizo cedido', components: ['frame', 'roof'],
    condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: mundoM.people[0]!.id,
  });
  const emisorA = new EmisorFotoDueno(mundoM);
  const emisorB = new EmisorFotoDueno(mundoM);
  const ranuraM = descM.ranuras[0]!;
  const chunksM = Array.from(dM.chunks);

  // Tick 1 (completo): A emite y se confirma (genEntregado = 1).
  const fM1 = { ranura: ranuraM, completo: true, tick: 1, epoca: 0, versiones: enlM.versiones! };
  const pM1 = emisorA.emitir(dM, fM1, chunksM, dM.organismos, (px, py) => dM.terrenoPercibido.paginaDe(px, py), 0, 0, true);
  assert.ok(pM1.estructurasAltasIds.includes(estCedidaId));

  // Tick 2: A emite incremental (tentativo gen=2), luego cede el chunk a B, y Tick 2 ABORTA (gen sigue en 1).
  const fM2 = { ranura: ranuraM, completo: false, tick: 2, epoca: 0, versiones: enlM.versiones! };
  emisorA.emitir(dM, fM2, [], dM.organismos, (px, py) => dM.terrenoPercibido.paginaDe(px, py), 1, 0, false);
  const estadoTransferido = emisorA.extraerChunkCedido(claveChunk, [estCedidaId], [], [], 2, 0, 1, 0);

  // Tick 3 F1: B adopta con genEntregado = 1 (sabe que tick 2 abortó -> toma confirmado de tick 1).
  // Antes del fotograma 3, la estructura se demuele en B -> B DEBE emitir `{ tipo: 'estructura', id: estCedidaId, vista: null }`.
  emisorB.adoptarChunk(claveChunk, estadoTransferido, 3, 0, 1, 0);
  mundoM.structures = mundoM.structures.filter(s => s.id !== estCedidaId);
  const fM3 = { ranura: ranuraM, completo: false, tick: 3, epoca: 0, versiones: enlM.versiones! };
  const pM3 = emisorB.emitir(dM, fM3, [], dM.organismos, (px, py) => dM.terrenoPercibido.paginaDe(px, py), 1, 0, false);
  assert.ok(pM3.estructurasBajasIds.includes(estCedidaId), 'B debe emitir baja de estructura heredada por cesión tras aborto');
  assert.ok(decodificarBloques([pM3.bajasBytes]).some(s => s.tipo === 'estructura' && s.id === estCedidaId && s.vista === null));
});

test('una cesión con activos instalados conserva su masa en la proyección de tecnología', async t => {
  const semilla = 23;
  const mundo = createWorld(semilla, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos: 2, emisionFotogramaDuenos: true });
  t.after(() => motor.cerrar());
  const descriptor = crearDescriptor(), enlace = enlaceCinta(descriptor);
  motor.enlazar(descriptor, fuenteFotograma(mundo, 0, 'activos', RUNTIME, () => 10, () => undefined));
  Atomics.store(enlace.cadencia, 0, 1);
  motor.paso([]);

  const d = duenoSi(mundo)!, terreno = d.terrenoPercibido;
  const chunk = d.chunks.find(c => terreno.duenoChunk[c] === 0);
  assert.notEqual(chunk, undefined);
  const x = terreno.paginaX[chunk!]! * 16, y = terreno.paginaY[chunk!]! * 16;
  const masa = 1000;
  mundo.structures.push({
    id: 'est-cedida-con-activo', x, y, blueprintId: 'bp-cedida', name: 'Cobertizo',
    components: ['frame', 'roof'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: mundo.people[0]!.id,
    installed: [{ id: 'activo-cedido', mass: masa, recipeId: null, containment: 1, insulation: 1, cohesion: 1, binding: 1, condition: 1 }],
  });
  const estado = estadoVista(0);
  Atomics.store(enlace.creditos, 0, 1);
  motor.paso([]);
  assert.ok(leerFotograma(enlace, 0n, (f, s) => {
    assert.equal(fotogramaAVista(estado, f, s, 1).vista.technology?.dynamics.productMass, masa);
  }));
  assert.equal(motor.trazaFotogramaDuenos?.emitidos, 1);

  d.ordenar(0, [ORDEN.ceder, chunk!, 1]);
  terreno.duenoSiguiente[chunk!] = 1;
  motor.paso([]);
  assert.ok(leerFotograma(enlace, 1n, (f, s) => {
    const vista = fotogramaAVista(estado, f, s, 2).vista;
    assert.ok(vista.structures?.some(estructura => estructura.id === 'est-cedida-con-activo'));
    assert.equal(vista.technology?.dynamics.productMass, masa);
  }));
  assert.equal(motor.trazaFotogramaDuenos?.emitidos, 1);
  assert.equal(motor.trazaFotogramaDuenos?.fallbacksCompat, 1);
});

test('aborto de fotograma completo conserva el estado confirmado anterior y reintenta sin corrupción', async t => {
  // Parte A: prueba directa del estado confirmado en EmisorFotoDueno ante aborto de f.completo.
  const mundoA = createWorld(31, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motorA = crearMotor(mundoA, unSoloDueno(31));
  t.after(() => motorA.cerrar());
  const descA = crearDescriptor();
  const enlA = enlaceCinta(descA);
  motorA.enlazar(descA);
  motorA.cargar({ world: mundoA, materia: null }, 0);
  const dA = duenoSi(mundoA)!;
  const estructuraId = 'estructura-confirmada-test';
  mundoA.structures.push({
    id: estructuraId, x: mundoA.people[0]!.x, y: mundoA.people[0]!.y,
    blueprintId: 'bp-test', name: 'Refugio de prueba', components: ['frame', 'roof'],
    condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: mundoA.people[0]!.id,
  });
  const emisor = new EmisorFotoDueno(mundoA);
  const ranuraA = descA.ranuras[0]!;
  const chunksA = Array.from(dA.chunks);

  // 1) Fotograma completo inicial se confirma (genEntregado pasa de 0 a 1).
  const f1 = { ranura: ranuraA, completo: true, tick: 1, epoca: 0, versiones: enlA.versiones! };
  const p1 = emisor.emitir(dA, f1, chunksA, dA.organismos, (px, py) => dA.terrenoPercibido.paginaDe(px, py), 0, 0, true);
  assert.equal(p1.desbordado, false);
  assert.ok(p1.estructurasAltasIds.includes(estructuraId));

  // 2) Se demuele la estructura y se pide un fotograma completo (tick 2), que ABORTA (genEntregado sigue en 1).
  mundoA.structures = mundoA.structures.filter(s => s.id !== estructuraId);
  const f2CompletoAbortado = { ranura: ranuraA, completo: true, tick: 2, epoca: 0, versiones: enlA.versiones! };
  const p2 = emisor.emitir(dA, f2CompletoAbortado, chunksA, dA.organismos, (px, py) => dA.terrenoPercibido.paginaDe(px, py), 1, 0, true);
  assert.equal(p2.desbordado, false);
  // No confirmamos p2: genEntregado sigue en 1 (aborto de f.completo!).

  // 3) En tick 3, un fotograma incremental (genEntregado sigue en 1) DEBE seguir viendo `estructuraId` en `confirmado`
  //    y emitir su baja `{ tipo: 'estructura', id: estructuraId, vista: null }`!
  const f3Incremental = { ranura: ranuraA, completo: false, tick: 3, epoca: 0, versiones: enlA.versiones! };
  const p3 = emisor.emitir(dA, f3Incremental, [], dA.organismos, (px, py) => dA.terrenoPercibido.paginaDe(px, py), 1, 0, false);
  assert.ok(p3.estructurasBajasIds.includes(estructuraId), 'confirmado anterior debe sobrevivir al aborto de un f.completo');
  const bajasP3 = decodificarBloques([p3.bajasBytes]);
  assert.ok(bajasP3.some(s => s.tipo === 'estructura' && s.id === estructuraId && s.vista === null));

  // Parte B: prueba de extremo a extremo con 2 dueños y saturación de anillo al pedir f.completo.
  const mundoB = createWorld(37, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motorB = crearMotor(mundoB, { ...unSoloDueno(37), hilos: 2, emisionFotogramaDuenos: true });
  t.after(() => motorB.cerrar());
  // Anillo pequeño (64 KiB): cabe el primer fotograma si se lee, pero al saturarlo sin leer falla el segundo `f.completo`.
  const descB = crearDescriptor(1024 * 1024);
  const enlB = enlaceCinta(descB);
  const fuenteB = fuenteFotograma(mundoB, 0, 'aborto', RUNTIME, () => 10, () => undefined);
  const vistaB = estadoVista(0);
  motorB.enlazar(descB, fuenteB);
  Atomics.store(enlB.cadencia, 0, 1);
  motorB.paso([]);
  Atomics.store(enlB.creditos, 0, 1);

  motorB.paso([]);
  assert.equal(Atomics.load(enlB.entregados, 0), 1n);
  let bytesPrimero = 0n;
  assert.ok(leerFotograma(enlB, 0n, (f, s) => {
    bytesPrimero = BigInt(f.sucesos[1] - f.sucesos[0]);
    fotogramaAVista(vistaB, f, s, 1);
  }));
  assert.ok(bytesPrimero > 0n);

  // Forzamos saturación real del anillo en `escribirSucesos` durante un `f.completo`:
  // mantenemos `sucesosLeidos >= 0n` dejando solo 64 bytes libres en el anillo.
  const escritos = Atomics.load(enlB.sucesosEscritos, 0);
  Atomics.store(enlB.sucesosLeidos, 0, 0n);
  Atomics.store(enlB.sucesosEscritos, 0, BigInt(descB.sucesos.byteLength - 64));
  Atomics.store(enlB.pedirCompleto, 0, 1);
  motorB.paso([]);
  assert.equal(Atomics.load(enlB.entregados, 0), 1n, 'el fotograma completo saturado debe abortar');
  assert.equal(Atomics.load(enlB.saturado, 0), 1);
  assert.equal(Atomics.load(enlB.pedirCompleto, 0), 1, 'pedirCompleto debe rearmarse al abortar');
  assert.equal(motorB.trazaFotogramaDuenos!.abortos, 1);
  assert.equal(motorB.trazaFotogramaDuenos!.completosAbortados, 1);

  // Liberamos el anillo restaurando cursores coherentes y reintentamos: debe entregar un fotograma completo válido.
  Atomics.store(enlB.sucesosEscritos, 0, escritos);
  Atomics.store(enlB.sucesosLeidos, 0, escritos);
  Atomics.store(enlB.saturado, 0, 0);
  motorB.paso([]);
  assert.equal(Atomics.load(enlB.entregados, 0), 2n);
  assert.ok(leerFotograma(enlB, 1n, (f, s) => {
    assert.equal(f.completo, true);
    const corte = fotogramaAVista(vistaB, f, s, 2);
    assert.ok(corte.vista.people.length > 0);
  }));
});

test('límite de transferencia activa fallback reunido y recupera emisión por dueños sin perder bajas', async t => {
  const mundo = createWorld(41, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  // Límite muy bajo (256 B) para forzar desborde en dueños -> fallback reunido operativo.
  const motorLimite = crearMotor(mundo, {
    ...unSoloDueno(41), hilos: 2, emisionFotogramaDuenos: true, limiteBytesFotoDueno: 256,
  });
  t.after(() => motorLimite.cerrar());
  const desc = crearDescriptor();
  const enl = enlaceCinta(desc);
  const fuente = fuenteFotograma(mundo, 0, 'limite', RUNTIME, () => 10, () => undefined);
  const vista = estadoVista(0);
  motorLimite.enlazar(desc, fuente);
  Atomics.store(enl.cadencia, 0, 1);
  motorLimite.paso([]);
  Atomics.store(enl.creditos, 0, 1);

  motorLimite.paso([]);
  assert.equal(Atomics.load(enl.entregados, 0), 1n);
  assert.equal(motorLimite.trazaFotogramaDuenos!.fallbacksLimite, 1);
  assert.equal(motorLimite.trazaFotogramaDuenos!.emitidos, 0);
  assert.ok(leerFotograma(enl, 0n, (f, s) => {
    const corte = fotogramaAVista(vista, f, s, 1);
    assert.ok(corte.vista.people.length > 0);
  }));

  // Transición duenos (T1 full) -> fallback (T2 delta, devolviendo null una vez) -> duenos (T3 delta):
  const mundo2 = createWorld(43, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor2 = crearMotor(mundo2, { ...unSoloDueno(43), hilos: 2, emisionFotogramaDuenos: true });
  t.after(() => motor2.cerrar());
  const desc2 = crearDescriptor();
  const enl2 = enlaceCinta(desc2);
  const fuenteBase = fuenteFotograma(mundo2, 0, 'handoff', RUNTIME, () => 10, () => undefined);
  const vista2 = estadoVista(0);
  let forzarFallback = false;
  motor2.enlazar(desc2, {
    corte: (c, f, paginas, reunido) => fuenteBase.corte(c, f, paginas, reunido),
    cortePorDuenos: (c, f, paginas, lote) => forzarFallback ? null : fuenteBase.cortePorDuenos!(c, f, paginas, lote),
    confirmar: f => fuenteBase.confirmar(f),
  });
  Atomics.store(enl2.cadencia, 0, 1);
  motor2.paso([]);
  Atomics.store(enl2.creditos, 0, 1);

  // T1 (duenos full)
  motor2.paso([]);
  assert.ok(leerFotograma(enl2, 0n, (f, s) => { fotogramaAVista(vista2, f, s, 1); }));
  assert.equal(motor2.trazaFotogramaDuenos!.emitidos, 1);

  // T2 (fallback reunido incremental)
  forzarFallback = true;
  motor2.paso([]);
  assert.ok(leerFotograma(enl2, 1n, (f, s) => { fotogramaAVista(vista2, f, s, 2); }));
  assert.equal(motor2.trazaFotogramaDuenos!.fallbacksCompat, 1);

  // T3 (vuelta a duenos incremental sin forzar completo)
  forzarFallback = false;
  motor2.paso([]);
  assert.ok(leerFotograma(enl2, 2n, (f, s) => {
    assert.equal(f.completo, false);
    const corte = fotogramaAVista(vista2, f, s, 3);
    assert.ok(corte.vista.people.length > 0);
  }));
  assert.equal(motor2.trazaFotogramaDuenos!.emitidos, 2);
});
