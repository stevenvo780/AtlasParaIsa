import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { beberConCuerpo } from '../src/world/actuar/recursos.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { waterAvailable } from '../src/world/inventions.js';
import { metabolizar, vistaCuerpo } from '../src/world/materia/cuerpo.js';
import { lotesDeCelda, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe, refDeOrganismo } from '../src/world/motor/acceso.js';
import { slotDe } from '../src/world/motor/contratos.js';

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
    const apartado = c.materia.nuevo(Rol.Objeto, -1, 0);
    const quitarAgua = (origen: number, cuantos: number) => {
      const trasladados = c.materia.moverParte(origen, apartado, { parte: Parte.Exacta, esp: H2O, cuantos, kappa: null });
      assert.equal(trasladados, cuantos);
    };
    quitarAgua(cuerpo.reserva, Math.floor(c.materia.cuantos(cuerpo.reserva, H2O) / 2));
    if (agotada) quitarAgua(agua, c.materia.cuantos(agua, H2O));

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
