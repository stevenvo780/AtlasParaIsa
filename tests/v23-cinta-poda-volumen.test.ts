import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { crc32, gzipSync } from 'node:zlib';
import { CatalogoCinta, MAX_SEGMENTO, NIVELES, rutaSegmento, type BloqueCinta } from '../src/server/cinta/catalogo.js';
import { codificarBloque, decodificarBloque, verificarBloque } from '../src/server/cinta/formato.js';
import { podar } from '../src/server/cinta/poda.js';
import { CINTA, type Nivel } from '../src/shared/cinta.js';
import type { WorldView } from '../src/shared/types.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';

const TOPE = 2e9;
const VOLUMEN = 10e9;
const MARGEN = 16 * 1024 ** 2;
const CABECERA = 33;
const CRC = 25;
const LONGITUD_KF = 29;
const ARCHIVO = resolve(import.meta.dirname, '../../../archivo/tmp-v23-c1a');

function vista(tick: number): WorldView {
  return { version: 10, sequence: tick, tick, day: Math.floor(tick / TICKS_PER_DAY), phase: 'day', weather: 'clear',
    width: 1, height: 1, tiles: [], people: [], places: [], events: [], memories: [], paused: true };
}

/** Un gzip con varios miembros permite cambiar el tick sin volver a comprimir el relleno aleatorio. */
function volumenSintetico() {
  const ruido = randomBytes(41 * 1024 ** 2).toString('base64');
  const resto = Buffer.concat([gzipSync(ruido, { level: 0 }), gzipSync('"}')]);
  const bufer = Buffer.allocUnsafe(MAX_SEGMENTO);
  function bloque(nivel: Nivel, tick: number): Buffer {
    const frame = vista(tick);
    const plantilla = codificarBloque(nivel, frame, []);
    const prefijo = gzipSync(JSON.stringify(frame).slice(0, -1) + ',"pauseReason":"');
    const largo = CABECERA + prefijo.length + resto.length;
    assert.ok(largo < bufer.length);
    plantilla.copy(bufer, 0, 0, CABECERA);
    prefijo.copy(bufer, CABECERA);
    resto.copy(bufer, CABECERA + prefijo.length);
    const datos = bufer.subarray(0, largo);
    datos.writeUInt32LE(prefijo.length + resto.length, LONGITUD_KF);
    datos.writeUInt32LE(crc32(datos.subarray(LONGITUD_KF), crc32(datos.subarray(0, CRC))), CRC);
    return datos;
  }
  const muestra = decodificarBloque(bloque(0, 0));
  assert.ok(muestra.baseFrame.pauseReason === ruido);
  return bloque;
}

function usoReal(path: string): { logicos: number; asignados: number } {
  let logicos = 0, asignados = 0;
  for (const entrada of readdirSync(path, { withFileTypes: true, recursive: true })) {
    if (!entrada.isFile()) continue;
    const info = statSync(join(entrada.parentPath, entrada.name));
    logicos += info.size;
    asignados += info.blocks * 512;
  }
  return { logicos, asignados };
}

function leer(ruta: string, bufer: Buffer, offset: number): void {
  const fd = openSync(ruta, 'r');
  try {
    for (let leido = 0; leido < bufer.length;) {
      const bytes = readSync(fd, bufer, leido, bufer.length - leido, offset + leido);
      assert.ok(bytes > 0, `Bloque truncado en ${ruta}`);
      leido += bytes;
    }
  } finally { closeSync(fd); }
}

test('I4: poda en disco real tras escribir 10 GB con tope estricto de 2 GB', {
  skip: process.env.ATLAS_V23_CINTA_VOLUMEN !== '1',
}, t => {
  mkdirSync(ARCHIVO, { recursive: true });
  const directorio = mkdtempSync(join(ARCHIVO, 'poda-volumen-'));
  t.after(() => rmSync(directorio, { recursive: true, force: true }));
  const bloque = volumenSintetico();
  const confirmados = new Map<Nivel, BloqueCinta>();
  const lectura = Buffer.allocUnsafe(MAX_SEGMENTO);
  let picoLogico = 0, picoAsignado = 0, escritos = 0, bloques = 0, podas = 0, podasEntreNiveles = 0;
  let nivelEntrada: Nivel;
  let catalogo = new CatalogoCinta(directorio, punto => {
    medir();
    comprobarUltimos();
    if (punto === 'catálogo podado') {
      podas++;
      const segmentos = new Set(catalogo.segmentos().map(s => s.id));
      if (NIVELES.some(nivel => nivel !== nivelEntrada && readdirSync(join(directorio, `n${nivel}`))
        .some(file => !segmentos.has(Number(/^seg-(\d+)\.cnt$/.exec(file)?.[1]))))) podasEntreNiveles++;
    }
  });
  const epoca = catalogo.abrir({ instanciaId: 'volumen-poda', epoca: 0, tMundo: 0, motivo: 'reinicio' });
  function medir() {
    const uso = usoReal(directorio);
    picoLogico = Math.max(picoLogico, uso.logicos);
    picoAsignado = Math.max(picoAsignado, uso.asignados);
    assert.ok(uso.logicos <= TOPE, `Tamaño lógico: ${uso.logicos} bytes`);
    assert.ok(uso.asignados <= TOPE, `Tamaño asignado: ${uso.asignados} bytes`);
  }
  function ultimo(nivel: Nivel): BloqueCinta | undefined {
    return catalogo.db.prepare('SELECT * FROM bloques WHERE nivel=? ORDER BY epoca DESC,t1 DESC LIMIT 1')
      .get(nivel) as unknown as BloqueCinta | undefined;
  }
  function comprobarUltimos() {
    for (const [nivel, esperado] of confirmados) {
      assert.deepEqual(ultimo(nivel), esperado);
      const ruta = rutaSegmento(directorio, nivel, esperado.segmento);
      assert.ok(statSync(ruta).size >= esperado.offset + esperado.bytes);
      const cabecera = lectura.subarray(0, CABECERA);
      leer(ruta, cabecera, esperado.offset);
      assert.equal(cabecera.readDoubleLE(9), esperado.t0);
      assert.equal(cabecera.readUInt32LE(CRC), esperado.crc);
    }
  }
  function agregar(nivel: Nivel, tick: number) {
    nivelEntrada = nivel;
    const data = bloque(nivel, tick);
    const meta = verificarBloque(data);
    comprobarUltimos();
    podar(catalogo, TOPE, nivel, data.length, MARGEN);
    catalogo.escribirBloque(epoca, data, undefined);
    const recienConfirmado = ultimo(nivel)!;
    const ruta = rutaSegmento(directorio, nivel, recienConfirmado.segmento);
    const bytes = lectura.subarray(0, recienConfirmado.bytes);
    leer(ruta, bytes, recienConfirmado.offset);
    assert.deepEqual(verificarBloque(bytes), meta);
    assert.ok(statSync(ruta).blocks * 512 >= data.length, 'El segmento entero ocupa disco.');
    confirmados.set(nivel, recienConfirmado);
    escritos += data.length;
    bloques++;
    medir();
    comprobarUltimos();
  }
  try {
    for (const nivel of NIVELES) agregar(nivel, 0);
    catalogo.db.prepare('INSERT INTO marcadores VALUES (?,?,NULL,?,?,?,?)').run('volumen', Date.now(), epoca, 0, 0, 1);
    // El marcador mantiene L0 sobre su cuota y obliga a la poda global a desalojar otros niveles.
    for (let i = 1; i <= 20; i++) agregar(0, i * CINTA.pasos[0]);
    for (let i = 1; escritos < VOLUMEN; i++) for (const nivel of NIVELES) {
      agregar(nivel, i * CINTA.pasos[nivel] + (nivel === 0 ? 40_000 : 0));
    }
    assert.ok(podas > 0);
    assert.ok(podasEntreNiveles > 0, 'Hubo poda global además de la cuota de cada nivel.');
    assert.equal(confirmados.size, 5);
  } finally { catalogo.db.close(); }
  catalogo = new CatalogoCinta(directorio);
  try {
    comprobarUltimos();
    medir();
    const segmentos = catalogo.segmentos();
    const fijados = segmentos.filter(s => s.nivel === 0 && s.t0 <= 14 * TICKS_PER_DAY);
    assert.deepEqual(fijados.map(s => s.t0), Array.from({ length: 21 }, (_, i) => i * CINTA.pasos[0]));
    assert.equal(bloques - segmentos.length, podas);
    assert.equal(catalogo.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    t.diagnostic(JSON.stringify({ escritos, bloques, picoLogico, picoAsignado, podas, podasEntreNiveles,
      ultimos: [...confirmados.values()].map(({ nivel, t0, crc }) => ({ nivel, t0, crc })) }));
  } finally { catalogo.db.close(); }
});
