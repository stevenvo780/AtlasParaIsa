import { closeSync, openSync, readSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LeerBytes } from './formato.js';

const VENTANA_TEMPORAL = 1024 ** 2;

function abrirTemporal(directorio: string): number {
  const ruta = join(directorio, `.cnt2-${randomUUID()}.tmp`);
  const fd = openSync(ruta, 'wx+', 0o600);
  // Se lee por descriptor. Un corte del grabador libera el archivo sin dejar una cola que restaurar.
  try { unlinkSync(ruta); }
  catch (error) { closeSync(fd); throw error; }
  return fd;
}

function escribir(fd: number, buffer: Buffer, desde: number): void {
  for (let i = 0; i < buffer.length;) {
    const n = writeSync(fd, buffer, i, buffer.length - i, desde + i);
    if (n <= 0) throw new Error('No avanzó el cuerpo temporal de la cinta.');
    i += n;
  }
}

function leer(fd: number, buffer: Buffer, copiados: number, desde: number): void {
  for (let i = copiados; i < buffer.length;) {
    const n = readSync(fd, buffer, i, buffer.length - i, desde + i - copiados);
    if (n <= 0) throw new Error('Cuerpo temporal de cinta truncado.');
    i += n;
  }
}

/** Conserva cuerpos pequeños en RAM y derrama los grandes al volumen de la cinta. */
export class CuerpoBloqueCinta {
  private readonly partes: Buffer[] = [];
  private bytes = 0;
  private fd: number | null = null;
  private topeTemporal: number | undefined;

  constructor(private readonly directorio: string, private readonly presupuesto: number, private readonly reservaDisco: number) {}

  private disponible(): number {
    const disco = statfsSync(this.directorio);
    return disco.bavail * disco.bsize - this.reservaDisco;
  }

  agregar(datos: Buffer): void {
    const total = this.bytes + datos.length;
    if (this.topeTemporal === undefined && total > this.presupuesto) {
      // Mientras se confirma el segmento coexisten el temporal y su destino.
      this.topeTemporal = Math.floor(this.disponible() / 2);
      if (total <= this.topeTemporal) {
        this.fd = abrirTemporal(this.directorio);
        let offset = 0;
        for (const p of this.partes) {
          escribir(this.fd, p, offset);
          offset += p.length;
        }
        this.partes.length = 0;
      }
    }
    // Otros niveles pueden haber abierto temporales desde el cálculo del tope.
    if (this.fd !== null && (total > this.topeTemporal! || datos.length + total > this.disponible())) this.volverARam();
    if (this.fd === null) this.partes.push(datos);
    else escribir(this.fd, datos, this.bytes);
    this.bytes = total;
  }

  private volverARam(): void {
    if (this.fd === null) return;
    const partes: Buffer[] = [];
    for (let offset = 0; offset < this.bytes; offset += VENTANA_TEMPORAL) {
      const parte = Buffer.allocUnsafe(Math.min(VENTANA_TEMPORAL, this.bytes - offset));
      leer(this.fd, parte, 0, offset);
      partes.push(parte);
    }
    this.cerrar();
    for (const parte of partes) this.partes.push(parte);
  }

  prepararDestino(bytes: number): void {
    // Incluye el índice y el espacio que otros escritores consumieron durante la preparación.
    if (this.fd !== null && bytes > this.disponible()) this.volverARam();
  }

  lector(indice: Buffer, bytes: number): LeerBytes {
    if (bytes !== indice.length + this.bytes) throw new Error('Longitud del bloque de cinta incoherente.');
    const fd = this.fd;
    if (fd === null) {
      const partes = [indice, ...this.partes];
      this.partes.length = 0;
      const fines: number[] = [];
      let fin = 0;
      for (const parte of partes) fines.push(fin += parte.length);
      let ventana = Buffer.alloc(0);
      return (offset, n) => {
        if (n === 0) return indice.subarray(0, 0);
        let inicio = 0, fin = fines.length;
        while (inicio < fin) {
          const medio = Math.floor((inicio + fin) / 2);
          if (fines[medio]! <= offset) inicio = medio + 1;
          else fin = medio;
        }
        const local = offset - (fines[inicio - 1] ?? 0);
        if (offset + n <= fines[inicio]!) return partes[inicio]!.subarray(local, local + n);
        if (ventana.length < n) ventana = Buffer.allocUnsafe(n);
        const buffer = ventana.subarray(0, n);
        let copiados = partes[inicio]!.copy(buffer, 0, local);
        while (copiados < n) copiados += partes[++inicio]!.copy(buffer, copiados);
        return buffer;
      };
    }
    // El catálogo consume cada lectura del cuerpo antes de pedir la siguiente.
    let ventana = Buffer.alloc(0);
    return (offset, n) => {
      if (offset + n <= indice.length) return indice.subarray(offset, offset + n);
      if (ventana.length < n) ventana = Buffer.allocUnsafe(n);
      const buffer = ventana.subarray(0, n);
      const copiados = offset < indice.length ? indice.copy(buffer, 0, offset) : 0;
      leer(fd, buffer, copiados, offset + copiados - indice.length);
      return buffer;
    };
  }

  cerrar(): void {
    this.partes.length = 0;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
