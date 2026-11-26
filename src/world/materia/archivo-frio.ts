import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { PageArena } from '../soa/arena.js';
import { desbordeDeEspecies, LOTES_POR_BLOQUE, type ArenaLotes } from './arena.js';
import { Rol, type LoteRef } from './tipos.js';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Contenido físico de lotes dormidos en un directorio privado de una instancia. VMAT sigue siendo el guardado durable. */
export class ArchivoMateriaFria {
  readonly contenido: PageArena;
  readonly #paginas = new Map<number, { huella: string; bytes: number; lotes: number }>();
  #directorio?: string;
  #cache?: { pagina: number; lotes: Map<LoteRef, Float64Array> };
  #errorEscritura?: string;

  constructor(private readonly raiz: string, maxRanuras: number, private readonly desborde: PageArena) {
    if (!isAbsolute(raiz) || !statSync(raiz, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('CARTA_MATERIA_FRIA_DIR debe identificar un directorio absoluto existente.');
    }
    this.contenido = new PageArena(maxRanuras);
  }

  tiene(pagina: number): boolean { return this.#paginas.has(pagina); }

  leer(ref: LoteRef, celda: number): Float64Array {
    const pagina = Math.floor(celda / 256);
    const pares = this.#leerPagina(pagina).get(ref);
    if (!pares) throw new Error(`No existe el lote ${ref} en la página fría ${pagina}.`);
    return pares;
  }

  enfriar(arena: ArenaLotes, pagina: number, referencias: readonly LoteRef[]): void {
    if (!referencias.length || this.#errorEscritura || this.tiene(pagina)) return;
    const lotes = new Map<LoteRef, Float64Array>();
    for (const ref of referencias) {
      const lote = arena.muestra(ref);
      if (Math.floor(lote.celda / 256) !== pagina || (lote.rol !== Rol.Suelo && lote.rol !== Rol.Vida) || lotes.has(ref)) {
        throw new Error(`Lote ajeno o duplicado en la página fría ${pagina}.`);
      }
      lotes.set(ref, lote.pares);
    }
    const datos = serialize(lotes);
    let ruta: string | undefined;
    try {
      this.#directorio ??= mkdtempSync(join(this.raiz, 'atlas-materia-'));
      ruta = this.#ruta(pagina);
      writeFileSync(ruta, datos, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      this.#errorEscritura = (error as NodeJS.ErrnoException).code ?? 'desconocido';
      // El fallo suspende más escrituras y conserva todos los lotes de esta página en RAM.
      if (ruta && this.#errorEscritura !== 'EEXIST') {
        try { rmSync(ruta, { force: true }); } catch { /* El directorio se limpia al cerrar la instancia. */ }
      }
      return;
    }
    this.#paginas.set(pagina, { huella: digest(datos), bytes: datos.length, lotes: lotes.size });
    this.#cache = { pagina, lotes };
    const retirados: LoteRef[] = [];
    try {
      for (const ref of lotes.keys()) { arena.aparcar(ref); retirados.push(ref); }
    } catch (error) {
      for (const ref of retirados) arena.reponer(ref);
      this.#borrar(pagina);
      throw error;
    } finally { this.#cache = undefined; }
  }

  calentar(arena: ArenaLotes, pagina: number): void {
    if (!this.tiene(pagina)) return;
    const lotes = this.#leerPagina(pagina);
    this.contenido.prepararF0(lotes.size, LOTES_POR_BLOQUE);
    let desborde = 0;
    for (const [ref, pares] of lotes) if (arena.estaAparcado(ref)) {
      const calor = pares.length > 0 && pares[pares.length - 2] === 0;
      desborde += desbordeDeEspecies(pares.length / 2 - Number(calor));
    }
    this.desborde.prepararF0(desborde);
    for (const ref of lotes.keys()) if (arena.estaAparcado(ref)) arena.reponer(ref);
    this.#borrar(pagina);
  }

  medidas() {
    let bytesEnDisco = 0, lotesFrios = 0;
    for (const p of this.#paginas.values()) { bytesEnDisco += p.bytes; lotesFrios += p.lotes; }
    return { paginasFrias: this.#paginas.size, lotesFrios, bytesEnDisco, lotesFisicos: this.contenido.used,
      capacidadFisica: this.contenido.capacity, bytesFisicos: this.contenido.bytes, errorEscritura: this.#errorEscritura };
  }

  cerrar(): void {
    this.#cache = undefined;
    this.#paginas.clear();
    if (this.#directorio) rmSync(this.#directorio, { recursive: true, force: true });
    this.#directorio = undefined;
  }

  #ruta(pagina: number): string { return join(this.#directorio!, `${pagina}.bin`); }

  #leerPagina(pagina: number): Map<LoteRef, Float64Array> {
    if (this.#cache?.pagina === pagina) return this.#cache.lotes;
    const sello = this.#paginas.get(pagina);
    if (!sello) throw new Error(`Falta el archivo de la página fría ${pagina}.`);
    const datos = readFileSync(this.#ruta(pagina));
    if (datos.length !== sello.bytes || digest(datos) !== sello.huella) throw new Error(`Archivo frío corrupto en página ${pagina}.`);
    const lotes: Map<LoteRef, Float64Array> = deserialize(datos);
    this.#cache = { pagina, lotes };
    return lotes;
  }

  #borrar(pagina: number): void {
    unlinkSync(this.#ruta(pagina));
    this.#paginas.delete(pagina);
    if (this.#cache?.pagina === pagina) this.#cache = undefined;
  }
}
