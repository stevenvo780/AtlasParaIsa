import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { cargarPunto, guardarPunto, type PuntoGuardado } from '../scripts/lab/poblacion.mjs';
import { createWorld, stepWorld } from '../src/world/index.js';
import { masaLote, pedidoComida, plantillaDe } from '../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, TipoIntento } from '../src/world/motor/contratos.js';
import { paramsOf, parseParams } from '../src/world/params.js';

test('un punto del panel reabre las plantillas, los lotes y las garantías de un mundo material', () => {
  const temporales = '/tmp/atlas-v23-natalidad';
  mkdirSync(temporales, { recursive: true });
  const dir = mkdtempSync(join(temporales, 'punto-materia-'));
  try {
    const mundo = createWorld(19106, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
    for (let i = 0; i < 8; i++) stepWorld(mundo);
    const d = duenoSi(mundo)!, c = ctxMateriaDe(mundo), persona = mundo.people.find(p => p.role === 'neighbor');
    const animal = mundo.animals.find(a => a.cuerpo);
    assert.ok(persona?.cuerpo && animal?.cuerpo);
    const celda = c.terreno.celda(persona.x, persona.y);
    assert.ok(celda >= 0);
    const idPlantilla = animal.cuerpo.plantilla;
    const kg = masaLote(c, animal.cuerpo.tejido);
    const materia = Float64Array.from(c.materia.garantizar(persona.cuerpo.reserva, pedidoComida(c, persona.cuerpo, 0.025), c.libro));
    assert.ok(materia.length > 0);
    d.buzon.enviar(c.hilo, {
      tipo: TipoIntento.Depositar, de: REF_NULA, a: REF_NULA, celda, lote: REF_NULA,
      nonce: c.id('nonce'), materia, dato: null, bytes: null,
    });
    const saldo = c.libro.enVuelo.slice();
    assert.equal(balanceConservacion(mundo)?.ok, true);

    const ruta = join(dir, 'poblacion.atlas-punto');
    guardarPunto(ruta, mundo, new Map());
    const punto = deserialize(readFileSync(ruta)) as PuntoGuardado;
    assert.ok(punto.materia?.registro.length);
    const rutaPanel = join(dir, 'panel.punto');
    writeFileSync(rutaPanel, serialize({ ...punto, formato: 1, archivo: new Map(punto.archivo) }));
    const { mundo: copia } = cargarPunto(rutaPanel, base => parseParams({ cuerpo: { longevidadBaseDias: 20 } }, base));
    const cc = ctxMateriaDe(copia), cuerpoCopiado = copia.animals.find(a => a.id === animal.id)!.cuerpo!;
    assert.equal(paramsOf(copia).cuerpo.longevidadBaseDias, 20);
    assert.equal(copia.tick, mundo.tick);
    assert.equal(plantillaDe(cc, cuerpoCopiado).id, idPlantilla);
    assert.equal(masaLote(cc, cuerpoCopiado.tejido), kg);
    assert.deepEqual(cc.libro.enVuelo, saldo);
    assert.equal(balanceConservacion(copia)?.ok, true);
    stepWorld(copia);
    assert.equal(copia.tick, mundo.tick + 1);
    assert.ok(cc.libro.enVuelo.every(n => n === 0));
    assert.equal(balanceConservacion(copia)?.ok, true);

    delete punto.materia;
    writeFileSync(ruta, serialize(punto));
    assert.throws(() => cargarPunto(ruta), /no guarda su materia/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
