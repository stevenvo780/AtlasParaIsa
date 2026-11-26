import { existsSync, realpathSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as igual } from 'node:util';
import { CINTA, type Apertura, type Corte, type EntradaCatalogo, type Hito, type Nivel, type SeriePunto } from '../../shared/cinta.js';
import type { PersonView, Tile, WorldView } from '../../shared/types.js';
import { CatalogoCinta, MAX_SEGMENTO, NIVELES, sincronizarDirectorio, type PuntoEscritura } from './catalogo.js';
import { clientDelta, crearCodificadorBloque, cotaIndiceBloque } from './formato.js';
import { CuerpoBloqueCinta } from './bloque-temporal.js';
import { podar, RESERVA_DISCO } from './poda.js';
import { reducir, reducirTesela } from './reducir.js';

const FOTOGRAMAS_BLOQUE = 32;
const PRESUPUESTO_CUERPO_BLOQUE = 16 * 1024 ** 2;
export const PASO_MAXIMO = 32;
export function cintaDeMundo(worldPath: string, directorio?: string): string {
  if (!directorio) return join(dirname(worldPath), 'cinta');
  if (!isAbsolute(directorio)) throw new Error('CARTA_CINTA_DIR debe ser una ruta absoluta.');
  if (!statSync(directorio, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('CARTA_CINTA_DIR debe ser un directorio ya creado en el volumen de la cinta.');
  }
  const cinta = realpathSync.native(directorio);
  const mundo = dirname(resolve(worldPath));
  const datos = existsSync(mundo) ? realpathSync.native(mundo) : mundo;
  const desdeCinta = relative(cinta, datos);
  // El escritor puede mover una cinta huérfana al abrir una instancia nueva.
  if (!isAbsolute(desdeCinta) && desdeCinta !== '..' && !desdeCinta.startsWith(`..${sep}`)) {
    throw new Error('CARTA_CINTA_DIR debe estar separado del directorio que contiene el mundo.');
  }
  return cinta;
}

interface BloquePendiente {
  cuerpo: CuerpoBloqueCinta;
  codificador: ReturnType<typeof crearCodificadorBloque>;
  previo: WorldView;
  fotogramas: number;
  cabe: ReturnType<typeof cotaIndiceBloque>;
}
export interface OpcionesEscritor {
  directorio: string;
  topeBytes?: number;
  memoriaCuerpoBloqueBytes?: number;
  puntoEscritura?: (p: PuntoEscritura) => void;
}

export class EscritorCinta {
  private catalogo: CatalogoCinta;
  private readonly tope: number;
  private readonly margen: number;
  private readonly memoriaCuerpoBloque: number;
  // Las teselas se siguen por coordenada para que un fotograma cueste lo que cambió y no lo que el mundo mide:
  // el espejo de L0, lo último grabado en L1 y L2, y lo tocado desde el último fotograma de L0, L1 y L2.
  private readonly teselas = new Map<string, Tile>();
  private readonly grabadas = [new Map<string, Tile>(), new Map<string, Tile>()];
  private readonly sucias = [new Set<string>(), new Set<string>(), new Set<string>()];
  private readonly notables = new Set<string>();
  private readonly bloques: (BloquePendiente | undefined)[] = [];
  private readonly proximos: number[] = [];
  private readonly serie: SeriePunto[] = [];
  private readonly hitos: Hito[] = [];
  private readonly entradas: EntradaCatalogo[] = [];
  private proximaSerie = 0;
  private entradaEpoca: number | undefined;
  private epoca = -1;
  private tMundo = 0;
  private ultimoTick = -1;
  private ultimaSecuencia = -1;
  private fallo: { causa: unknown } | undefined;

  constructor(private readonly opciones: OpcionesEscritor) {
    this.tope = opciones.topeBytes ?? CINTA.topeBytes;
    if (!Number.isSafeInteger(this.tope) || this.tope <= 0) throw new Error('Presupuesto de cinta inválido.');
    this.memoriaCuerpoBloque = opciones.memoriaCuerpoBloqueBytes ?? PRESUPUESTO_CUERPO_BLOQUE;
    if (!Number.isSafeInteger(this.memoriaCuerpoBloque) || this.memoriaCuerpoBloque < 0) {
      throw new Error('Presupuesto de memoria para el bloque de cinta inválido.');
    }
    this.margen = Math.min(16 * 1024 ** 2, Math.max(64 * 1024, Math.floor(0.02 * this.tope)));
    this.catalogo = new CatalogoCinta(opciones.directorio, opciones.puntoEscritura);
  }

  abrir(a: Apertura, hitosPrevios: readonly Hito[] = []): number {
    if (!a.instanciaId || !Number.isSafeInteger(a.epoca) || a.epoca < 0 || !Number.isSafeInteger(a.tMundo) || a.tMundo < 0) {
      throw new Error('Apertura de cinta inválida.');
    }
    if (hitosPrevios.length && this.entradaEpoca === undefined) throw new Error('No hay época anterior para los hitos pendientes.');
    for (const hito of hitosPrevios) this.hitos.push(hito);
    this.flush();
    const anterior = this.catalogo.ultimaEpoca();
    if (anterior && anterior.instanciaId !== a.instanciaId) {
      const path = this.catalogo.directorio;
      this.catalogo.db.close();
      renameSync(path, `${path}.huerfana-${Date.now()}-${randomUUID()}`);
      sincronizarDirectorio(dirname(path));
      this.catalogo = new CatalogoCinta(path, this.opciones.puntoEscritura);
    }
    podar(this.catalogo, this.tope, undefined, 0, { margen: this.margen });
    this.epoca = this.catalogo.abrir(a);
    this.entradaEpoca = a.epoca;
    this.tMundo = a.tMundo;
    this.ultimoTick = -1;
    this.proximos.fill(0);
    this.proximaSerie = 0;
    this.olvidarTeselas();
    this.notables.clear();
    return this.epoca;
  }

  private olvidarTeselas(): void {
    this.teselas.clear();
    for (const mapa of this.grabadas) mapa.clear();
    for (const claves of this.sucias) claves.clear();
  }

  /** Teselas del nivel que cambiaron desde su fotograma anterior; el orden de inserción es el del aplicador compartido. */
  private parcheTeselas(nivel: Nivel): Tile[] {
    const sucias = this.sucias[nivel];
    if (!sucias) return [];
    const grabadas = nivel === 0 ? undefined : this.grabadas[nivel - 1]!;
    const parche: Tile[] = [];
    for (const clave of sucias) {
      const tesela = reducirTesela(nivel, this.teselas.get(clave)!)!;
      if (grabadas) {
        if (igual(grabadas.get(clave), tesela)) continue;
        grabadas.set(clave, tesela);
      }
      parche.push(tesela);
    }
    sucias.clear();
    return parche;
  }

  // Quien ya no vive no vuelve a L3: el conjunto no crece con la historia de la época.
  private olvidarAusentes(personas: readonly PersonView[]): void {
    const vivas = new Set(personas.map(p => p.id));
    for (const id of this.notables) if (!vivas.has(id)) this.notables.delete(id);
  }

  private teselasDe(nivel: Nivel): Tile[] {
    if (nivel === 0) return [...this.teselas.values()];
    return [...this.grabadas[nivel - 1]?.values() ?? []];
  }

  registrar(corte: Corte, serieAutomatica = true): void {
    this.comprobarActivo();
    const completo = corte.tilesCambiadas === 'todas';
    if (this.entradaEpoca === undefined || corte.epoca !== this.entradaEpoca
      || !Number.isSafeInteger(corte.seq) || corte.seq <= this.ultimaSecuencia || !Number.isSafeInteger(corte.t)
      || corte.t < this.tMundo || corte.t <= this.ultimoTick || corte.vista.tick !== corte.t
      || completo !== (this.ultimoTick < 0) || corte.serie.hz !== corte.hz) throw new Error('Corte fuera de época, secuencia o tick.');
    try { this.registrarCorte(corte, completo, serieAutomatica); }
    catch (error) { this.abortar(error); }
  }

  private registrarCorte(corte: Corte, completo: boolean, serieAutomatica: boolean): void {
    const anterior = this.ultimoTick < 0 ? this.tMundo : this.ultimoTick;
    const declarada = corte.hitos.some(h => h.tipo === 'laguna' && h.laguna.t0 === anterior && h.laguna.t1 === corte.t);
    if (declarada || corte.t - anterior > (this.ultimoTick < 0 ? 0 : PASO_MAXIMO)) {
      this.flush();
      if (!declarada) this.hitos.push({ t: corte.t, importancia: 1, tipo: 'laguna', laguna: { t0: anterior, t1: corte.t } });
    }
    this.ultimaSecuencia = corte.seq;
    this.ultimoTick = corte.t;
    if (completo) this.olvidarTeselas();
    for (const tesela of corte.tilesCambiadas === 'todas' ? corte.vista.tiles : corte.tilesCambiadas) {
      const clave = `${tesela.x},${tesela.y}`;
      if (igual(this.teselas.get(clave), tesela)) continue;
      this.teselas.set(clave, tesela);
      for (const claves of this.sucias) claves.add(clave);
    }
    for (const hito of corte.hitos) {
      this.hitos.push(hito);
      if (hito.tipo === 'suceso' && hito.importancia > 0) for (const id of hito.suceso.actors) this.notables.add(id);
    }
    for (const entrada of corte.catalogo) this.entradas.push(entrada);
    if (serieAutomatica && corte.t >= this.proximaSerie) this.registrarSerie(corte.epoca, { t: corte.t, ...corte.serie });
    const sinTeselas = { ...corte.vista, tiles: [] };
    for (const nivel of NIVELES) {
      if (nivel > 0 && corte.t < (this.proximos[nivel] ?? 0)) continue;
      const paso = CINTA.pasos[nivel];
      this.proximos[nivel] = (Math.floor(corte.t / paso) + 1) * paso;
      if (nivel === 3) this.olvidarAusentes(corte.vista.people);
      // Las deltas se calculan sin teselas y llevan aparte el parche por coordenada.
      const vista = reducir(nivel, sinTeselas, this.notables);
      const parche = this.parcheTeselas(nivel);
      const bloque = this.bloques[nivel];
      if (bloque) {
        const delta = clientDelta(bloque.previo, vista);
        if (parche.length) delta.tilesPatch = parche;
        if (bloque.cabe(delta)) {
          bloque.codificador.agregar(delta);
          bloque.previo = vista;
          bloque.fotogramas++;
          if (bloque.fotogramas >= FOTOGRAMAS_BLOQUE) this.escribir(nivel);
          continue;
        }
        this.escribir(nivel);
      }
      const base = { ...vista, tiles: this.teselasDe(nivel) };
      const cabe = cotaIndiceBloque(base);
      const cuerpo = new CuerpoBloqueCinta(this.catalogo.directorio, this.memoriaCuerpoBloque, RESERVA_DISCO + this.margen);
      try {
        const codificador = crearCodificadorBloque(nivel, base, parte => cuerpo.agregar(parte));
        this.bloques[nivel] = { cuerpo, codificador, previo: vista, cabe, fotogramas: 1 };
      } catch (error) {
        try { cuerpo.cerrar(); } catch { /* conserva el fallo de codificación */ }
        throw error;
      }
    }
  }

  registrarSerie(epoca: number, punto: SeriePunto): void {
    this.comprobarActivo();
    if (epoca !== this.entradaEpoca || !Number.isSafeInteger(punto.t) || punto.t < this.tMundo || punto.t < this.proximaSerie) {
      throw new Error('Punto de serie fuera de época o cadencia.');
    }
    this.serie.push(punto);
    this.proximaSerie = (Math.floor(punto.t / CINTA.seriePaso) + 1) * CINTA.seriePaso;
  }

  private escribir(nivel: Nivel): void {
    const bloque = this.bloques[nivel];
    if (!bloque) return;
    this.confirmarFlujos();
    const { cuerpo, codificador } = bloque;
    const { indice, bytes } = codificador.cerrar();
    const ultimo = this.catalogo.segmentos().filter(s => s.nivel === nivel).at(-1);
    const segmento = ultimo?.epoca === this.epoca && ultimo.bytes + bytes <= MAX_SEGMENTO ? ultimo : undefined;
    cuerpo.prepararDestino(bytes);
    podar(this.catalogo, this.tope, nivel, bytes, { margen: this.margen });
    this.catalogo.escribirBloqueLeido(this.epoca, cuerpo.lector(indice, bytes), bytes, segmento);
    this.bloques[nivel] = undefined;
    cuerpo.cerrar();
  }

  private confirmarFlujos(): void {
    if (this.serie.length || this.hitos.length || this.entradas.length) {
      // Los flujos sin adelgazamiento también ocupan disco. Reserva sus páginas antes de publicar el lote.
      const bytes = Buffer.byteLength(JSON.stringify([this.serie, this.hitos, this.entradas]));
      podar(this.catalogo, this.tope, undefined, bytes * 3, { margen: this.margen });
      this.catalogo.flujos(this.epoca, this.serie, this.hitos, this.entradas);
      this.serie.length = this.hitos.length = this.entradas.length = 0;
    }
  }

  flush(): void {
    this.comprobarActivo();
    try {
      this.confirmarFlujos();
      for (const nivel of NIVELES) this.escribir(nivel);
    } catch (error) { this.abortar(error); }
  }

  private comprobarActivo(): void {
    if (this.fallo) throw this.fallo.causa;
  }

  private descartarBloques(): void {
    const errores: unknown[] = [];
    for (const bloque of this.bloques.splice(0)) {
      try { bloque?.cuerpo.cerrar(); }
      catch (error) { errores.push(error); }
    }
    if (errores.length) throw errores[0];
  }

  private abortar(error: unknown): never {
    this.fallo = { causa: error };
    try { this.descartarBloques(); } catch { /* conserva el fallo que interrumpió el grabador */ }
    throw error;
  }

  estado(): { frames: number; latestTick: number } {
    const fila = this.catalogo.db.prepare('SELECT coalesce(sum(fotogramas),0) AS frames FROM bloques WHERE epoca=? AND nivel=0')
      .get(this.epoca)!;
    return { frames: Number(fila.frames), latestTick: this.ultimoTick };
  }

  close(confirmar = true): void {
    try {
      if (confirmar) this.flush();
      else this.descartarBloques();
    } catch (error) {
      try { this.catalogo.db.close(); } catch { /* conserva el fallo del cierre del grabador */ }
      throw error;
    }
    this.catalogo.db.close();
  }
}
