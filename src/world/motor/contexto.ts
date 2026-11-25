/**
 * El dueño de una parte del mundo y su contexto de ley (carril m4a; ARQ-motor §3.1 y `motor/acceso.ts`).
 *
 * Un `Dueno` ES el `CtxLey` (y el `CtxF0` en el coordinador) que reciben las leyes: con un solo dueño se arma sobre el
 * `World` de siempre (`duenoDe`), y con varios hay uno por hilo sobre su parte del mundo y la memoria compartida
 * (`motor/coordinador.ts` y `motor/dueno-worker.ts`). Las fases del tick las conduce quien lo tiene: `mundo/paso.ts` con
 * un dueño (intercalando los pasos heredados que ninguna ley sustituye) y `faseDueno` con varios. Los ganchos, el orden
 * y lo que hace el motor en cada fase están aquí, una sola vez.
 *
 * Mensajes del motor: viajan por los buzones como `Gesto` (del coordinador a un dueño, cola B: llegan en F1 del mismo
 * tick), `Global` (de un dueño al coordinador, cola F0) y `Migrante` (un chunk o un organismo que cambia de dueño). El
 * buzón que ven las leyes (`c.buzon`) los aparta al vaciar una cola: el aplicador de m5 nunca los recibe.
 */
import { deserialize, serialize } from 'node:v8';
import { enlaceCinta, type DescriptorEnlace, type EnlaceCinta, type SucesoVisible } from '../../shared/fotograma.js';
import { NE, NU, R } from '../../shared/naturaleza.js';
import type { ChronicleEvent, CommunityView, Gesture, GestureResult, PlaceView, Tile } from '../../shared/types.js';
import type { StructureView } from '../../shared/life.js';
import { applyGesture } from '../actuar/gestos.js';
import { faunaCacheAppended, faunaCacheFiltered, type Animal } from '../animals.js';
import { percepcionDe, olvidarPercepcion } from '../decision/percepcion.js';
import type { TerrenoPercepcion } from '../decision/terreno-percepcion.js';
import { ArenaLotes, LOTES_POR_BLOQUE, ranurasDesborde } from '../materia/arena.js';
import { codificarEnVuelo, codificarPaginas, decodificarEnVuelo, decodificarPaginas, saldoEnVuelo, type LoteGuardado } from '../materia/checkpoint.js';
import { plegarLibros, sumarEnVuelo, type TotalesMateria } from '../materia/libro.js';
import { sustanciasMundo } from '../materia/mundo.js';
import { cargarSustancias, crearServicioQuimico, serializarSustancias, type ServicioQuimicoImpl } from '../materia/servicio.js';
import { barreraEfectiva, nivelDeLote, type ArenaMateria, type Kappa, type Libro, type LoteRef, type MateriaCheckpoint, type ServicioQuimico, type Sustancia } from '../materia/tipos.js';
import { addEvent, random } from '../mundo/crear.js';
import { MAX_EVENTS, TICKS_PER_DAY, type Person, type World, type WorldContext } from '../mundo/tipos.js';
import { paramsOf, type WorldParams } from '../params.js';
import { PageArena } from '../soa/arena.js';
import { olvidarOrganismos, organismosDe, type OrganismosMundo } from '../soa/organismos-mundo.js';
import { residentFastAccess } from '../soa/terreno.js';
import { maintainRegions, observarRegiones, type ChunkMeta } from '../spatial.js';
import { tileIndexAppended, tileLookup } from '../tile-index.js';
import { ctxSi, enlazarCtx, type CtxF0, type Ley } from './acceso.js';
import { aplicarCola } from './aplicar.js';
import { Buzones, type FaseMotor } from './buzon.js';
import { Contadores, crearLibros } from './contadores.js';
import {
  Clase, REF_NULA, TipoIntento, genDe, refDe, slotDe,
  type Buzon, type ChunkId, type FrenteEscritura, type FrentePublico, type Globales, type Hilo, type Intento, type Ref, type Slot,
  type Terreno, type TerrenoDueno,
} from './contratos.js';
import { abrirFotograma, cerrarFotograma, enlazarFuenteFotograma, escribirFotograma, type FotogramaEnCurso, type FuenteFotograma } from './fotograma.js';
import { leyesActivas } from './leyes.js';
import { RegistroContenido } from './registro.js';

// ── Constantes ───────────────────────────────────────────────────────────────────────────────────────────

/** Temperatura corporal (K) a la que la arena valora lo digerible de una sustancia. Es la misma `T_CUERPO` de
 * `materia/mundo.ts`, que no la exporta: el integrador las une en `shared/naturaleza.ts`. */
export const T_DIGESTION_K = 310;
/** Reserva virtual de ranuras de la arena de lotes y de su desborde (las mismas de `materia/mundo.ts`). No es memoria
 * usada: agotarla es fatal. */
export const RESERVA_LOTES = 2 ** 23;
export const RESERVA_DESBORDE = 2 ** 25;
/** Lotes libres que el coordinador garantiza en F0 por cada chunk que se activa en el tick (3 por tesela y el aire de
 * la página, redondeado a bloques de 256) y, además, una holgura igual a los lotes en uso (crías, objetos, cadáveres):
 * la arena solo crece en F0 y quedarse sin ranuras a mitad de tick es fatal. Es política de memoria, no una ley. */
export const LOTES_POR_CHUNK_NUEVO = 1024;
/** Ticks de memoria del directorio de identidades tras una muerte (un día: `CtxLey.idDe`). */
export const MEMORIA_DIRECTORIO_TICKS = TICKS_PER_DAY;
/** Espacio de nonces que se salta al abrir una época, por tick ya vivido: mayor que los intentos que caben en un tick,
 * para que un nonce nuevo nunca repita uno anterior al guardado aunque el contador no se guarde. */
const NONCES_POR_TICK = 2 ** 22;

/** Órdenes del coordinador a un dueño (`Gesto`, dato[0]). */
export const ORDEN = { gesto: 0, replica: 1, ceder: 2, detalle: 3, directorio: 4 } as const;
/** Avisos de un dueño al coordinador (`Global`, dato[0]). */
export const AVISO = { lugar: 0, comunidad: 1, resultado: 2, tick: 3, parte: 4, detalle: 5, chunk: 6 } as const;

/** Celdas del control compartido del motor (Float64 sobre SAB). Las de cada dueño empiezan en `CTL.porDueno`. */
export const CTL = { tick: 0, epoca: 1, fotoRanura: 2, fotoCompleto: 3, fotoInvalido: 4, lluvia: 5, porDueno: 8 } as const;
export const CTL_DUENO = { msF1: 0, msEco: 1, msPercibir: 2, msActuar: 3, msAplicar: 4, msTick: 5, intentos: 6, rechazados: 7, migraciones: 8, recibidos: 9, celdas: 10 } as const;
export const celdaDueno = (hilo: Hilo, campo: number): number => CTL.porDueno + hilo * CTL_DUENO.celdas + campo;

/** Un chunk que cambia de dueño (o llega a su primer dueño), con todo lo que hay en él. Los organismos viajan con la fila
 * que ya tenían en la tabla. Los lotes de materia no
 * viajan: están en la arena compartida y cambian de dueño con `duenoChunk`. */
export interface MigranteChunk {
  tipo: 'chunk'; chunk: ChunkId; key: string; meta: ChunkMeta; tiles: Tile[]; structures: StructureView[];
  animals: Animal[]; personas: { persona: Person; ref: Ref }[];
  refsFauna?: Ref[];
  /** Reparto al abrir la época: no es una activación (lo cubre `Ley.iniciar`). */
  inicial: boolean;
}
/** Un organismo que cruzó a un chunk de otro dueño. */
export interface MigranteOrganismo { tipo: 'organismo'; persona?: { persona: Person; ref: Ref }; animal?: { animal: Animal; ref: Ref } }
export type Migrante = MigranteChunk | MigranteOrganismo;

/** Lo que cada dueño manda al coordinador al cerrar el tick. */
export interface ParteTick { hilo: Hilo; sucesos: ChronicleEvent[]; visibles: SucesoVisible[]; altas: [uid: number, id: string][] }

/** Lo que un dueño recibe ya armado sobre la memoria compartida. Con un solo dueño lo arma `duenoDe`. */
export interface PiezasDueno {
  hilo: Hilo; hilos: number;
  /** Solo quien fija la fase (el coordinador, o el único dueño). */
  buzones: Buzones | null;
  buzon: Buzon;
  libros: Libro[];
  /** null con un solo dueño: los ids salen de los contadores del propio mundo. */
  contadores: Contadores | null;
  registro: RegistroContenido;
  azar: () => number;
  control: Float64Array | null;
  /** Memoria de la materia ya creada (varios dueños) o null para que el dueño la cree al encender `v23.materia`. */
  materia: { lotes: PageArena; desborde: PageArena; quimica: ServicioQuimicoImpl } | null;
  enlace: DescriptorEnlace | null;
}

type GanchoFase = 'F1' | 'eco' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';
const intento = (tipo: TipoIntento, dato: number[], bytes: Uint8Array | null): Intento =>
  ({ tipo, de: REF_NULA, a: REF_NULA, celda: -1, lote: REF_NULA, nonce: 0, materia: null, dato: Float64Array.from(dato), bytes });

/** Una celda en el punto de control: la posición de su página, no su ranura en la arena (que cambia de una carga a
 * otra). |px|, |py| < 2²⁰ (MAX_COORDINATE / 16), así que cabe exacta en un double y conserva `celda % 256`. */
const SESGO_PAGINA = 2 ** 20, ANCHO_PAGINA = 2 ** 21;
export function celdaMundo(terreno: Pick<Terreno, 'paginaX' | 'paginaY'>, celda: number): number {
  if (celda < 0) return -1;
  const chunk = celda >> 8;
  return ((terreno.paginaX[chunk]! + SESGO_PAGINA) * ANCHO_PAGINA + terreno.paginaY[chunk]! + SESGO_PAGINA) * 256 + (celda & 255);
}
/** La celda de la arena de ahora para una del punto de control; da de alta la página si no está (solo el coordinador). */
export function celdaLocal(terreno: TerrenoPercepcion, guardada: number): number {
  if (guardada < 0) return -1;
  const pagina = Math.floor(guardada / 256), px = Math.floor(pagina / ANCHO_PAGINA) - SESGO_PAGINA, py = pagina % ANCHO_PAGINA - SESGO_PAGINA;
  return terreno.asegurarPagina(px, py, 0) * 256 + guardada % 256;
}

// ── El dueño ─────────────────────────────────────────────────────────────────────────────────────────────

export class Dueno implements CtxF0 {
  readonly hilo: Hilo;
  readonly hilos: number;
  readonly buzon: Buzon;
  readonly libro: Libro;
  readonly registro: RegistroContenido;
  readonly globales: Globales;
  materia?: ArenaMateria;
  quimica?: ServicioQuimico;
  /** Leyes encendidas, en el orden de `LEYES`. */
  leyes: Ley[] = [];
  /** Época que abrió el motor (`Motor.cargar`); 0 mientras nadie la fija. */
  epoca = 0;
  /** Totales de materia del mundo ya plegados (solo el coordinador). */
  totales: TotalesMateria = { inicial: Array<bigint>(NE + 1).fill(0n), fuentes: Array<bigint>(NE + 1).fill(0n), sumideros: Array<bigint>(NE + 1).fill(0n) };
  /** Sucesos de este dueño en el tick: crónica (solo con varios dueños; con uno van directos al mundo) y lo visible. */
  readonly sucesosTick: ChronicleEvent[] = [];
  readonly visiblesTick: SucesoVisible[] = [];
  /** Órdenes de ceder un chunk recibidas en F1 y que se cumplen en F6: [chunk, destino] (−1 = retirar). */
  readonly cesiones: [ChunkId, Hilo][] = [];
  /** Avisos que no son peticiones de ley: los procesa quien conduce (el coordinador). */
  avisar: ((clase: number, i: Intento) => void) | undefined;

  readonly #piezas: PiezasDueno;
  readonly #interno: Buzon;
  readonly #activos = new Map<ChunkId, string>();
  #chunks: Int32Array | undefined;
  #firma = '';
  #escritura: { frente: FrentePublico; w: FrenteEscritura } | undefined;
  #propio: { terreno: TerrenoPercepcion; w: TerrenoDueno } | undefined;
  #indice: { frente: FrentePublico; refs: Map<number, Ref> } | undefined;
  #globalesDe = -1;
  readonly #idPorUid = new Map<number, string>();
  readonly #uidPorId = new Map<string, number>();
  readonly #muertoEn = new Map<number, number>();
  readonly #altas: [number, string][] = [];
  readonly #peticiones: Record<'lugar' | 'comunidad', Uint8Array[]> = { lugar: [], comunidad: [] };
  #nonce = 0;
  #enlace: EnlaceCinta | null = null;
  #foto: FotogramaEnCurso | null = null;
  #fotoValida = true;
  #pendientes: [ChunkId, string][] = [];
  #vaciar: ChunkId[] = [];

  constructor(readonly mundo: World, piezas: PiezasDueno) {
    this.#piezas = piezas;
    this.hilo = piezas.hilo; this.hilos = piezas.hilos;
    this.#interno = piezas.buzon;
    this.libro = piezas.libros[piezas.hilo]!;
    this.registro = piezas.registro;
    this.globales = { lugares: new Map(), comunidades: new Map(), registro: piezas.registro, version: 0 };
    this.buzon = {
      enviar: (destino, i) => {
        this.#contar(i.tipo === TipoIntento.Migrante ? CTL_DUENO.migraciones : i.tipo === TipoIntento.Devuelto ? CTL_DUENO.rechazados : CTL_DUENO.intentos);
        this.#interno.enviar(destino, i);
      },
      vaciar: (cola, f) => this.#interno.vaciar(cola, i => {
        if (this.#aplicarMotor(i)) return;
        f(i);
        this.#contar(CTL_DUENO.recibidos);
      }),
    };
    if (piezas.enlace) this.enlazar(piezas.enlace);
    this.#nonce = (mundo.tick + 1) * NONCES_POR_TICK;
    enlazarCtx(mundo, this);
  }

  // ── CtxLectura y CtxDueno ──────────────────────────────────────────────────────────────────────────────

  get params(): Readonly<WorldParams> { return paramsOf(this.mundo); }
  get tick(): number { return this.mundo.tick; }
  get organismos(): OrganismosMundo { return organismosDe(this.mundo); }
  get terrenoPercibido(): TerrenoPercepcion { return percepcionDe(this.mundo).vista.terreno; }
  get terreno(): Terreno { return this.terrenoPercibido; }
  get frente(): FrentePublico { return this.organismos.tabla.lectura(); }
  get personas(): ReadonlyMap<Slot, Person> { return this.organismos.personas.mapa as ReadonlyMap<Slot, Person>; }

  get propio(): TerrenoDueno {
    const terreno = this.terrenoPercibido;
    if (this.#propio?.terreno !== terreno) this.#propio = { terreno, w: terreno.escritura(this.hilo) };
    return this.#propio.w;
  }

  get escritura(): FrenteEscritura {
    const frente = this.frente;
    if (this.#escritura?.frente !== frente) this.#escritura = { frente, w: this.organismos.tabla.escritura(this.hilo) };
    return this.#escritura.w;
  }

  /** Chunks de este dueño con su contenido en este heap (los retirados conservan página, pero no cuentan). */
  get chunks(): Int32Array { return this.#chunks ??= Int32Array.from(this.#activos.keys()); }

  readonly ref = (uid: number): Ref => {
    const frente = this.frente;
    if (this.#indice?.frente !== frente) {
      const refs = new Map<number, Ref>(), { uid: uids, vivo, gen, alta } = frente;
      for (let s = 0; s < alta; s++) if (vivo[s]) refs.set(uids[s]!, gen[s]! * 4294967296 + s);
      this.#indice = { frente, refs };
    }
    return this.#indice.refs.get(uid) ?? REF_NULA;
  };

  azar(): number { return this.#piezas.azar(); }

  id(tipo: 'uid' | 'suceso' | 'comunidad' | 'estructura' | 'nonce'): number {
    const { contadores } = this.#piezas;
    if (contadores) return contadores.id(tipo);
    // Un dueño: los contadores son los del mundo, para no repetir un id que dé un paso heredado. `suceso` no es el
    // número de crónica (ese lo pone `suceso()`): comparte el espacio de los nonces, que tampoco se repite.
    const m = this.mundo;
    switch (tipo) {
      case 'uid': { const uid = m.siguienteUid ?? 1; m.siguienteUid = uid + 1; return uid; }
      case 'comunidad': return ++m.communityCounter;
      case 'estructura': return ++m.structureCounter;
      default: return this.#nonce++;
    }
  }

  alta(clase: Clase, persona?: Person): Ref {
    if (clase === Clase.Persona) {
      if (!persona) throw new Error('El alta de una persona lleva a la persona.');
      const ref = this.organismos.personas.registrar(persona);
      this.#anotarAlta(persona.uid!, persona.id);
      return ref;
    }
    return this.organismos.tabla.alta(this.hilo, clase);
  }

  baja(r: Ref): void {
    const organismos = this.organismos, slot = slotDe(r);
    if (organismos.personas.retirar(r)) return;
    // La fila de un animal que lleva la tabla de fauna cae sola cuando el animal sale de `mundo.animals`.
    if (organismos.fauna.animal(slot) && organismos.fauna.ref(organismos.fauna.animal(slot)!) === r) return;
    organismos.tabla.baja(this.hilo, r);
  }

  suceso(e: Omit<ChronicleEvent, 'id' | 'tick'>): string {
    const { contadores } = this.#piezas;
    if (!contadores) return addEvent(this.mundo, e).id;
    // Con varios dueños el número lo da el contador común y la crónica la escribe el coordinador al cerrar el tick.
    const suceso = { ...e, id: `e${contadores.cronica()}`, tick: this.mundo.tick } as ChronicleEvent;
    this.sucesosTick.push(suceso);
    if (this.hilo !== 0) { this.mundo.events.push(suceso); if (this.mundo.events.length > MAX_EVENTS) this.mundo.events.shift(); }
    return suceso.id;
  }

  publicar(s: SucesoVisible): void { this.visiblesTick.push(s); }

  pedirGlobal(tipo: 'lugar' | 'comunidad', datos: Uint8Array): void {
    this.#interno.enviar(0, intento(TipoIntento.Global, [AVISO[tipo]], datos));
  }

  // ── CtxLey y CtxF0 ─────────────────────────────────────────────────────────────────────────────────────

  idDe(uid: number): string | undefined { return this.#idPorUid.get(uid); }
  uidDe(id: string): number { return this.#uidPorId.get(id) ?? 0; }

  peticiones(tipo: 'lugar' | 'comunidad'): readonly Uint8Array[] {
    const pedidas = this.#peticiones[tipo];
    this.#peticiones[tipo] = [];
    return pedidas;
  }

  publicarComunidades(comunidades: readonly CommunityView[]): void {
    this.mundo.communities = [...comunidades];
    this.#replica({ comunidades: this.mundo.communities });
  }
  publicarLugares(lugares: readonly PlaceView[]): void {
    this.mundo.places = [...lugares];
    this.#replica({ lugares: this.mundo.places });
  }

  #replica(r: { comunidades?: CommunityView[]; lugares?: PlaceView[] }): void {
    this.#ponerReplica(r);
    if (this.hilos === 1) return;
    const bytes = serialize(r);
    for (let h = 1; h < this.hilos; h++) this.#interno.enviar(h, intento(TipoIntento.Gesto, [ORDEN.replica], bytes));
  }
  #ponerReplica(r: { comunidades?: CommunityView[]; lugares?: PlaceView[] }): void {
    if (r.comunidades) { this.mundo.communities = r.comunidades; this.globales.comunidades = new Map(r.comunidades.map(c => [c.id, c])); }
    if (r.lugares) { this.mundo.places = r.lugares; this.globales.lugares = new Map(r.lugares.map(p => [p.id, p])); }
    this.globales.version++;
    this.#globalesDe = this.mundo.tick;
  }
  /** Con un dueño, los pasos heredados cambian `mundo.communities` y `mundo.places` sin avisar: la réplica se rehace al
   * abrir cada tick sobre los mismos objetos. Con varios, solo cambia por `publicar…`. */
  #refrescarGlobales(): void {
    if (this.hilos > 1 && this.#globalesDe >= 0) return;
    this.globales.comunidades = new Map(this.mundo.communities.map(c => [c.id, c]));
    this.globales.lugares = new Map(this.mundo.places.map(p => [p.id, p]));
    this.#globalesDe = this.mundo.tick;
  }

  // ── Época ──────────────────────────────────────────────────────────────────────────────────────────────

  /** ¿Conduce este dueño el tick? Con todo apagado y sin cinta enlazada, no: el tick es el heredado. */
  get activo(): boolean { return leyesActivas(this.params.v23).length > 0 || this.#enlace !== null; }

  enlazar(cinta: DescriptorEnlace | null, fuente?: FuenteFotograma): void {
    this.#enlace = cinta && enlaceCinta(cinta);
    if (this.#enlace && fuente) enlazarFuenteFotograma(this.#enlace, fuente);
  }

  /**
   * Antes del primer tick de una época con un solo dueño (mundo creado o cargado, o una ley recién encendida): columnas
   * de las leyes en la tabla, páginas de los chunks que ya están, materia (repuesta de `cp` si se carga), primer frente
   * y `Ley.iniciar`. Con varios dueños el coordinador hace estos pasos por separado (`motor/coordinador.ts`).
   */
  abrirEpoca(cp?: MateriaCheckpoint | null): void {
    if (!this.prepararEpoca()) return;
    if (cp) this.reponer(this.cargarMateria(cp));
    // `Ley.iniciar` de w materializa cada chunk ya activo que no traiga sus lotes: la reserva de F0 los cubre todos.
    this.reservarMateria(cp ? 0 : this.chunks.length);
    this.publicarFilas();
    this.organismos.tabla.publicar(this.mundo.tick);
    this.iniciarLeyes();
  }

  /** Leyes encendidas, sus columnas y la materia. Devuelve false si la época ya estaba abierta con las mismas leyes. */
  prepararEpoca(): boolean {
    const leyes = leyesActivas(this.params.v23), firma = leyes.map(l => l.id).join() || '-', m = this.mundo;
    if (firma === this.#firma) return false;
    this.leyes = leyes;
    this.#firma = firma;
    if (this.hilos === 1) {
      const columnas = leyes.flatMap(l => l.columnas ?? []), declaradas = this.frente.columnas;
      if (columnas.some(([nombre]) => !declaradas.includes(nombre))) { olvidarPercepcion(m); olvidarOrganismos(m); this.#escritura = this.#indice = undefined; }
      for (const [nombre, tipo, ancho] of columnas) this.organismos.tabla.columna(nombre, tipo, ancho);
      observarRegiones(m, leyes.length || this.params.v23.fotograma ? { activado: (key, cx, cy) => this.#activado(key, cx, cy), retirar: (_k, cx, cy) => this.#retirar(cx, cy) } : undefined);
      const terreno = this.terrenoPercibido, tileIn = tileLookup(m.tiles), fast = residentFastAccess(m.tiles);
      for (const [key, meta] of Object.entries(m.chunks)) {
        const chunk = terreno.asegurarPagina(meta.cx, meta.cy, 0);
        terreno.sincronizarPagina(chunk, tileIn, fast);
        this.#activos.set(chunk, key);
      }
      this.#chunks = undefined;
    }
    if (this.params.v23.materia && !this.materia) this.#armarMateria();
    return true;
  }

  /** `Ley.iniciar` de cada ley encendida, con el directorio y la réplica de globales al día. */
  iniciarLeyes(): void {
    this.#directorioPropio();
    this.#refrescarGlobales();
    for (const ley of this.leyes) ley.iniciar?.(this);
  }

  /** `Ley.alAdoptar` de todo organismo propio: tras cargar con varios dueños, cada uno adopta los lotes de los suyos. */
  adoptarPropios(): void {
    for (const ley of this.leyes) if (ley.alAdoptar) {
      for (const p of this.mundo.people) ley.alAdoptar(this, p);
      for (const a of this.mundo.animals) ley.alAdoptar(this, a);
    }
  }

  /** Vuelve a poner en vuelo los intentos con garantía de un punto de control: el aplicador de este dueño los resuelve
   * en su F1 (o los reenvía a quien toque). Los `Ref` de antes de cargar ya no viven: la garantía acaba en su celda. */
  reponer(intentos: readonly Intento[]): void { for (const i of intentos) this.#interno.enviar(this.hilo, i); }

  /** Intentos que siguen en los buzones (solo quien tiene los buzones: el coordinador o el único dueño). */
  pendientes(): Intento[] { return this.#piezas.buzones?.pendientes() ?? []; }

  /** Saldo de entregas de ley, incluido el tramo que sigue en los buzones, leído en barrera. */
  balanceIntentos(): { enviados: number; recibidos: number; pendientes: number } {
    const { control } = this.#piezas;
    const cuenta = (campo: number): number => {
      if (!control) return this.cuentas[campo - CTL_DUENO.intentos]!;
      let n = 0;
      for (let h = 0; h < this.hilos; h++) n += control[celdaDueno(h, campo)]!;
      return n;
    };
    return {
      enviados: cuenta(CTL_DUENO.intentos) + cuenta(CTL_DUENO.rechazados),
      recibidos: cuenta(CTL_DUENO.recibidos),
      pendientes: this.pendientes().filter(i => i.nonce !== 0).length,
    };
  }

  /** Migrantes de la cola M (los aparta el buzón del dueño: ningún aplicador los ve). Y, si el aplicador de m5 no está
   * encendido, las órdenes del coordinador de la cola B, que sin él nadie vaciaría (no hay más intentos en ella). */
  adoptarMigrantes(): void {
    this.buzon.vaciar('M', () => {});
    if (!this.params.v23.intentos) this.buzon.vaciar('B', () => {});
  }

  #armarMateria(): void {
    const dadas = this.#piezas.materia;
    const quimica = dadas?.quimica ?? crearServicioQuimico({ modo: 'inmediato' });
    const lotes = dadas?.lotes ?? new PageArena(RESERVA_LOTES), desborde = dadas?.desborde ?? new PageArena(RESERVA_DESBORDE);
    const base = sustanciasMundo(quimica), terreno = this.terrenoPercibido;
    this.#lotes = lotes; this.#desborde = desborde;
    this.quimica = quimica;
    this.materia = new ArenaLotes({
      lotes, desborde, paginas: terreno.paginasMateria, terreno, quimica, hilo: this.hilo, agua: base.H2O,
      // Lo digerible con κ a la temperatura del cuerpo, solo exotérmicas: la fracción que se oxida en un día de tránsito
      // (la misma regla que `MundoMaterial` da a su arena).
      digerible: (s: Readonly<Sustancia>, kappa: Kappa) => {
        const r = quimica.reaccion(s.id, base.O2, nivelDeLote(T_DIGESTION_K, kappa));
        if (!r || r.dH >= 0) return 0;
        const nu = r.entradas.find(t => t.id === s.id)?.nu ?? 1;
        return (-r.dH / nu) * -Math.expm1(-NU * Math.exp(-barreraEfectiva(r, kappa) / (R * T_DIGESTION_K)) * TICKS_PER_DAY);
      },
    });
  }
  #lotes: PageArena | undefined;
  #desborde: PageArena | undefined;

  /** F0 (coordinador): la arena de lotes solo crece aquí. Garantiza ranuras para `chunksNuevos` chunks y la holgura. */
  reservarMateria(chunksNuevos: number): void {
    if (!this.#lotes || !this.#desborde || this.hilo !== 0) return;
    const libres = chunksNuevos * LOTES_POR_CHUNK_NUEVO + Math.max(LOTES_POR_CHUNK_NUEVO, this.#lotes.used);
    this.#lotes.prepararF0(libres, LOTES_POR_BLOQUE);
    this.#desborde.prepararF0(Math.max(libres, this.#desborde.used));
  }

  // ── Directorio de identidades ──────────────────────────────────────────────────────────────────────────

  #anotarAlta(uid: number, id: string): void {
    if (this.#idPorUid.has(uid)) return;
    this.#idPorUid.set(uid, id); this.#uidPorId.set(id, uid);
    this.#altas.push([uid, id]);
  }
  /** Altas de lo propio (quien ya tiene uid y aún no figura). */
  #directorioPropio(): void {
    for (const p of this.mundo.people) if (p.uid !== undefined && !this.#idPorUid.has(p.uid)) this.#anotarAlta(p.uid, p.id);
    for (const a of this.mundo.animals) if (a.uid !== undefined && !this.#idPorUid.has(a.uid)) this.#anotarAlta(a.uid, a.id);
  }
  /** Altas de otros dueños que reparte el coordinador. */
  anotarAjenas(altas: readonly [number, string][]): void {
    for (const [uid, id] of altas) if (!this.#idPorUid.has(uid)) { this.#idPorUid.set(uid, id); this.#uidPorId.set(id, uid); }
  }
  /** Una vez al día: olvida a quien lleva más de un día sin fila viva en el frente. */
  #podarDirectorio(): void {
    const tick = this.mundo.tick;
    for (const [uid, id] of this.#idPorUid) {
      if (this.ref(uid) !== REF_NULA) { this.#muertoEn.delete(uid); continue; }
      const desde = this.#muertoEn.get(uid);
      if (desde === undefined) this.#muertoEn.set(uid, tick);
      else if (tick - desde >= MEMORIA_DIRECTORIO_TICKS) { this.#idPorUid.delete(uid); this.#uidPorId.delete(id); this.#muertoEn.delete(uid); }
    }
  }

  // ── Regiones (un dueño): el observador de `maintainRegions` ─────────────────────────────────────────────

  #activado(key: string, cx: number, cy: number): void { this.#pendientes.push([this.terrenoPercibido.asegurarPagina(cx, cy, 0), key]); }
  #retirar(cx: number, cy: number): void {
    const chunk = this.terrenoPercibido.paginaDe(cx, cy);
    if (chunk < 0 || !this.#activos.has(chunk)) return;
    for (const ley of this.leyes) ley.alRetirar?.(this, chunk);
    this.#activos.delete(chunk); this.#chunks = undefined;
    this.#vaciar.push(chunk);
  }

  /** F0 con un dueño: `maintainRegions` y, por cada chunk que entra o sale, `alActivar` o `alRetirar`. */
  regiones(context: WorldContext): void {
    const m = this.mundo;
    maintainRegions(m, context);
    if (!this.#pendientes.length && !this.#vaciar.length) return;
    if (this.#enlace) Atomics.store(this.#enlace.pedirCompleto, 0, 1);
    const terreno = this.terrenoPercibido;
    for (const chunk of this.#vaciar.splice(0)) terreno.vaciarPagina(chunk);
    const nuevos = this.#pendientes.splice(0);
    if (!nuevos.length) return;
    this.reservarMateria(nuevos.length);
    const tileIn = tileLookup(m.tiles), fast = residentFastAccess(m.tiles);
    for (const [chunk, key] of nuevos) {
      terreno.sincronizarPagina(chunk, tileIn, fast);
      this.#activos.set(chunk, key);
    }
    this.#chunks = undefined;
    for (const [chunk] of nuevos) for (const ley of this.leyes) ley.alActivar?.(this, chunk);
  }

  // ── Fases ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Fija la fase de los buzones (el coordinador, o el único dueño). */
  fase(f: FaseMotor): void { this.#piezas.buzones?.fijarFase(f); }

  gancho(fase: GanchoFase): void { for (const ley of this.leyes) ley[fase]?.(this); }

  /** Vacía una cola con el aplicador de m5 (solo con `v23.intentos`). */
  aplicar(cola: 'M' | 'A' | 'B'): void { if (this.params.v23.intentos) aplicarCola(this, cola); }

  /** F0, tras las regiones y los gestos: lo global del coordinador y `Ley.F0`. */
  F0(): void {
    const m = this.mundo;
    this.#refrescarGlobales();
    this.#directorioPropio();
    if (m.tick % MEMORIA_DIRECTORIO_TICKS === 0) this.#podarDirectorio();
    if (this.materia) {
      (this.materia as ArenaLotes).barrera();
      this.totales = plegarLibros(this.#piezas.libros, this.totales);
      this.reservarMateria(0);
    }
    this.recibirAvisos();
    for (const ley of this.leyes) ley.F0?.(this);
    this.#foto = this.#enlace ? abrirFotograma(this, this.#enlace, this.epoca) : null;
    this.#fotoValida = true;
    const control = this.#piezas.control;
    if (control) {
      control[CTL.fotoRanura] = this.#foto ? this.#enlace!.ranuras.indexOf(this.#foto.ranura) : -1;
      control[CTL.fotoCompleto] = this.#foto?.completo ? 1 : 0;
      control[CTL.fotoInvalido] = 0;
    }
  }

  /** Vacía la cola F0 del coordinador: las peticiones de las leyes quedan para `peticiones()` y lo demás va a `avisar`. */
  recibirAvisos(): void {
    if (this.hilo !== 0) return;
    this.#interno.vaciar('F0', i => {
      const clase = i.dato?.[0] ?? -1;
      if (i.tipo === TipoIntento.Global && clase === AVISO.lugar) this.#peticiones.lugar.push(new Uint8Array(i.bytes!));
      else if (i.tipo === TipoIntento.Global && clase === AVISO.comunidad) this.#peticiones.comunidad.push(new Uint8Array(i.bytes!));
      else this.avisar?.(i.tipo === TipoIntento.Activar ? -1 : clase, i);
    });
  }

  /** F1 de un dueño que no es el único: lo que F0 hace para el coordinador y que cada heap necesita. */
  abrirTick(): void {
    this.#directorioPropio();
    if (this.mundo.tick % MEMORIA_DIRECTORIO_TICKS === 0) this.#podarDirectorio();
    if (this.materia) (this.materia as ArenaLotes).barrera();
    const control = this.#piezas.control!;
    const ranura = control[CTL.fotoRanura]!;
    this.#foto = ranura >= 0 && this.#enlace
      ? { ranura: this.#enlace.ranuras[ranura]!, completo: control[CTL.fotoCompleto] === 1, tick: this.mundo.tick,
        epoca: this.epoca, versiones: this.#enlace.versiones! } : null;
  }

  /** F6, antes de `Ley.F6`: cada organismo propio tiene fila y sus columnas base quedan escritas en el frente t+1. Las
   * leyes escriben después las suyas (`c.escritura`). */
  publicarFilas(): void {
    const m = this.mundo, organismos = this.organismos, terreno = this.terrenoPercibido;
    const faunaHeredada = !this.params.v23.fauna;
    organismos.fauna.sincronizar(faunaHeredada ? m.animals : []);
    if (!faunaHeredada) this.#retirarFilasFaunaAusente();
    organismos.escribir(m.tick, faunaHeredada ? { celda: (x, y) => terreno.celda(x, y), chunkDe: c => c >> 8 } : undefined, m.people);
    const w = this.escritura, chunk = w.i32('chunk');
    for (const [slot, p] of organismos.personas.mapa) {
      const celda = terreno.celda(p.x, p.y);
      chunk[slot] = celda < 0 ? -1 : celda >> 8;
    }
  }

  #retirarFilasFaunaAusente(): void {
    const presentes = new Set(this.mundo.animals.map(a => a.uid));
    const frente = this.frente, vivo = this.escritura.u8('vivo'), gen = this.escritura.i32('gen');
    for (let s = 0; s < frente.alta; s++) {
      if (frente.vivo[s] && frente.clase[s] === Clase.Animal && frente.dueno[s] === this.hilo
        && vivo[s] && gen[s] === frente.gen[s] && !presentes.has(frente.uid[s])) {
        this.organismos.tabla.baja(this.hilo, refDe(s, frente.gen[s]!));
      }
    }
  }

  /** F6 con varios dueños, tras `Ley.F6`: las páginas propias al día para quien las lee desde otro hilo. */
  publicarTerreno(): void {
    const m = this.mundo, terreno = this.terrenoPercibido, tileIn = tileLookup(m.tiles), fast = residentFastAccess(m.tiles);
    for (const chunk of this.#activos.keys()) terreno.sincronizarPagina(chunk, tileIn, fast);
  }

  /** F6: escribe la parte de este dueño en el fotograma abierto en F0, si lo hay. */
  escribirFoto(): void {
    if (!this.#foto) return;
    if (this.hilos === 1) this.publicarTerreno();
    const cupo = escribirFotograma(this, this.#foto);
    if (cupo) return;
    this.#fotoValida = false;
    const control = this.#piezas.control;
    if (control) control[CTL.fotoInvalido] = 1;
  }

  /** Tras la última barrera (coordinador): publica o aborta el fotograma, y lo visible del tick deja de estar pendiente
   * (m6 lo lee de `visiblesTick` dentro de `cerrarFotograma`). Devuelve si el fotograma se perdió. */
  cerrarFoto(): boolean {
    let perdido = false;
    if (this.#foto && this.#enlace) {
      const control = this.#piezas.control;
      const valido = this.#fotoValida && (!control || control[CTL.fotoInvalido] === 0);
      perdido = !cerrarFotograma(this, this.#enlace, this.#foto, valido);
      this.#foto = null;
      if (perdido) this.fotogramasPerdidos++;
    }
    this.visiblesTick.length = 0;
    return perdido;
  }
  /** Fotogramas abiertos que no llegaron a publicarse porque algún dueño no cupo en la ranura. */
  fotogramasPerdidos = 0;

  /** El suceso entero (no solo su id), para `addEvent` cuando el mundo es la parte de un dueño entre varios. */
  registrarSuceso(e: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent {
    const id = this.suceso(e);
    return this.#piezas.contadores ? this.sucesosTick[this.sucesosTick.length - 1]! : this.mundo.events.find(s => s.id === id)!;
  }

  /** Cierra el tick de este dueño con un solo dueño: frente publicado y sucesos visibles entregados. */
  publicarFrente(): void { this.organismos.tabla.publicar(this.mundo.tick); }

  // ── Mensajes del motor ─────────────────────────────────────────────────────────────────────────────────

  #contar(campo: number): void {
    const control = this.#piezas.control;
    if (control) control[celdaDueno(this.hilo, campo)]!++;
    else this.cuentas[campo - CTL_DUENO.intentos]!++;
  }
  /** Intentos, rechazos, migraciones y entregas de este dueño (con varios están en el control). */
  readonly cuentas = [0, 0, 0, 0];

  #aplicarMotor(i: Intento): boolean {
    if (i.tipo === TipoIntento.Migrante) { this.#adoptar(deserialize(i.bytes!) as Migrante); return true; }
    if (i.tipo !== TipoIntento.Gesto || !i.dato) return false;
    switch (i.dato[0]) {
      case ORDEN.gesto: {
        const { gesto, orden } = deserialize(i.bytes!) as { gesto: Gesture; orden: number };
        const resultado = applyGesture(this.mundo, gesto, orden);
        this.#interno.enviar(0, intento(TipoIntento.Global, [AVISO.resultado], serialize(resultado)));
        return true;
      }
      case ORDEN.replica: this.#ponerReplica(deserialize(i.bytes!) as { comunidades?: CommunityView[]; lugares?: PlaceView[] }); return true;
      case ORDEN.ceder: this.cesiones.push([i.dato[1]!, i.dato[2]!]); return true;
      case ORDEN.directorio: this.anotarAjenas(deserialize(i.bytes!) as [number, string][]); return true;
      case ORDEN.detalle: {
        const uid = i.dato[1]!, slot = slotDe(this.ref(uid));
        const persona = this.personas.get(slot);
        this.#interno.enviar(0, intento(TipoIntento.Global, [AVISO.detalle, uid], persona?.uid === uid ? serialize(persona) : null));
        return true;
      }
      default: return false;
    }
  }

  /** El gesto de un usuario para un dueño que no es el coordinador (lo aplica en F1 y contesta con su resultado). */
  enviarGesto(destino: Hilo, gesto: Gesture, orden: number): void {
    this.#interno.enviar(destino, intento(TipoIntento.Gesto, [ORDEN.gesto], serialize({ gesto, orden })));
  }
  ordenar(destino: Hilo, dato: number[], carga?: unknown): void {
    this.#interno.enviar(destino, intento(TipoIntento.Gesto, dato, carga === undefined ? null : serialize(carga)));
  }
  enviarMigrante(destino: Hilo, m: Migrante): void { this.buzon.enviar(destino, intento(TipoIntento.Migrante, [], serialize(m))); }

  #adoptar(mig: Migrante): void {
    const m = this.mundo, organismos = this.organismos;
    const adoptarPersona = ({ persona, ref }: { persona: Person; ref: Ref }): void => {
      m.people.push(persona);
      if (ref === REF_NULA) organismos.personas.registrar(persona); else organismos.personas.adoptar(persona, ref);
      this.#anotarAlta(persona.uid!, persona.id);
    };
    const adoptarAnimal = (animal: Animal, ref: Ref): void => {
      m.animals.push(animal);
      if (ref !== REF_NULA) organismos.fauna.adoptar(animal, ref);
    };
    if (mig.tipo === 'organismo') {
      if (mig.persona) { adoptarPersona(mig.persona); for (const ley of this.leyes) ley.alAdoptar?.(this, mig.persona.persona); }
      if (mig.animal) {
        adoptarAnimal(mig.animal.animal, mig.animal.ref);
        for (const ley of this.leyes) ley.alAdoptar?.(this, mig.animal.animal);
      }
      return;
    }
    const desde = m.tiles.length;
    m.chunks[mig.key] = mig.meta;
    m.tiles.push(...mig.tiles);
    tileIndexAppended(m.tiles, desde);
    faunaCacheAppended(m.tiles, desde);
    m.structures.push(...mig.structures);
    mig.animals.forEach((animal, k) => adoptarAnimal(animal, mig.refsFauna?.[k] ?? REF_NULA));
    for (const p of mig.personas) adoptarPersona(p);
    this.#activos.set(mig.chunk, mig.key); this.#chunks = undefined;
    this.terrenoPercibido.sincronizarPagina(mig.chunk, tileLookup(m.tiles), residentFastAccess(m.tiles));
    // El reparto al abrir la época no es una activación: lo cubren `Ley.iniciar` y, tras una carga, `adoptarPropios`.
    if (mig.inicial) return;
    for (const ley of this.leyes) ley.alActivar?.(this, mig.chunk);
    for (const ley of this.leyes) if (ley.alAdoptar) {
      for (const p of mig.personas) ley.alAdoptar(this, p.persona);
      for (const a of mig.animals) ley.alAdoptar(this, a);
    }
  }

  /** Saca de este heap el chunk `chunk` con todo lo que hay en él (para cederlo o archivarlo). */
  #desprender(chunk: ChunkId, inicial: boolean): MigranteChunk | null {
    const key = this.#activos.get(chunk), m = this.mundo, terreno = this.terrenoPercibido;
    const meta = key === undefined ? undefined : m.chunks[key];
    if (key === undefined || !meta) return null;
    const px = terreno.paginaX[chunk]!, py = terreno.paginaY[chunk]!;
    const dentro = (o: { x: number; y: number }): boolean => (o.x >> 4) === px && (o.y >> 4) === py;
    const previas = m.tiles, tiles: Tile[] = [], quedan: Tile[] = [];
    // Copia plana: una tesela observada por el anfitrión es un proxy y no cruza la serialización.
    for (const t of previas) if (dentro(t)) tiles.push({ ...t }); else quedan.push(t);
    m.tiles = quedan;
    faunaCacheFiltered(previas, quedan);
    const structures = m.structures.filter(dentro), animals = m.animals.filter(dentro);
    if (structures.length) m.structures = m.structures.filter(s => !dentro(s));
    if (animals.length) m.animals = m.animals.filter(a => !dentro(a));
    const personas = m.people.filter(dentro).map(persona => ({ persona, ref: this.organismos.personas.ref(persona) }));
    if (personas.length) m.people = m.people.filter(p => !dentro(p));
    delete m.chunks[key];
    this.#activos.delete(chunk); this.#chunks = undefined;
    return { tipo: 'chunk', chunk, key, meta, tiles, structures, animals, personas, inicial };
  }

  /**
   * F6 con varios dueños, tras escribir las filas: cumple las órdenes de ceder chunks y manda a su nuevo dueño a quien
   * cruzó a un chunk ajeno. `ceder` cambia el dueño de la fila en el frente t+1.
   */
  emigrar(): void {
    const m = this.mundo, organismos = this.organismos, tabla = organismos.tabla, terreno = this.terrenoPercibido;
    for (const [chunk, destino] of this.cesiones.splice(0)) {
      if (!this.#activos.has(chunk)) continue;
      for (const ley of this.leyes) ley.alRetirar?.(this, chunk);
      const mig = this.#desprender(chunk, false);
      if (!mig) continue;
      // Un chunk se archiva sin gente: quien estuviera en él sigue con este dueño (su halo lo volverá a pedir).
      if (destino < 0) { for (const p of mig.personas) m.people.push(p.persona); mig.personas = []; }
      for (const p of mig.personas) if (p.ref !== REF_NULA) { organismos.personas.soltar(p.persona); tabla.ceder(this.hilo, p.ref, destino); }
      mig.refsFauna = mig.animals.map(a => {
        const ref = organismos.fauna.soltar(a);
        if (ref !== REF_NULA) {
          if (destino < 0) tabla.baja(this.hilo, ref);
          else tabla.ceder(this.hilo, ref, destino);
        }
        return ref;
      });
      if (destino >= 0) this.enviarMigrante(destino, mig);
      else {
        terreno.vaciarPagina(chunk);
        this.#interno.enviar(0, intento(TipoIntento.Global, [AVISO.chunk, chunk], serialize(mig)));
      }
    }
    const duenoDe = (o: { x: number; y: number }): Hilo => {
      const celda = terreno.celda(o.x, o.y);
      if (celda < 0) return this.hilo;
      // El organismo llega en F1, una vez que F0 ya aplicó las cesiones del rebalanceo.
      const chunk = terreno.chunkDe(celda), siguiente = terreno.duenoSiguiente[chunk]!;
      return siguiente >= 0 ? siguiente : terreno.duenoChunk[chunk]!;
    };
    let seVan: Person[] | undefined;
    for (const p of m.people) {
      const destino = duenoDe(p);
      if (destino === this.hilo || destino < 0) continue;
      const ref = organismos.personas.soltar(p);
      tabla.ceder(this.hilo, ref, destino);
      this.enviarMigrante(destino, { tipo: 'organismo', persona: { persona: p, ref } });
      (seVan ??= []).push(p);
    }
    if (seVan) { const fuera = new Set(seVan); m.people = m.people.filter(p => !fuera.has(p)); }
    let animales: Animal[] | undefined;
    for (const a of m.animals) {
      const destino = duenoDe(a);
      if (destino === this.hilo || destino < 0) continue;
      const ref = organismos.fauna.soltar(a);
      if (ref !== REF_NULA) tabla.ceder(this.hilo, ref, destino);
      this.enviarMigrante(destino, { tipo: 'organismo', animal: { animal: a, ref } });
      (animales ??= []).push(a);
    }
    if (animales) { const fuera = new Set(animales); m.animals = m.animals.filter(a => !fuera.has(a)); }
  }

  /** F6 con varios dueños: lo que el coordinador junta al cerrar el tick (crónica, visibles y altas del directorio). */
  parteDelTick(): ParteTick | null {
    this.#directorioPropio();
    if (!this.sucesosTick.length && !this.visiblesTick.length && !this.#altas.length) return null;
    return { hilo: this.hilo, sucesos: this.sucesosTick.splice(0), visibles: this.visiblesTick.splice(0), altas: this.#altas.splice(0) };
  }
  enviarParte(): void {
    const parte = this.parteDelTick();
    if (parte) this.#interno.enviar(0, intento(TipoIntento.Global, [AVISO.tick], serialize(parte)));
  }
  avisarCoordinador(dato: number[], carga: unknown): void { this.#interno.enviar(0, intento(TipoIntento.Global, dato, serialize(carga))); }

  /** Los chunks de este dueño como migrantes, sin sacarlos (reparto inicial desde el coordinador). */
  repartirChunk(chunk: ChunkId): MigranteChunk | null { return this.#desprender(chunk, true); }
  /** Registra como propio un chunk cuyo contenido ya está en este heap (el coordinador al abrir la época). */
  tenerChunk(chunk: ChunkId, key: string): void { this.#activos.set(chunk, key); this.#chunks = undefined; }

  // ── Materia: punto de control ──────────────────────────────────────────────────────────────────────────

  /** Balance global de materia en barrera: un lote puede cambiar de dueño sin un asiento de fuente o sumidero. */
  balanceMateria(): { esperado: bigint[]; hallado: bigint[] } {
    const libros = this.#piezas.libros, vuelo = sumarEnVuelo(libros);
    const lotes = (this.materia as ArenaLotes).saldo();
    return {
      esperado: this.totales.inicial.map((n, k) => libros.reduce(
        (s, l) => s + BigInt(l.fuentes[k]!) - BigInt(l.sumideros[k]!),
        n + this.totales.fuentes[k]! - this.totales.sumideros[k]!,
      )),
      hallado: lotes.map((n, k) => n + vuelo[k]!),
    };
  }

  /** La materia para `Instantanea` (en barrera, con todos los dueños detenidos). null sin `v23.materia`. */
  instantaneaMateria(pendientes: readonly Intento[]): MateriaCheckpoint | null {
    if (!this.materia || !this.quimica) return null;
    const arena = this.materia as ArenaLotes & { guardar?(): { lotes: Iterable<LoteGuardado>; libres: Iterable<LoteRef> } };
    if (!arena.guardar) throw new Error('La arena de lotes no sabe volcarse: falta ArenaLotes.guardar() (pedido de m4a al integrador).');
    this.totales = plegarLibros(this.#piezas.libros, this.totales);
    const terreno = this.terrenoPercibido, { lotes: propios, libres } = arena.guardar();
    const lotes = Array.from(propios, l => ({ ...l, celda: celdaMundo(terreno, l.celda) }));
    const enVuelo = pendientes.filter(i => i.materia !== null).map(i => ({ ...i, celda: celdaMundo(terreno, i.celda) }));
    return {
      epoca: this.epoca, tick: this.mundo.tick,
      sustancias: serializarSustancias(this.quimica as ServicioQuimicoImpl), registro: this.registro.guardar(),
      paginas: codificarPaginas(this.epoca, lotes, libres), enVuelo: codificarEnVuelo(enVuelo),
      inicial: this.totales.inicial, fuentes: this.totales.fuentes, sumideros: this.totales.sumideros,
    };
  }

  /** Repone la materia de un punto de control en la arena recién creada y devuelve los intentos con garantía que
   * estaban en vuelo (quien llama los repone en un buzón). */
  cargarMateria(cp: MateriaCheckpoint): Intento[] {
    if (!this.materia || !this.quimica) throw new Error('Cargar materia exige v23.materia.');
    const terreno = this.terrenoPercibido, { lotes: guardados, libres } = decodificarPaginas(cp.epoca, cp.paginas);
    // Con un dueño todo lote ligado a un organismo es suyo; con varios, cada dueño adopta los de los suyos al repartir.
    const lotes = guardados.map(l => ({ ...l, celda: celdaLocal(terreno, l.celda), dueno: 0 }));
    this.reservarMateria(Math.ceil((lotes.length + libres.length) / LOTES_POR_CHUNK_NUEVO));
    this.#desborde!.prepararF0(ranurasDesborde(lotes));
    (this.materia as ArenaLotes).cargar(lotes, libres);
    this.registro.cargar(cp.registro);
    this.totales = { inicial: [...cp.inicial], fuentes: [...cp.fuentes], sumideros: [...cp.sumideros] };
    const q = this.quimica, saldo = saldoEnVuelo(cp.enVuelo, id => q.sustancia(id));
    this.#piezas.libros[0]!.enVuelo.set(saldo.map(Number));
    return decodificarEnVuelo(cp.enVuelo).map(i => ({ ...i, celda: celdaLocal(terreno, i.celda) }));
  }
}

// ── Un solo dueño ────────────────────────────────────────────────────────────────────────────────────────

/** El dueño único de `mundo` si ya lo tiene. */
export function duenoSi(mundo: World): Dueno | undefined {
  const c = ctxSi(mundo);
  return c instanceof Dueno ? c : undefined;
}

/** El dueño único de `mundo`: el hilo que llama, sobre el mundo entero, con el azar del mundo. Se crea al primer uso.
 * `sustancias`: el registro químico de un punto de control que se va a cargar. */
export function duenoDe(mundo: World, sustancias?: Uint8Array): Dueno {
  const previo = duenoSi(mundo);
  if (previo) return previo;
  const buzones = new Buzones(1), azar = (): number => random(mundo);
  const quimica = sustancias && cargarSustancias(sustancias, { modo: 'inmediato' });
  return new Dueno(mundo, {
    hilo: 0, hilos: 1, buzones, buzon: buzones.dueno(0, azar), libros: crearLibros(1), contadores: null,
    registro: new RegistroContenido(1), azar, control: null, enlace: null,
    materia: quimica ? { lotes: new PageArena(RESERVA_LOTES), desborde: new PageArena(RESERVA_DESBORDE), quimica } : null,
  });
}

/** El dueño que debe conducir el tick de `mundo`, o `undefined` si todo está apagado (tick heredado). */
export function conductorDe(mundo: World): Dueno | undefined {
  const previo = duenoSi(mundo);
  if (previo) return previo.hilos === 1 && previo.activo ? previo : undefined;
  return leyesActivas(paramsOf(mundo).v23).length > 0 ? duenoDe(mundo) : undefined;
}
