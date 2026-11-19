import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import {
  aplicarMigraciones, compararIntentos, confirmarIntentos, ejecutarFaseB, ejecutarFaseBGenerica,
  mortonDeRegion, ordenarIntentos, ordenarMigraciones, regionDeCelda, simularLlegada, validarIntent,
  type Intent,
} from '../src/world/paralelo/reduccion.js';

const intent = (parcial: Partial<Intent> & Pick<Intent, 'actorSlot'>): Intent => ({
  fase: 'decision', tipoRecurso: 'cosecha', recursoId: 'celda:10,10:food', celdaX: 10, celdaY: 10,
  secuenciaLocal: 0, cantidad: 0.5, ...parcial,
});

// Llegada simulada: actores agrupados por su región de origen (geometría dada), regiones
// repartidas en colas contiguas entre workers, y llegada en el orden pedido. La confirmación
// no debe depender de nada de esto.
function llegadaPorOrigen(
  intentos: readonly Intent[], origenes: ReadonlyMap<number, { x: number; y: number }>,
  regionSide: number, workers: number, orden: 'natural' | 'inverso' | 'mezclado',
): Intent[] {
  const porRegion = new Map<string, { morton: bigint; intentos: Intent[] }>();
  for (const it of intentos) {
    const origen = origenes.get(it.actorSlot)!;
    const region = regionDeCelda(origen.x, origen.y, regionSide);
    const clave = `${region.x},${region.y}`;
    const grupo = porRegion.get(clave) ?? { morton: mortonDeRegion(region.x, region.y), intentos: [] };
    grupo.intentos.push(it);
    porRegion.set(clave, grupo);
  }
  const regiones = [...porRegion.values()].sort((a, b) => a.morton < b.morton ? -1 : a.morton > b.morton ? 1 : 0);
  const colas: Intent[][] = Array.from({ length: workers }, (_, w) =>
    regiones.slice(Math.floor(regiones.length * w / workers), Math.floor(regiones.length * (w + 1) / workers))
      .flatMap(g => g.intentos));
  if (orden === 'natural') return colas.flat();
  if (orden === 'inverso') return colas.reverse().flatMap(c => [...c].reverse());
  const llegada = colas.flat();
  let semilla = 0x12345678;
  for (let i = llegada.length - 1; i > 0; i--) {
    semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((semilla / 4294967296) * (i + 1));
    [llegada[i], llegada[j]] = [llegada[j]!, llegada[i]!];
  }
  return llegada;
}

const resumen = (r: ReturnType<typeof confirmarIntentos>): string => JSON.stringify({
  resultados: r.resultados.map(x => [x.intent.actorSlot, x.intent.secuenciaLocal, x.concedido, x.denegado, x.duplicado]),
  stocks: [...r.stocksFinales.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1),
});

test('T145: competencia por la misma tesela — mismo ganador con 1/2/8/28 workers, 3 geometrías y orden adversarial', () => {
  // Tres actores en regiones de origen distintas compiten por la tesela (10,10), stock 1.
  const origenes = new Map([[2, { x: 0, y: 0 }], [5, { x: 900, y: 0 }], [7, { x: -900, y: 900 }]]);
  const base = [intent({ actorSlot: 7, cantidad: 0.75 }), intent({ actorSlot: 2, cantidad: 0.75 }), intent({ actorSlot: 5, cantidad: 0.75 })];
  const esperado = confirmarIntentos(base, new Map([['celda:10,10:food', 1]]));
  // Orden canónico por actorSlot: 2 concede 0.75, 5 concede 0.25, 7 concede 0.
  assert.deepEqual(esperado.resultados.map(r => [r.intent.actorSlot, r.concedido]), [[2, 0.75], [5, 0.25], [7, 0]]);
  assert.ok(Object.is(esperado.stocksFinales.get('celda:10,10:food'), 0));
  let combos = 0;
  for (const workers of [1, 2, 8, 28]) for (const side of [128, 256, 512]) {
    for (const orden of ['natural', 'inverso', 'mezclado'] as const) {
      const llegada = llegadaPorOrigen(base, origenes, side, workers, orden);
      assert.equal(resumen(confirmarIntentos(llegada, new Map([['celda:10,10:food', 1]]))), resumen(esperado),
        `workers=${workers} side=${side} orden=${orden}`);
      combos++;
    }
  }
  assert.equal(combos, 36);
});

test('T145: ningún intento se pierde ni se aplica dos veces; stocks finitos exactos (Object.is)', () => {
  const tipos = ['cosecha', 'agua', 'caza', 'construccion', 'reparacion', 'intercambio', 'compartir'] as const;
  for (const tipoRecurso of tipos) {
    const recursoId = `celda:3,4:${tipoRecurso}`;
    const intentos = [
      intent({ tipoRecurso, recursoId, celdaX: 3, celdaY: 4, actorSlot: 4, secuenciaLocal: 0, cantidad: 0.5 }),
      intent({ tipoRecurso, recursoId, celdaX: 3, celdaY: 4, actorSlot: 1, secuenciaLocal: 0, cantidad: 0.5 }),
      intent({ tipoRecurso, recursoId, celdaX: 3, celdaY: 4, actorSlot: 9, secuenciaLocal: 1, cantidad: 0.25 }),
      intent({ tipoRecurso, recursoId, celdaX: 3, celdaY: 4, actorSlot: 1, secuenciaLocal: 1, cantidad: 0.25 }),
    ];
    const r = confirmarIntentos([...intentos].reverse(), new Map([[recursoId, 1]]));
    assert.equal(r.resultados.length, intentos.length, `${tipoRecurso}: ningún intento se pierde`);
    assert.equal(new Set(r.resultados.map(x => `${x.intent.actorSlot}:${x.intent.secuenciaLocal}`)).size, intentos.length,
      `${tipoRecurso}: ninguno se aplica dos veces`);
    let concedidoTotal = 0;
    for (const x of r.resultados) {
      assert.ok(Object.is(x.concedido + x.denegado, x.intent.cantidad), `${tipoRecurso}: concedido+denegado=cantidad`);
      concedidoTotal += x.concedido;
    }
    assert.ok(Object.is(concedidoTotal, 1), `${tipoRecurso}: lo concedido suma el stock`);
    assert.ok(Object.is(r.stocksFinales.get(recursoId), 0), `${tipoRecurso}: stock final exacto`);
    assert.ok(r.stocksFinales.get(recursoId)! >= 0, `${tipoRecurso}: stock nunca negativo`);
  }
});

test('T145: reemisión idéntica no duplica la aplicación; reemisión conflictiva lanza', () => {
  const uno = intent({ actorSlot: 3, secuenciaLocal: 0, cantidad: 0.5 });
  const r = confirmarIntentos([uno, { ...uno }, uno], new Map([['celda:10,10:food', 1]]));
  assert.equal(r.resultados.length, 3);
  assert.equal(r.ordenados.length, 1);
  assert.deepEqual(r.resultados.map(x => x.duplicado), [false, true, true]);
  assert.ok(Object.is(r.stocksFinales.get('celda:10,10:food'), 0.5), 'solo se descontó una vez');
  // Payload con claves en otro orden sigue siendo la misma emisión.
  const conPayload = intent({ actorSlot: 4, secuenciaLocal: 0, cantidad: 0.25, payload: { a: 1, b: 2 } });
  const r2 = confirmarIntentos([conPayload, { ...conPayload, payload: { b: 2, a: 1 } }], new Map([['celda:10,10:food', 1]]));
  assert.equal(r2.ordenados.length, 1);
  assert.throws(
    () => confirmarIntentos([uno, { ...uno, cantidad: 0.25 }], new Map([['celda:10,10:food', 1]])),
    /Reemisión conflictiva.*actorSlot 3/,
  );
});

test('T145: orden canónico (celda, actorSlot, secuenciaLocal) independiente de la entrada y sin mutarla', () => {
  const entrada = [
    intent({ actorSlot: 1, secuenciaLocal: 2, celdaX: 5, celdaY: 5 }),
    intent({ actorSlot: 1, secuenciaLocal: 0, celdaX: 5, celdaY: 5 }),
    intent({ actorSlot: 0, secuenciaLocal: 9, celdaX: 5, celdaY: 5 }),
    intent({ actorSlot: 8, secuenciaLocal: 0, celdaX: -3, celdaY: 99 }),
    intent({ actorSlot: 8, secuenciaLocal: 0, celdaX: 5, celdaY: -1 }),
  ];
  const copia = entrada.map(i => ({ ...i }));
  const ordenados = ordenarIntentos(entrada);
  assert.deepEqual(ordenados.map(i => [i.celdaX, i.celdaY, i.actorSlot, i.secuenciaLocal]),
    [[-3, 99, 8, 0], [5, -1, 8, 0], [5, 5, 0, 9], [5, 5, 1, 0], [5, 5, 1, 2]]);
  assert.deepEqual(entrada, copia, 'la entrada no se muta');
  assert.deepEqual(ordenarIntentos([...entrada].reverse()), ordenados);
  assert.ok(compararIntentos(ordenados[0]!, ordenados[1]!) < 0 && compararIntentos(ordenados[1]!, ordenados[0]!) > 0);
  assert.equal(compararIntentos(ordenados[0]!, ordenados[0]!), 0);
});

test('T145: simularLlegada + confirmar es idéntico entre geometrías, workers y órdenes (escena multicelda)', () => {
  const intentos: Intent[] = [];
  const stocks = new Map<string, number>();
  for (let celda = 0; celda < 6; celda++) {
    const recursoId = `celda:${celda * 300},${celda * 170}:food`;
    stocks.set(recursoId, 1);
    for (const actorSlot of [celda, celda + 10, celda + 20]) {
      intentos.push(intent({ actorSlot, secuenciaLocal: celda, recursoId, celdaX: celda * 300, celdaY: celda * 170, cantidad: 0.5 }));
    }
  }
  const esperado = resumen(confirmarIntentos(intentos, stocks));
  for (const side of [128, 256, 512]) for (const workers of [1, 2, 8, 28]) {
    for (const orden of ['natural', 'inverso', 'adversarial', 'mezclado'] as const) {
      const llegada = simularLlegada(intentos, { regionSide: side, workers, orden });
      assert.equal(llegada.length, intentos.length);
      assert.deepEqual(new Set(llegada), new Set(intentos.map(validarIntent)), 'la llegada conserva el multiconjunto');
      assert.equal(resumen(confirmarIntentos(llegada, stocks)), esperado, `side=${side} workers=${workers} orden=${orden}`);
    }
  }
  assert.deepEqual(simularLlegada(intentos, { regionSide: 256, workers: 8, orden: 'mezclado' }),
    simularLlegada(intentos, { regionSide: 256, workers: 8, orden: 'mezclado' }), 'la llegada simulada es determinista');
});

test('T145: validación de Intent y de stocks', () => {
  const stocks = new Map([['celda:10,10:food', 1]]);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: 0, cantidad: -1 })], stocks), /cantidad/);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: 0, cantidad: Number.NaN })], stocks), /cantidad/);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: -1 })], stocks), /actorSlot/);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: 0, celdaX: 1.5 })], stocks), /celdaX/);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: 0, recursoId: '' })], stocks), /recursoId/);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: 0, recursoId: 'desconocido' })], stocks), /Stock desconocido/);
  assert.throws(() => confirmarIntentos([intent({ actorSlot: 0 }), intent({ actorSlot: 1, celdaX: 11 })], stocks), /dos celdas/);
  assert.throws(() => confirmarIntentos([], new Map([['x', -1]])), /Stock de x/);
  const vacio = confirmarIntentos([], stocks);
  assert.deepEqual(vacio.ordenados, []);
  assert.ok(Object.is(vacio.stocksFinales.get('celda:10,10:food'), 1), 'sin intentos el stock queda intacto');
  const cero = confirmarIntentos([intent({ actorSlot: 0, cantidad: 0 })], new Map([['celda:10,10:food', 0]]));
  assert.ok(Object.is(cero.resultados[0]!.concedido, 0) && Object.is(cero.stocksFinales.get('celda:10,10:food'), 0));
  assert.throws(() => validarIntent(intent({ actorSlot: 0, secuenciaLocal: -2 })), /secuenciaLocal/);
});

test('T145: migración tras la barrera en orden (regionDestinoMorton, actorSlot), slot invariable', () => {
  const entidades = [
    { actorSlot: 9, x: 0, y: 0, id: 'p9' }, { actorSlot: 3, x: 5, y: 5, id: 'p3' },
    { actorSlot: 7, x: 9, y: 9, id: 'p7' }, { actorSlot: 1, x: 2, y: 2, id: 'p1' },
  ];
  // Destinos sobre la diagonal: el orden Morton relativo se conserva en las 3 geometrías.
  const solicitudes = [
    { actorSlot: 9, destinoX: 1536, destinoY: 1536 }, { actorSlot: 3, destinoX: 512, destinoY: 512 },
    { actorSlot: 7, destinoX: 1024, destinoY: 1024 }, { actorSlot: 1, destinoX: 0, destinoY: 0 },
  ];
  const esperadoOrden = [1, 3, 7, 9];
  for (const side of [128, 256, 512]) {
    const mezcladas = [solicitudes[2]!, solicitudes[0]!, solicitudes[3]!, solicitudes[1]!];
    const { entidades: migradas, migraciones } = aplicarMigraciones(entidades, mezcladas, side);
    assert.deepEqual(migradas.map(e => e.actorSlot), esperadoOrden, `side=${side}`);
    assert.deepEqual(migraciones.map(m => m.actorSlot), esperadoOrden);
    for (const e of migradas) {
      const sol = solicitudes.find(s => s.actorSlot === e.actorSlot)!;
      assert.equal(e.x, sol.destinoX); assert.equal(e.y, sol.destinoY);
      assert.equal(e.id, entidades.find(o => o.actorSlot === e.actorSlot)!.id, 'la entidad conserva su identidad');
    }
    // Orden estrictamente creciente en (Morton destino, slot).
    for (let i = 1; i < migraciones.length; i++) {
      const a = migraciones[i - 1]!, b = migraciones[i]!;
      assert.ok(a.regionDestinoMorton < b.regionDestinoMorton || (a.regionDestinoMorton === b.regionDestinoMorton && a.actorSlot < b.actorSlot));
    }
  }
  assert.deepEqual(entidades.map(e => [e.x, e.y]), [[0, 0], [5, 5], [9, 9], [2, 2]], 'los orígenes no se mutan');
  assert.deepEqual(ordenarMigraciones([...solicitudes].reverse(), 256).map(m => m.actorSlot), esperadoOrden);
  assert.throws(() => ordenarMigraciones([solicitudes[0]!, solicitudes[0]!], 256), /duplicada.*actorSlot 9/);
  assert.throws(() => aplicarMigraciones(entidades, [{ actorSlot: 99, destinoX: 0, destinoY: 0 }], 256), /sin entidad.*99/);
});

test('T145: guardia T148 — una escritura fugada en fase B lanza con el slot culpable (estado sintético)', () => {
  const estado = { tiles: [{ x: 10, y: 10, food: 1 }], totals: { foodHarvested: 0 } };
  assert.throws(
    () => ejecutarFaseBGenerica(estado, 6, vista => { vista.tiles[0]!.food = 0; return []; }),
    /slot 6.*tiles\[0\]\.food/,
  );
  assert.equal(estado.tiles[0]!.food, 1, 'la escritura fugada no llega al estado compartido');
  const emitidos = ejecutarFaseBGenerica(estado, 6, vista => [
    intent({ actorSlot: 6, cantidad: Math.min(0.5, vista.tiles[0]!.food) }),
  ]);
  assert.equal(emitidos.length, 1);
  assert.ok(Object.is(emitidos[0]!.cantidad, 0.5));
  assert.throws(
    () => ejecutarFaseBGenerica(estado, 6, () => [intent({ actorSlot: 7 })]),
    /emitido por slot 6/,
  );
});

test('T145: guardia T148 sobre un mundo real (motor.depuracion=true) y runner sin depuración', () => {
  const world = createWorld(4821, parseParams('motor.depuracion=true'));
  const food = world.tiles[0]!.food;
  assert.throws(
    () => ejecutarFaseB(world, 4, vista => { vista.tiles[0]!.food = food + 1; return []; }),
    /slot 4.*tiles\[0\]\.food/,
  );
  assert.equal(world.tiles[0]!.food, food);
  const ok = ejecutarFaseB(world, 4, vista => [intent({ actorSlot: 4, cantidad: vista.tiles[0]!.food > 0 ? 0.25 : 0 })]);
  assert.equal(ok.length, 1);
  const sinDepuracion = createWorld(4821, parseParams('motor.depuracion=false'));
  assert.equal(ejecutarFaseB(sinDepuracion, 2, () => intent({ actorSlot: 2 })).length, 1, 'un solo Intent también se recoge');
  assert.equal(ejecutarFaseB(sinDepuracion, 2, () => null).length, 0);
});

test('T145: región y Morton son geometría de ejecución, no regla', () => {
  assert.deepEqual(regionDeCelda(-1, -1, 256), { x: -1, y: -1 });
  assert.deepEqual(regionDeCelda(255, 256, 256), { x: 0, y: 1 });
  assert.deepEqual(regionDeCelda(512, 0, 512), { x: 1, y: 0 });
  assert.ok(mortonDeRegion(0, 0) < mortonDeRegion(1, 0) && mortonDeRegion(1, 0) < mortonDeRegion(1, 1));
  assert.throws(() => regionDeCelda(0, 0, 0), /regionSide/);
  assert.throws(() => simularLlegada([], { regionSide: 256, workers: 0, orden: 'natural' }), /workers/);
});
