import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { TIPOS, codigoForma } from '../src/shared/materia.js';
import { leyFauna } from '../src/world/ley-fauna.js';
import { ArenaLotes, LOTES_POR_BLOQUE } from '../src/world/materia/arena.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { ENERGIA, Parte, Rol, libroVacio, type Kappa } from '../src/world/materia/tipos.js';
import type { CtxLeyMateria } from '../src/world/motor/acceso.js';
import { aplicarCola, balanceAplicador, contarEnvioIntento } from '../src/world/motor/aplicar.js';
import { REF_NULA, TipoIntento, genDe, refDe, slotDe, type Buzon, type Intento } from '../src/world/motor/contratos.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { PageArena } from '../src/world/soa/arena.js';

function escenario() {
  const frente = {
    alta: 2, gen: Int32Array.of(1, 1), vivo: Uint8Array.of(1, 1), uid: Float64Array.of(1, 2),
    clase: Uint8Array.of(1, 1), x: Float32Array.of(0, 16), y: Float32Array.of(0, 0), dueno: Int32Array.of(0, 1),
  };
  const terreno = {
    celda: (x: number) => x < 16 ? 0 : 256,
    chunkDe: (celda: number) => Math.floor(celda / 256), duenoChunk: Int16Array.of(0, 1),
  };
  const lotes = new PageArena(LOTES_POR_BLOQUE), desborde = new PageArena(16), paginas = new PageArena(2);
  lotes.prepararF0(LOTES_POR_BLOQUE, LOTES_POR_BLOQUE);
  desborde.prepararF0(16);
  paginas.prepararF0(2);
  const quimica = crearServicioQuimico({ modo: 'inmediato' });
  const esp = quimica.internar(Uint16Array.of(TIPOS.findIndex(t => t.k === 1), 1));
  const colas: Intento[][] = [[], []];
  const kappaLeida: Kappa[] = [];
  const params = { ...DEFAULT_PARAMS, v23: escalon('intentos') };
  const duenos = colas.map((cola, hilo) => {
    const materia = new ArenaLotes({
      lotes, desborde, paginas, terreno, hilo, quimica, agua: esp,
      digerible: (_s, kappa) => { kappaLeida.push(kappa); return 1; },
    });
    const buzon: Buzon = {
      enviar(destino, intento) {
        colas[destino].push(intento);
        contarEnvioIntento(c);
      },
      vaciar(_cola, aplicar) {
        const lote = cola.splice(0);
        lote.forEach(aplicar);
        return lote.length;
      },
    };
    const ref = (uid: number) => frente.vivo[uid - 1] ? refDe(uid - 1, frente.gen[uid - 1]) : REF_NULA;
    const datos = {
      tick: 10, hilo, frente, terreno, materia, quimica, params, buzon, ref, libro: libroVacio(),
      personas: new Map(), mundo: { animals: [] },
    };
    const c = datos as unknown as CtxLeyMateria;
    return { c, materia, avanzar: () => { datos.tick++; } };
  });
  return { duenos, colas, frente, esp, kappaLeida, params };
}

const intento = (atributos: Partial<Intento>): Intento => ({
  tipo: TipoIntento.Dar, de: refDe(0, 1), a: refDe(1, 1), celda: 256, lote: REF_NULA, nonce: 42,
  dato: null, materia: null, bytes: null, ...atributos,
});

test('un Dar repetido se abona una vez incluso en los dos ticks siguientes', () => {
  const { duenos, esp } = escenario();
  const [emisor, receptor] = duenos;
  const origen = emisor.materia.nuevo(Rol.Reserva, -1, 0);
  const lote = receptor.materia.nuevo(Rol.Objeto, 256, 0);
  emisor.materia.fuente(origen, Float64Array.of(esp, 6, 0, 120), emisor.c.libro);
  const materia = emisor.materia.garantizar(origen, { parte: Parte.Todo, esp, cuantos: 0, kappa: null }, emisor.c.libro);
  const i = intento({ lote, materia });
  emisor.c.buzon.enviar(1, i);
  emisor.c.buzon.enviar(1, i);
  assert.equal(aplicarCola(receptor.c, 'A'), 1);
  assert.deepEqual(balanceAplicador(receptor.c), {
    enviados: 0, aplicados: 1, devueltos: 0, depositados: 0, reenviados: 0, duplicados: 1,
  });
  receptor.avanzar();
  receptor.avanzar();
  emisor.c.buzon.enviar(1, i);
  assert.equal(aplicarCola(receptor.c, 'B'), 0);
  assert.equal(balanceAplicador(emisor.c).enviados, 3);
  assert.equal(receptor.materia.cuantos(lote, esp), 6);
  assert.equal(receptor.materia.calor(lote), 120);
  assert.ok(emisor.c.libro.enVuelo.every((n, k) => n + receptor.c.libro.enVuelo[k] === 0));
});

test('el destinatario muerto deja la garantía en el Suelo de su última celda', () => {
  const { duenos, frente, colas, esp } = escenario();
  const [emisor, receptor] = duenos;
  frente.vivo[1] = 0;
  frente.gen[1] = 2;
  colas[0].push(intento({ celda: 0, materia: Float64Array.of(esp, 6, 0, 120) }));
  assert.equal(aplicarCola(emisor.c, 'B'), 0);
  assert.equal(balanceAplicador(emisor.c).reenviados, 1);
  const i = colas[1][0];
  assert.equal(i.tipo, TipoIntento.Depositar);
  assert.equal(i.celda, 256);
  assert.equal(i.a, REF_NULA);
  assert.equal(aplicarCola(receptor.c, 'A'), 1);
  const suelo = new Float64Array(1);
  assert.equal(receptor.materia.lotes(256, Rol.Suelo, suelo), 1);
  assert.equal(receptor.materia.cuantos(suelo[0], esp), 6);
  assert.equal(receptor.materia.calor(suelo[0]), 120);
  assert.equal(balanceAplicador(receptor.c).depositados, 1);
});

test('Tomar recorta el pedido, conserva los cuatro κ y contesta aunque el lote caduque', () => {
  const { duenos, colas, frente, esp, kappaLeida } = escenario();
  // Este escenario no tiene mundo ni contexto de dueño: el `Tomar` de una persona no debe pasar por la ley de la fauna (que sí
  // los necesita; su extracción se prueba en ola-f-fauna). Se la sustituye por una sin ganchos durante la prueba.
  const leyOriginal = leyFauna.aplicar;
  Object.assign(leyFauna, { aplicar: {} });
  try {
    const [emisor, receptor] = duenos;
    const origen = receptor.materia.nuevo(Rol.Vida, 256, 0), lote = emisor.materia.nuevo(Rol.Reserva, -1, 0);
    receptor.materia.fuente(origen, Float64Array.of(esp, 2, 0, 60), receptor.c.libro);
    const pedir = intento({ tipo: TipoIntento.Tomar, lote: origen, dato: Float64Array.of(Rol.Vida, Parte.Digerible, esp, 4, lote, 4, 3, 2, 1) });
    colas[1].push(pedir, pedir);
    assert.equal(aplicarCola(receptor.c, 'A'), 1);
    assert.deepEqual(kappaLeida, [[4, 3, 2, 1]]);
    assert.equal(colas[0].length, 1);
    assert.equal(colas[0][0].tipo, TipoIntento.Concedido);
    assert.equal(colas[0][0].nonce, pedir.nonce);
    assert.equal(colas[0][0].a, pedir.de);
    assert.deepEqual(colas[0][0].materia, Float64Array.of(esp, 2, 0, 60));
    assert.equal(aplicarCola(emisor.c, 'B'), 1);
    assert.equal(emisor.materia.cuantos(lote, esp), 2);
    assert.equal(emisor.materia.calor(lote), 60);
    assert.ok(emisor.c.libro.enVuelo.every((n, k) => n + receptor.c.libro.enVuelo[k] === 0));

    receptor.materia.liberar(origen);
    frente.gen[1] = genDe(pedir.a) + 1;
    colas[1].push({ ...pedir, nonce: 43, a: refDe(slotDe(pedir.a), frente.gen[1]) });
    aplicarCola(receptor.c, 'A');
    assert.equal(colas[0][0].tipo, TipoIntento.Concedido);
    assert.equal(colas[0][0].materia?.length, 0);
  } finally {
    Object.assign(leyFauna, { aplicar: leyOriginal });
  }
});

test('un rechazo de la ley destino devuelve lo debitado y un Tomar rechazado vuelve vacío', () => {
  const { duenos, colas } = escenario();
  const [emisor, receptor] = duenos;
  const leyOriginal = leyFauna.aplicar;
  Object.assign(leyFauna, { aplicar: { Dar: () => 'rechazo', Tomar: () => 'rechazo' } });
  try {
    const dar = intento({ materia: Float64Array.of(0, 75) });
    const pedir = intento({ tipo: TipoIntento.Tomar, dato: Float64Array.of(Rol.Vida, Parte.Todo, 0, 0, REF_NULA) });
    colas[1].push(dar, pedir);
    assert.equal(aplicarCola(receptor.c, 'A'), 0);
    assert.equal(balanceAplicador(receptor.c).devueltos, 2);
    assert.deepEqual(colas[0].map(i => [i.tipo, i.a, i.nonce, i.materia?.length]), [
      [TipoIntento.Devuelto, dar.de, dar.nonce, 2],
      [TipoIntento.Concedido, pedir.de, pedir.nonce, 0],
    ]);
    assert.equal(aplicarCola(emisor.c, 'B'), 2);
    assert.equal(emisor.c.libro.enVuelo[ENERGIA], -75);
  } finally {
    Object.assign(leyFauna, { aplicar: leyOriginal });
  }
});

test('el envío que cambia de dueño conserva el tipo y el nonce, y se abona una vez', () => {
  const { duenos, colas, params } = escenario();
  params.v23.intentos = false;
  const [anterior, actual] = duenos, lote = actual.materia.nuevo(Rol.Objeto, 256, 0);
  const dar = intento({ lote, materia: Float64Array.of(0, 10) });
  colas[0].push(dar, dar);
  assert.equal(aplicarCola(anterior.c, 'B'), 0);
  assert.equal(colas[0].length, 2);

  params.v23.intentos = true;
  assert.equal(aplicarCola(anterior.c, 'B'), 0);
  assert.deepEqual(colas[1], [dar]);
  assert.equal(balanceAplicador(anterior.c).duplicados, 1);
  assert.equal(aplicarCola(actual.c, 'A'), 1);
  assert.equal(actual.materia.calor(lote), 10);
});

test('crea un lote con la forma solicitada y una entrega a un lote caducado va al Suelo', () => {
  const { duenos, colas } = escenario();
  const receptor = duenos[1];
  const sinForma = receptor.materia.nuevo(Rol.Objeto, 256, 0);
  const forma = codigoForma({ largo: 0.5, ancho: 0.5, grueso: 0.1, hueco: 0, filo: 0 });
  const caduco = receptor.materia.nuevo(Rol.Objeto, 256, 0);
  receptor.materia.liberar(caduco);
  colas[1].push(
    intento({ tipo: TipoIntento.Depositar, a: REF_NULA, dato: Float64Array.of(Rol.Objeto, forma), materia: Float64Array.of(0, 33) }),
    intento({ nonce: 43, lote: caduco, materia: Float64Array.of(0, 59) }),
  );
  assert.equal(aplicarCola(receptor.c, 'A'), 2);
  const lotes = new Float64Array(2);
  assert.equal(receptor.materia.lotes(256, Rol.Objeto, lotes), 2);
  const formado = lotes.find(l => l !== sinForma)!;
  assert.equal(receptor.materia.vista(formado).forma, forma);
  assert.equal(receptor.materia.calor(formado), 33);
  assert.equal(receptor.materia.calor(sinForma), 0);
  assert.equal(receptor.materia.lotes(256, Rol.Suelo, lotes), 1);
  assert.equal(receptor.materia.calor(lotes[0]), 59);
});
