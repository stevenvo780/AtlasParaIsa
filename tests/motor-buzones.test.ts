import assert from 'node:assert/strict';
import test from 'node:test';
import { loadavg } from 'node:os';
import { Buzones, conectarBuzon, type FaseMotor } from '../src/world/motor/buzon.js';
import { ORDEN, TipoIntento, type Buzon, type Cola, type Intento } from '../src/world/motor/contratos.js';
import { ErrorFatalMotor } from '../src/world/paralelo/barrera.js';
import { Piscina } from '../src/world/paralelo/piscina.js';
import { ENVIOS, ERR, crear, mensaje, mismoMensaje, type DatosBuzones } from './lib/motor-hilos.js';

const MODULO = new URL('./lib/motor-hilos.ts', import.meta.url);

function semilla(n: number): () => number {
  let s = n >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
}

const FASE_DE_VACIADO: Record<Cola, FaseMotor> = { F0: 0, M: 1, B: 1, A: 5, C: 6 };

function vaciarEnSuFase(buzones: Buzones, buzon: Buzon, cola: Cola): Intento[] {
  buzones.fijarFase(FASE_DE_VACIADO[cola]);
  const vistos: Intento[] = [];
  buzon.vaciar(cola, i => vistos.push({ ...i, materia: i.materia && i.materia.slice(), dato: i.dato && i.dato.slice(), bytes: i.bytes && i.bytes.slice() }));
  return vistos;
}

// Con un hilo los buzones son locales; con varios, viven en memoria compartida. Las mismas reglas valen en ambos.
for (const hilos of [1, 2]) {
  const modo = hilos === 1 ? 'un hilo (local)' : 'memoria compartida';

  test(`${modo}: enruta por tipo y por fase como fija el contrato`, () => {
    const buzones = new Buzones(hilos), buzon = buzones.dueno(0, semilla(1));
    assert.equal(buzones.memoria === null, hilos === 1);
    const tipos = Object.values(TipoIntento);
    let seq = 0;
    const esperado: Record<Cola, number[]> = { F0: [], M: [], A: [], B: [], C: [] };
    for (let fase = 0 as FaseMotor; fase <= 6; fase = fase + 1 as FaseMotor) {
      buzones.fijarFase(fase);
      for (const tipo of tipos) {
        const cola: Cola = tipo === TipoIntento.Migrante ? 'M'
          : tipo === TipoIntento.Activar || tipo === TipoIntento.Global ? 'F0'
            : tipo === TipoIntento.Admitido ? 'C' : fase >= 1 && fase <= 4 ? 'A' : 'B';
        esperado[cola].push(seq);
        buzon.enviar(0, { ...mensaje(0, 0, seq++), tipo });
      }
    }
    for (const cola of ['F0', 'M', 'A', 'B', 'C'] as const) {
      const recibidos = vaciarEnSuFase(buzones, buzon, cola).map(i => i.a).sort((x, y) => x - y);
      assert.deepEqual(recibidos, esperado[cola], `cola ${cola}`);
    }
  });

  test(`${modo}: cada cola se vacía solo en su fase, por su dueño y sin reentrar`, () => {
    const buzones = new Buzones(hilos), buzon = buzones.dueno(0, semilla(2));
    for (const [cola, fase] of Object.entries(FASE_DE_VACIADO) as [Cola, FaseMotor][]) {
      for (let otra = 0 as FaseMotor; otra <= 6; otra = otra + 1 as FaseMotor) {
        if (otra === fase) continue;
        buzones.fijarFase(otra);
        assert.throws(() => buzon.vaciar(cola, () => {}), /inválido/, `${cola} en F${otra}`);
      }
    }
    if (buzones.memoria) {
      buzones.fijarFase(0);
      assert.throws(() => conectarBuzon(buzones.memoria!, 1, semilla(3)).vaciar('F0', () => {}), /inválido/);
    }
    buzones.fijarFase(2);
    buzon.enviar(0, mensaje(0, 2, 1));
    buzones.fijarFase(5);
    assert.throws(() => buzon.vaciar('A', () => buzon.vaciar('A', () => {})), ErrorFatalMotor);
    assert.throws(() => buzon.enviar(0, mensaje(0, 2, 2)), /abortado/, 'un buzón que falló no se reutiliza');
  });

  test(`${modo}: A y B se barajan con el azar del dueño, M y F0 conservan el orden; enviar copia los arrays`, () => {
    const orden = (s: number) => {
      const buzones = new Buzones(hilos), buzon = buzones.dueno(0, semilla(s));
      buzones.fijarFase(2);
      for (let seq = 0; seq < 64; seq++) {
        const i = mensaje(0, 2, seq);
        buzon.enviar(0, i);
        i.materia?.fill(NaN); i.dato?.fill(NaN); i.bytes?.fill(0);
      }
      buzones.fijarFase(0);
      for (let seq = 0; seq < 64; seq++) buzon.enviar(0, mensaje(0, 0, seq));
      buzones.fijarFase(3);
      for (let seq = 0; seq < 64; seq++) buzon.enviar(0, mensaje(0, 1, seq));
      const a = vaciarEnSuFase(buzones, buzon, 'A');
      for (const i of a) assert.ok(mismoMensaje(i, mensaje(0, 2, i.a)), 'el contenido llega intacto aunque el emisor reutilizó sus arrays');
      assert.deepEqual(vaciarEnSuFase(buzones, buzon, 'F0').map(i => i.a), [...Array(64).keys()]);
      assert.deepEqual(vaciarEnSuFase(buzones, buzon, 'M').map(i => i.a), [...Array(64).keys()]);
      return a.map(i => i.a);
    };
    const primera = orden(7);
    assert.deepEqual([...primera].sort((x, y) => x - y), [...Array(64).keys()]);
    assert.notDeepEqual(primera, [...Array(64).keys()], 'A se entrega barajada');
    assert.deepEqual(orden(7), primera, 'con la misma semilla, el mismo orden');
    assert.notDeepEqual(orden(8), primera);
  });
}

test('B publica el directorio antes de vincular sin cambiar el azar ni el orden del resto', () => {
  const recoger = (directorio: boolean, sorteo: number) => {
    const buzones = new Buzones(2), emisor = buzones.dueno(0, () => 0);
    let sorteos = 0;
    const receptor = buzones.dueno(1, () => { sorteos++; return sorteo; });
    const enviar = (secuencia: number, orden: number = ORDEN.detalle) => {
      emisor.enviar(1, { ...mensaje(0, 0, secuencia), tipo: TipoIntento.Gesto,
        materia: null, dato: Float64Array.of(orden) });
    };
    buzones.fijarFase(5);
    emisor.enviar(1, { ...mensaje(0, 0, 10), tipo: TipoIntento.Vincular });
    enviar(20);
    buzones.fijarFase(0);
    enviar(30, directorio ? ORDEN.directorio : ORDEN.detalle);
    enviar(40);
    return { orden: vaciarEnSuFase(buzones, receptor, 'B').map(i => i.a), sorteos };
  };
  for (const sorteo of [0.99, 0]) {
    const referencia = recoger(false, sorteo);
    assert.deepEqual(referencia.orden, sorteo === 0 ? [20, 30, 40, 10] : [10, 20, 30, 40]);
    assert.equal(referencia.sorteos, 3);
    assert.deepEqual(recoger(true, sorteo), { orden: [30, ...referencia.orden.filter(a => a !== 30)], sorteos: 3 });
  }
});

test('con memoria compartida, los arrays entregados son vistas que solo valen durante la llamada y el espacio se recicla', () => {
  const buzones = new Buzones(2), buzon = buzones.dueno(0, semilla(4));
  const cola = buzones.memoria!.duenos[0]!.A;
  for (let ronda = 0; ronda < 3; ronda++) {
    buzones.fijarFase(2);
    for (let seq = 0; seq < 1000; seq++) buzon.enviar(0, mensaje(1, 2, seq));
    buzones.fijarFase(5);
    let n = 0;
    assert.equal(buzon.vaciar('A', i => { n++; assert.ok(mismoMensaje(i, mensaje(1, 2, i.a))); }), 1000);
    assert.equal(n, 1000);
    assert.deepEqual([...cola.cursores], [0n, 0n], 'una cola vaciada sin envíos en curso vuelve a empezar');
  }
});

test('el tope de cola lo fija el anfitrión: pasarlo es fatal y varias piscinas de 28 hilos caben en las direcciones', () => {
  const buzones = new Buzones(2, 4096), buzon = buzones.dueno(0, semilla(5));
  buzones.fijarFase(2);
  assert.throws(() => { for (let seq = 0; seq < 1000; seq++) buzon.enviar(1, mensaje(0, 2, seq)); }, ErrorFatalMotor);
  // Cada cola reserva su tope en direcciones virtuales; con el tope de memoria física (125 GiB) la undécima fallaba.
  const muchas = Array.from({ length: 12 }, () => new Buzones(28));
  assert.equal(muchas.length, 12);
});

test('28 productores, un millón de mensajes por cola: sin pérdida, duplicado ni alteración, vaciando F0 y M mientras se envía',
  { timeout: 900_000 }, async () => {
    const hilos = 28, ticks = 5, porTick = Math.ceil(1_000_000 / hilos / ticks);
    const buzones = new Buzones(hilos);
    const datos: DatosBuzones = {
      prueba: 'buzones', memoria: buzones.memoria!, hilos, porTick, ticks,
      hechos: new Int32Array(new SharedArrayBuffer(8)), errores: new Int32Array(new SharedArrayBuffer(32)),
    };
    const piscina = new Piscina({ hilos, datos, crear, moduleURL: MODULO, exportName: 'crear' });
    const inicio = performance.now();
    try {
      // Los ticks completos y un tick más (F0 y F1) que solo vacía lo que quedó en vuelo.
      for (let tick = 0; tick <= ticks; tick++) {
        for (let fase = 0 as FaseMotor; fase <= (tick === ticks ? 1 : 6); fase = fase + 1 as FaseMotor) {
          buzones.fijarFase(fase);
          piscina.ejecutar(fase);
        }
      }
    } finally {
      await piscina.cerrar();
    }
    const total = ENVIOS.length * hilos * porTick * ticks;
    const e = datos.errores;
    console.log(`# buzones: ${total} mensajes de ${hilos} productores en ${((performance.now() - inicio) / 1000).toFixed(1)} s, carga ${loadavg()[0]!.toFixed(0)}`);
    assert.equal(e[ERR.recibidos], total);
    assert.equal(e[ERR.perdidos], 0, 'perdidos');
    assert.equal(e[ERR.duplicados], 0, 'duplicados');
    assert.equal(e[ERR.alterados], 0, 'alterados');
    assert.equal(e[ERR.desordenados], 0, 'F0 y M conservan el orden de cada emisor');
  });
