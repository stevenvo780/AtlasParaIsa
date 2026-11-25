import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogoCinta, INDICE_CINTA, MAX_SEGMENTO, NIVELES, rutaSegmento, type BloqueCinta } from '../src/server/cinta/catalogo.js';
import { codificarBloque, decodificarBloque, prepararBloque, verificarBloque } from '../src/server/cinta/formato.js';
import { LectorCinta } from '../src/server/cinta/lector.js';
import { podar } from '../src/server/cinta/poda.js';
import { CINTA, type ChunkResp, type Nivel } from '../src/shared/cinta.js';
import type { WorldView } from '../src/shared/types.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';

const TOPE = 2e9;
const VOLUMEN = Number(process.env.ATLAS_V23_CINTA_VOLUMEN_BYTES ?? 10e9);
const MARGEN = 16 * 1024 ** 2;
const CABECERA = 33;
const CRC = 25;
const ARCHIVO = process.env.ATLAS_V23_CINTA_VOLUMEN_DIR ?? resolve(import.meta.dirname, '../../../archivo/tmp-v23-c1a');

function vista(tick: number): WorldView {
  return { version: 10, sequence: tick, tick, day: Math.floor(tick / TICKS_PER_DAY), phase: 'day', weather: 'clear',
    width: 1, height: 1, tiles: [], people: [], places: [], events: [], memories: [], paused: true };
}

/** El índice CNT2 permite cambiar el tick sin volver a comprimir el relleno aleatorio. */
function volumenSintetico() {
  const ruido = randomBytes(47 * 1024 ** 2).toString('base64');
  const frame = { ...vista(0), pauseReason: ruido };
  const plantillas = NIVELES.map(nivel => prepararBloque(nivel, frame, []));
  const bloque = (nivel: Nivel, tick: number): Buffer => plantillas[nivel]!(tick);
  const datos = bloque(0, 0);
  assert.ok(datos.length < MAX_SEGMENTO);
  const muestra = decodificarBloque(datos);
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

test('I2/I6/I10: la poda intermedia confirma la laguna con el borrado y conserva la lectura de L1', t => {
  const raiz = '/tmp/atlas-v23-o-cinta';
  mkdirSync(raiz, { recursive: true });
  const directorio = mkdtempSync(join(raiz, 'poda-laguna-'));
  t.after(() => rmSync(directorio, { recursive: true, force: true }));
  const interrupcion = new Error('poda interrumpida antes del unlink');
  let catalogo = new CatalogoCinta(directorio, punto => {
    if (punto === 'catálogo podado') throw interrupcion;
  });
  const tope = 1_000_000;
  const marcador = 24;
  const fijado = marcador + 14 * TICKS_PER_DAY;
  const medio = fijado + CINTA.pasos[0];
  const segundo = medio + CINTA.pasos[0];
  const ultimo = segundo + CINTA.pasos[0];
  const ultimoL1 = segundo + CINTA.pasos[1];
  const lagunasPoda = (db: DatabaseSync) => db.prepare('SELECT epoca,nivel,t0,t1 FROM lagunas_poda ORDER BY epoca,nivel,t0')
    .all().map(fila => ({ ...fila }));
  const podarHasta = (...ticks: number[]) => {
    const conservados = catalogo.segmentos().filter(s => s.nivel === 0 && ticks.includes(s.t0));
    const entrada = Math.floor(tope * CINTA.cuotas[0]) - conservados.reduce((suma, s) => suma + s.bytes, 0);
    podar(catalogo, tope, 0, entrada, { reservaDisco: 0 });
  };
  const epoca = catalogo.abrir({ instanciaId: 'poda-laguna', epoca: 0, tMundo: 0, motivo: 'reinicio' });
  const rutaMedio = rutaSegmento(directorio, 0, 2);
  try {
    for (const tick of [fijado, medio, segundo, ultimo]) catalogo.escribirBloque(epoca, codificarBloque(0, vista(tick), []), undefined);
    catalogo.escribirBloque(epoca, codificarBloque(1, vista(fijado), []), undefined);
    for (const tick of [segundo, ultimoL1]) catalogo.escribirBloque(epoca, codificarBloque(1, vista(tick), []), catalogo.segmentos().at(-1));
    catalogo.db.prepare('INSERT INTO marcadores VALUES (?,?,NULL,?,?,?,?)').run('poda-laguna', Date.now(), epoca, marcador, 0, 1);

    catalogo.db.exec(`CREATE TEMP TRIGGER impedir_laguna BEFORE INSERT ON lagunas_poda
      BEGIN SELECT RAISE(ABORT, 'falló la declaración'); END`);
    assert.throws(() => podarHasta(fijado, segundo, ultimo), /falló la declaración/);
    assert.ok(existsSync(rutaMedio) && catalogo.db.prepare('SELECT 1 FROM bloques WHERE segmento=2').get());
    assert.deepEqual(lagunasPoda(catalogo.db), []);
    catalogo.db.exec('DROP TRIGGER impedir_laguna');

    assert.throws(() => podarHasta(fijado, segundo, ultimo), error => error === interrupcion);
    assert.equal(existsSync(rutaMedio), true, 'la interrupción ocurre antes de desvincular');
    const db = new DatabaseSync(join(directorio, INDICE_CINTA), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT id FROM segmentos WHERE id=2').get(), undefined);
      assert.equal(db.prepare('SELECT 1 FROM bloques WHERE segmento=2').get(), undefined);
      assert.deepEqual(lagunasPoda(db), [{ epoca, nivel: 0, t0: fijado, t1: segundo }]);
    } finally { db.close(); }
  } finally { catalogo.db.close(); }

  catalogo = new CatalogoCinta(directorio);
  const lector = new LectorCinta(directorio);
  try {
    assert.equal(existsSync(rutaMedio), false, 'la recuperación borra el archivo desreferenciado');
    assert.deepEqual(lagunasPoda(catalogo.db), [{ epoca, nivel: 0, t0: fijado, t1: segundo }]);
    podarHasta(fijado, ultimo);
    assert.deepEqual(lagunasPoda(catalogo.db), [{ epoca, nivel: 0, t0: fijado, t1: ultimo }]);
    assert.deepEqual(lector.meta().lagunas, []);
    const fino = JSON.parse(lector.chunk({ t: fijado, n: 120, nivel: 0 })) as ChunkResp;
    assert.deepEqual([fino.t0, fino.t1, fino.hayMas], [fijado, fijado, true]);
    const auto = JSON.parse(lector.chunk({ t: medio, n: 1 })) as ChunkResp;
    assert.deepEqual([auto.nivel, auto.cambioDeNivelEn], [1, ultimo]);
    const grueso = JSON.parse(lector.chunk({ t: fijado, n: 120, nivel: 1 })) as ChunkResp;
    assert.deepEqual([grueso.t0, grueso.t1], [fijado, ultimoL1]);
    const siguiente = JSON.parse(lector.chunk({ t: ultimo, n: 1 })) as ChunkResp;
    assert.deepEqual([siguiente.nivel, siguiente.t0], [0, ultimo]);
    catalogo.db.exec('UPDATE marcadores SET en=0');
    podarHasta(ultimo);
    assert.deepEqual(lagunasPoda(catalogo.db), [], 'el tramo podado queda fuera de la pista al desaparecer el pin');
    assert.deepEqual(catalogo.segmentos().filter(s => s.nivel === 0).map(s => s.t0), [ultimo]);
  } finally { lector.close(); catalogo.db.close(); }
});

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
    podar(catalogo, TOPE, nivel, data.length, { margen: MARGEN });
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
