/**
 * ¿Cuánto costaría verificar sólo una VENTANA del archivo de ejecuciones? (sprint noche-arch 2026-09-23)
 *
 *   TMPDIR=/datos/tmp-atlas-lab nice -n 10 npx tsx scripts/perf/ventana-archivo.ts --db <copia.sqlite> \
 *     [--ventanas 2400,24000,48000] [--poda 24000] [--salida json]
 *
 * Sin tocar el código del Store: carga el mundo de una copia propia (la carga de hoy, entera) y luego
 * llama al MISMO verificador que usa `load()` (`assertTechnologyReceipts`, privado) con el intervalo que
 * dejaría una poda de prefijo: desde la frontera `b` = último serial con tick <= tick − ventana (y nunca
 * por encima del anillo reciente del mundo) hasta `committedThrough`. Mide también:
 *   - la cadena de digestos que haría verificable lo podado: sha256(previo + "\n" + digest de fila) en
 *     orden de serial, sobre la ventana (lo que pagaría cada carga) y sobre todo el archivo con la
 *     comprobación sha256(body) = digest (lo que pagaría UNA vez la migración);
 *   - `PRAGMA quick_check`, que `load()` corre entero y es O(tamaño del fichero);
 *   - el coste de borrar el prefijo en la copia: un tramo de régimen (una ventana de filas) y la
 *     migración (todo lo anterior a la frontera de la ventana mayor), cada uno en su transacción.
 * Todo con reloj de pared y CPU propia (`process.cpuUsage`). La copia se borra al terminar.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import type { World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r1 = (x: number): number => Math.round(x * 10) / 10;
function medir<T>(trabajo: () => T): { valor: T; paredMs: number; cpuMs: number } {
  const pared = performance.now(), cpu = cpuMs();
  const valor = trabajo();
  return { valor, paredMs: r1(performance.now() - pared), cpuMs: r1(cpuMs() - cpu) };
}

const origen = arg('--db'), salida = arg('--salida');
const ventanas = (arg('--ventanas') ?? '2400,24000,48000').split(',').map(Number), poda = Number(arg('--poda') ?? 24000);
if (!origen || !existsSync(origen)) throw new Error('Uso: ventana-archivo.ts --db <copia.sqlite> [--ventanas 2400,24000] [--salida json]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp'))
  throw new Error('TMPDIR debe apuntar fuera de /tmp: TMPDIR=/datos/tmp-atlas-lab');
if ([...ventanas, poda].some(v => !Number.isSafeInteger(v) || v < 1)) throw new Error('--ventanas y --poda: enteros positivos');

const dir = mkdtempSync(join(tmpdir(), 'atlas-ventana-'));
const ruta = join(dir, 'world.sqlite');
for (const sufijo of ['', '-wal', '-shm']) if (existsSync(origen + sufijo)) copyFileSync(origen + sufijo, ruta + sufijo);
type Privado = { assertTechnologyReceipts(world: World, startsAfter: number, through: number): void };
try {
  const store = new Store(ruta);
  const carga = medir(() => store.load());
  if (!carga.valor) throw new Error('La base no tiene mundo');
  const world = carga.valor.world, digesto = digestoCanonico(world);
  const journal = world.technology.journal!, through = journal.committedThrough;
  const serialEn = (tick: number): number => Number((store.db
    .prepare('SELECT COALESCE(MAX(serial),0) AS s FROM technology_executions WHERE tick<=?').get(tick) as { s: number }).s);
  // La poda nunca puede pasar del anillo reciente: `assertTechnologyReceipts` compara esos recibos con el archivo.
  const frontera = (ventana: number): number => Math.min(serialEn(world.tick - ventana), world.technology.historyDropped);
  const verificar = (desde: number) => medir(() => {
    // Igual que `load()`: dentro de una transacción anfitriona, donde las pruebas de definiciones se reutilizan.
    store.db.exec('BEGIN');
    try {
      store.technologyArchive.beginHostTransaction();
      (store as unknown as Privado).assertTechnologyReceipts(world, desde, through);
      store.db.exec('COMMIT'); store.technologyArchive.acknowledgeHostCommit();
    } catch (error) {
      if (store.db.isTransaction) store.db.exec('ROLLBACK');
      store.technologyArchive.invalidateVerification(); throw error;
    }
  });
  const cadena = (desde: number, conCuerpo: boolean) => medir(() => {
    let h = '0'.repeat(64), filas = 0;
    const sql = `SELECT ${conCuerpo ? 'body,' : ''}digest FROM technology_executions WHERE serial>? ORDER BY serial`;
    for (const fila of store.db.prepare(sql).iterate(desde) as Iterable<{ body?: string; digest: string }>) {
      if (conCuerpo && createHash('sha256').update(fila.body!).digest('hex') !== fila.digest) throw new Error('checksum');
      h = createHash('sha256').update(`${h}\n${fila.digest}`).digest('hex'); filas++;
    }
    return { filas, h };
  });
  const verificaciones = [];
  for (const ventana of [...ventanas, 0]) {
    const desde = ventana === 0 ? journal.startsAfter : frontera(ventana);
    const v = verificar(desde), c = cadena(desde, false);
    verificaciones.push({ ventana: ventana || 'todo', desde, filas: through - desde, receipts: { paredMs: v.paredMs, cpuMs: v.cpuMs },
      cadenaDigestos: { paredMs: c.paredMs, cpuMs: c.cpuMs } });
    console.log(JSON.stringify(verificaciones.at(-1)));
  }
  const migracionCadena = cadena(journal.startsAfter, true);
  const quickCheck = medir(() => Object.values(store.db.prepare('PRAGMA quick_check').get() as object)[0]);
  console.log(JSON.stringify({ migracionCadena: { ...migracionCadena, valor: migracionCadena.valor.filas }, quickCheck }));
  // Borrado del prefijo con la ventana de `--poda`: primero un tramo de régimen (las filas más viejas, tantas
  // como deja la ventana: lo que borraría cada poda periódica) y después el resto hasta la frontera (la migración).
  const limite = frontera(poda), tramo = journal.startsAfter + Math.min(through - limite, limite - journal.startsAfter);
  const borrar = (hasta: number) => medir(() => {
    store.db.exec('BEGIN IMMEDIATE');
    const n = Number(store.db.prepare('DELETE FROM technology_executions WHERE serial<=?').run(hasta).changes);
    store.db.exec('COMMIT');
    return n;
  });
  const regimen = borrar(tramo), migracion = borrar(limite);
  const borrados = { poda, regimen: { filas: regimen.valor, paredMs: regimen.paredMs, cpuMs: regimen.cpuMs },
    migracion: { filas: migracion.valor, paredMs: migracion.paredMs, cpuMs: migracion.cpuMs } };
  console.log(JSON.stringify(borrados));
  store.close();
  const informe = { origen, tick: world.tick, poblacion: world.people.length, committedThrough: through, digesto,
    carga: { paredMs: carga.paredMs, cpuMs: carga.cpuMs }, verificaciones,
    migracionCadena: { filas: migracionCadena.valor.filas, paredMs: migracionCadena.paredMs, cpuMs: migracionCadena.cpuMs },
    quickCheck: { resultado: quickCheck.valor, paredMs: quickCheck.paredMs, cpuMs: quickCheck.cpuMs }, borrados };
  if (salida) writeFileSync(salida, JSON.stringify(informe, null, 1));
} finally { rmSync(dir, { recursive: true, force: true }); }
