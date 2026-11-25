import {
  closeSync, fdatasyncSync, fsyncSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync,
  ftruncateSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Apertura, Bifurcacion, EntradaCatalogo, Hito, Laguna, Nivel, SeriePunto } from '../../shared/cinta.js';
import { verificarBloque, verificarBloqueLeido } from './formato.js';

export const NIVELES = [0, 1, 2, 3, 4] as const;
export const INDICE_CINTA = 'cinta.idx.sqlite';
export const VERSION_CATALOGO = 4;
export const MAX_SEGMENTO = 64 * 1024 ** 2;

export type PuntoEscritura = 'mitad de bloque' | 'bloque sincronizado' | 'catálogo podado';
export interface EpocaCinta {
  id: number; instanciaId: string; tMundo: number; t1: number; visibleHasta: number | null;
}
export interface SegmentoCinta {
  id: number; epoca: number; nivel: Nivel; t0: number; t1: number; bytes: number; visibleHasta: number | null;
}
export interface BloqueCinta {
  segmento: number; epoca: number; nivel: Nivel; t0: number; t1: number;
  offset: number; bytes: number; crc: number; fotogramas: number;
}
export type BloqueAislado = Pick<BloqueCinta, 'segmento' | 'offset' | 'epoca' | 'nivel' | 't0' | 't1'> & { motivo: string };

export function rutaSegmento(directorio: string, nivel: Nivel, id: number): string {
  return join(directorio, `n${nivel}`, `seg-${String(id).padStart(6, '0')}.cnt`);
}
const esSegmento = (nombre: string): boolean => /^seg-\d+\.cnt$/.test(nombre);

export function sincronizarDirectorio(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function escribir(fd: number, buffer: Buffer, offset: number, desde: number, hasta: number): void {
  for (let cursor = desde; cursor < hasta;) {
    const n = writeSync(fd, buffer, cursor, hasta - cursor, offset + cursor);
    if (!n) throw new Error('La escritura del bloque no avanzó.');
    cursor += n;
  }
}

// La apertura normal relee el CRC del último segmento de cada nivel. La verificación explícita relee también los sellados.
function verificarSegmento(path: string, segmento: SegmentoCinta, bloques: BloqueCinta[], ultimo: boolean,
  aislados: ReadonlySet<number>, aislar?: (fila: BloqueCinta, motivo: string) => void): void {
  let fd: number | undefined;
  try { fd = openSync(path, ultimo ? 'r+' : 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (!aislar && bloques.some(b => !aislados.has(b.offset)))) throw error;
  }
  try {
    const size = fd === undefined ? 0 : fstatSync(fd).size;
    let intocable = aislados.size > 0;
    let offset = 0, t1 = -1;
    for (const fila of bloques) {
      if (fila.nivel !== segmento.nivel || fila.epoca !== segmento.epoca || fila.offset !== offset
        || fila.bytes <= 0 || fila.bytes > segmento.bytes - offset || fila.t0 <= t1) {
        throw new Error(`Índice de bloque incoherente: ${segmento.id}/${fila.offset}.`);
      }
      if (!aislados.has(fila.offset)) {
        try {
          if (size - offset < fila.bytes) throw new Error(`Segmento confirmado truncado: ${segmento.id}/${offset}.`);
          if (ultimo || aislar) {
            const b = verificarBloqueLeido((desde, bytes) => {
              const data = Buffer.allocUnsafe(bytes);
              for (let cursor = 0; cursor < bytes;) {
                const n = readSync(fd!, data, cursor, bytes - cursor, offset + desde + cursor);
                if (!n) throw new Error(`Bloque confirmado incompleto: ${segmento.id}/${offset}.`);
                cursor += n;
              }
              return data;
            }, fila.bytes);
            if (b.nivel !== fila.nivel || b.t0 !== fila.t0 || b.t1 !== fila.t1 || b.crc !== fila.crc || b.fotogramas !== fila.fotogramas) {
              throw new Error(`El catálogo no coincide con el bloque confirmado: ${segmento.id}/${offset}.`);
            }
          }
        } catch (error) {
          if (!aislar || !(error instanceof Error) || (error as NodeJS.ErrnoException).code) throw error;
          aislar(fila, error.message);
          intocable = true;
        }
      }
      offset += fila.bytes;
      t1 = fila.t1;
    }
    if (offset !== segmento.bytes || t1 !== segmento.t1 || bloques[0]?.t0 !== segmento.t0) {
      throw new Error(`Extensión confirmada incoherente: ${segmento.id}.`);
    }
    if (ultimo && !intocable && size > offset) { ftruncateSync(fd!, offset); fdatasyncSync(fd!); }
  } finally { if (fd !== undefined) closeSync(fd); }
}

export class CatalogoCinta {
  readonly db: DatabaseSync;

  constructor(readonly directorio: string, private readonly punto?: (p: PuntoEscritura) => void, verificar = false) {
    mkdirSync(directorio, { recursive: true });
    for (const nivel of NIVELES) mkdirSync(join(directorio, `n${nivel}`), { recursive: true });
    this.db = new DatabaseSync(join(directorio, INDICE_CINTA));
    try {
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version !== 0 && version !== VERSION_CATALOGO) throw new Error(`Versión de catálogo de cinta incompatible: ${version}.`);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      if (version === 0 && NIVELES.some(n => readdirSync(join(directorio, `n${n}`)).some(esSegmento))) {
        throw new Error('Falta el catálogo de una cinta con segmentos existentes.');
      }
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS epocas (
          id INTEGER PRIMARY KEY, instanciaId TEXT NOT NULL, tMundo INTEGER NOT NULL,
          motivo TEXT NOT NULL, t1 INTEGER NOT NULL, visibleHasta INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS segmentos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, epoca INTEGER NOT NULL REFERENCES epocas(id),
          nivel INTEGER NOT NULL CHECK (nivel BETWEEN 0 AND 4), t0 INTEGER NOT NULL,
          t1 INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK (bytes > 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS bloques (
          segmento INTEGER NOT NULL REFERENCES segmentos(id) ON DELETE CASCADE,
          epoca INTEGER NOT NULL REFERENCES epocas(id), nivel INTEGER NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL,
          offset INTEGER NOT NULL CHECK (offset >= 0), bytes INTEGER NOT NULL CHECK (bytes > 0),
          crc INTEGER NOT NULL, fotogramas INTEGER NOT NULL CHECK (fotogramas > 0),
          PRIMARY KEY (epoca,nivel,t0), UNIQUE (segmento,offset)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS bifurcaciones (
          epoca INTEGER PRIMARY KEY REFERENCES epocas(id), desde INTEGER NOT NULL, hasta INTEGER NOT NULL, motivo TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS lagunas (
          epoca INTEGER NOT NULL REFERENCES epocas(id), t0 INTEGER NOT NULL, t1 INTEGER NOT NULL,
          PRIMARY KEY (epoca,t0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS lagunas_poda (
          epoca INTEGER NOT NULL REFERENCES epocas(id), nivel INTEGER NOT NULL CHECK (nivel BETWEEN 0 AND 4),
          t0 INTEGER NOT NULL, t1 INTEGER NOT NULL CHECK (t1 > t0),
          PRIMARY KEY (epoca,nivel,t0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS serie (
          epoca INTEGER NOT NULL REFERENCES epocas(id), t INTEGER NOT NULL, poblacion INTEGER NOT NULL,
          nacimientos INTEGER NOT NULL, muertes INTEGER NOT NULL, fauna INTEGER NOT NULL, estructuras INTEGER NOT NULL,
          sustancias INTEGER NOT NULL, hz REAL NOT NULL, PRIMARY KEY (epoca,t)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS hitos (
          epoca INTEGER NOT NULL REFERENCES epocas(id), t INTEGER NOT NULL, tipo TEXT NOT NULL,
          id TEXT NOT NULL, importancia REAL NOT NULL, cuerpo TEXT NOT NULL, PRIMARY KEY (epoca,tipo,id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS hitos_por_tick ON hitos(epoca,t);
        CREATE TABLE IF NOT EXISTS catalogo (
          epoca INTEGER NOT NULL REFERENCES epocas(id), id INTEGER NOT NULL, t INTEGER NOT NULL,
          sustancia TEXT NOT NULL, PRIMARY KEY (epoca,id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS marcadores (
          perfil TEXT NOT NULL, en INTEGER NOT NULL, nombre TEXT, epoca INTEGER NOT NULL REFERENCES epocas(id),
          t INTEGER NOT NULL, nivel INTEGER NOT NULL, velocidad REAL NOT NULL, PRIMARY KEY (perfil,en)
        ) STRICT;
        PRAGMA user_version=${VERSION_CATALOGO};
        COMMIT;
      `);
      this.db.exec(`CREATE TABLE IF NOT EXISTS cuarentena (
        segmento INTEGER NOT NULL, offset INTEGER NOT NULL, epoca INTEGER NOT NULL REFERENCES epocas(id),
        nivel INTEGER NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, motivo TEXT NOT NULL,
        PRIMARY KEY (segmento,offset)
      ) STRICT`);
      this.recuperar(verificar);
      sincronizarDirectorio(directorio);
      sincronizarDirectorio(dirname(directorio));
    } catch (error) { this.db.close(); throw error; }
  }

  private recuperar(verificar: boolean): void {
    if (this.db.prepare('PRAGMA quick_check').all().some(fila => fila.quick_check !== 'ok')
      || this.db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Catálogo de cinta corrupto.');
    const segmentos = this.segmentos();
    const referenciados = new Set(segmentos.map(s => rutaSegmento(this.directorio, s.nivel, s.id)));
    const ultimos = new Set(new Map(segmentos.map(s => [s.nivel, s.id])).values());
    const bloques = this.db.prepare('SELECT * FROM bloques WHERE segmento=? ORDER BY offset');
    const aislados = this.db.prepare('SELECT offset FROM cuarentena WHERE segmento=?');
    const danados: BloqueAislado[] = [];
    for (const s of segmentos) {
      verificarSegmento(rutaSegmento(this.directorio, s.nivel, s.id), s, bloques.all(s.id) as unknown as BloqueCinta[],
        ultimos.has(s.id), new Set(aislados.all(s.id).map(r => Number(r.offset))),
        verificar ? ({ segmento, offset, epoca, nivel, t0, t1 }, motivo) => danados.push({ segmento, offset, epoca, nivel, t0, t1, motivo }) : undefined);
    }
    const solape = this.db.prepare(`SELECT 1 FROM (
      SELECT t0,lag(t1) OVER (PARTITION BY epoca,nivel ORDER BY t0) AS anterior FROM bloques
    ) WHERE t0<=anterior LIMIT 1`).get();
    if (solape) throw new Error('Bloques solapados en una época de la cinta.');
    if (danados.length) this.transaccion(() => {
      const guardar = this.db.prepare('INSERT INTO cuarentena VALUES (?,?,?,?,?,?,?)');
      for (const b of danados) guardar.run(b.segmento, b.offset, b.epoca, b.nivel, b.t0, b.t1, b.motivo);
    });
    for (const nivel of NIVELES) {
      const path = join(this.directorio, `n${nivel}`);
      let borrado = false;
      for (const file of readdirSync(path)) {
        const ruta = join(path, file);
        if (esSegmento(file) && !referenciados.has(ruta)) { unlinkSync(ruta); borrado = true; }
      }
      if (borrado) sincronizarDirectorio(path);
    }
  }

  cuarentena(): BloqueAislado[] {
    return this.db.prepare('SELECT * FROM cuarentena ORDER BY segmento,offset').all()
      .map(fila => ({ ...fila })) as unknown as BloqueAislado[];
  }

  private transaccion(escribir: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { escribir(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  ultimaEpoca(): EpocaCinta | undefined {
    return this.db.prepare('SELECT * FROM epocas ORDER BY id DESC LIMIT 1').get() as unknown as EpocaCinta | undefined;
  }

  abrir(a: Apertura): number {
    const anterior = this.ultimaEpoca();
    const id = anterior ? Math.max(a.epoca, anterior.id + 1) : a.epoca;
    this.transaccion(() => {
      const ultimoVisual = anterior ? Number(this.db.prepare(`SELECT max(t1) AS t FROM bloques b WHERE epoca=? AND nivel=0
        AND NOT EXISTS (SELECT 1 FROM cuarentena c WHERE c.segmento=b.segmento AND c.offset=b.offset)`)
        .get(anterior.id)!.t ?? anterior.tMundo) : 0;
      this.db.prepare('INSERT INTO epocas VALUES (?,?,?,?,?,NULL)').run(id, a.instanciaId, a.tMundo, a.motivo, a.tMundo);
      if (anterior && a.tMundo < anterior.t1) {
        const bifurcacion: Bifurcacion = { epoca: anterior.id, desde: a.tMundo, hasta: anterior.t1, motivo: a.motivo };
        this.db.prepare(`UPDATE epocas SET visibleHasta=min(coalesce(visibleHasta,t1),?) WHERE id<>? AND t1>?`)
          .run(a.tMundo, id, a.tMundo);
        this.db.prepare('INSERT INTO bifurcaciones VALUES (?,?,?,?)').run(anterior.id, a.tMundo, anterior.t1, a.motivo);
        this.hito(id, { t: a.tMundo, tipo: 'bifurcacion', importancia: 1, bifurcacion });
      }
      // La serie y la crónica pueden haber quedado confirmadas por delante del último bloque visual.
      if (a.tMundo > ultimoVisual) {
        const laguna: Laguna = { t0: ultimoVisual, t1: a.tMundo };
        this.db.prepare('INSERT INTO lagunas VALUES (?,?,?)').run(id, laguna.t0, laguna.t1);
        this.hito(id, { t: a.tMundo, tipo: 'laguna', importancia: 1, laguna });
      }
    });
    return id;
  }

  private hito(epoca: number, h: Hito): void {
    const id = h.tipo === 'suceso' ? h.suceso.id : String(h.t);
    this.db.prepare('INSERT INTO hitos VALUES (?,?,?,?,?,?) ON CONFLICT(epoca,tipo,id) DO NOTHING')
      .run(epoca, h.t, h.tipo, id, h.importancia, JSON.stringify(h));
  }

  flujos(epoca: number, serie: readonly SeriePunto[], hitos: readonly Hito[], entradas: readonly EntradaCatalogo[]): void {
    this.transaccion(() => {
      const fila = this.db.prepare('INSERT INTO serie VALUES (?,?,?,?,?,?,?,?,?)');
      for (const s of serie) fila.run(epoca, s.t, s.poblacion, s.nacimientos, s.muertes, s.fauna, s.estructuras, s.sustancias, s.hz);
      for (const h of hitos) {
        if (h.tipo === 'laguna') this.db.prepare('INSERT INTO lagunas VALUES (?,?,?) ON CONFLICT DO NOTHING')
          .run(epoca, h.laguna.t0, h.laguna.t1);
        this.hito(epoca, h);
      }
      const nueva = this.db.prepare('INSERT INTO catalogo VALUES (?,?,?,?) ON CONFLICT(epoca,id) DO NOTHING');
      for (const e of entradas) nueva.run(epoca, e.sustancia.id, e.t, JSON.stringify(e.sustancia));
      let ultimo = serie.at(-1)?.t ?? 0;
      for (const h of hitos) ultimo = Math.max(ultimo, h.t);
      for (const e of entradas) ultimo = Math.max(ultimo, e.t);
      this.db.prepare('UPDATE epocas SET t1=max(t1,?) WHERE id=?').run(ultimo, epoca);
    });
  }

  segmentos(): SegmentoCinta[] {
    return this.db.prepare(`SELECT s.*, e.visibleHasta FROM segmentos s JOIN epocas e ON e.id=s.epoca ORDER BY s.id`)
      .all() as unknown as SegmentoCinta[];
  }

  bytesIndice(): number {
    let bytes = 0;
    for (const sufijo of ['', '-wal', '-shm']) {
      bytes += statSync(join(this.directorio, INDICE_CINTA + sufijo), { throwIfNoEntry: false })?.size ?? 0;
    }
    return bytes;
  }

  escribirBloque(epoca: number, data: Buffer, segmento: SegmentoCinta | undefined): void {
    if (segmento && this.db.prepare('SELECT 1 FROM cuarentena WHERE segmento=? LIMIT 1').get(segmento.id)) {
      throw new Error(`No se puede anexar al segmento ${segmento.id}: contiene bloques en cuarentena.`);
    }
    const b = verificarBloque(data);
    const id = segmento?.id ?? Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='segmentos'").get()?.seq ?? 0) + 1;
    const path = rutaSegmento(this.directorio, b.nivel, id);
    const offset = segmento?.bytes ?? 0;
    const fd = openSync(path, segmento ? 'r+' : 'wx');
    try {
      if (this.punto) {
        const mitad = Math.floor(data.length / 2);
        escribir(fd, data, offset, 0, mitad);
        this.punto('mitad de bloque');
        escribir(fd, data, offset, mitad, data.length);
      } else escribir(fd, data, offset, 0, data.length);
      fdatasyncSync(fd);
      if (!segmento) sincronizarDirectorio(join(this.directorio, `n${b.nivel}`));
      this.punto?.('bloque sincronizado');
      // El catálogo solo publica bytes que ya están en disco. Una cola posterior al offset confirmado se trunca al abrir.
      this.transaccion(() => {
        if (segmento) this.db.prepare('UPDATE segmentos SET t1=?,bytes=? WHERE id=?').run(b.t1, offset + data.length, id);
        else this.db.prepare('INSERT INTO segmentos VALUES (?,?,?,?,?,?)').run(id, epoca, b.nivel, b.t0, b.t1, data.length);
        this.db.prepare('INSERT INTO bloques VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, epoca, b.nivel, b.t0, b.t1, offset, data.length, b.crc, b.fotogramas);
        this.db.prepare('UPDATE epocas SET t1=max(t1,?) WHERE id=?').run(b.t1, epoca);
      });
    } finally { closeSync(fd); }
  }

  borrarSegmento(s: SegmentoCinta, protegido?: () => boolean, trasBorrar?: () => void): boolean {
    let borrado = false;
    this.transaccion(() => {
      if (protegido?.()) return;
      borrado = Number(this.db.prepare('DELETE FROM segmentos WHERE id=?').run(s.id).changes) > 0;
      if (borrado) trasBorrar?.();
    });
    if (!borrado) return false;
    this.punto?.('catálogo podado');
    try { unlinkSync(rutaSegmento(this.directorio, s.nivel, s.id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    sincronizarDirectorio(join(this.directorio, `n${s.nivel}`));
    return true;
  }
}
