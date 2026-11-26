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
import { ArenaLotes, desbordeDeEspecies, LOTES_POR_BLOQUE } from '../materia/arena.js';
import { ArchivoMateriaFria } from '../materia/archivo-frio.js';
import { codificarEnVuelo, codificarPaginas, decodificarEnVuelo, indexarPaginas, saldoEnVuelo, type GarantiaGuardada, type LoteGuardado } from '../materia/checkpoint.js';
import { lotesDe } from '../materia/cuerpo.js';
import { olvidarEstadoMateria, sueloYVidaDormidos } from '../materia/ley-mundo.js';
import { plegarLibros, sumarEnVuelo, type TotalesMateria } from '../materia/libro.js';
import { sustanciasMundo } from '../materia/mundo.js';
import { cargarSustancias, crearServicioQuimico, serializarSustancias, type ServicioQuimicoImpl } from '../materia/servicio.js';
import { Rol, barreraEfectiva, nivelDeLote, type ArenaMateria, type Kappa, type Libro, type LoteRef, type MateriaCheckpoint, type ServicioQuimico, type Sustancia } from '../materia/tipos.js';
import { addEvent, random } from '../mundo/crear.js';
import { MAX_EVENTS, TICKS_PER_DAY, type Person, type World, type WorldContext } from '../mundo/tipos.js';
import { paramsOf, type WorldParams } from '../params.js';
import type { PageArena } from '../soa/arena.js';
import { olvidarOrganismos, organismosDe, type OrganismosMundo } from '../soa/organismos-mundo.js';
import { residentFastAccess } from '../soa/terreno.js';
import { clavesDeHalo, maintainRegions, observarRegiones, worldContext, type ChunkMeta } from '../spatial.js';
import { CHUNK_SIZE, chunkKey, type Chunk } from '../terrain.js';
import { tileIndexAppended, tileLookup } from '../tile-index.js';
import { ctxSi, desenlazarCtx, enlazarCtx, type CtxF0, type Ley } from './acceso.js';
import { aplicarCola } from './aplicar.js';
import { Buzones, type FaseMotor } from './buzon.js';
import { Contadores, crearLibros } from './contadores.js';
import {
  Clase, DATO_MATERIA, DATO_TOMAR, REF_NULA, TipoIntento, genDe, refDe, slotDe,
  type Buzon, type ChunkId, type FrenteEscritura, type FrentePublico, type Globales, type Hilo, type Intento, type Ref, type Slot,
  type Terreno, type TerrenoDueno,
} from './contratos.js';
import { abrirFotograma, cerrarFotograma, enlazarFuenteFotograma, escribirFotograma, type FotogramaEnCurso, type FuenteFotograma } from './fotograma.js';
import {
  EmisorFotoDueno, type EstadoCintaChunk, type EstadoCintaOrganismo, type ParteFotoDueno,
} from './fotograma-dueno.js';
import { leyesActivas } from './leyes.js';
import { RegistroContenido } from './registro.js';
import { crearArenasMateria, type ArenasMateria } from './reserva-materia.js';

// ── Constantes ───────────────────────────────────────────────────────────────────────────────────────────

/** Temperatura corporal (K) a la que la arena valora lo digerible de una sustancia. Es la misma `T_CUERPO` de
 * `materia/mundo.ts`, que no la exporta: el integrador las une en `shared/naturaleza.ts`. */
export const T_DIGESTION_K = 310;
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
export const AVISO = { lugar: 0, comunidad: 1, resultado: 2, tick: 3, parte: 4, detalle: 5, chunk: 6, foto: 7 } as const;

/** Celdas del control compartido del motor (Float64 sobre SAB). Las de cada dueño empiezan en `CTL.porDueno`. */
export const CTL = {
  tick: 0, epoca: 1, fotoRanura: 2, fotoCompleto: 3, fotoInvalido: 4, lluvia: 5, falloConfirmar: 6,
  fotoCaras: 7, fotoDuenosEntregado: 8, fotoDuenosResync: 9, porDueno: 12,
} as const;
export const CTL_DUENO = {
  msF1: 0, msEco: 1, msPercibir: 2, msActuar: 3, msAplicar: 4, msTick: 5,
  intentos: 6, rechazados: 7, migraciones: 8, recibidos: 9, migrantesFoto: 10, celdas: 11,
} as const;
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
  cedido?: boolean;
  /** Solo con `emisionFotogramaDuenos`: firmas confirmado/tentativo transferidas en una cesión (`destino >= 0`). */
  estadoCinta?: EstadoCintaChunk;
}
/** Un organismo que cruzó a un chunk de otro dueño. */
export interface MigranteOrganismo {
  tipo: 'organismo';
  persona?: { persona: Person; ref: Ref };
  animal?: { animal: Animal; ref: Ref };
  /** Solo con `emisionFotogramaDuenos`: firmas confirmado/tentativo transferidas al receptor. */
  estadoCinta?: EstadoCintaOrganismo;
}
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
  materia: (ArenasMateria & { quimica: ServicioQuimicoImpl }) | null;
  reservaLotesMateria?: number;
  enlace: DescriptorEnlace | null;
  emisionFotogramaDuenos?: boolean;
  limiteBytesFotoDueno?: number;
  cabeceraFoto?: World;
  publicarFoto?: (epoca: number, parte: ParteFotoDueno) => void;
}

type GanchoFase = 'F1' | 'eco' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';
const intento = (tipo: TipoIntento, dato: number[], bytes: Uint8Array | null): Intento =>
  ({ tipo, de: REF_NULA, a: REF_NULA, celda: -1, lote: REF_NULA, nonce: 0, materia: null, dato: Float64Array.from(dato), bytes });

/** Una celda en el punto de control: la posición de su página, no su ranura en la arena (que cambia de una carga a
 * otra). |px|, |py| < 2²⁰ (MAX_COORDINATE / 16), así que cabe exacta en un double y conserva `celda % 256`. */
const SESGO_PAGINA = 2 ** 20, ANCHO_PAGINA = 2 ** 21;
function coordenadasDePagina(guardada: number): [number, number] {
  const pagina = Math.floor(guardada / 256);
  return [Math.floor(pagina / ANCHO_PAGINA) - SESGO_PAGINA, pagina % ANCHO_PAGINA - SESGO_PAGINA];
}
function admiteComposicionFria(rol: Rol): boolean {
  return rol === Rol.Suelo || rol === Rol.Vida;
}
export function celdaMundo(terreno: Pick<Terreno, 'paginaX' | 'paginaY'>, celda: number): number {
  if (celda < 0) return -1;
  const chunk = celda >> 8;
  return ((terreno.paginaX[chunk]! + SESGO_PAGINA) * ANCHO_PAGINA + terreno.paginaY[chunk]! + SESGO_PAGINA) * 256 + (celda & 255);
}
/** La celda de la arena de ahora para una del punto de control; da de alta la página si no está (solo el coordinador). */
export function celdaLocal(terreno: TerrenoPercepcion, guardada: number): number {
  if (guardada < 0) return -1;
  const [px, py] = coordenadasDePagina(guardada);
  return terreno.asegurarPagina(px, py, 0) * 256 + guardada % 256;
}

type GarantiaRestaurable = GarantiaGuardada & { uidDestino: number };

export function destinatariosDeGarantias(pendientes: readonly GarantiaRestaurable[]): ReadonlySet<number> {
  const uids = new Set<number>();
  for (const i of pendientes) if (i.uidDestino > 0) uids.add(i.uidDestino);
  return uids;
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
  #emisorFoto: EmisorFotoDueno | null = null;
  #parteFotoLocal: ParteFotoDueno | null = null;
  readonly #crucesFaunaEntrantes = new Set<ChunkId>();
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
        if (i.tipo === TipoIntento.Admitido && i.celda >= 0 && this.#emisorFoto) {
          this.#crucesFaunaEntrantes.add(this.terrenoPercibido.chunkDe(i.celda));
        }
        this.#contar(i.tipo === TipoIntento.Migrante ? CTL_DUENO.migraciones : i.tipo === TipoIntento.Devuelto ? CTL_DUENO.rechazados : CTL_DUENO.intentos);
        this.#interno.enviar(destino, i);
      },
      vaciar: (cola, f) => this.#interno.vaciar(cola, i => {
        if (this.#aplicarMotor(i)) return;
        if (this.hilos === 1 && this.#archivoFrio) this.#protegerDestinoFrio(i);
        f(i);
        this.#contar(CTL_DUENO.recibidos);
      }),
    };
    if (piezas.enlace) this.enlazar(piezas.enlace);
    if (piezas.emisionFotogramaDuenos && piezas.cabeceraFoto) {
      this.#emisorFoto = new EmisorFotoDueno(piezas.cabeceraFoto, { limiteBytes: piezas.limiteBytesFotoDueno });
    }
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

  readonly ref = (uid: number): Ref => this.organismos.tabla.refPublicada(uid);

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
    const pendientes = cp ? this.cargarMateria(cp) : [], destinatarios = destinatariosDeGarantias(pendientes);
    // `Ley.iniciar` de w materializa cada chunk ya activo que no traiga sus lotes: la reserva de F0 los cubre todos.
    this.reservarMateria(cp ? 0 : this.chunks.length);
    this.publicarFilas(destinatarios);
    this.organismos.tabla.publicar(this.mundo.tick);
    this.iniciarLeyes();
    this.reponer(pendientes, destinatarios);
  }

  /** Leyes encendidas, sus columnas y la materia. Devuelve false si la época ya estaba abierta con las mismas leyes. */
  prepararEpoca(): boolean {
    const leyes = leyesActivas(this.params.v23), firma = leyes.map(l => l.id).join() || '-', m = this.mundo;
    if (firma === this.#firma) return false;
    this.leyes = leyes;
    this.#firma = firma;
    if (this.hilos === 1) {
      const columnas = leyes.flatMap(l => l.columnas ?? []), declaradas = this.frente.columnas;
      if (columnas.some(([nombre]) => !declaradas.includes(nombre))) { olvidarPercepcion(m); olvidarOrganismos(m); this.#escritura = undefined; }
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

  /** En F0, con el frente de la nueva época publicado, vuelve a encaminar las garantías para su F1. */
  reponer(pendientes: readonly GarantiaRestaurable[], destinatarios: ReadonlySet<number>): void {
    if (!pendientes.length) return;
    const frente = this.frente, refs = new Map<number, Ref>();
    if (destinatarios.size) for (let slot = 0; slot < frente.alta; slot++) {
      const uid = frente.uid[slot]!;
      if (frente.vivo[slot] === 1 && destinatarios.has(uid)) {
        refs.set(uid, refs.has(uid) ? REF_NULA : refDe(slot, frente.gen[slot]!));
      }
    }
    for (const { uidDestino, ...i } of pendientes) {
      const a = refs.get(uidDestino) ?? REF_NULA;
      if (a !== REF_NULA) {
        this.#interno.enviar(frente.dueno[slotDe(a)]!, { ...i, a });
        continue;
      }
      // Una garantía dirigida sin actor comprobable se liquida en la celda persistida.
      const entrega = uidDestino === REF_NULA ? i : { ...i, tipo: TipoIntento.Depositar, lote: REF_NULA, dato: null, bytes: null };
      const dueno = i.celda < 0 ? REF_NULA : this.terreno.duenoChunk[this.terreno.chunkDe(i.celda)]!;
      this.#interno.enviar(dueno >= 0 ? dueno : this.hilo, entrega);
    }
  }

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

  /** Activa la emisión opt-in de vistas lentas de fotograma en este dueño con la cabecera de la época. */
  activarEmisionFoto(cabecera: World, limiteBytes?: number): void {
    this.#emisorFoto = new EmisorFotoDueno(cabecera, { limiteBytes });
    this.#parteFotoLocal = null;
  }

  /** Parte de fotograma del coordinador (dueño 0) producido en F6, listo para `#recoger()`. */
  tomarParteFotoLocal(): ParteFotoDueno | null {
    const parte = this.#parteFotoLocal;
    this.#parteFotoLocal = null;
    return parte;
  }

  /** Migrantes de la cola M (los aparta el buzón del dueño: ningún aplicador los ve). Y, si el aplicador de m5 no está
   * encendido, las órdenes del coordinador de la cola B, que sin él nadie vaciaría (no hay más intentos en ella). */
  adoptarMigrantes(): void {
    const control = this.#piezas.control;
    if (this.#emisorFoto && control) {
      this.#emisorFoto.reconciliar(this.mundo.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!, true);
    }
    this.buzon.vaciar('M', () => {});
    if (!this.params.v23.intentos) this.buzon.vaciar('B', () => {});
  }

  #armarMateria(): void {
    const dadas = this.#piezas.materia;
    const quimica = dadas?.quimica ?? crearServicioQuimico({ modo: 'inmediato' });
    const { lotes, desborde } = dadas ?? crearArenasMateria(this.#piezas.reservaLotesMateria);
    const base = sustanciasMundo(quimica), terreno = this.terrenoPercibido;
    this.#lotes = lotes; this.#desborde = desborde;
    const raizFria = process.env.CARTA_MATERIA_FRIA_DIR;
    const archivo = this.#archivoFrio = raizFria && this.hilos === 1 && this.params.v23.guardadoCompleto
      ? new ArchivoMateriaFria(raizFria, dadas?.contenido ?? lotes.maxCapacity, desborde) : undefined;
    const contenido = this.#contenido = archivo?.contenido ?? dadas?.contenido;
    this.quimica = quimica;
    this.materia = new ArenaLotes({
      lotes, desborde, contenido, paginas: terreno.paginasMateria, terreno, quimica, hilo: this.hilo, agua: base.H2O,
      ...(archivo && { leerFrio: (ref, celda) => archivo.leer(ref, celda) }),
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
  #contenido: PageArena | undefined;
  #archivoFrio?: ArchivoMateriaFria;

  muestraMemoriaMateria() {
    if (!this.#lotes || !this.#desborde) return undefined;
    const estadoFrio = this.#archivoFrio?.medidas();
    return {
      lotesVivos: this.#lotes.used, capacidadLotes: this.#lotes.capacity,
      limiteLotes: this.#lotes.maxCapacity, limiteDesborde: this.#desborde.maxCapacity,
      limiteLotesFisicos: this.#contenido?.maxCapacity,
      bytesArena: this.#lotes.bytes + this.#desborde.bytes + (this.#contenido?.bytes ?? 0), estadoFrio,
    };
  }
  cerrarMateriaFria(): void {
    if (!this.#archivoFrio) return;
    this.#archivoFrio.cerrar();
    this.#archivoFrio = undefined;
    if (ctxSi(this.mundo) !== this) return;
    // Las columnas y vistas siguen apuntando a una arena que contenía referencias al directorio privado.
    observarRegiones(this.mundo, undefined);
    olvidarEstadoMateria(this.mundo);
    olvidarPercepcion(this.mundo);
    olvidarOrganismos(this.mundo);
    desenlazarCtx(this.mundo, this);
  }

  /** F0 (coordinador): la arena de lotes solo crece aquí. Garantiza ranuras para `chunksNuevos` chunks y la holgura. */
  reservarMateria(chunksNuevos: number): void {
    if (!this.#lotes || !this.#desborde || this.hilo !== 0) return;
    const porChunk = chunksNuevos * LOTES_POR_CHUNK_NUEVO;
    const libres = porChunk + Math.max(LOTES_POR_CHUNK_NUEVO, this.#lotes.used);
    this.#lotes.prepararF0(libres, LOTES_POR_BLOQUE);
    const contenido = this.#contenido;
    const libresFisicos = contenido ? porChunk + Math.max(LOTES_POR_CHUNK_NUEVO, contenido.used) : libres;
    contenido?.prepararF0(libresFisicos, LOTES_POR_BLOQUE);
    this.#desborde.prepararF0(Math.max(libresFisicos, this.#desborde.used));
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
    if (this.#archivoFrio) this.#enfriarPagina(chunk, cx, cy);
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
    for (const [chunk] of nuevos) {
      this.reponerMateriaParaCeder(chunk);
      for (const ley of this.leyes) ley.alActivar?.(this, chunk);
    }
  }

  /** En barrera, antes de cambiar el dueño o exponer una página reactivada a las leyes. */
  reponerMateriaParaCeder(chunk: ChunkId): void {
    const archivo = this.#archivoFrio;
    if (!archivo?.tiene(chunk)) return;
    if (this.terreno.duenoChunk[chunk] !== this.hilo) throw new Error('La reposición de materia fría exige el dueño anterior.');
    archivo.calentar(this.materia as ArenaLotes, chunk);
  }

  /** Los gestos directos del coordinador todavía se ejecutan en F0. */
  prepararMateriaParaGestos(gestos: readonly Gesture[]): void {
    if (!this.#archivoFrio || gestos.length === 0) return;
    this.#exigirBarreraMateriaFria();
    for (const gesto of gestos) {
      const celda = this.terreno.celda(gesto.x, gesto.y);
      if (celda >= 0) this.reponerMateriaParaCeder(this.terreno.chunkDe(celda));
      if (gesto.agentId === undefined) continue;
      const posicion = this.#celdaMaterialDeRef(this.ref(this.uidDe(gesto.agentId)));
      if (posicion >= 0) this.reponerMateriaParaCeder(this.terreno.chunkDe(posicion));
    }
  }

  /** F0, después del último envío del coordinador y antes de que los dueños vacíen sus colas.
   * Solo prepara mensajes ya publicados. Activar el retiro distribuido exige además acotar destinos nuevos de F1–F6. */
  prepararMateriaAntesDeF1(): number {
    const archivo = this.#archivoFrio;
    if (!archivo) return 0;
    this.#exigirBarreraMateriaFria();
    const arena = this.materia as ArenaLotes, paginas = new Set<ChunkId>();
    const aire = new Float64Array(1);
    const protegerCelda = (celda: number): boolean => {
      if (!Number.isSafeInteger(celda) || celda < 0) return false;
      const pagina = this.terreno.chunkDe(celda);
      if (!(this.terreno.duenoChunk[pagina]! >= 0)) return false;
      if (archivo.tiene(pagina)) paginas.add(pagina);
      return true;
    };
    const protegerLote = (ref: LoteRef): boolean => {
      if (arena.estaAparcado(ref)) protegerCelda(arena.muestra(ref).celda);
      return arena.vivo(ref);
    };
    for (const i of this.pendientes()) {
      if (i.tipo !== TipoIntento.Tomar && !i.materia?.length) continue;
      if (this.#esVaporResidente(i, arena, aire)) continue;
      // Incluye los destinos alternativos que pueden resultar al aplicar o reenviar, aunque el principal siga vivo.
      const explicita = protegerCelda(i.celda);
      const receptor = protegerCelda(this.#celdaMaterialDeRef(i.a));
      const emisor = protegerCelda(this.#celdaMaterialDeRef(i.de));
      const lote = protegerLote(i.lote);
      const destino = i.tipo === TipoIntento.Tomar && protegerLote(i.dato?.[DATO_TOMAR.loteDestino] ?? REF_NULA);
      if (!(explicita || receptor || emisor || lote || destino)) throw new Error(`Intento material ${i.nonce} sin destino demostrable en F0.`);
    }
    for (const pagina of paginas) this.reponerMateriaParaCeder(pagina);
    return paginas.size;
  }

  #exigirBarreraMateriaFria(): void {
    if (this.hilo !== 0 || this.#piezas.buzones?.faseActual !== 0) throw new Error('La preparación de materia fría exige la barrera F0 del coordinador.');
  }

  #celdaMaterialDeRef(ref: Ref): number {
    if (!Number.isSafeInteger(ref) || ref < 0) return REF_NULA;
    const frente = this.frente, slot = slotDe(ref), generacion = genDe(ref);
    if (slot >= frente.alta) return REF_NULA;
    // M5 admite la última celda del destinatario recién muerto como caída de la garantía.
    if (frente.gen[slot] !== generacion && !(frente.vivo[slot] === 0 && frente.gen[slot] === generacion + 1)) return REF_NULA;
    return this.terreno.celda(frente.x[slot]!, frente.y[slot]!);
  }

  #esVaporResidente(i: Intento, arena: ArenaLotes, aire: Float64Array): boolean {
    return i.tipo === TipoIntento.Depositar && i.a === REF_NULA && i.lote === REF_NULA && i.celda >= 0
      && i.dato?.[DATO_MATERIA.rol] === Rol.Aire && arena.lotes(i.celda, Rol.Aire, aire) === 1
      && arena.propio(aire[0]!) && !arena.estaAparcado(aire[0]!);
  }

  #enfriarPagina(chunk: ChunkId, cx: number, cy: number): void {
    const enPagina = ({ x, y }: { x: number; y: number }): boolean => Math.floor(x / 16) === cx && Math.floor(y / 16) === cy;
    const m = this.mundo, x0 = cx * 16, y0 = cy * 16;
    if (m.people.some(enPagina) || m.animals.some(enPagina) || m.structures.some(s => s.cells?.some(enPagina)
      || (s.x < x0 + 16 && s.y < y0 + 16 && s.x + (s.footprint?.width ?? 1) > x0
        && s.y + (s.footprint?.height ?? 1) > y0))) return;
    const arena = this.materia as ArenaLotes;
    const ninguno = new Float64Array(0);
    for (let i = 0; i < 256; i++) {
      const celda = chunk * 256 + i;
      if (arena.lotes(celda, Rol.Objeto, ninguno) || arena.lotes(celda, Rol.Cadaver, ninguno) || arena.lotes(celda, Rol.Pieza, ninguno)) return;
    }
    this.#archivoFrio!.enfriar(arena, chunk, sueloYVidaDormidos(this, chunk));
  }

  #protegerDestinoFrio(i: Intento): void {
    if (i.tipo !== TipoIntento.Tomar && !i.materia?.length) return;
    const archivo = this.#archivoFrio!, arena = this.materia as ArenaLotes;
    if (arena.estaAparcado(i.lote)) archivo.calentar(arena, Math.floor(arena.muestra(i.lote).celda / 256));
    const destino = i.tipo === TipoIntento.Tomar ? i.dato?.[DATO_TOMAR.loteDestino] ?? REF_NULA : REF_NULA;
    if (arena.estaAparcado(destino)) archivo.calentar(arena, Math.floor(arena.muestra(destino).celda / 256));
    if (i.celda < 0) return;
    const pagina = Math.floor(i.celda / 256);
    if (!archivo.tiene(pagina)) return;
    if (this.#esVaporResidente(i, arena, new Float64Array(1))) return;
    // El piloto solo tiene un dueño: la reserva no puede competir con otro hilo al resolver esta entrega.
    archivo.calentar(arena, pagina);
  }

  // ── Fases ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Fija la fase de los buzones (el coordinador, o el único dueño). */
  fase(f: FaseMotor): void { this.#piezas.buzones?.fijarFase(f); }

  gancho(fase: GanchoFase): void { for (const ley of this.leyes) ley[fase]?.(this); }

  /** Vacía una cola con el aplicador de m5 (solo con `v23.intentos`). */
  aplicar(cola: 'M' | 'A' | 'B' | 'C'): void { if (this.params.v23.intentos) aplicarCola(this, cola); }

  retiraChunk(chunk: ChunkId): boolean { return this.cesiones.some(([c, destino]) => c === chunk && destino < 0); }

  /** F0, tras las regiones y los gestos: lo global del coordinador y `Ley.F0`. */
  F0(): void {
    const m = this.mundo;
    this.#crucesFaunaEntrantes.clear();
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
    this.#crucesFaunaEntrantes.clear();
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
  publicarFilas(destinatarios?: ReadonlySet<number>): void {
    const m = this.mundo, organismos = this.organismos, terreno = this.terrenoPercibido;
    const faunaHeredada = !this.params.v23.fauna;
    organismos.fauna.sincronizar(m.animals);
    organismos.escribir(m.tick, faunaHeredada ? { celda: (x, y) => terreno.celda(x, y), chunkDe: c => c >> 8 } : undefined, m.people);
    const w = this.escritura, chunk = w.i32('chunk');
    if (!faunaHeredada && destinatarios?.size) {
      // La ley de fauna aún no ha corrido F6. Solo publica lo que requiere encaminar una garantía repuesta.
      const uid = w.f64('uid'), x = w.f32('x'), y = w.f32('y');
      for (const a of m.animals) {
        if (a.uid === undefined || !destinatarios.has(a.uid)) continue;
        const slot = slotDe(organismos.fauna.ref(a));
        uid[slot] = a.uid;
        x[slot] = a.x;
        y[slot] = a.y;
        const celda = terreno.celda(a.x, a.y);
        chunk[slot] = celda < 0 ? -1 : celda >> 8;
      }
    }
    for (const [slot, p] of organismos.personas.mapa) {
      const celda = terreno.celda(p.x, p.y);
      chunk[slot] = celda < 0 ? -1 : celda >> 8;
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
    const chunksEscritos: number[] | undefined = this.#emisorFoto ? [] : undefined;
    const cupo = escribirFotograma(this, this.#foto, this.#filasFotograma(), chunksEscritos);
    if (!cupo) {
      this.#fotoValida = false;
      const control = this.#piezas.control;
      if (control) control[CTL.fotoInvalido] = 1;
      return;
    }
    const control = this.#piezas.control;
    if (!this.#emisorFoto || !control) return;
    const parte = this.#emisorFoto.emitir(
      this, this.#foto, chunksEscritos!, this.organismos,
      (px, py) => this.terrenoPercibido.paginaDe(px, py),
      control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!,
      control[CTL.fotoCaras] === 1,
      this.#crucesFaunaEntrantes,
    );
    this.#crucesFaunaEntrantes.clear();
    if (this.hilo === 0) this.#parteFotoLocal = parte;
    else if (this.#piezas.publicarFoto) this.#piezas.publicarFoto(this.epoca, parte);
    else this.#interno.enviar(0, intento(TipoIntento.Global, [AVISO.foto, this.hilo], serialize(parte)));
  }

  *#filasFotograma(): Iterable<number> {
    // El frente escrito puede incluir una cesión de otro hilo en este mismo F6. Solo se graba desde el heap que aún tiene el organismo.
    const { personas, fauna } = this.organismos;
    yield* personas.ranuras;
    for (const animal of this.mundo.animals) {
      const ref = fauna.ref(animal);
      if (ref !== REF_NULA) yield slotDe(ref);
    }
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
      const control = this.#piezas.control;
      if (mig.persona) {
        adoptarPersona(mig.persona);
        if (this.#emisorFoto && control && mig.persona.persona.uid !== undefined) {
          this.#emisorFoto.adoptarOrganismo(mig.persona.persona.uid, Clase.Persona, mig.estadoCinta,
            m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!);
        }
        for (const ley of this.leyes) ley.alAdoptar?.(this, mig.persona.persona);
      }
      if (mig.animal) {
        adoptarAnimal(mig.animal.animal, mig.animal.ref);
        if (this.#emisorFoto && control && mig.animal.animal.uid !== undefined) {
          this.#emisorFoto.adoptarOrganismo(mig.animal.animal.uid, Clase.Animal, mig.estadoCinta,
            m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!);
        }
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
    const control = this.#piezas.control;
    if (this.#emisorFoto && control && mig.cedido) {
      this.#emisorFoto.adoptarChunk(mig.key, mig.estadoCinta,
        m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!);
    }
    // El reparto al abrir la época no es una activación: lo cubren `Ley.iniciar` y, tras una carga, `adoptarPropios`.
    if (mig.inicial) return;
    for (const ley of this.leyes) ley.alActivar?.(this, mig.chunk, mig.cedido);
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
      if (destino >= 0) {
        mig.cedido = true;
        // Las proyecciones globales leen los activos del dueño 0 después de emigrar.
        // El camino reunido añade los migrantes que aún no ha adoptado el destino.
        if (this.#parteFotoLocal && (mig.structures.some(s => s.installed?.length || s.storedCompounds?.length)
          || mig.personas.some(p => p.persona.compounds?.length))) this.#parteFotoLocal = null;
        const control = this.#piezas.control;
        if (this.#emisorFoto && control) {
          mig.estadoCinta = this.#emisorFoto.extraerChunkCedido(
            mig.key,
            mig.structures.map(s => s.id),
            mig.personas.map(p => p.persona.uid!).filter(uid => uid !== undefined),
            mig.animals.map(a => a.uid!).filter(uid => uid !== undefined),
            m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!,
          );
          control[celdaDueno(this.hilo, CTL_DUENO.migrantesFoto)]!++;
        }
        this.enviarMigrante(destino, mig);
      } else {
        const control = this.#piezas.control;
        if (this.#emisorFoto && control) {
          this.#emisorFoto.alRetirarChunk(mig.key, m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!);
        }
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
    const control = this.#piezas.control;
    let seVan: Person[] | undefined;
    for (const p of m.people) {
      const destino = duenoDe(p);
      if (destino === this.hilo || destino < 0) continue;
      if (this.#parteFotoLocal && p.compounds?.length) this.#parteFotoLocal = null;
      const ref = organismos.personas.soltar(p);
      tabla.ceder(this.hilo, ref, destino);
      let estadoCinta: EstadoCintaOrganismo | undefined;
      if (this.#emisorFoto && control && p.uid !== undefined) {
        estadoCinta = this.#emisorFoto.extraerOrganismo(
          p.uid, Clase.Persona, m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!,
        );
        control[celdaDueno(this.hilo, CTL_DUENO.migrantesFoto)]!++;
      }
      this.enviarMigrante(destino, { tipo: 'organismo', persona: { persona: p, ref }, ...(estadoCinta ? { estadoCinta } : {}) });
      (seVan ??= []).push(p);
    }
    if (seVan) { const fuera = new Set(seVan); m.people = m.people.filter(p => !fuera.has(p)); }
    let animales: Animal[] | undefined;
    for (const a of m.animals) {
      const destino = duenoDe(a);
      if (destino === this.hilo || destino < 0) continue;
      const ref = organismos.fauna.soltar(a);
      if (ref !== REF_NULA) tabla.ceder(this.hilo, ref, destino);
      let estadoCinta: EstadoCintaOrganismo | undefined;
      if (this.#emisorFoto && control && a.uid !== undefined) {
        estadoCinta = this.#emisorFoto.extraerOrganismo(
          a.uid, Clase.Animal, m.tick, this.epoca, control[CTL.fotoDuenosEntregado]!, control[CTL.fotoDuenosResync]!,
        );
        control[celdaDueno(this.hilo, CTL_DUENO.migrantesFoto)]!++;
      }
      this.enviarMigrante(destino, { tipo: 'organismo', animal: { animal: a, ref }, ...(estadoCinta ? { estadoCinta } : {}) });
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

  /** Reparto al abrir una época: clasifica una vez cada colección y entrega los chunks en el orden de entrada. */
  repartirChunksIniciales(chunks: Int32Array, duenos: Int16Array): void {
    const m = this.mundo, terreno = this.terrenoPercibido;
    const remotos = new Map<ChunkId, { destino: Hilo; migrante: MigranteChunk }>();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!, destino = duenos[i]!;
      if (destino === this.hilo || remotos.has(chunk)) continue;
      const key = this.#activos.get(chunk), meta = key === undefined ? undefined : m.chunks[key];
      if (key === undefined || !meta) continue;
      remotos.set(chunk, { destino, migrante: {
        tipo: 'chunk', chunk, key, meta, tiles: [], structures: [], animals: [], personas: [], inicial: true,
      } });
    }
    if (remotos.size === 0) return;

    function separar<T extends { x: number; y: number }>(lista: T[], trasladar: (migrante: MigranteChunk, elemento: T) => void): T[] {
      let locales: T[] | undefined;
      for (let i = 0; i < lista.length; i++) {
        const elemento = lista[i]!;
        // Replica el criterio del desprendimiento de un chunk, incluso en coordenadas fraccionarias negativas.
        const remoto = remotos.get(terreno.paginaDe(elemento.x >> 4, elemento.y >> 4));
        if (remoto) {
          locales ??= lista.slice(0, i);
          trasladar(remoto.migrante, elemento);
        } else locales?.push(elemento);
      }
      return locales ?? lista;
    }

    const previas = m.tiles;
    m.tiles = separar(previas, (mig, tile) => mig.tiles.push(tile));
    faunaCacheFiltered(previas, m.tiles);
    m.structures = separar(m.structures, (mig, estructura) => mig.structures.push(estructura));
    m.animals = separar(m.animals, (mig, animal) => mig.animals.push(animal));
    m.people = separar(m.people, (mig, persona) => mig.personas.push({ persona, ref: this.organismos.personas.ref(persona) }));
    for (const { destino, migrante } of remotos.values()) {
      delete m.chunks[migrante.key];
      this.#activos.delete(migrante.chunk);
      // Una tesela residente puede ser un proxy. Aplana solo la página que se está enviando.
      this.enviarMigrante(destino, { ...migrante, tiles: migrante.tiles.map(tile => ({ ...tile })) });
    }
    this.#chunks = undefined;
  }

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
    const arena = this.materia as ArenaLotes;
    this.totales = plegarLibros(this.#piezas.libros, this.totales);
    const terreno = this.terrenoPercibido;
    function* lotes(): IterableIterator<LoteGuardado> {
      for (const lote of arena.muestras()) {
        lote.celda = celdaMundo(terreno, lote.celda);
        yield lote;
      }
    }
    const recorrido = this.#archivoFrio?.fuenteCheckpoint(arena, celda => celdaMundo(terreno, celda), pagina => {
      const [cx, cy] = coordenadasDePagina(pagina * 256);
      return terreno.paginaDe(cx, cy);
    }) ?? {
      *medir() {
        for (const { celda, pares } of arena.medirComposiciones()) {
          if (pares === null) throw new Error('Composición fría sin archivo en el punto de control.');
          yield { celda: celdaMundo(terreno, celda), pares };
        }
      },
    };
    const frente = this.frente;
    const enVuelo = pendientes.filter(i => i.materia !== null).map(i => {
      const celda = celdaMundo(terreno, i.celda);
      if (i.a === REF_NULA) return { ...i, de: REF_NULA, celda };
      const slot = slotDe(i.a);
      const uid = frente.vivo[slot] === 1 && frente.gen[slot] === genDe(i.a) ? frente.uid[slot]! : 0;
      return { ...i, de: REF_NULA, a: REF_NULA, celda, uidDestino: uid };
    });
    return {
      epoca: this.epoca, tick: this.mundo.tick,
      sustancias: serializarSustancias(this.quimica as ServicioQuimicoImpl), registro: this.registro.guardar(),
      paginas: codificarPaginas(this.epoca, lotes, () => arena.libres(), recorrido), enVuelo: codificarEnVuelo(enVuelo),
      inicial: this.totales.inicial, fuentes: this.totales.fuentes, sumideros: this.totales.sumideros,
    };
  }

  /** Repone la materia de un punto de control en la arena recién creada y devuelve los intentos con garantía que
   * estaban en vuelo (quien llama los repone en un buzón). */
  cargarMateria(cp: MateriaCheckpoint): GarantiaRestaurable[] {
    if (!this.materia || !this.quimica) throw new Error('Cargar materia exige v23.materia.');
    const terreno = this.terrenoPercibido;
    // Guardados previos: recoger roca dejaba su lote Objeto ligado a la celda aunque la persona ya lo llevaba.
    const carga = new Set<LoteRef>();
    for (const persona of this.mundo.people) for (const lote of persona.carga ?? []) carga.add(lote);
    const celdaGuardada = (lote: LoteGuardado): number =>
      lote.rol === Rol.Objeto && carga.has(lote.ref) ? REF_NULA : lote.celda;
    const enVuelo = decodificarEnVuelo(cp.enVuelo);
    const sinCelda = enVuelo.filter(i => i.celda < 0 && i.materia?.length);
    const archivo = this.#archivoFrio;
    const arranque = sinCelda.length === 0 && archivo ? this.#prepararArranqueFrio(archivo, enVuelo) : undefined;
    let desborde = 0, vivos = 0;
    const paginasLocales = new Map<number, number>();
    const indice = indexarPaginas(cp.epoca, cp.paginas, (lote, especies) => {
      const celda = celdaGuardada(lote);
      if (celda >= 0) {
        const pagina = celda - celda % 256;
        if (!paginasLocales.has(pagina)) paginasLocales.set(pagina, arranque ? celdaLocal(terreno, pagina) : 0);
      }
      const extra = desbordeDeEspecies(especies);
      arranque?.observar(lote, paginasLocales, extra);
      desborde += extra;
      vivos++;
    });
    // Demostrar la identidad o la celda con la generación exacta del lote antes de instalar la arena.
    const ligados = new Set<LoteRef>();
    for (const i of enVuelo) {
      const actorLegado = i.uidDestino === undefined && i.a !== REF_NULA;
      if ((!actorLegado && i.celda >= 0) || i.lote === REF_NULA || !i.materia?.length) continue;
      const lote = indice.leer(slotDe(i.lote));
      if (lote === undefined || typeof lote === 'number' || lote.ref !== i.lote) continue;
      if (i.celda < 0) i.celda = celdaGuardada(lote);
      if (actorLegado || i.celda < 0) ligados.add(i.lote);
    }
    const portadores = ligados.size ? this.#portadoresDeGarantias(ligados) : undefined;
    for (const i of sinCelda) {
      if (i.celda < 0) i.celda = portadores?.get(i.lote)?.celda ?? REF_NULA;
      if (i.celda < 0) throw new Error(`Garantía guardada ${i.nonce} sin celda ni destino material demostrable.`);
    }
    if (arranque) {
      const frio = arranque.terminar();
      this.#lotes!.prepararF0(indice.ranuras, LOTES_POR_BLOQUE);
      archivo!.contenido.prepararF0(vivos - frio.lotes, LOTES_POR_BLOQUE);
      this.#desborde!.prepararF0(desborde - frio.desborde);
    } else {
      // Se dan de alta en el orden del archivo, antes de instalar los lotes por ranura.
      for (const pagina of paginasLocales.keys()) paginasLocales.set(pagina, celdaLocal(terreno, pagina));
      this.reservarMateria(Math.ceil(indice.ranuras / LOTES_POR_CHUNK_NUEVO));
      this.#desborde!.prepararF0(desborde);
    }
    (this.materia as ArenaLotes).cargarPorRanura(indice.ranuras, ranura => {
      const lote = indice.leer(ranura);
      if (lote === undefined || typeof lote === 'number') return lote;
      const celda = celdaGuardada(lote), desplazamiento = celda % 256;
      lote.celda = celda < 0 ? REF_NULA : paginasLocales.get(celda - desplazamiento)! + desplazamiento;
      // Cada dueño adopta los lotes de sus organismos al repartir.
      lote.dueno = 0;
      return lote;
    }, arranque ? lote => lote.celda >= 0 && admiteComposicionFria(lote.rol)
      && archivo!.tiene(Math.floor(lote.celda / 256)) : undefined);
    this.registro.cargar(cp.registro);
    this.totales = { inicial: [...cp.inicial], fuentes: [...cp.fuentes], sumideros: [...cp.sumideros] };
    const q = this.quimica, saldo = saldoEnVuelo(cp.enVuelo, id => q.sustancia(id));
    this.#piezas.libros[0]!.enVuelo.set(saldo.map(Number));
    return enVuelo.map(i => {
      const uidDestino = i.uidDestino ?? (i.a === REF_NULA ? REF_NULA : portadores?.get(i.lote)?.uid ?? 0);
      return { ...i, de: REF_NULA, a: REF_NULA, celda: celdaLocal(terreno, i.celda), uidDestino };
    });
  }

  #portadoresDeGarantias(ligados: ReadonlySet<LoteRef>): Map<LoteRef, { celda: number; uid?: number } | null> {
    const terreno = this.terrenoPercibido, portadores = new Map<LoteRef, { celda: number; uid?: number } | null>();
    const componentes: LoteRef[] = [];
    const anotar = (organismo: Person | Animal, carga: readonly LoteRef[]): void => {
      const { x, y, cuerpo } = organismo;
      const uid = organismo.uid !== undefined && Number.isSafeInteger(organismo.uid) && organismo.uid > 0 ? organismo.uid : undefined;
      componentes.length = 0;
      if (cuerpo) lotesDe(cuerpo, componentes);
      for (const l of carga) componentes.push(l);
      let celda: number | undefined;
      for (const l of componentes) {
        if (!ligados.has(l)) continue;
        if (portadores.has(l)) { portadores.set(l, null); continue; }
        if (celda === undefined) {
          const pagina = terreno.paginaDe(x >> 4, y >> 4);
          celda = pagina < 0 ? REF_NULA : celdaMundo(terreno, pagina * 256 + (y & 15) * 16 + (x & 15));
        }
        portadores.set(l, { celda, uid });
      }
    };
    for (const p of this.mundo.people) if (p.demography.deathCause === null) anotar(p, p.carga ?? []);
    for (const a of this.mundo.animals) anotar(a, []);
    return portadores;
  }

  #prepararArranqueFrio(archivo: ArchivoMateriaFria, garantias: readonly Intento[]) {
    // Con mensajes sin coordenadas se conserva la apertura caliente.
    if (garantias.some(i => i.celda < 0)) return undefined;
    const m = this.mundo, contexto = worldContext(m);
    const retiradas = new Map<string, Chunk>();
    for (const chunk of m.retiredChunks) if (!retiradas.has(chunk.key)) retiradas.set(chunk.key, chunk);
    if (!retiradas.size && !contexto.loadChunk) return undefined;
    const ocupadas = new Set(Object.keys(m.chunks));
    for (const p of m.people) for (const clave of clavesDeHalo(p.x, p.y)) ocupadas.add(clave);
    for (const a of m.animals) ocupadas.add(chunkKey(a.x, a.y));
    for (const s of m.structures) {
      for (const punto of s.cells ?? [s]) ocupadas.add(chunkKey(punto.x, punto.y));
      for (let x = 0; x < (s.footprint?.width ?? 1); x++) for (let y = 0; y < (s.footprint?.height ?? 1); y++) {
        ocupadas.add(chunkKey(s.x + x, s.y + y));
      }
    }
    const bloquesProtegidos = new Set(garantias.map(i => i.celda - i.celda % 256));
    const refsProtegidas = new Set(garantias.map(i => i.lote));
    const total = { lotes: 0, desborde: 0 };
    let bloque: { local: number; cx: number; cy: number; clave: string; lotes: Map<LoteRef, Float64Array>; desborde: number } | undefined;
    let baseAnterior = -Infinity;
    const terminarBloque = () => {
      if (!bloque || bloque.lotes.size !== 512) return;
      const { local, cx, cy, clave, lotes, desborde } = bloque;
      const guardado = retiradas.get(clave) ?? contexto.loadChunk?.(clave, m.tick, this.params.v23);
      if (!guardado || guardado.key !== clave || guardado.cx !== cx || guardado.cy !== cy || guardado.lifeVersion !== 4
        || !Number.isSafeInteger(guardado.lastTick) || guardado.lastTick < 0 || guardado.lastTick > m.tick
        || guardado.tiles.length !== CHUNK_SIZE ** 2 || !Array.isArray(guardado.animals) || guardado.animals.length
        || !Array.isArray(guardado.structures) || guardado.structures.length) return;
      // Store valida al leer. Comprueba también las posiciones de las retiradas que aún no se guardaron.
      if (retiradas.has(clave) && guardado.tiles.some((tile, i) =>
        tile.x !== cx * CHUNK_SIZE + i % CHUNK_SIZE || tile.y !== cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE))) return;
      if (archivo.guardar(local, lotes)) { total.lotes += lotes.size; total.desborde += desborde; }
    };
    return {
      observar(lote: LoteGuardado, locales: ReadonlyMap<number, number>, desborde: number) {
        const base = Math.floor(lote.celda / 256) * 256;
        if (base !== baseAnterior) {
          terminarBloque();
          baseAnterior = base;
          bloque = undefined;
          if (base >= 0 && !bloquesProtegidos.has(base)) {
            const [cx, cy] = coordenadasDePagina(base), clave = `${cx},${cy}`;
            const local = locales.get(base);
            if (local !== undefined && !ocupadas.has(clave)) bloque = { local: local / 256, cx, cy, clave, lotes: new Map(), desborde: 0 };
          }
        }
        if (!bloque) return;
        if (refsProtegidas.has(lote.ref)) { bloque = undefined; return; }
        if (admiteComposicionFria(lote.rol)) {
          bloque.lotes.set(lote.ref, lote.pares);
          bloque.desborde += desborde;
        } else if (lote.rol !== Rol.Agua && lote.rol !== Rol.Aire && lote.rol !== Rol.Roca && lote.rol !== Rol.Mar && lote.rol !== Rol.Cielo) {
          bloque = undefined;
        }
      },
      terminar() { terminarBloque(); return total; },
    };
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
export function duenoDe(mundo: World, sustancias?: Uint8Array, reservaLotesMateria?: number): Dueno {
  const previo = duenoSi(mundo);
  if (previo) return previo;
  const buzones = new Buzones(1), azar = (): number => random(mundo);
  const quimica = sustancias && cargarSustancias(sustancias, { modo: 'inmediato' });
  return new Dueno(mundo, {
    hilo: 0, hilos: 1, buzones, buzon: buzones.dueno(0, azar), libros: crearLibros(1), contadores: null,
    registro: new RegistroContenido(1), azar, control: null, enlace: null,
    materia: quimica ? { ...crearArenasMateria(reservaLotesMateria), quimica } : null,
    reservaLotesMateria,
  });
}

/** El dueño que debe conducir el tick de `mundo`, o `undefined` si todo está apagado (tick heredado). */
export function conductorDe(mundo: World): Dueno | undefined {
  const previo = duenoSi(mundo);
  if (previo) return previo.hilos === 1 && previo.activo ? previo : undefined;
  return leyesActivas(paramsOf(mundo).v23).length > 0 ? duenoDe(mundo) : undefined;
}
