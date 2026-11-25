import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { CatalogoCinta, INDICE_CINTA, rutaSegmento, type PuntoEscritura } from '../../src/server/cinta/catalogo.js';
import { EscritorCinta } from '../../src/server/cinta/escritor.js';
import { codificarBloque } from '../../src/server/cinta/formato.js';
import { LectorCinta } from '../../src/server/cinta/lector.js';
import { podar, RESERVA_DISCO } from '../../src/server/cinta/poda.js';
import { CINTA, type Apertura, type ChunkResp } from '../../src/shared/cinta.js';
import { directorioBanco, escenaCinta } from './cinta-sintetica.mjs';

const MODULO = fileURLToPath(import.meta.url);
const REPO = dirname(dirname(dirname(MODULO)));
const APERTURA: Apertura = { instanciaId: 'banco-cinta', epoca: 0, tMundo: 0, motivo: 'reinicio' };
const PUNTOS = ['mitad de bloque', 'bloque sincronizado', 'catálogo podado'] as const satisfies readonly PuntoEscritura[];
const PARA_HASH = 200;
const TOPE_PODA = 1_000_000;

function sha(datos: string | Buffer): string {
  return createHash('sha256').update(datos).digest('hex');
}

function hashesL1(directorio: string): string[] {
  const lector = new LectorCinta(directorio, 0);
  try {
    return Array.from({ length: PARA_HASH }, (_, i) => {
      const t = i * CINTA.pasos[1];
      const r = JSON.parse(lector.chunk({ t, n: 1, nivel: 1 })) as ChunkResp;
      assert.equal(r.baseFrame?.tick, t);
      return sha(JSON.stringify(r.baseFrame));
    });
  } finally { lector.close(); }
}

function respaldo(origen: string, destino: string): string {
  const copia = spawnSync('bash', ['scripts/respaldo-cinta.sh', origen, destino], { cwd: REPO, encoding: 'utf8' });
  assert.equal(copia.status, 0, String(copia.error ?? copia.stderr));
  return copia.stdout.trim();
}

function restaurar(raiz: string) {
  const directorio = join(raiz, 'cinta'), destino = join(raiz, 'copias');
  const escena = escenaCinta(16, 64, 32);
  const escritor = new EscritorCinta({ directorio });
  try {
    escritor.abrir(APERTURA);
    for (let i = 0; i < PARA_HASH; i++) escritor.registrar(escena(i * CINTA.pasos[1], i, 300, i === 0));
  } finally { escritor.close(); }
  const antes = hashesL1(directorio);
  const primera = respaldo(directorio, destino), segunda = respaldo(directorio, destino);
  assert.notEqual(primera, segunda);
  const db = new DatabaseSync(join(segunda, INDICE_CINTA), { readOnly: true });
  let n1: number;
  try {
    assert.equal(db.prepare('SELECT id FROM segmentos WHERE nivel=0 LIMIT 1').get(), undefined);
    n1 = Number(db.prepare('SELECT id FROM segmentos WHERE nivel=1 ORDER BY id LIMIT 1').get()!.id);
  } finally { db.close(); }
  const anterior = statSync(rutaSegmento(primera, 1, n1)), nuevo = statSync(rutaSegmento(segunda, 1, n1));
  assert.deepEqual([nuevo.dev, nuevo.ino], [anterior.dev, anterior.ino], 'El segmento en común debe reutilizar el archivo del respaldo anterior.');
  rmSync(directorio, { recursive: true });
  cpSync(segunda, directorio, { recursive: true });
  const verificado = spawnSync('bash', ['scripts/respaldo-cinta.sh', '--verificar', directorio], { cwd: REPO, encoding: 'utf8' });
  assert.equal(verificado.status, 0, String(verificado.error ?? verificado.stderr));
  const catalogo = new CatalogoCinta(directorio);
  try {
    const tMundo = PARA_HASH * CINTA.pasos[1];
    const epoca = catalogo.abrir({ ...APERTURA, tMundo, motivo: 'restauracion' });
    const laguna = catalogo.db.prepare('SELECT t0,t1 FROM lagunas WHERE epoca=?').get(epoca);
    assert.equal(laguna?.t0, (PARA_HASH - 1) * CINTA.pasos[1]);
    assert.equal(laguna?.t1, tMundo);
  } finally { catalogo.db.close(); }
  const despues = hashesL1(directorio);
  assert.deepEqual(despues, antes, 'I8: la copia debe conservar los 200 fotogramas de L1.');
  return { fotogramas: PARA_HASH, sha256: sha(antes.join('')), enlacesDuros: true };
}

function bloque(t: number): Buffer {
  return codificarBloque(0, escenaCinta(1, 0, 4)(t, 0, 300, true).vista, []);
}

function hijo(directorio: string, punto: PuntoEscritura): void {
  const catalogo = new CatalogoCinta(directorio, actual => {
    if (actual !== punto) return;
    writeSync(1, actual + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  try {
    const ultimo = catalogo.segmentos().at(-1)!, epoca = catalogo.ultimaEpoca()!.id;
    if (punto === 'catálogo podado') {
      podar(catalogo, TOPE_PODA, 0, Math.floor(TOPE_PODA * CINTA.cuotas[0]) - ultimo.bytes, { reservaDisco: 0 });
    } else catalogo.escribirBloque(epoca, bloque(8), ultimo);
  } finally { catalogo.db.close(); }
  throw new Error(`No se alcanzó el punto «${punto}».`);
}

async function matar(directorio: string, punto: PuntoEscritura): Promise<void> {
  const proc = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), MODULO, '--hijo', directorio, punto],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const salida = once(proc, 'close');
  let listo = false;
  const lineas = createInterface({ input: proc.stdout });
  lineas.on('line', linea => {
    if (linea === punto) {
      listo = true;
      proc.kill('SIGKILL');
    }
  });
  const maximo = setTimeout(() => proc.kill('SIGKILL'), 30_000);
  try {
    const [codigo, senal] = await salida;
    assert.deepEqual([listo, codigo, senal], [true, null, 'SIGKILL'], punto);
  } finally { clearTimeout(maximo); lineas.close(); }
}

async function caidas(raiz: string) {
  const pruebas = [];
  for (const [i, punto] of PUNTOS.entries()) {
    const directorio = join(raiz, `caida-${i}`);
    let catalogo = new CatalogoCinta(directorio);
    const epoca = catalogo.abrir(APERTURA);
    for (const t of [0, 4]) catalogo.escribirBloque(epoca, bloque(t), undefined);
    const antes = catalogo.segmentos();
    const rutas = antes.map(s => rutaSegmento(directorio, s.nivel, s.id));
    const hashes = rutas.map(r => sha(readFileSync(r)));
    catalogo.db.close();

    await matar(directorio, punto);
    catalogo = new CatalogoCinta(directorio, undefined, true);
    try {
      assert.deepEqual(catalogo.cuarentena(), [], punto);
      assert.equal(catalogo.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
      assert.deepEqual(catalogo.segmentos(), punto === 'catálogo podado' ? antes.slice(1) : antes);
      assert.equal(sha(readFileSync(rutas[1]!)), hashes[1]);
      if (punto === 'catálogo podado') assert.equal(existsSync(rutas[0]!), false);
      else assert.equal(sha(readFileSync(rutas[0]!)), hashes[0]);
      pruebas.push(punto);
    } finally { catalogo.db.close(); }
  }
  return pruebas;
}

const [, , modo, dir, punto] = process.argv;
if (modo === '--hijo' && dir && PUNTOS.some(p => p === punto)) hijo(dir, punto as PuntoEscritura);
else {
  if (modo !== 'probar' || !dir || punto !== undefined) throw new Error('Uso: cinta-durabilidad.mts probar <directorio temporal>');
  const raiz = directorioBanco(dir, RESERVA_DISCO + 256 * 1024 ** 2, 'durabilidad-cinta-');
  const cargaInicio = loadavg();
  try {
    console.log(JSON.stringify({ restauracion: restaurar(raiz), caidas: await caidas(raiz), cargaInicio, cargaFinal: loadavg() }, null, 2));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
}
