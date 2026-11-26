import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { demographicTraits, initialDemography, updateDemography } from '../src/world/demography.js';
import { Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { createWorld } from '../src/world/mundo/crear.js';
import type { Person, World } from '../src/world/mundo/tipos.js';
import { assertWorld } from '../src/world/mundo/validar.js';
import { parseParams, type WorldParams } from '../src/world/params.js';
import { worldContext } from '../src/world/spatial.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

const semilla = 7;
const tickCorte = 3;
const tickFinal = tickCorte + 2;
const victimas = [
  { id: 'neighbor-6', tick: 2, remota: false },
  { id: 'neighbor-3', tick: tickCorte, remota: true },
  { id: 'neighbor-1', tick: tickFinal, remota: true },
] as const;
const supervivientes = ['neighbor-4', 'neighbor-5'];

function programarVejez(persona: Person, tickMuerte: number, ley: WorldParams['cuerpo']): void {
  const traits = demographicTraits(persona.genome, ley);
  const intervalo = Math.ceil(traits.maximumAge / 1_000);
  // El cuerpo arranca completo. Sin el factor de cuidado, el azar de senescencia depende solo de id, tick y edad.
  for (let edad = traits.maximumAge; edad < traits.maximumAge * 2; edad += intervalo) {
    let state = initialDemography(edad);
    for (let tick = 1; tick <= tickMuerte; tick++) {
      const paso = updateDemography({ id: persona.id, state, traits, hunger: 0.2, thirst: 0.15, fatigue: 0.2, energy: 0.8 },
        { exposure: 0, shelter: 0, protected: false, seed: semilla, tick, senescence: ley });
      if (paso.death) {
        if (tick !== tickMuerte || paso.death !== 'senescence') break;
        persona.demography = initialDemography(edad);
        persona.bornAt = -edad;
        return;
      }
      state = paso.state;
    }
  }
  assert.fail(`No se encontró una edad que produzca la muerte de ${persona.id} en el tick ${tickMuerte}.`);
}

function prepararEntorno(t: TestContext): void {
  const entorno = {
    CARTA_MOTOR_HILOS: '2', CARTA_CORTE_TRANSFERIBLE: '1', CARTA_FAUNA_CORTE_DIRECTA: '1',
    CARTA_TESELAS_CORTE_DIRECTAS: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1', CARTA_SNAPSHOT_PESOS_SEPARADOS: '1',
  };
  const anteriores = Object.keys(entorno).map(clave => [clave, process.env[clave]] as const);
  Object.assign(process.env, entorno);
  t.after(() => {
    for (const [clave, valor] of anteriores) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
  });
}

function escenario(t: TestContext) {
  const { path, store } = laboratorio(t, 'atlas-solape-bajas-');
  const params = parseParams({
    v23: escalon('duenos'), persistencia: { cadaTicks: tickCorte }, conducta: { politicaPeso: 1 },
    cuerpo: { riesgoSenescenciaDiario: 1, riesgoSenescenciaPendiente: 50, cuidadoReduceRiesgo: 0 },
  });
  const inicial = createWorld(semilla, params);
  const local = inicial.places.find(lugar => lugar.id === 'huerta');
  const refugio = inicial.places.find(lugar => lugar.id === 'refugio');
  assert.ok(local && refugio);
  const paginas = Object.values(inicial.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), 2);
  const remoto = inicial.tiles.find(tesela => tesela.terrain !== 'water'
    && (tesela.x & 15) >= 4 && (tesela.x & 15) < 12 && (tesela.y & 15) >= 4 && (tesela.y & 15) < 12
    && paginas.some((p, i) => reparto[i] === 1 && p.cx === (tesela.x >> 4) && p.cy === (tesela.y >> 4)));
  assert.ok(remoto);
  const posiciones = [local, refugio, remoto];
  for (const [i, persona] of inicial.people.entries()) {
    const baja = victimas.find(v => v.id === persona.id);
    const destino = baja ? baja.remota ? remoto : local
      : persona.id === supervivientes[0] ? local : persona.id === supervivientes[1] ? remoto : posiciones[i % posiciones.length]!;
    persona.x = destino.x;
    persona.y = destino.y;
    persona.target = { x: destino.x, y: destino.y };
    persona.action = 'rest';
    persona.decisionAt = 120;
    persona.hunger = 0.2;
    if (baja) programarVejez(persona, baja.tick, params.cuerpo);
    if (supervivientes.includes(persona.id)) for (const v of victimas) persona.bonds[v.id] = 0.9;
  }
  store.guardar({ world: inicial, materia: null });
  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'guardado-solapado-bajas-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true, maxTicksSolapados: 3 },
    onFatalExit: codigo => assert.fail(`Salida fatal inesperada (${codigo}).`),
  });
  return { app, path, store, local, remoto };
}

function comprobarBajas(mundo: World, tick: number): void {
  assert.equal(mundo.tick, tick);
  assertWorld(mundo);
  const bajas = victimas.filter(v => v.tick <= tick);
  assert.equal(mundo.demographyDynamics.deaths, bajas.length);
  for (const { id, tick: muertoEn } of victimas) {
    assert.equal(mundo.people.some(persona => persona.id === id), muertoEn > tick);
    const historia = mundo.legacy.find(persona => persona.id === id);
    assert.equal(historia?.diedAt, muertoEn <= tick ? muertoEn : undefined);
    if (muertoEn <= tick) {
      assert.equal(historia?.cause, 'senescence');
      const muertes = mundo.events.filter(evento => evento.kind === 'death' && evento.actors.includes(id));
      assert.deepEqual(muertes.map(evento => evento.tick), [muertoEn]);
      assert.ok(mundo.communities.every(comunidad => !comunidad.members.includes(id)));
      for (const persona of mundo.people) assert.ok(!Object.hasOwn(persona.bonds, id));
    }
  }
}

function comprobarArchivo(store: Store, tick: number) {
  return victimas.map(({ id, tick: muertoEn }) => {
    const archivo = store.loadLegacy(id);
    assert.equal(archivo?.diedAt, muertoEn <= tick ? muertoEn : undefined);
    return archivo;
  });
}

function cuerposEn(mundo: World, posicion: { x: number; y: number }) {
  const { terreno, materia } = ctxMateriaDe(mundo);
  const celda = terreno.celda(posicion.x, posicion.y);
  assert.ok(celda >= 0);
  const refs = new Float64Array(materia.lotes(celda, Rol.Cadaver, new Float64Array()));
  assert.equal(materia.lotes(celda, Rol.Cadaver, refs), refs.length);
  return Array.from(refs, ref => {
    const { masa, agua, energia } = materia.vista(ref);
    assert.ok(masa > 0);
    return { masa, agua, energia };
  }).sort((a, b) => a.masa - b.masa || a.agua - b.agua || a.energia - b.energia);
}

async function ejecutarBrazo(t: TestContext, retener: boolean) {
  const { app, store, path, local, remoto } = escenario(t);
  const bloqueo = new DatabaseSync(path);
  try {
    const mundo = app.world, dueno = duenoSi(mundo), epoca = app.guardado.epoca;
    assert.ok(dueno);
    for (const v of victimas) assert.equal(mundo.people.some(p => p.id === v.id), !v.remota);
    const inicial = comprobarArchivo(store, 0);
    assert.deepEqual(inicial, [null, null, null]);
    if (retener) bloqueo.exec('BEGIN IMMEDIATE');

    for (let tick = 1; tick <= tickCorte; tick++) {
      app.stepOnce();
      assert.equal(mundo.tick, tick);
    }
    const acuse = app.esperarGuardado();
    assert.ok(acuse);
    const corteVivo = app.mundoParaEmision(true);
    comprobarBajas(corteVivo, tickCorte);
    if (!retener) await acuse;
    for (let tick = tickCorte + 1; tick <= tickFinal; tick++) {
      app.stepOnce();
      assert.equal(mundo.tick, tick);
    }
    if (retener) {
      assert.equal(app.guardado.ultimoTickGuardado, 0);
      comprobarArchivo(store, 0);
      bloqueo.exec('COMMIT');
      await acuse;
    }

    assert.equal(app.world, mundo);
    assert.equal(duenoSi(app.world), dueno);
    assert.equal(app.guardado.epoca, epoca);
    assert.equal(app.salud().recargas, 0);
    assert.equal(app.failed, false);
    assert.equal(app.guardado.ultimoTickGuardado, tickCorte);
    const vivo = app.mundoParaEmision(true);
    comprobarBajas(vivo, tickFinal);
    assert.deepEqual(vivo.retiredLegacy.map(v => [v.id, v.diedAt]), [[victimas[2].id, tickFinal]],
      'el acuse retira las dos bajas del corte y deja pendiente la baja remota posterior');
    const archivadas = comprobarArchivo(store, tickCorte);
    for (const archivo of archivadas) if (archivo) assert.deepEqual(archivo, vivo.legacy.find(v => v.id === archivo.id));

    const lector = new Store(path, { readOnly: true });
    try {
      const recarga = lector.verificarGuardado();
      assert.equal(recarga?.slot, 0);
      assert.ok(recarga);
      comprobarBajas(recarga.world, tickCorte);
      assert.deepEqual(recarga.world.retiredLegacy, []);
      assert.deepEqual(recarga.world.legacy, corteVivo.legacy);
    } finally { lector.close(); }

    const balance = dueno.balanceMateria();
    assert.deepEqual(balance.hallado, balance.esperado);
    const cadaveres = [cuerposEn(mundo, local), cuerposEn(mundo, remoto)];
    assert.deepEqual(cadaveres.map(c => c.length), [1, 2]);

    await app.close();
    const final = comprobarArchivo(store, tickFinal);
    assert.deepEqual(store.db.prepare('SELECT count(*) AS total FROM legacy').get()?.total, victimas.length);
    return { archivadas, final, balance, cadaveres, comunidades: vivo.communities,
      vinculos: vivo.people.map(p => [p.id, p.bonds]), legado: vivo.legacy, demografia: vivo.demographyDynamics };
  } finally {
    if (bloqueo.isTransaction) bloqueo.exec('ROLLBACK');
    bloqueo.close();
    await app.close();
  }
}

test('el acuse tardío aplica solo las bajas del corte y coincide con el acuse en su tick', async t => {
  prepararEntorno(t);
  const aTiempo = await ejecutarBrazo(t, false);
  const tardio = await ejecutarBrazo(t, true);
  assert.deepEqual(tardio, aTiempo);
});

test('el rechazo después de solapar bajas conserva el archivo anterior y pausa el mundo', async t => {
  prepararEntorno(t);
  const { app, store, path } = escenario(t);
  const anterior = filaInstantanea(store);
  const bloqueo = new DatabaseSync(path);
  try {
    bloqueo.exec('BEGIN IMMEDIATE');
    bloqueo.exec(`CREATE TRIGGER rechazar_bajas_solapadas BEFORE INSERT ON snapshots WHEN NEW.slot=0
      BEGIN SELECT RAISE(ABORT,'Fallo de guardado de bajas para la prueba'); END`);
    for (let tick = 1; tick <= tickFinal; tick++) {
      app.stepOnce();
      assert.equal(app.world.tick, tick);
    }
    const acuse = app.esperarGuardado();
    assert.ok(acuse);
    const vistaRetenida = app.mundoParaEmision(true);
    comprobarBajas(vistaRetenida, tickFinal);
    const lector = worldContext(vistaRetenida).loadLegacy;
    const prefijo = victimas.slice(0, 2).map(({ id }) => lector?.(id, tickFinal));
    assert.ok(prefijo.every(Boolean));
    comprobarArchivo(store, 0);
    bloqueo.exec('COMMIT');
    await acuse;
    assert.equal(app.failed, true);
    assert.equal(app.guardado.ultimoTickGuardado, 0);
    assert.deepEqual(victimas.slice(0, 2).map(({ id }) => lector?.(id, tickFinal)), prefijo);
    const vistaTrasRestituir = app.mundoParaEmision();
    assert.notEqual(vistaTrasRestituir, vistaRetenida);
    assert.deepEqual(vistaTrasRestituir.retiredLegacy.map(({ id }) => id).sort(), victimas.map(({ id }) => id).sort());
    await app.close();
    assert.deepEqual(filaInstantanea(store), anterior);
    comprobarArchivo(store, 0);
  } finally {
    if (bloqueo.isTransaction) bloqueo.exec('ROLLBACK');
    bloqueo.close();
    await app.close();
  }
});
