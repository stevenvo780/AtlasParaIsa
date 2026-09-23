/** T104 — punto de restauración del paso. Con `motor.clonPorPaso=false` el paso corre sobre el
 * mundo vigente: la atomicidad ya no la regala el clon, la sostiene `puntoDeRestauracion`. La
 * puerta de calidad es `digestoCanonico`, que sí mira `retiredChunks` (el hash durable los borra). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './lib/net.js';
import { Store, SessionRevoked } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { PRODUCTION_PARAMS } from '../src/server/deployment-params.js';
import { cloneWorld, createWorld, puntoDeRestauracion, stepWorld, type FaseMedicion, type World } from '../src/world/index.js';
import { digestoCanonico, diferenciaCanonica } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { chunkKey } from '../src/world/terrain.js';

/** `digestoCanonico` incluye los params efectivos, y `motor.clonPorPaso` es uno de ellos: para
 * comparar dos motores hay que mirar el mundo, no la clave que eligió el motor. */
const digestoDelMundo = (world: World): string => {
  const copia = cloneWorld(world); setParams(copia, DEFAULT_PARAMS); return digestoCanonico(copia);
};

type Harness = { app: ReturnType<typeof createApp>; store: Store; origin: string; close: () => Promise<void> };
async function harness(clonPorPaso: boolean, extra = '', seed = 51926): Promise<Harness> {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const params = parseParams(`motor.clonPorPaso=${clonPorPaso}${extra}`, DEFAULT_PARAMS);
  // Reloj propio del servidor: así `performance.now()` durante el paso solo lo llama la medición de
  // fases de `stepOnce`, y `relojDeFases` puede contar en qué fase va el paso.
  const app = createApp({ store, origin, password: 'restauracion-t104-password', manual: true, seed, params,
    monotonicNow: () => Number(process.hrtime.bigint()) / 1e6 });
  return { app, store, origin, close: async () => { await app.close(); store.close(); } };
}
/** Lleva a todos los habitantes a un chunk vecino: el paso siguiente reanima terreno y retira el viejo. */
function mudar(world: World, dx: number, dy: number): void {
  for (const person of world.people) { person.x += dx; person.y += dy; person.target = { x: person.x, y: person.y }; }
}

test('(1) un fallo de store.save deja el digesto canónico exactamente como estaba antes del paso', async () => {
  const { app, store, close } = await harness(false);
  try {
    for (let n = 0; n < 12; n++) app.stepOnce();
    const antes = digestoCanonico(app.world), tick = app.world.tick;
    const mundoAntes = cloneWorld(app.world);
    store.save = () => { throw new Error('synthetic disk failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, true);
    assert.equal(app.world.tick, tick, 'el mundo no puede quedarse un tick por delante de lo confirmado');
    assert.equal(diferenciaCanonica(mundoAntes, app.world), null);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

test('(2) el mismo fallo con un chunk reanimado en ese paso: el terreno dormido vuelve a su sitio', async () => {
  const { app, store, close } = await harness(false);
  try {
    // Alejarse retira el chunk de origen (y `save` lo archiva, vaciando `retiredChunks`); volver
    // lo reanima desde el archivo del anfitrión, que es el caso que el hash durable no ve.
    for (let n = 0; n < 4; n++) app.stepOnce();
    const origen = chunkKey(app.world.people[0]!.x, app.world.people[0]!.y);
    mudar(app.world, 40, 0);
    for (let n = 0; n < 3; n++) app.stepOnce();
    assert.equal(origen in app.world.chunks, false, 'el chunk de origen debería haberse retirado');
    mudar(app.world, -40, 0);
    let lecturas = 0;
    const leer = store.loadChunk.bind(store);
    store.loadChunk = (key, atTick) => { lecturas++; return leer(key, atTick); };
    const antes = digestoCanonico(app.world), teselas = app.world.tiles.length;
    const mundoAntes = cloneWorld(app.world);
    store.save = () => { throw new Error('synthetic disk failure') };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, true);
    assert.ok(lecturas > 0, 'el paso fallido tenía que haber reanimado terreno archivado');
    assert.equal(origen in app.world.chunks, false, 'la reanimación del chunk tiene que quedar deshecha');
    assert.equal(app.world.tiles.length, teselas);
    assert.equal(diferenciaCanonica(mundoAntes, app.world), null);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

test('(3) `stepWorld` que lanza a mitad deja el mundo restaurado, no a medio paso', async () => {
  const { app, store, close } = await harness(false);
  try {
    for (let n = 0; n < 6; n++) app.stepOnce();
    // `activate` pide el chunk archivado al anfitrión desde dentro de `maintainRegions`, o sea
    // después de `world.tick++` y antes de la ecología: un fallo aquí es un paso a medias real.
    mudar(app.world, 40, 40);
    const antes = digestoCanonico(app.world), tick = app.world.tick;
    store.loadChunk = () => { throw new Error('synthetic mid-step failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, true);
    assert.equal(app.world.tick, tick);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

test('(4) SessionRevoked: el mundo no avanza con un gesto aplicado y no confirmado', async () => {
  const { app, store, origin, close } = await harness(false);
  try {
    for (let n = 0; n < 6; n++) app.stepOnce();
    app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening');
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'restauracion-t104-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const persona = app.world.people[0]!;
    const gesture = { id: 'restauracion-t104-gesto', kind: 'plant', x: persona.x + 1, y: persona.y };
    const enviado = fetch(origin + '/api/gesture', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(gesture) });
    for (let w = 0; w < 12; w++) await new Promise<void>(resolve => setImmediate(resolve));
    const antes = digestoCanonico(app.world), tick = app.world.tick;
    // Guardado real que revoca la sesión justo antes de confirmar: es la ruta viva, no un doble.
    const original = store.save.bind(store);
    store.save = (world, inputs, requiredSessions) => { store.revoke(requiredSessions?.[0]); return original(world, inputs, requiredSessions); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, false, 'una sesión revocada no pausa el mundo');
    assert.equal(app.world.tick, tick, 'el gesto no confirmado no puede dejar el mundo un tick por delante');
    assert.equal(digestoCanonico(app.world), antes);
    assert.equal((await enviado).status, 401);
  } finally { await close(); }
});

test('(5) `motor.clonPorPaso=true` reproduce exactamente el mundo de hoy, tick a tick', async () => {
  // El gobernador (ruling R17) es el único punto donde el reloj de pared entra en el mundo:
  // apaga los nacimientos cuando el p95 supera su presupuesto. Comparar dos motores que corren
  // a velocidades distintas exige un presupuesto que ninguno de los dos alcance; si no, la
  // divergencia que se mide es la del host, no la del cambio.
  const presupuesto = ',gobernador.presupuestoMs=5000';
  const conClon = await harness(true, presupuesto), sinClon = await harness(false, presupuesto);
  try {
    for (let n = 0; n < 60; n++) {
      conClon.app.stepOnce(); sinClon.app.stepOnce();
      assert.equal(digestoDelMundo(sinClon.app.world), digestoDelMundo(conClon.app.world), `divergencia en el paso ${n + 1}`);
    }
    assert.equal(sinClon.app.world.tick, 60);
  } finally { await conClon.close(); await sinClon.close(); }
});

test('el punto de restauración deshace un paso completo sin servidor, paso a paso y en tres semillas', () => {
  // Cinco digestos canónicos por paso (cada uno cuesta 30–90 pasos): 10 pasos por semilla bastan.
  for (const seed of [1, 7, 51926]) {
    let world = createWorld(seed);
    for (let n = 0; n < 10; n++) {
      // El gemelo se copia ANTES del punto: nunca intentó el paso, así que compararse con él prueba
      // que deshacer devuelve también lo que el digesto no ve (formas, índices, contexto).
      const control = cloneWorld(world);
      const antes = digestoCanonico(world);
      const punto = puntoDeRestauracion(world);
      stepWorld(world);
      assert.notEqual(digestoCanonico(world), antes, `el paso ${n + 1} de la semilla ${seed} no cambió nada`);
      punto.restaurar();
      assert.equal(digestoCanonico(world), antes, `restauración incompleta en el paso ${n + 1} de la semilla ${seed}`);
      assert.throws(() => punto.restaurar(), /ya se consumió/);
      // Y después de deshacer, el mundo sigue siendo un mundo: el paso vuelve a dar lo mismo.
      stepWorld(world); stepWorld(control);
      assert.equal(digestoCanonico(world), digestoCanonico(control));
      world = control;
    }
  }
});

test('SessionRevoked con clon por paso sigue sin pausar el mundo ni avanzarlo', async () => {
  const { app, store, close } = await harness(true);
  try {
    for (let n = 0; n < 4; n++) app.stepOnce();
    const antes = digestoCanonico(app.world);
    store.save = () => { throw new SessionRevoked('Session revoked before commit.'); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, false);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

/** Orden en que `advanceTick` mide sus fases: cada una llama dos veces al reloj de la medición. */
const FASES = ['maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros', 'demografia', 'comunidades',
  'reproduccion', 'checkpoint', 'muestreo'] as const;
type Fase = typeof FASES[number];

/** Sigue las fases de un paso por las llamadas al reloj de su medición: la llamada 2i+1 abre la fase i y
 * la 2i+2 la cierra. `armar(fase)` hace fallar ese cierre, justo después de que la fase entera mutó el
 * mundo; `dentro(fase)` sirve para fallar a mitad de una fase. */
class ContadorDeFases {
  private llamadas = -1;
  private cerrarConFallo: Fase | null = null;
  disparado = false;
  readonly clock = (): number => {
    if (this.llamadas >= 0) {
      this.llamadas++;
      if (this.cerrarConFallo !== null && this.llamadas === 2 * FASES.indexOf(this.cerrarConFallo) + 2) {
        this.cerrarConFallo = null; this.disparado = true;
        throw new Error('fallo inyectado al cerrar la fase');
      }
    }
    return Number(process.hrtime.bigint()) / 1e6;
  };
  armar(alCerrar: Fase | null = null): void { this.llamadas = 0; this.cerrarConFallo = alCerrar; this.disparado = false; }
  desarmar(): void { this.llamadas = -1; this.cerrarConFallo = null; }
  dentro(fase: Fase): boolean { return this.llamadas === 2 * FASES.indexOf(fase) + 1; }
}
/** `stepOnce` mide sus fases con `performance.now()` (el resto del servidor usa el reloj del arnés). */
async function conRelojDeFases<T>(uso: (fases: ContadorDeFases) => Promise<T>): Promise<T> {
  const fases = new ContadorDeFases();
  performance.now = fases.clock;
  try { return await uso(fases); } finally { Reflect.deleteProperty(performance, 'now'); }
}
/** Convierte `objeto[clave]` en un accesor que se porta como el dato salvo la primera vez que `cuando()`
 * es verdad: entonces lanza. El punto de restauración copia el VALOR, así que el mundo restaurado ya no
 * lleva la trampa, y la clave conserva su sitio en el orden de enumeración. */
function trampa(objeto: object, clave: string, cuando: () => boolean, error: () => Error): { readonly disparada: boolean } {
  let valor = (objeto as Record<string, unknown>)[clave], disparada = false;
  const vigilar = (): void => { if (!disparada && cuando()) { disparada = true; throw error(); } };
  Object.defineProperty(objeto, clave, { configurable: true, enumerable: true,
    get: () => { vigilar(); return valor; }, set: (nuevo: unknown) => { vigilar(); valor = nuevo; } });
  return { get disparada() { return disparada; } };
}
/** Hace fallar el `COMMIT` del siguiente guardado: todo lo demás del guardado ya corrió. */
function fallarAlConfirmar(store: Store, error: () => Error): { readonly disparado: boolean } {
  const exec = store.db.exec.bind(store.db);
  let disparado = false;
  store.db.exec = (sql: string) => {
    if (!disparado && sql === 'COMMIT') { disparado = true; throw error(); }
    return exec(sql);
  };
  return { get disparado() { return disparado; } };
}
const enMedio = <T>(lista: readonly T[]): T => {
  assert.ok(lista.length > 2, 'la prueba necesita más de dos elementos');
  return lista[lista.length >> 1]!;
};

test('(6) un fallo al cerrar cualquier fase del paso deja el mundo exactamente como antes del paso', async () => {
  await conRelojDeFases(async fases => {
    for (const fase of FASES) {
      const { app, close } = await harness(false);
      try {
        for (let n = 0; n < 6; n++) app.stepOnce();
        const antes = digestoCanonico(app.world), tick = app.world.tick, mundoAntes = cloneWorld(app.world);
        fases.armar(fase); app.stepOnce(); fases.desarmar();
        assert.equal(fases.disparado, true, `el fallo no llegó a cerrar ${fase}`);
        assert.equal(app.failed, true);
        assert.equal(app.world.tick, tick, fase);
        assert.equal(diferenciaCanonica(mundoAntes, app.world), null, fase);
        assert.equal(digestoCanonico(app.world), antes, fase);
      } finally { fases.desarmar(); await close(); }
    }
  });
});

test('(7) un fallo a mitad de personas, a mitad de fauna o al confirmar el guardado: mundo intacto y el Store sigue', async () => {
  await conRelojDeFases(async fases => {
    const casos: Record<string, (h: Harness) => () => boolean> = {
      personas: ({ app }) => {
        const t = trampa(enMedio(app.world.people), 'x', () => fases.dentro('personas'), () => new Error('fallo inyectado en personas'));
        return () => t.disparada;
      },
      fauna: ({ app }) => {
        const t = trampa(enMedio(app.world.animals), 'x', () => fases.dentro('fauna'), () => new Error('fallo inyectado en fauna'));
        return () => t.disparada;
      },
      guardado: ({ store }) => {
        const f = fallarAlConfirmar(store, () => new Error('fallo inyectado al confirmar'));
        return () => f.disparado;
      },
    };
    for (const [nombre, preparar] of Object.entries(casos)) {
      const h = await harness(false);
      try {
        for (let n = 0; n < 6; n++) h.app.stepOnce();
        const disparado = preparar(h);
        const antes = digestoCanonico(h.app.world), tick = h.app.world.tick, mundoAntes = cloneWorld(h.app.world);
        fases.armar(); h.app.stepOnce(); fases.desarmar();
        assert.equal(disparado(), true, `el fallo de ${nombre} no se disparó`);
        assert.equal(h.app.failed, true, nombre);
        assert.equal(h.app.world.tick, tick, nombre);
        assert.equal(diferenciaCanonica(mundoAntes, h.app.world), null, nombre);
        assert.equal(digestoCanonico(h.app.world), antes, nombre);
        // Lo durable es el último guardado confirmado (la cadencia de estos params es 1: el del paso
        // anterior), y un servidor que arranca sobre ese mismo Store sigue avanzando.
        assert.equal(h.store.load()!.world.tick, tick, nombre);
        await h.app.close();
        const otro = createApp({ store: h.store, origin: h.origin, password: 'restauracion-t104-password', manual: true });
        try {
          for (let n = 0; n < 3; n++) otro.stepOnce();
          assert.equal(otro.failed, false, nombre);
          assert.equal(otro.world.tick, tick + 3, nombre);
        } finally { await otro.close(); }
      } finally { fases.desarmar(); await h.close(); }
    }
  });
});

test('(8) un fallo DESPUÉS de confirmar el guardado no deshace en memoria un paso que ya es durable', async () => {
  const finales: string[] = [];
  for (const clonPorPaso of [true, false]) {
    const { app, store, close } = await harness(clonPorPaso, ',gobernador.presupuestoMs=5000');
    try {
      for (let n = 0; n < 6; n++) app.stepOnce();
      const tick = app.world.tick;
      // `stepOnce` lee `store.lastSnapshotBytes` después de `world = draft`, con el guardado ya confirmado.
      let armado = true;
      Object.defineProperty(store, 'lastSnapshotBytes', { configurable: true, set: () => {},
        get: () => { if (armado) { armado = false; throw new Error('fallo inyectado tras confirmar'); } return 0; } });
      app.stepOnce();
      assert.equal(armado, false, 'el fallo no se disparó');
      assert.equal(app.failed, true);
      assert.equal(app.world.tick, tick + 1, `clonPorPaso=${clonPorPaso}: lo confirmado en disco no se deshace en memoria`);
      assert.equal(digestoDelMundo(store.load()!.world), digestoDelMundo(app.world));
      finales.push(digestoDelMundo(app.world));
    } finally { await close(); }
  }
  assert.equal(finales[1], finales[0]);
});

test('(9) tras deshacer, el servidor sigue y su mundo es el de un gemelo con clon que nunca intentó ese paso', async () => {
  await conRelojDeFases(async fases => {
    const presupuesto = ',gobernador.presupuestoMs=5000';
    const gemelo = await harness(true, presupuesto), punto = await harness(false, presupuesto);
    try {
      // `SessionRevoked` es el fallo del que el servidor se recupera solo: deshace y reintenta al paso
      // siguiente. Lanzado a mitad de fase, o al confirmar, ejercita la restauración de un paso a medias.
      const revocada = (donde: string) => () => new SessionRevoked(`sesión revocada ${donde}`);
      const fallos: Record<number, () => () => boolean> = {
        8: () => {
          const t = trampa(enMedio(punto.app.world.people), 'x', () => fases.dentro('personas'), revocada('en personas'));
          return () => t.disparada;
        },
        16: () => {
          const t = trampa(enMedio(punto.app.world.animals), 'x', () => fases.dentro('fauna'), revocada('en fauna'));
          return () => t.disparada;
        },
        24: () => { const f = fallarAlConfirmar(punto.store, revocada('al confirmar')); return () => f.disparado; },
      };
      for (let n = 1; n <= 40; n++) {
        const inyectar = fallos[n];
        if (inyectar) {
          const disparado = inyectar(), tick = punto.app.world.tick;
          fases.armar(); punto.app.stepOnce(); fases.desarmar();
          assert.equal(disparado(), true, `el fallo del paso ${n} no se disparó`);
          assert.equal(punto.app.failed, false, 'una sesión revocada no pausa el mundo');
          assert.equal(punto.app.world.tick, tick);
          assert.equal(digestoDelMundo(punto.app.world), digestoDelMundo(gemelo.app.world), `restauración inexacta en el paso ${n}`);
        }
        gemelo.app.stepOnce(); punto.app.stepOnce();
        assert.equal(digestoDelMundo(punto.app.world), digestoDelMundo(gemelo.app.world), `divergencia en el paso ${n}`);
      }
      assert.equal(punto.app.failed, false);
      assert.equal(digestoDelMundo(punto.store.load()!.world), digestoDelMundo(gemelo.store.load()!.world));
    } finally { fases.desarmar(); await gemelo.close(); await punto.close(); }
  });
});

test('(10) con la receta de producción los dos motores dan el mismo mundo, en memoria y en disco', async () => {
  const receta = `,${PRODUCTION_PARAMS},gobernador.presupuestoMs=5000`;
  const conClon = await harness(true, receta), sinClon = await harness(false, receta);
  try {
    assert.equal(paramsOf(sinClon.app.world).persistencia.cadaTicks, 100);
    for (let n = 1; n <= 300; n++) {
      conClon.app.stepOnce(); sinClon.app.stepOnce();
      if (n % 10 === 0) assert.equal(digestoDelMundo(sinClon.app.world), digestoDelMundo(conClon.app.world), `divergencia en el paso ${n}`);
    }
    assert.equal(digestoDelMundo(sinClon.store.load()!.world), digestoDelMundo(conClon.store.load()!.world));
  } finally { await conClon.close(); await sinClon.close(); }
});

const MUNDO_ALTO = process.env.ATLAS_MUNDO_ALTO ?? '/datos/tmp-atlas-lab/perfil/psinagua3-d12.sqlite';
test('(11) mundo de ~230 habitantes con archivo de recetas: deshacer a mitad de paso y seguir como su gemelo',
  { timeout: 3_600_000, skip: existsSync(MUNDO_ALTO) ? false : `falta la instantánea ${MUNDO_ALTO}` }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-restauracion-alto-'));
    for (const sufijo of ['', '-wal', '-shm']) {
      if (existsSync(MUNDO_ALTO + sufijo)) copyFileSync(MUNDO_ALTO + sufijo, join(dir, 'world.sqlite' + sufijo));
    }
    const store = new Store(join(dir, 'world.sqlite'));
    try {
      const context = store.context, world = store.load()!.world;
      assert.ok(world.people.length > 200);
      let lecturas = 0;
      const resolve = store.catalogueReader.resolve;
      store.catalogueReader.resolve = (id, atTick) => { lecturas++; return resolve(id, atTick); };
      const control = cloneWorld(world, context);
      const fases = new ContadorDeFases(), medicion: FaseMedicion = { clock: fases.clock, fases: {} };
      const intentar = (alCerrar: Fase | null, esperado: RegExp): void => {
        const antes = digestoCanonico(world), tick = world.tick, punto = puntoDeRestauracion(world);
        lecturas = 0; fases.armar(alCerrar);
        try { assert.throws(() => stepWorld(world, [], context, medicion), esperado); } finally { fases.desarmar(); }
        punto.restaurar();
        assert.equal(world.tick, tick);
        assert.equal(digestoCanonico(world), antes);
      };
      // A mitad de personas, con parte de la gente ya movida…
      trampa(enMedio(world.people), 'x', () => fases.dentro('personas'), () => new Error('fallo inyectado en personas'));
      intentar(null, /fallo inyectado en personas/);
      // …y al cerrar `checkpoint`, con casi todo el paso hecho y las recetas archivadas ya leídas.
      intentar('checkpoint', /fallo inyectado al cerrar la fase/);
      assert.ok(lecturas > 0, 'el paso fallido tenía que haber leído recetas del archivo');
      for (let n = 1; n <= 5; n++) {
        stepWorld(world, [], context); stepWorld(control, [], context);
        assert.equal(digestoCanonico(world), digestoCanonico(control), `divergencia con el gemelo en el paso ${n}`);
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

/** Entre guardados un mismo objeto vive en el estado y en la cola que el Store confirmará; las leyes
 * escriben por un camino contando con que el otro lo ve. Cuenta, por id, los pares que siguen siendo
 * el mismo objeto (`compartidos`) y los que ya son dos objetos (`separados`). */
function comparticion(world: World): { compartidos: number; separados: number } {
  let compartidos = 0, separados = 0;
  const cruzar = (estado: readonly { id: string }[] | undefined, cola: readonly { id: string }[] | undefined): void => {
    if (!estado || !cola) return;
    const porId = new Map(estado.map(objeto => [objeto.id, objeto] as const));
    for (const objeto of cola) {
      const residente = porId.get(objeto.id);
      if (residente === objeto) compartidos++; else if (residente !== undefined) separados++;
    }
  };
  cruzar(world.events, world.chronicleJournal?.pending);
  cruzar(world.technology.history, world.technology.journal?.pending);
  cruzar(world.technology.recipes, world.technology.catalogue?.pending);
  return { compartidos, separados };
}

test('(12) receta de producción: deshacer entre guardados conserva lo compartido y el servidor sigue como su gemelo',
  { timeout: 1_800_000 }, async () => {
    await conRelojDeFases(async fases => {
      // Cadencia de producción (100): entre guardados las colas del Store acumulan lo que el estado
      // también referencia. Con la cadencia 1 de los defaults se vacían en cada paso y un punto
      // tomado al empezar el paso nunca las ve llenas.
      const receta = `,${PRODUCTION_PARAMS},gobernador.presupuestoMs=5000`;
      const gemelo = await harness(true, receta), punto = await harness(false, receta);
      try {
        const revocada = (donde: string) => () => new SessionRevoked(`sesión revocada ${donde}`);
        // 60 y 140: a mitad de personas y de fauna, lejos del guardado; 200: al confirmar el guardado del tick 200.
        const fallos: Record<number, () => () => boolean> = {
          60: () => {
            const t = trampa(enMedio(punto.app.world.people), 'x', () => fases.dentro('personas'), revocada('en personas'));
            return () => t.disparada;
          },
          140: () => {
            const t = trampa(enMedio(punto.app.world.animals), 'x', () => fases.dentro('fauna'), revocada('en fauna'));
            return () => t.disparada;
          },
          200: () => { const f = fallarAlConfirmar(punto.store, revocada('al confirmar')); return () => f.disparado; },
        };
        for (let n = 1; n <= 320; n++) {
          const inyectar = fallos[n];
          if (inyectar) {
            const antes = comparticion(punto.app.world);
            assert.ok(antes.compartidos > 0, `sin objetos compartidos antes del paso ${n}: la prueba no probaría nada`);
            assert.deepEqual(antes, comparticion(gemelo.app.world));
            const disparado = inyectar(), tick = punto.app.world.tick;
            fases.armar(); punto.app.stepOnce(); fases.desarmar();
            assert.equal(disparado(), true, `el fallo del paso ${n} no se disparó`);
            assert.equal(punto.app.failed, false, 'una sesión revocada no pausa el mundo');
            assert.equal(punto.app.world.tick, tick);
            assert.deepEqual(comparticion(punto.app.world), antes, `deshacer separó objetos compartidos en el paso ${n}`);
            assert.equal(digestoDelMundo(punto.app.world), digestoDelMundo(gemelo.app.world), `restauración inexacta en el paso ${n}`);
          }
          gemelo.app.stepOnce(); punto.app.stepOnce();
          if (n % 10 === 0) {
            assert.equal(digestoDelMundo(punto.app.world), digestoDelMundo(gemelo.app.world), `divergencia en el paso ${n}`);
          }
        }
        assert.equal(punto.app.failed, false);
        assert.equal(punto.app.world.tick, 320);
        assert.equal(digestoDelMundo(punto.store.load()!.world), digestoDelMundo(gemelo.store.load()!.world));
      } finally { fases.desarmar(); await gemelo.close(); await punto.close(); }
    });
  });
