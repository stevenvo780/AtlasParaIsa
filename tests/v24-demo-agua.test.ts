import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import type { StructureView } from '../src/shared/life.js';
import { beberConCuerpo } from '../src/world/actuar/recursos.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { aguaMaterialDisponible, hayDepositoObraEnDisco, waterAvailable } from '../src/world/inventions.js';
import { metabolizar, vistaCuerpo } from '../src/world/materia/cuerpo.js';
import { lotesDeCelda, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import type { EstadoObra } from '../src/world/materia/piezas.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe, enlazarCtx, refDeOrganismo } from '../src/world/motor/acceso.js';
import { slotDe } from '../src/world/motor/contratos.js';
import { RADIUS } from '../src/world/mundo/tipos.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { CHUNK_SIZE } from '../src/world/terrain.js';

test('la consulta de agua suma la cisterna de la vista con el inventario material del dueño', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'obra' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo);
  const persona = mundo.people.find(p => p.role === 'neighbor');
  assert.ok(persona);
  const punto = { x: persona.x, y: persona.y };
  const celda = c.terreno.celda(punto.x, punto.y);
  const deposito = c.materia.nuevo(Rol.Objeto, celda, 0);
  c.materia.fuente(deposito, Float64Array.of(sustanciasDe(c).H2O, 100_000), c.libro);
  const obraMaterial: EstadoObra = { piezas: [], agua: deposito, comida: -1, pendiente: null, terminada: true };
  const cisterna: StructureView & { obraMaterial: EstadoObra } = { ...punto, id: 'cisterna-de-prueba', name: 'Cisterna de prueba',
    blueprintId: mundo.blueprints[0]!.id, cells: [punto], components: ['cistern'], condition: 1, water: 0, food: 0, uses: 0,
    builtAt: mundo.tick, builderId: null, obraMaterial };
  const vista = { ...mundo, structures: [cisterna] };
  setParams(vista, paramsOf(mundo));
  enlazarCtx(vista, c);
  const ambiente = aguaMaterialDisponible(mundo, c, punto, false, celda);
  const stock = c.materia.vista(deposito).masa;
  assert.ok(stock > 0);
  assert.equal(waterAvailable(mundo, punto), ambiente);
  assert.equal(waterAvailable(vista, punto), ambiente + stock);
  assert.equal(aguaMaterialDisponible(vista, c, punto, true, celda), ambiente + stock);

  // El borde del disco toca una celda de la planta lejos de su ancla.
  const centro = { x: punto.x - RADIUS, y: punto.y };
  const alBorde = { ...vista, structures: [{ ...cisterna, x: punto.x + CHUNK_SIZE }] };
  const conCriba = (w: typeof vista) =>
    aguaMaterialDisponible(w, c, punto, hayDepositoObraEnDisco(w, centro, RADIUS, 'agua'), celda);
  assert.equal(hayDepositoObraEnDisco(alBorde, centro, RADIUS, 'agua'), true);
  assert.equal(hayDepositoObraEnDisco(alBorde, centro, RADIUS, 'comida'), false);
  assert.equal(conCriba(alBorde), ambiente + stock);
  assert.equal(aguaMaterialDisponible(alBorde, c, punto, true, -1), 0);

  obraMaterial.agua = -1;
  assert.equal(hayDepositoObraEnDisco(alBorde, centro, RADIUS, 'agua'), false);
  assert.equal(conCriba(alBorde), aguaMaterialDisponible(alBorde, c, punto, true, celda));
  obraMaterial.agua = Number.MAX_SAFE_INTEGER;
  assert.equal(hayDepositoObraEnDisco(alBorde, centro, RADIUS, 'agua'), true);
  assert.equal(conCriba(alBorde), ambiente);
  obraMaterial.agua = deposito;
  assert.equal(conCriba(alBorde), ambiente + stock);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('sin agua material no hay sorbo ni alivio de sed en una charca', () => {
  function beberDeLaCharca(agotada: boolean) {
    const mundo = createWorld(51926, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
    stepWorld(mundo);
    const c = ctxMateriaDe(mundo);
    const vecinos = mundo.people.filter(p => p.role === 'neighbor' && p.cuerpo);
    const chunkDe = (p: { x: number; y: number }) => c.terreno.chunkDe(c.terreno.celda(p.x, p.y));
    const vecinosPorChunk = new Map(vecinos.map(p => [c.frente.chunk[slotDe(refDeOrganismo(c, p))], p]));
    const charca = mundo.tiles.find(t => vecinosPorChunk.has(chunkDe(t)) && waterAvailable(mundo, t) > 0.15);
    const persona = charca && vecinosPorChunk.get(chunkDe(charca));
    assert.ok(persona?.cuerpo && charca);
    const cuerpo = persona.cuerpo;
    const { H2O } = sustanciasDe(c);
    const celda = c.terreno.celda(charca.x, charca.y);
    const { agua } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
    assert.ok(agua >= 0);
    const aguaInicial = aguaMaterialDisponible(mundo, c, charca, false, celda);
    assert.ok(aguaInicial > 0);
    assert.equal(aguaInicial, aguaMaterialDisponible(mundo, c, charca, false));
    assert.equal(aguaMaterialDisponible(mundo, c, charca, false, -1), 0);
    const apartado = c.materia.nuevo(Rol.Objeto, -1, 0);
    const quitarAgua = (origen: number, cuantos: number) => {
      const trasladados = c.materia.moverParte(origen, apartado, { parte: Parte.Exacta, esp: H2O, cuantos, kappa: null });
      assert.equal(trasladados, cuantos);
    };
    quitarAgua(cuerpo.reserva, Math.floor(c.materia.cuantos(cuerpo.reserva, H2O) / 2));
    if (agotada) quitarAgua(agua, c.materia.cuantos(agua, H2O));
    assert.equal(aguaMaterialDisponible(mundo, c, charca, false, celda), agotada ? 0 : aguaInicial);

    persona.x = charca.x;
    persona.y = charca.y;
    persona.target = { x: charca.x, y: charca.y };
    persona.action = 'drink';
    const vista = { hambre: 0, sed: 0, energia: 0, salud: 0, masa: 0, carga: 0, T: 0 };
    const sedInicial = vistaCuerpo(c, cuerpo, vista).sed;
    assert.ok(sedInicial > 0);
    persona.thirst = sedInicial;

    const antes = c.materia.cuantos(agua, H2O), antesDigestivo = c.materia.cuantos(cuerpo.digestivo, H2O);
    const kilos = beberConCuerpo(mundo, persona, cuerpo, charca);
    const debitados = antes - c.materia.cuantos(agua, H2O);
    assert.equal(c.materia.cuantos(cuerpo.digestivo, H2O) - antesDigestivo, debitados);
    for (let paso = 0; paso < 20; paso++) metabolizar(c, cuerpo, celda, 1);
    assert.equal(balanceConservacion(mundo)?.ok, true);
    return { sedInicial, sedFinal: vistaCuerpo(c, cuerpo, vista).sed, kilos, debitados };
  }

  const conAgua = beberDeLaCharca(false), sinAgua = beberDeLaCharca(true);
  assert.equal(conAgua.sedInicial, sinAgua.sedInicial);
  assert.equal(sinAgua.kilos, 0);
  assert.equal(sinAgua.debitados, 0);
  assert.ok(conAgua.kilos > 0 && conAgua.debitados > 0);
  assert.ok(conAgua.sedFinal < sinAgua.sedFinal);
});
