import { renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CINTA, type Apertura, type Corte, type EntradaCatalogo, type Hito, type Nivel, type SeriePunto } from '../../shared/cinta.js';
import type { TapeClientDelta } from '../../shared/tape-delta.js';
import type { Tile, WorldView } from '../../shared/types.js';
import { CatalogoCinta, MAX_SEGMENTO, NIVELES, sincronizarDirectorio, type PuntoEscritura } from './catalogo.js';
import { clientDelta, codificarBloque } from './formato.js';
import { podar } from './poda.js';
import { reducir } from './reducir.js';

const FOTOGRAMAS_BLOQUE = 32;
export const PASO_MAXIMO = 32;
export const cintaDeMundo = (worldPath: string): string => join(dirname(worldPath), 'cinta');

interface BloquePendiente { base: WorldView; previo: WorldView; deltas: TapeClientDelta[] }
export interface OpcionesEscritor {
  directorio: string;
  topeBytes?: number;
  puntoEscritura?: (p: PuntoEscritura) => void;
}

export class EscritorCinta {
  private catalogo: CatalogoCinta;
  private readonly tope: number;
  private readonly margen: number;
  private readonly teselas = new Map<string, Tile>();
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

  constructor(private readonly opciones: OpcionesEscritor) {
    this.tope = opciones.topeBytes ?? CINTA.topeBytes;
    if (!Number.isSafeInteger(this.tope) || this.tope <= 0) throw new Error('Presupuesto de cinta inválido.');
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
    podar(this.catalogo, this.tope, undefined, 0, this.margen);
    this.epoca = this.catalogo.abrir(a);
    this.entradaEpoca = a.epoca;
    this.tMundo = a.tMundo;
    this.ultimoTick = -1;
    this.proximos.fill(0);
    this.proximaSerie = 0;
    this.teselas.clear();
    this.notables.clear();
    return this.epoca;
  }

  registrar(corte: Corte): void {
    const completo = corte.tilesCambiadas === 'todas';
    if (this.entradaEpoca === undefined || corte.epoca !== this.entradaEpoca
      || !Number.isSafeInteger(corte.seq) || corte.seq <= this.ultimaSecuencia || !Number.isSafeInteger(corte.t)
      || corte.t < this.tMundo || corte.t <= this.ultimoTick || corte.vista.tick !== corte.t
      || completo !== (this.ultimoTick < 0) || corte.serie.hz !== corte.hz) throw new Error('Corte fuera de época, secuencia o tick.');
    const anterior = this.ultimoTick < 0 ? this.tMundo : this.ultimoTick;
    if (corte.t - anterior > (this.ultimoTick < 0 ? 0 : PASO_MAXIMO)) {
      this.flush();
      this.hitos.push({ t: corte.t, importancia: 1, tipo: 'laguna', laguna: { t0: anterior, t1: corte.t } });
    }
    this.ultimaSecuencia = corte.seq;
    this.ultimoTick = corte.t;
    if (completo) this.teselas.clear();
    for (const tesela of corte.tilesCambiadas === 'todas' ? corte.vista.tiles : corte.tilesCambiadas) {
      this.teselas.set(`${tesela.x},${tesela.y}`, tesela);
    }
    for (const hito of corte.hitos) {
      this.hitos.push(hito);
      if (hito.tipo === 'suceso' && hito.importancia > 0) for (const id of hito.suceso.actors) this.notables.add(id);
    }
    for (const entrada of corte.catalogo) this.entradas.push(entrada);
    if (corte.t >= this.proximaSerie) this.registrarSerie(corte.epoca, { t: corte.t, ...corte.serie });
    const estado = { ...corte.vista, tiles: [...this.teselas.values()] };
    for (const nivel of NIVELES) {
      if (nivel > 0 && corte.t < (this.proximos[nivel] ?? 0)) continue;
      const paso = CINTA.pasos[nivel];
      this.proximos[nivel] = (Math.floor(corte.t / paso) + 1) * paso;
      const vista = reducir(nivel, estado, this.notables);
      const bloque = this.bloques[nivel];
      if (!bloque) this.bloques[nivel] = { base: vista, previo: vista, deltas: [] };
      else {
        bloque.deltas.push(clientDelta(bloque.previo, vista));
        bloque.previo = vista;
      }
      if (this.bloques[nivel]!.deltas.length + 1 >= FOTOGRAMAS_BLOQUE) this.escribir(nivel);
    }
  }

  registrarSerie(epoca: number, punto: SeriePunto): void {
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
    const data = codificarBloque(nivel, bloque.base, bloque.deltas);
    const ultimo = this.catalogo.segmentos().filter(s => s.nivel === nivel).at(-1);
    const segmento = ultimo?.epoca === this.epoca && ultimo.bytes + data.length <= MAX_SEGMENTO ? ultimo : undefined;
    podar(this.catalogo, this.tope, nivel, data.length, this.margen);
    this.catalogo.escribirBloque(this.epoca, data, segmento);
    this.bloques[nivel] = undefined;
  }

  private confirmarFlujos(): void {
    if (this.serie.length || this.hitos.length || this.entradas.length) {
      // Los flujos sin adelgazamiento también ocupan disco. Reserva sus páginas antes de publicar el lote.
      const bytes = Buffer.byteLength(JSON.stringify([this.serie, this.hitos, this.entradas]));
      podar(this.catalogo, this.tope, undefined, bytes * 3, this.margen);
      this.catalogo.flujos(this.epoca, this.serie, this.hitos, this.entradas);
      this.serie.length = this.hitos.length = this.entradas.length = 0;
    }
  }

  flush(): void {
    this.confirmarFlujos();
    for (const nivel of NIVELES) this.escribir(nivel);
  }

  estado(): { frames: number; latestTick: number } {
    const fila = this.catalogo.db.prepare('SELECT coalesce(sum(fotogramas),0) AS frames FROM bloques WHERE epoca=? AND nivel=0')
      .get(this.epoca)!;
    return { frames: Number(fila.frames), latestTick: this.ultimoTick };
  }

  close(confirmar = true): void {
    try { if (confirmar) this.flush(); } finally { this.catalogo.db.close(); }
  }
}
