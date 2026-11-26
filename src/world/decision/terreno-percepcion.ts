import type { Tile } from '../../shared/types.js';
import type { ChunkId, TerrenoDueno } from '../motor/contratos.js';
import type { TileLookup } from '../mundo/geometria.js';
import { RADIUS } from '../mundo/tipos.js';
import type { DestinoBarrera } from '../soa/barrera-percepcion.js';
import { ArenaTerreno, type ResidentFastAccess, type TerrenoCompartido } from '../soa/terreno.js';
import { CAMPOS_PERCEPCION, TERRENOS } from './planes.js';

const COORDINADOR = 0;
const CELDAS_PAGINA = 256;
/** Un NaN del SoA es un campo ausente: 0, como lo lee `choose`. */
const numero = (v: number): number => v === v ? v : 0;
/** Distintos para la percepción: también un cero que cambia de signo. */
const distinto = (a: number, b: number): boolean => a !== b || (a === 0 && 1 / a !== 1 / b);

interface VistaLocalPagina {
  readonly teselas: (Tile | undefined)[];
  readonly soa: Int32Array;
}

/**
 * El terreno que percibe el mundo: páginas 16 × 16 de `ArenaTerreno` (M1) con los campos de `CAMPOS_PERCEPCION`, que
 * viven lo que vive el mundo y que leen los hilos de la piscina y las tarjetas sobre los mismos SAB. Una página entra la
 * primera vez que el disco r = 7 de alguien la toca y no sale. `versionPagina` sube solo cuando lo que la página lleva
 * cambia: al sincronizarla con el mundo, si alguna celda difiere, y en la fase de personas cada vez que una ley escribe
 * una tesela suya (`barrera-percepcion.ts`), así que la tarjeta solo vuelve a subir las páginas que cambiaron. El dueño
 * sabe si el disco de alguien sigue como en F2 con las versiones de sus ≤ 4 páginas y, en las que cambiaron, con las
 * celdas que se escribieron desde la captura.
 *
 * Una celda sin tesela lleva `terreno` = 0 y `celda` la da por ausente. Los valores de páginas vecinas se leen del SAB.
 * Las referencias a teselas y las posiciones del SoA del heap propio se guardan solo en los bloques locales.
 */
export class TerrenoPercepcion extends ArenaTerreno implements DestinoBarrera {
  readonly valores: readonly Float64Array[];
  readonly duenoSiguiente: Int16Array;
  readonly #vistasLocales: (VistaLocalPagina | undefined)[] = [];
  /** Páginas comparadas con el mundo y cuántas de ellas habían cambiado, desde que se creó. */
  readonly cuentas = { sincronizadas: 0, cambiadas: 0 };
  #dueno: TerrenoDueno | undefined;
  /** Dueño que escribe las páginas desde esta copia: 0 en el coordinador y con un solo dueño. */
  #hilo = COORDINADOR;
  #px = NaN; #py = NaN; #chunk = -1;
  #epoca = 0;
  /** Por página: época y versión de su última sincronización, y versión y época de la captura de F2. */
  #sincronizadaEn = new Uint32Array(0);
  #versionSincronizada = new Uint32Array(0);
  #capturadaEn = new Uint32Array(0);
  #versionCaptura = new Uint32Array(0);
  #epocaCaptura = 0;
  #capturando = false;
  #vigilado = false;
  /** Por página: celdas que cambiaron desde la captura de F2 (época de la lista, lista y mapa de bits de 256 celdas). */
  #tocadaEn = new Uint32Array(0);
  #tocadas: number[][] = [];
  #bitsTocadas = new Uint32Array(0);
  readonly #enCaptura: number[] = [];
  readonly #lectura = new Float64Array(CAMPOS_PERCEPCION.length);

  constructor(verificar = false, compartido?: TerrenoCompartido) {
    super(verificar, compartido);
    this.duenoSiguiente = this.paginasMateria.field('duenoSiguiente', Int16Array, 1, -1);
    if (!compartido) for (const campo of CAMPOS_PERCEPCION) this.registrarCampo(campo, 'f64');
    this.valores = CAMPOS_PERCEPCION.map(campo => this.campo(campo) as Float64Array);
  }

  static override conectar(descriptor: TerrenoCompartido): TerrenoPercepcion {
    return new TerrenoPercepcion(descriptor.verificar, descriptor);
  }

  /** La copia de un dueño (motor de dueños): solo pone al día y marca las páginas cuyo `duenoChunk` es `hilo`. */
  static conectarDueno(descriptor: TerrenoCompartido, hilo: number): TerrenoPercepcion {
    const terreno = new TerrenoPercepcion(descriptor.verificar, descriptor);
    terreno.#hilo = hilo;
    terreno.#deDuenos = true;
    return terreno;
  }
  /** Con dueños por chunk, cada copia (también la del coordinador) respeta `duenoChunk`. */
  usarDuenos(): void { this.#deDuenos = true; }
  #deDuenos = false;
  #ajena(chunk: ChunkId): boolean { return this.#deDuenos && this.duenoChunk[chunk] !== this.#hilo; }

  /** Vista del heap propio, preparada al sincronizar y depurada de páginas vecinas en F2. */
  vistaLocal(chunk: ChunkId): VistaLocalPagina | undefined { return this.#vistasLocales[chunk]; }

  override celda(x: number, y: number): number {
    if ((x | 0) !== x || (y | 0) !== y) return -1;
    const chunk = this.#paginaDe(x >> 4, y >> 4);
    if (chunk < 0) return -1;
    const c = (chunk << 8) | ((y & 15) << 4) | (x & 15);
    return this.valores[0]![c]! > 0 ? c : -1;
  }

  /** Página residente de (px, py) o −1. Solo se guarda un acierto: las páginas no salen, pero pueden entrar. */
  #paginaDe(px: number, py: number): ChunkId {
    if (px === this.#px && py === this.#py) return this.#chunk;
    const c = super.celda(px << 4, py << 4);
    if (c < 0) return -1;
    this.#px = px; this.#py = py; this.#chunk = c >> 8;
    return this.#chunk;
  }

  // ── Solo en el hilo dueño ──────────────────────────────────────────────────────────────────────────────

  /** Empieza la captura de F2: las páginas se vuelven a comparar con el mundo, y hasta `soltar` la barrera de escritura
   * está abierta sobre este terreno. */
  empezarCaptura(): void {
    this.#epoca++;
    this.#enCaptura.length = 0;
    this.#capturando = true;
    this.#vigilado = true;
  }

  /** Cierra la fase: sin barrera, el mundo puede cambiar sin que suba ninguna versión, así que toda página se vuelve a
   * comparar entera antes de percibir sobre ella. */
  soltar(): void { this.#vigilado = false; this.#capturando = false; }

  /** Las páginas del disco r = 7 de (cx, cy), al día con el mundo de ahora. */
  capturarDisco(cx: number, cy: number, tileIn: TileLookup, fast: ResidentFastAccess | undefined): void {
    if ((cx | 0) !== cx || (cy | 0) !== cy) return;
    const px0 = (cx - RADIUS) >> 4, px1 = (cx + RADIUS) >> 4, py0 = (cy - RADIUS) >> 4, py1 = (cy + RADIUS) >> 4;
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
      let chunk = this.#paginaDe(px, py);
      // Con dueños, la arena crece solo en F0 (coordinador) y una página ajena se lee como la dejó su dueño.
      if (chunk < 0) { if (this.#deDuenos) continue; chunk = this.#alta(px, py); }
      this.#reservar(chunk);
      if (this.#ajena(chunk)) {
        this.#vistasLocales[chunk] = undefined;
      } else if (!this.#vigilado || this.#sincronizadaEn[chunk] !== this.#epoca || this.versionPagina[chunk] !== this.#versionSincronizada[chunk]) {
        // Con la barrera abierta y la misma versión, nadie la tocó desde la sincronización.
        this.#sincronizar(chunk, tileIn, fast);
      }
      if (this.#capturando && this.#capturadaEn[chunk] !== this.#epoca) { this.#capturadaEn[chunk] = this.#epoca; this.#enCaptura.push(chunk); }
    }
  }

  /** Cierra la captura de F2: desde aquí, `vigenteDesdeCaptura` compara con estas versiones. */
  fijarCaptura(): void {
    for (const chunk of this.#enCaptura) this.#versionCaptura[chunk] = this.versionPagina[chunk]!;
    this.#epocaCaptura = this.#epoca;
    this.#capturando = false;
  }

  /** Páginas de la última captura de F2. */
  get paginasCapturadas(): readonly number[] { return this.#enCaptura; }

  /** ¿Sigue el disco r = 7 de (cx, cy) como en la captura de F2? Sí si sus páginas conservan la versión de la captura
   * o, en las que no, ninguna celda escrita desde entonces cae en el disco. Exacto mientras toda escritura pase por la
   * barrera: entonces lo percibido en F2 es lo mismo que se percibiría ahora. */
  vigenteDesdeCaptura(cx: number, cy: number): boolean {
    if ((cx | 0) !== cx || (cy | 0) !== cy) return false;
    const px0 = (cx - RADIUS) >> 4, px1 = (cx + RADIUS) >> 4, py0 = (cy - RADIUS) >> 4, py1 = (cy + RADIUS) >> 4;
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
      const chunk = this.#paginaDe(px, py);
      if (chunk < 0 || this.#capturadaEn[chunk] !== this.#epocaCaptura) return false;
      if (this.versionPagina[chunk] === this.#versionCaptura[chunk]) continue;
      if (this.#tocadaEn[chunk] !== this.#epocaCaptura) return false;
      const x0 = px << 4, y0 = py << 4;
      for (const o of this.#tocadas[chunk]!) {
        const dx = x0 + (o & 15) - cx, dy = y0 + (o >> 4) - cy;
        if (dx * dx + dy * dy <= RADIUS * RADIUS) return false;
      }
    }
    return true;
  }

  /** Barrera de escritura: una ley escribió un campo percibido de la tesela (x, y). */
  tocar(x: number, y: number): void {
    if ((x | 0) !== x || (y | 0) !== y) return;
    const chunk = this.#paginaDe(x >> 4, y >> 4);
    if (chunk < 0 || this.#ajena(chunk)) return;
    this.#reservar(chunk);
    this.#escritura().marcar(chunk, true);
    this.#anotar(chunk, ((y & 15) << 4) | (x & 15));
  }

  /** Tras la captura y con la barrera abierta, la celda `o` de la página cambió (o pudo cambiar). */
  #anotar(chunk: ChunkId, o: number): void {
    if (!this.#vigilado || this.#capturando) return;
    const bits = chunk << 3;
    if (this.#tocadaEn[chunk] !== this.#epoca) {
      this.#tocadaEn[chunk] = this.#epoca;
      this.#tocadas[chunk]!.length = 0;
      this.#bitsTocadas.fill(0, bits, bits + 8);
    }
    const palabra = bits + (o >> 5), bit = 1 << (o & 31);
    if (this.#bitsTocadas[palabra]! & bit) return;
    this.#bitsTocadas[palabra]! |= bit;
    this.#tocadas[chunk]!.push(o);
  }

  /**
   * ¿Lleva la página lo mismo que el mundo de ahora en el disco r = 7 de (cx, cy)? Es la comparación de valores, celda a
   * celda, que hacía el dueño antes de las versiones de página: aquí solo sirve de oráculo de la barrera y para medir.
   */
  coincideConMundo(cx: number, cy: number, tileIn: TileLookup, fast: ResidentFastAccess | undefined, valores: readonly Float64Array[] = this.valores): boolean {
    if ((cx | 0) !== cx || (cy | 0) !== cy) return false;
    const leido = this.#lectura;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
      const x = cx + dx, y = cy + dy, chunk = this.#paginaDe(x >> 4, y >> 4);
      if (chunk < 0) return false;
      const c = (chunk << 8) | ((y & 15) << 4) | (x & 15);
      this.#leer(x, y, tileIn(x, y), fast, leido);
      for (let k = 0; k < valores.length; k++) if (distinto(valores[k]![c]!, leido[k]!)) return false;
    }
    return true;
  }

  #escritura(): TerrenoDueno { return this.#dueno ??= this.escritura(this.#hilo); }

  /** F0, solo el coordinador: la página de (px, py), dándola de alta para `hilo` si no estaba. Las páginas no salen de
   * la arena aunque su chunk se retire: quedan con `terreno` = 0 (celdas ausentes) y vuelven a llenarse si se reactiva. */
  asegurarPagina(px: number, py: number, hilo = COORDINADOR): ChunkId {
    let chunk = this.#paginaDe(px, py);
    if (chunk < 0) { chunk = this.alta(px, py, hilo); this.#reservar(chunk); }
    return chunk;
  }
  /** La página de (px, py) si es residente, o −1. */
  paginaDe(px: number, py: number): ChunkId { return this.#paginaDe(px, py); }

  /** Pone al día una página propia con las teselas de este dueño (al activarla, al adoptarla y al publicar en F6). */
  sincronizarPagina(chunk: ChunkId, tileIn: TileLookup, fast: ResidentFastAccess | undefined): void {
    this.#reservar(chunk);
    this.#sincronizar(chunk, tileIn, fast);
  }
  /** Las 256 celdas de una página propia pasan a ausentes (su chunk se retira o se cede). */
  vaciarPagina(chunk: ChunkId): void {
    this.#reservar(chunk);
    const base = chunk << 8;
    for (const valores of this.valores) valores.fill(0, base, base + CELDAS_PAGINA);
    this.#vistasLocales[chunk] = undefined;
    this.#escritura().marcar(chunk, true);
  }

  #alta(px: number, py: number): ChunkId {
    const chunk = this.alta(px, py, COORDINADOR);
    this.#reservar(chunk);
    return chunk;
  }

  /** Estado local de la página `chunk` en este hilo (una copia conectada no da altas: crece al ver la página). */
  #reservar(chunk: ChunkId): void {
    if (chunk >= this.#sincronizadaEn.length) {
      const cap = Math.max(64, 2 * (chunk + 1));
      const crecer = (previo: Uint32Array): Uint32Array<ArrayBuffer> => { const nuevo = new Uint32Array(cap); nuevo.set(previo); return nuevo; };
      this.#sincronizadaEn = crecer(this.#sincronizadaEn); this.#versionSincronizada = crecer(this.#versionSincronizada);
      this.#capturadaEn = crecer(this.#capturadaEn); this.#versionCaptura = crecer(this.#versionCaptura);
      this.#tocadaEn = crecer(this.#tocadaEn);
      const bits = new Uint32Array(cap * 8);
      bits.set(this.#bitsTocadas);
      this.#bitsTocadas = bits;
      while (this.#tocadas.length < cap) {
        this.#tocadas.push([]);
        this.#vistasLocales.push(undefined);
      }
    }
  }

  /** Copia en la página lo que el mundo lleva ahora en sus 256 celdas y sube su versión si algo cambió. Una celda que
   * cambió tras la captura se anota como escrita aunque la barrera no la viera. */
  #sincronizar(chunk: ChunkId, tileIn: TileLookup, fast: ResidentFastAccess | undefined): void {
    const x0 = this.paginaX[chunk]! << 4, y0 = this.paginaY[chunk]! << 4, base = chunk << 8, leido = this.#lectura;
    const valores = this.valores, n = valores.length;
    let cambio = false, hayTeselas = false, local = this.#vistasLocales[chunk];
    for (let o = 0; o < CELDAS_PAGINA; o++) {
      const c = base + o, x = x0 + (o & 15), y = y0 + (o >> 4), tile = tileIn(x, y);
      const soa = this.#leer(x, y, tile, fast, leido);
      if (tile) {
        hayTeselas = true;
        local ??= { teselas: new Array<Tile | undefined>(CELDAS_PAGINA).fill(undefined), soa: new Int32Array(CELDAS_PAGINA).fill(-1) };
      }
      if (local) { local.teselas[o] = tile; local.soa[o] = soa; }
      for (let k = 0; k < n; k++) {
        const v = leido[k]!;
        if (distinto(valores[k]![c]!, v)) { valores[k]![c] = v; cambio = true; this.#anotar(chunk, o); }
      }
    }
    if (local) this.#vistasLocales[chunk] = hayTeselas ? local : undefined;
    this.cuentas.sincronizadas++;
    if (cambio) { this.#escritura().marcar(chunk, true); this.cuentas.cambiadas++; }
    this.#sincronizadaEn[chunk] = this.#epoca;
    this.#versionSincronizada[chunk] = this.versionPagina[chunk]!;
  }

  /** Escribe los campos percibidos y devuelve su posición en el SoA local (−1 si no está). */
  #leer(x: number, y: number, tile: Tile | undefined, fast: ResidentFastAccess | undefined, out: Float64Array): number {
    let s = -1;
    if (!tile) out.fill(0);
    else {
      s = fast?.exact ? fast.exact.cellAt(x, y) : -1;
      if (fast && s < 0) s = fast.cellOf(tile);
      if (s >= 0) {
        out[0] = fast!.terrainArr[s]!;
        out[1] = numero(fast!.foodArr[s]!); out[2] = numero(fast!.drinkingWaterArr[s]!); out[3] = numero(fast!.woodArr[s]!);
        out[5] = numero(fast!.moistureArr[s]!); out[6] = numero(fast!.vegetationArr[s]!);
      } else {
        out[0] = TERRENOS.indexOf(tile.terrain) + 1;
        out[1] = tile.food; out[2] = tile.drinkingWater ?? 0; out[3] = tile.wood ?? 0;
        out[5] = tile.moisture; out[6] = tile.vegetation;
      }
      out[4] = tile.stone ?? 0;
    }
    return s;
  }
}
