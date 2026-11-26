import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { crc32 } from 'node:zlib';
import { codificarCheckpointEnTramos } from '../world/materia/checkpoint.js';
import type { MateriaCheckpoint } from '../world/materia/tipos.js';
import { SnapshotPhysicalError } from './snapshot.js';

export const MAX_SNAPSHOT_MATTER_PART_BYTES = 4 * 1024 * 1024;
const VMAT = 0x54414d56, VMPT = 0x54504d56; // little endian
const VERSION_VMAT = 1;
const VERSION = 1;
const SHA_BYTES = 32;
const HEADER_BYTES = 16 + SHA_BYTES;
const ENTRY_BYTES = 4 + SHA_BYTES;
const CRC_BYTES = 4;
const checksum = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

interface Referencia { readonly digest: string; readonly bytes: number; }
interface Manifiesto { readonly digest: string; readonly longitud: number; readonly partes: readonly Referencia[]; }
export interface PreparedMatterParts extends Manifiesto {
  readonly partes: readonly (Referencia & { readonly body: Uint8Array })[];
}

function error(message: string): never { throw new SnapshotPhysicalError(message); }

function leerManifiesto(body: Uint8Array): Manifiesto | null {
  const vista = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length >= 4 && vista.getUint32(0, true) === VMAT) return null;
  if (body.length < HEADER_BYTES + ENTRY_BYTES || vista.getUint32(0, true) !== VMPT
    || vista.getUint32(4, true) !== VERSION || (body.length - HEADER_BYTES) % ENTRY_BYTES !== 0)
    return error('Formato del manifiesto de materia desconocido o truncado.');
  const longitud = vista.getFloat64(8, true);
  if (!Number.isSafeInteger(longitud) || longitud < 8 + CRC_BYTES) return error('Longitud de VMAT inválida.');
  const digest = Buffer.from(body.subarray(16, HEADER_BYTES)).toString('hex');
  const partes: Referencia[] = [];
  let restantes = longitud;
  for (let pos = HEADER_BYTES; pos < body.length; pos += ENTRY_BYTES) {
    const bytes = vista.getUint32(pos, true);
    if (bytes === 0 || bytes > MAX_SNAPSHOT_MATTER_PART_BYTES || bytes > restantes)
      return error('Longitud de parte de materia inválida.');
    restantes -= bytes;
    partes.push({ bytes, digest: Buffer.from(body.subarray(pos + 4, pos + ENTRY_BYTES)).toString('hex') });
  }
  if (restantes !== 0) return error('Las longitudes de partes no completan el VMAT.');
  return { digest, longitud, partes };
}

function codificarManifiesto({ digest, longitud, partes }: Manifiesto): Uint8Array {
  const body = new Uint8Array(HEADER_BYTES + ENTRY_BYTES * partes.length);
  const vista = new DataView(body.buffer);
  vista.setUint32(0, VMPT, true);
  vista.setUint32(4, VERSION, true);
  vista.setFloat64(8, longitud, true);
  body.set(Buffer.from(digest, 'hex'), 16);
  let pos = HEADER_BYTES;
  for (const parte of partes) {
    vista.setUint32(pos, parte.bytes, true);
    body.set(Buffer.from(parte.digest, 'hex'), pos + 4);
    pos += ENTRY_BYTES;
  }
  return body;
}

function exigirTransaccion(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Las partes de materia requieren una transacción SQLite.');
}

/** Los slots de Store guardan un VMAT antiguo o un manifiesto. Las partes de todos sus respaldos
 * comparten la misma tabla. El llamador controla la transacción que instala, publica y recolecta. */
export class SnapshotMatterParts {
  constructor(private readonly db: DatabaseSync) {}

  static installed(db: DatabaseSync): boolean {
    return !!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='snapshot_matter_parts'").get();
  }

  static install(db: DatabaseSync): void {
    exigirTransaccion(db);
    db.exec(`CREATE TABLE IF NOT EXISTS main.snapshot_matter_parts (
      digest TEXT PRIMARY KEY NOT NULL,
      body BLOB NOT NULL CHECK(length(body) BETWEEN 1 AND ${MAX_SNAPSHOT_MATTER_PART_BYTES})
    ) STRICT`);
  }

  /** SHA-256 del VMAT, incluido su CRC32, compatible con el enlace de la agenda. Hasta write(),
   * el material de entrada debe permanecer inmóvil. La preparación conserva vistas y metadatos. */
  static prepare(checkpoint: MateriaCheckpoint, maximo = MAX_SNAPSHOT_MATTER_PART_BYTES): PreparedMatterParts {
    if (!Number.isSafeInteger(maximo) || maximo < 1 || maximo > MAX_SNAPSHOT_MATTER_PART_BYTES)
      throw new RangeError('Límite de bytes por parte de materia inválido.');
    const { longitud, tramos } = codificarCheckpointEnTramos(checkpoint, maximo);
    const sha = createHash('sha256');
    const partes: PreparedMatterParts['partes'][number][] = [];
    for (const body of tramos) {
      sha.update(body);
      partes.push({ body, bytes: body.byteLength, digest: checksum(body) });
    }
    return { digest: sha.digest('hex'), longitud, partes };
  }

  write(preparado: PreparedMatterParts): Uint8Array {
    exigirTransaccion(this.db);
    const insertar = this.db.prepare('INSERT INTO main.snapshot_matter_parts VALUES (?,?) ON CONFLICT(digest) DO NOTHING');
    const leer = this.db.prepare('SELECT body FROM main.snapshot_matter_parts WHERE digest=?');
    for (const { body, bytes, digest } of preparado.partes) {
      if (body.byteLength !== bytes || checksum(body) !== digest) return error('Una parte de materia preparada cambió antes de escribir.');
      if (insertar.run(digest, body).changes === 0) {
        const encontrada = leer.get(digest)?.body;
        if (!(encontrada instanceof Uint8Array) || Buffer.compare(encontrada, body) !== 0)
          return error('La parte de materia retenida no coincide con su SHA-256.');
      }
    }
    return codificarManifiesto(preparado);
  }

  static references(body: Uint8Array | null): string[] {
    const manifiesto = body === null ? null : leerManifiesto(body);
    return manifiesto?.partes.map(parte => parte.digest) ?? [];
  }

  /** Recibe todos los cuerpos retenidos después de rotar slots, incluidos los respaldos profundos. */
  collect(bodies: Iterable<Uint8Array | null>): void {
    exigirTransaccion(this.db);
    const retenidos = new Set<string>();
    for (const body of bodies) for (const digest of SnapshotMatterParts.references(body)) retenidos.add(digest);
    const borrar = this.db.prepare('DELETE FROM main.snapshot_matter_parts WHERE digest=?');
    for (const { digest } of this.db.prepare('SELECT digest FROM main.snapshot_matter_parts').all() as { digest: string }[])
      if (!retenidos.has(digest)) borrar.run(digest);
  }

  /** El decodificador de VMAT sigue a cargo de la estructura y el balance del material. */
  read(body: Uint8Array | null): { bytes: Uint8Array | null; digest: string | null } {
    exigirTransaccion(this.db);
    if (body === null) return { bytes: null, digest: null };
    const manifiesto = leerManifiesto(body);
    if (!manifiesto) return { bytes: body, digest: checksum(body) };
    const bytes = new Uint8Array(manifiesto.longitud);
    return { bytes, digest: this.verificarManifiesto(manifiesto, bytes) };
  }

  /** Para cotejar cuerpos retenidos en la transacción de escritura sin ensamblar la carga útil. */
  verify(body: Uint8Array | null): string | null {
    exigirTransaccion(this.db);
    if (body === null) return null;
    const manifiesto = leerManifiesto(body);
    return manifiesto ? this.verificarManifiesto(manifiesto) : checksum(body);
  }

  private verificarManifiesto(manifiesto: Manifiesto, destino?: Uint8Array): string {
    if (!SnapshotMatterParts.installed(this.db))
      return error('Falta la tabla de partes de materia.');
    const leer = this.db.prepare('SELECT body FROM main.snapshot_matter_parts WHERE digest=?');
    const sha = createHash('sha256');
    const cabecera = new Uint8Array(8);
    const sello = new Uint8Array(CRC_BYTES);
    const finCrc = manifiesto.longitud - sello.length;
    let pos = 0, crc = 0;
    for (const [indice, parte] of manifiesto.partes.entries()) {
      const fila = leer.get(parte.digest);
      if (!fila) return error(`Falta la parte de materia ${indice}.`);
      const bytes = fila.body;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== parte.bytes || checksum(bytes) !== parte.digest)
        return error(`La parte de materia ${indice} no coincide con su longitud o SHA-256.`);
      sha.update(bytes);
      if (pos < cabecera.length) cabecera.set(bytes.subarray(0, cabecera.length - pos), pos);
      const nCrc = Math.max(0, Math.min(bytes.length, finCrc - pos));
      if (nCrc > 0) crc = crc32(bytes.subarray(0, nCrc), crc);
      if (nCrc < bytes.length) sello.set(bytes.subarray(nCrc), pos + nCrc - finCrc);
      destino?.set(bytes, pos);
      pos += bytes.length;
    }
    const digest = sha.digest('hex');
    if (digest !== manifiesto.digest) return error('Las partes no coinciden con el SHA-256 del VMAT.');
    const formato = new DataView(cabecera.buffer);
    if (formato.getUint32(0, true) !== VMAT || formato.getUint32(4, true) !== VERSION_VMAT)
      return error('El encabezado VMAT de las partes de materia es desconocido.');
    if (crc !== new DataView(sello.buffer).getUint32(0, true)) return error('Las partes no coinciden con el CRC32 del VMAT.');
    return digest;
  }
}
