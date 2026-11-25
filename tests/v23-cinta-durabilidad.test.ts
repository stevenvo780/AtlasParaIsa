import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CatalogoCinta, INDICE_CINTA, NIVELES, rutaSegmento, type PuntoEscritura } from '../src/server/cinta/catalogo.js';
import { codificarBloque, verificarBloque } from '../src/server/cinta/formato.js';
import { podar } from '../src/server/cinta/poda.js';
import { CINTA, type Nivel } from '../src/shared/cinta.js';
import type { WorldView } from '../src/shared/types.js';

const RAIZ = '/tmp/atlas-v23-c1a';
const TOPE_PODA = 1_000_000;
type Operacion = 'anexar' | 'nuevo' | 'podar';

function bloque(tick: number, nivel: Nivel = 0): Buffer {
  const vista: WorldView = { version: 10, sequence: tick, tick, day: 1, phase: 'day', weather: 'clear',
    width: 1, height: 1, tiles: [{ x: 0, y: 0, terrain: 'meadow', moisture: 0.5, food: 0.4, vegetation: 0.6 }],
    people: [], events: [], memories: [], places: [] };
  return codificarBloque(nivel, vista, []);
}

function ejecutarHijo(directorio: string, operacion: Operacion, punto: PuntoEscritura): void {
  const catalogo = new CatalogoCinta(directorio, actual => {
    if (actual !== punto) return;
    // La llamada síncrona publica el punto exacto aun con el hilo bloqueado después.
    writeSync(1, actual + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  try {
    const ultimo = catalogo.segmentos().filter(s => s.nivel === 0).at(-1)!;
    const epoca = catalogo.ultimaEpoca()!.id;
    switch (operacion) {
      case 'anexar': catalogo.escribirBloque(epoca, bloque(8), ultimo); break;
      case 'nuevo': catalogo.escribirBloque(epoca, bloque(8, 2), undefined); break;
      case 'podar': podar(catalogo, TOPE_PODA, 0, Math.floor(TOPE_PODA * CINTA.cuotas[0]) - ultimo.bytes); break;
    }
  } finally { catalogo.db.close(); }
  throw new Error(`El hijo terminó sin detenerse en «${punto}».`);
}

async function matarEn(directorio: string, operacion: Operacion, punto: PuntoEscritura): Promise<void> {
  const hijo = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
    '--hijo', directorio, operacion, punto], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cierre = once(hijo, 'close');
  let salida = '', errores = '', alcanzo = false;
  const vigilancia = setTimeout(() => hijo.kill('SIGKILL'), 30_000);
  hijo.stderr.setEncoding('utf8').on('data', (trozo: string) => { errores += trozo; });
  hijo.stdout.setEncoding('utf8').on('data', (trozo: string) => {
    salida += trozo;
    if (!alcanzo && salida === punto + '\n') {
      alcanzo = true;
      hijo.kill('SIGKILL');
    }
  });
  try {
    const [codigo, senal] = await cierre;
    assert.equal(alcanzo, true, `El hijo no llegó a «${punto}»: ${salida}\n${errores}`);
    assert.equal(codigo, null);
    assert.equal(senal, 'SIGKILL');
  } finally {
    clearTimeout(vigilancia);
  }
}

function temporal(t: TestContext): string {
  mkdirSync(RAIZ, { recursive: true });
  const dir = mkdtempSync(join(RAIZ, 'durabilidad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Confirmado { datos: Buffer; fotogramas: Buffer[] }

function sembrar(dir: string, separados = false): Map<string, Confirmado> {
  const catalogo = new CatalogoCinta(dir);
  try {
    const epoca = catalogo.abrir({ instanciaId: 'durabilidad', epoca: 0, tMundo: 0, motivo: 'reinicio' });
    const inicial = bloque(0), siguiente = bloque(4);
    catalogo.escribirBloque(epoca, inicial, undefined);
    catalogo.escribirBloque(epoca, siguiente, separados ? undefined : catalogo.segmentos()[0]);
    if (separados) {
      const otroNivel = bloque(0, 2);
      catalogo.escribirBloque(epoca, otroNivel, undefined);
      return new Map([
        [rutaSegmento(dir, 0, 1), { datos: inicial, fotogramas: [inicial] }],
        [rutaSegmento(dir, 0, 2), { datos: siguiente, fotogramas: [siguiente] }],
        [rutaSegmento(dir, 2, 3), { datos: otroNivel, fotogramas: [otroNivel] }],
      ]);
    }
    return new Map([[rutaSegmento(dir, 0, 1), { datos: Buffer.concat([inicial, siguiente]), fotogramas: [inicial, siguiente] }]]);
  } finally { catalogo.db.close(); }
}

function recuperar(dir: string, confirmados: Map<string, Confirmado>): void {
  const catalogo = new CatalogoCinta(dir);
  try {
    assert.deepEqual(catalogo.db.prepare('PRAGMA quick_check').all().map(f => f.quick_check), ['ok']);
    assert.deepEqual(catalogo.db.prepare('PRAGMA foreign_key_check').all(), []);
    const referenciados = catalogo.segmentos().map(s => rutaSegmento(dir, s.nivel, s.id));
    const enDisco = NIVELES.flatMap(nivel => readdirSync(join(dir, `n${nivel}`)).map(nombre => join(dir, `n${nivel}`, nombre)));
    assert.deepEqual(referenciados.sort(), [...confirmados.keys()].sort());
    assert.deepEqual(enDisco.sort(), referenciados);
    const consultar = catalogo.db.prepare('SELECT offset,bytes,crc,t0,t1 FROM bloques WHERE segmento=? ORDER BY offset');
    for (const segmento of catalogo.segmentos()) {
      const path = rutaSegmento(dir, segmento.nivel, segmento.id);
      const esperado = confirmados.get(path)!;
      const datos = readFileSync(path);
      assert.deepEqual(datos, esperado.datos);
      assert.equal(segmento.bytes, datos.length);
      const filas = consultar.all(segmento.id);
      assert.equal(filas.length, esperado.fotogramas.length);
      let offset = 0;
      for (const [i, anterior] of esperado.fotogramas.entries()) {
        const fila = filas[i]!;
        const meta = verificarBloque(anterior);
        assert.deepEqual({ ...fila }, { offset, bytes: anterior.length, crc: meta.crc, t0: meta.t0, t1: meta.t1 });
        assert.deepEqual(verificarBloque(datos.subarray(offset, offset + anterior.length)), meta);
        offset += anterior.length;
      }
      assert.equal(offset, datos.length);
    }
  } finally { catalogo.db.close(); }
}

if (process.argv[2] === '--hijo') {
  ejecutarHijo(process.argv[3], process.argv[4] as Operacion, process.argv[5] as PuntoEscritura);
} else {
  test('I6: cien SIGKILL reales a mitad de bloque conservan cada byte y CRC confirmado', async t => {
    const dir = temporal(t), confirmados = sembrar(dir);
    const [archivo, previo] = [...confirmados][0];
    const bytesEsperados = previo.datos.length + Math.floor(bloque(8).length / 2);
    for (let i = 0; i < 100; i++) {
      await matarEn(dir, 'anexar', 'mitad de bloque');
      assert.equal(statSync(archivo).size, bytesEsperados, `cola parcial de la caída ${i + 1}`);
      recuperar(dir, confirmados);
    }
  });

  test('I6: el catálogo descarta la cola y el segmento sincronizados sin commit', async t => {
    const dir = temporal(t), confirmados = sembrar(dir);
    const [archivo, previo] = [...confirmados][0];
    await matarEn(dir, 'anexar', 'bloque sincronizado');
    assert.equal(statSync(archivo).size, previo.datos.length + bloque(8).length);
    recuperar(dir, confirmados);
    const huerfano = rutaSegmento(dir, 2, 2);
    await matarEn(dir, 'nuevo', 'bloque sincronizado');
    assert.deepEqual(readFileSync(huerfano), bloque(8, 2));
    recuperar(dir, confirmados);
    assert.equal(existsSync(huerfano), false);
  });

  test('I6: el reinicio termina una poda interrumpida tras confirmar el catálogo', async t => {
    const dir = temporal(t), confirmados = sembrar(dir, true);
    const viejo = rutaSegmento(dir, 0, 1);
    await matarEn(dir, 'podar', 'catálogo podado');
    assert.equal(existsSync(viejo), true);
    const db = new DatabaseSync(join(dir, INDICE_CINTA), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT id FROM segmentos WHERE id=1').get(), undefined);
      assert.equal(db.prepare('SELECT t0 FROM bloques WHERE segmento=1').get(), undefined);
    } finally { db.close(); }
    confirmados.delete(viejo);
    recuperar(dir, confirmados);
    assert.equal(existsSync(viejo), false);
  });

  test('con el disco casi lleno la poda conserva la reserva del mundo y el último bloque de cada nivel', t => {
    const dir = temporal(t);
    // Un disco de 24 MiB sobre los ficheros reales del directorio: /tmp lo comparten otros procesos.
    const capacidad = 24 * 1024 ** 2, reservaDisco = 4 * 1024 ** 2;
    const usado = () => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
      .reduce((suma, e) => suma + statSync(join(e.parentPath, e.name)).size, 0);
    const holguras = { margen: 64 * 1024, reservaDisco, libre: () => capacidad - usado() };
    const relleno = randomBytes(768 * 1024).toString('base64');
    const catalogo = new CatalogoCinta(dir);
    try {
      const epoca = catalogo.abrir({ instanciaId: 'disco', epoca: 0, tMundo: 0, motivo: 'reinicio' });
      const ultimos = new Map<Nivel, number>();
      for (let i = 0; i < 60; i++) {
        const nivel = (i % 5) as Nivel, tick = Math.floor(i / 5) * CINTA.pasos[nivel];
        const vista: WorldView = { version: 10, sequence: tick, tick, day: 1, phase: 'day', weather: 'clear', width: 1, height: 1,
          tiles: [], people: [], events: [], memories: [], places: [], pauseReason: relleno + i };
        const datos = codificarBloque(nivel, vista, []);
        // Con un tope enorme solo el disco obliga a podar.
        podar(catalogo, 1e15, nivel, datos.length, holguras);
        catalogo.escribirBloque(epoca, datos, undefined);
        ultimos.set(nivel, tick);
        assert.ok(capacidad - usado() >= reservaDisco, `bloque ${i}: la cinta invadió la reserva del disco`);
        for (const [n, t0] of ultimos) {
          assert.ok(catalogo.db.prepare('SELECT 1 FROM bloques WHERE nivel=? AND t0=?').get(n, t0), `bloque ${i}: falta el último de L${n}`);
        }
      }
      assert.ok(catalogo.segmentos().length < 60, 'hubo poda por disco');
      assert.throws(() => podar(catalogo, 1e15, 0, capacidad, holguras), /el disco/);
    } finally { catalogo.db.close(); }
  });

  test('I6: abrir rechaza CRC inválido o truncado en un bloque confirmado', async t => {
    await t.test('CRC inválido', sub => {
      const dir = temporal(sub), confirmados = sembrar(dir);
      const [archivo, previo] = [...confirmados][0];
      const alterado = Buffer.from(previo.datos);
      alterado[alterado.length - 1] ^= 0x80;
      writeFileSync(archivo, alterado);
      assert.throws(() => new CatalogoCinta(dir), /CRC32 CNT2 inválido/);
      assert.deepEqual(readFileSync(archivo), alterado);
    });
    await t.test('solo se relee el segmento que admite anexos; de los sellados basta su tamaño', sub => {
      const dir = temporal(sub), confirmados = sembrar(dir, true);
      const sellado = rutaSegmento(dir, 0, 1), abierto = rutaSegmento(dir, 0, 2);
      const alterado = Buffer.from(confirmados.get(sellado)!.datos);
      alterado[alterado.length - 1] ^= 0x80;
      writeFileSync(sellado, alterado);
      new CatalogoCinta(dir).db.close();
      truncateSync(sellado, alterado.length - 1);
      assert.throws(() => new CatalogoCinta(dir), /Segmento confirmado truncado/);
      writeFileSync(sellado, confirmados.get(sellado)!.datos);
      const ultimo = Buffer.from(confirmados.get(abierto)!.datos);
      ultimo[ultimo.length - 1] ^= 0x80;
      writeFileSync(abierto, ultimo);
      assert.throws(() => new CatalogoCinta(dir), /CRC32 CNT2 inválido/);
    });
    await t.test('truncado', sub => {
      const dir = temporal(sub), confirmados = sembrar(dir);
      const [archivo, previo] = [...confirmados][0];
      truncateSync(archivo, previo.datos.length - 1);
      assert.throws(() => new CatalogoCinta(dir), /Segmento confirmado truncado/);
      assert.equal(statSync(archivo).size, previo.datos.length - 1);
    });
  });
}
