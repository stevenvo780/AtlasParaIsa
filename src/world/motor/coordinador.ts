/**
 * INTERFAZ PUENTE del motor de dueños (carril m4a; ARQ-motor §3 y contrato `Motor`). El esqueleto lo fijó la
 * preparación de la oleada: m4a rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consumen srv, lab y los bancos).
 *
 * Con un hilo, `MotorUnico` es una fachada de `stepWorld`: el hilo que llama es el único dueño. Con más,
 * `MotorDuenos` es el coordinador (y dueño 0): reparte el mundo en tramos Morton, lanza un worker por dueño sobre una
 * `Piscina` y conduce cada tick con cuatro barreras (F0 en serie, percibir, actuar, aplicar y el cierre en serie).
 * Toda la memoria compartida se crea al abrir la época (un SAB no viaja por un buzón): cargar, o enlazar una cinta con
 * los workers ya en marcha, cierra la piscina y abre otra.
 */
import { availableParallelism } from 'node:os';
import { deserialize, serialize } from 'node:v8';
import type { DescriptorEnlace } from '../../shared/fotograma.js';
import type { ChronicleEvent, FaseNombre, Gesture, GestureResult } from '../../shared/types.js';
import { applyGesture } from '../actuar/gestos.js';
import { olvidarPercepcion } from '../decision/percepcion.js';
import { TerrenoPercepcion } from '../decision/terreno-percepcion.js';
import { cargarSustancias, crearServicioQuimico, serializarSustancias } from '../materia/servicio.js';
import type { MateriaCheckpoint } from '../materia/tipos.js';
import { addEvent } from '../mundo/crear.js';
import { stepWorld, type FaseMedicion } from '../mundo/paso.js';
import { TICKS_PER_DAY, type Person, type World } from '../mundo/tipos.js';
import { paramsOf } from '../params.js';
import { ErrorFatalMotor } from '../paralelo/barrera.js';
import { Piscina } from '../paralelo/piscina.js';
import { PageArena } from '../soa/arena.js';
import { olvidarOrganismos } from '../soa/organismos-mundo.js';
import { RESERVA_FILAS_DUENOS, TablaOrganismosSoA } from '../soa/organismos.js';
import { residentFastAccess } from '../soa/terreno.js';
import { archivarChunk, tomarChunk, validCoordinate } from '../spatial.js';
import { recordSample } from '../statistics.js';
import { chunkKey } from '../terrain.js';
import { tileLookup } from '../tile-index.js';
import { duenoDeVecino, repartirPorTramos } from './bloques.js';
import { Buzones } from './buzon.js';
import { Contadores, crearLibros } from './contadores.js';
import {
  AVISO, CTL, CTL_DUENO, Dueno, ORDEN, RESERVA_DESBORDE, RESERVA_LOTES, celdaDueno, duenoDe, duenoSi,
  type MigranteChunk, type ParteTick,
} from './contexto.js';
import { Clase, slotDe, type ChunkId, type Hilo, type Instantanea, type Intento, type Motor, type MotorConfig, type TelemetriaMotor } from './contratos.js';
import { TRAMO, azarDeHilo, crearDueno, faseDueno, ligarCompartido, type DatosDueno } from './dueno-worker.js';
import { leyesActivas } from './leyes.js';
import { desequilibrio, repartir, tocaRebalancear, type MedidaReparto } from './rebalanceo.js';
import { RegistroContenido } from './registro.js';
import { cabeceraDe, reunir } from './reunir.js';

// ── Constantes del motor (política del proceso, no leyes del mundo) ──────────────────────────────────────

/** Ticks de una ventana de medida del reparto: al cerrarla se anota el desequilibrio y m7 decide si toca rebalancear. */
export const VENTANA_REPARTO_TICKS = 60;
/** Peso de la última medida en la media móvil del coste por chunk (ms de pared de su dueño repartidos entre sus chunks). */
export const ALFA_COSTE_CHUNK = 0.1;
/** Peso del último tick en la media móvil de la telemetría (Hz y ms por fase). */
export const ALFA_TELEMETRIA = 0.05;
/** Ventanas de desequilibrio que se guardan para `tocaRebalancear`. */
export const VENTANAS_REPARTO = 8;
/** Alcance del halo de una persona en celdas (el de `maintainRegions`): su chunk y los que tocan x ± 8, y ± 8. */
const HALO = [-8, 0, 8] as const;

const ema = (previo: number, valor: number, alfa: number): number => previo === 0 ? valor : previo + alfa * (valor - previo);
const clavePagina = (px: number, py: number): number => (px + 2 ** 20) * 2 ** 21 + py + 2 ** 20;
const telemetriaVacia = (hilos: number): TelemetriaMotor => ({
  tick: 0, hz: 0, diasPorMinuto: 0, hilos, desequilibrio: 1,
  faseMs: { F0: 0, eco: 0, percibir: 0, actuar: 0, aplicar: 0 }, esperaBarreraMs: 0, ocupacion: new Float32Array(hilos),
  gpuMs: [], gpuBytes: [], gpuEstado: [], intentos: 0, rechazados: 0, migraciones: 0, fotogramasSaltados: 0,
});

/** Arma el motor sobre un mundo ya creado o cargado. Con `config.hilos === 1` no lanza workers: el hilo que llama es el
 * único dueño y `paso` hace lo mismo que `stepWorld`. Con más, reparte el mundo entre dueños (exige `v23.duenos`). */
export function crearMotor(mundo: World, config: MotorConfig): Motor {
  // 'auto' toma los hilos que el proceso puede usar; elegir entre T y ¾T por Hz medido es de m7 (`hilosAuto`).
  const hilos = config.hilos === 'auto' ? (paramsOf(mundo).v23.duenos ? availableParallelism() : 1) : config.hilos;
  if (!Number.isSafeInteger(hilos) || hilos < 1) throw new RangeError(`Cantidad de hilos inválida: ${hilos}.`);
  if (hilos === 1) return new MotorUnico(mundo);
  if (!paramsOf(mundo).v23.duenos) throw new Error('Un motor de varios dueños exige v23.duenos (y con él todas las leyes de la V23).');
  return new MotorDuenos(mundo, config, hilos);
}

// ── Un dueño ─────────────────────────────────────────────────────────────────────────────────────────────

/** Fachada de `stepWorld`: el mundo entero en el hilo que llama. */
class MotorUnico implements Motor {
  #mundo: World;
  #enlace: DescriptorEnlace | null = null;
  #epoca = 0;
  readonly #t = telemetriaVacia(1);
  readonly #medicion: FaseMedicion = { clock: () => performance.now(), fases: {} };

  constructor(mundo: World) { this.#mundo = mundo; }

  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] } {
    const inicio = performance.now(), fases = this.#medicion.fases = {} as Partial<Record<FaseNombre, number>>;
    const resultados = stepWorld(this.#mundo, [...gestos], undefined, this.#medicion);
    const ms = performance.now() - inicio, t = this.#t, d = duenoSi(this.#mundo), de = (n: FaseNombre): number => fases[n] ?? 0;
    t.tick = this.#mundo.tick;
    t.hz = ema(t.hz, 1000 / Math.max(ms, 1e-3), ALFA_TELEMETRIA);
    t.diasPorMinuto = t.hz * 60 / TICKS_PER_DAY;
    t.faseMs.F0 = ema(t.faseMs.F0, de('maintainRegions'), ALFA_TELEMETRIA);
    t.faseMs.eco = ema(t.faseMs.eco, de('ecologia') + de('kernel') + de('fauna'), ALFA_TELEMETRIA);
    t.faseMs.actuar = ema(t.faseMs.actuar, de('personas'), ALFA_TELEMETRIA);
    t.faseMs.aplicar = ema(t.faseMs.aplicar, de('encuentros') + de('demografia') + de('comunidades') + de('reproduccion'), ALFA_TELEMETRIA);
    t.ocupacion[0] = 1;
    if (d) { t.intentos = d.cuentas[0]!; t.rechazados = d.cuentas[1]!; t.migraciones = d.cuentas[2]!; t.fotogramasSaltados = d.fotogramasPerdidos; }
    return { tick: this.#mundo.tick, resultados };
  }

  instantanea(): Instantanea {
    const d = duenoSi(this.#mundo);
    return { world: this.#mundo, materia: d ? d.instantaneaMateria(d.pendientes()) : null };
  }

  cargar(i: Instantanea, epoca: number): void {
    this.#mundo = i.world;
    this.#epoca = epoca;
    const activo = leyesActivas(paramsOf(i.world).v23).length > 0 || this.#enlace !== null;
    if (!activo && !i.materia) return;
    const d = duenoDe(i.world, i.materia?.sustancias);
    d.epoca = epoca;
    d.enlazar(this.#enlace);
    d.abrirEpoca(i.materia);
  }

  enlazar(cinta: DescriptorEnlace): void {
    this.#enlace = cinta;
    const d = duenoDe(this.#mundo);
    d.epoca = this.#epoca;
    d.enlazar(cinta);
  }

  detalle(uid: number): Promise<Person | null> {
    const persona = this.#mundo.people.find(p => p.uid === uid);
    return Promise.resolve(persona ? structuredClone(persona) : null);
  }

  telemetria(): TelemetriaMotor { return { ...this.#t, faseMs: { ...this.#t.faseMs }, ocupacion: this.#t.ocupacion.slice() }; }

  cerrar(): Promise<void> { return Promise.resolve(); }
}

// ── Varios dueños ────────────────────────────────────────────────────────────────────────────────────────

interface Pagina { chunk: ChunkId; px: number; py: number; key: string; estado: 'activo' | 'retirando' }

class MotorDuenos implements Motor {
  #mundo: World;
  readonly #config: MotorConfig;
  readonly #hilos: number;
  #epoca = 0;
  #enlace: DescriptorEnlace | null = null;
  #piscina: Piscina<DatosDueno> | null = null;
  #fatal: ErrorFatalMotor | undefined;
  // Vigentes mientras hay piscina (los arma `#arrancar`).
  #d!: Dueno;
  #buzones!: Buzones;
  #contadores!: Contadores;
  #control!: Float64Array;
  #terreno!: TerrenoPercepcion;
  #tabla!: TablaOrganismosSoA;
  #cabecera!: World;
  readonly #paginas = new Map<number, Pagina>();
  /** Chunks mandados ceder en el tick anterior: cambian de dueño en este F0. */
  #cesiones: [ChunkId, Hilo][] = [];
  #costeMs = new Float64Array(0);
  readonly #historial: number[] = [];
  // Lo que llega por la cola F0 del coordinador.
  #resultados: GestureResult[] = [];
  #partesTick: ParteTick[] = [];
  #partesMundo: World[] = [];
  #altas: [number, string][] = [];
  readonly #detalles = new Map<number, ((p: Person | null) => void)[]>();
  readonly #t: TelemetriaMotor;

  constructor(mundo: World, config: MotorConfig, hilos: number) {
    this.#mundo = mundo; this.#config = config; this.#hilos = hilos;
    this.#t = telemetriaVacia(hilos);
  }

  // ── Época: memoria compartida, reparto y workers ───────────────────────────────────────────────────────

  #arrancar(materia: MateriaCheckpoint | null): void {
    const m = this.#mundo, hilos = this.#hilos, params = paramsOf(m), verificar = this.#config.verificar || params.motor.depuracion;
    void this.#piscina?.cerrar().catch(() => {});
    this.#piscina = null;
    this.#fatal = undefined;
    olvidarPercepcion(m); olvidarOrganismos(m);
    this.#paginas.clear(); this.#cesiones = []; this.#historial.length = 0;
    this.#resultados = []; this.#partesTick = []; this.#partesMundo = []; this.#altas = [];

    // Memoria compartida de la época. La reserva de filas crece con el mundo que se carga: agotarla es fatal y la
    // recarga siguiente la abre mayor.
    let reserva = RESERVA_FILAS_DUENOS;
    while (reserva < 8 * (m.people.length + m.animals.length)) reserva *= 2;
    const tabla = this.#tabla = new TablaOrganismosSoA(verificar, { reservaFilas: reserva });
    const contadores = this.#contadores = new Contadores(hilos, {
      uid: m.siguienteUid ?? 1, comunidad: m.communityCounter + 1, estructura: m.structureCounter + 1,
      nonce: Math.min(2 ** 52, (m.tick + 1) * 2 ** 22),
    });
    contadores.fijarCronica(m.eventCounter + 1);
    const terreno = this.#terreno = new TerrenoPercepcion(verificar);
    terreno.usarDuenos();
    ligarCompartido(m, tabla, terreno, contadores);
    for (const ley of leyesActivas(params.v23)) for (const [nombre, tipo, ancho] of ley.columnas ?? []) tabla.columna(nombre, tipo, ancho);
    const buzones = this.#buzones = new Buzones(hilos), libros = crearLibros(hilos), registro = new RegistroContenido(hilos);
    const control = this.#control = new Float64Array(new SharedArrayBuffer((CTL.porDueno + hilos * CTL_DUENO.celdas) * Float64Array.BYTES_PER_ELEMENT));
    control[CTL.tick] = m.tick; control[CTL.epoca] = this.#epoca; control[CTL.fotoRanura] = -1;
    const azar = azarDeHilo(this.#config.semilla, 0);
    const conMateria = params.v23.materia;
    const quimica = !conMateria ? null : materia ? cargarSustancias(materia.sustancias, { modo: 'inmediato' }) : crearServicioQuimico({ modo: 'inmediato' });
    const lotes = conMateria ? new PageArena(RESERVA_LOTES) : null, desborde = conMateria ? new PageArena(RESERVA_DESBORDE) : null;
    const d = this.#d = new Dueno(m, {
      hilo: 0, hilos, buzones, buzon: buzones.dueno(0, azar), libros, contadores, registro, azar, control, enlace: this.#enlace,
      materia: quimica && lotes && desborde ? { lotes, desborde, quimica } : null,
    });
    d.epoca = this.#epoca;
    d.avisar = (clase, i) => this.#aviso(clase, i);
    d.prepararEpoca();

    // Páginas y reparto inicial: tramos Morton con el mismo peso por chunk (aún no hay coste medido).
    const claves = Object.keys(m.chunks), px = Int32Array.from(claves, k => m.chunks[k]!.cx), py = Int32Array.from(claves, k => m.chunks[k]!.cy);
    const duenos = repartirPorTramos(px, py, hilos), chunks = new Int32Array(claves.length);
    for (let i = 0; i < claves.length; i++) {
      const chunk = chunks[i] = terreno.asegurarPagina(px[i]!, py[i]!, duenos[i]!);
      d.tenerChunk(chunk, claves[i]!);
      this.#paginas.set(clavePagina(px[i]!, py[i]!), { chunk, px: px[i]!, py: py[i]!, key: claves[i]!, estado: 'activo' });
    }
    buzones.fijarFase(0);
    if (materia) d.reponer(d.cargarMateria(materia));
    d.reservarMateria(0);
    const cabecera = serialize(cabeceraDe(m));
    this.#cabecera = deserialize(cabecera) as World;
    for (let i = 0; i < claves.length; i++) if (duenos[i] !== 0) {
      const migrante = d.repartirChunk(chunks[i]!);
      if (migrante) d.enviarMigrante(duenos[i]!, migrante);
    }
    const tileIn = tileLookup(m.tiles), fast = residentFastAccess(m.tiles);
    for (let i = 0; i < claves.length; i++) if (duenos[i] === 0) terreno.sincronizarPagina(chunks[i]!, tileIn, fast);

    const datos: DatosDueno = {
      hilos, tabla: tabla.compartirTabla(), terreno: terreno.compartir(), buzones: buzones.memoria!, contadores: contadores.memoria!,
      registro: registro.memoria!, libros, lotes: lotes?.compartir() ?? null, desborde: desborde?.compartir() ?? null,
      sustancias: quimica && serializarSustancias(quimica), control: control.buffer as SharedArrayBuffer, enlace: this.#enlace,
      semilla: this.#config.semilla, cabecera, params, epoca: this.#epoca, conMateriaCargada: materia !== null,
    };
    try {
      const piscina = this.#piscina = new Piscina<DatosDueno>({
        hilos, datos, moduleURL: new URL('./dueno-worker.js', import.meta.url), exportName: crearDueno.name,
        crear: (hilo, dd) => hilo === 0 ? tramo => faseDueno(d, tramo, control, dd.conMateriaCargada) : crearDueno(hilo, dd),
      });
      buzones.fijarFase(1);
      piscina.ejecutar(TRAMO.cargar);
      tabla.publicar(m.tick);
      this.#recoger();
      this.#cronica();
    } catch (error) { throw this.#fallo(error); }
  }

  #fallo(error: unknown): ErrorFatalMotor {
    return this.#fatal = error instanceof ErrorFatalMotor ? error : new ErrorFatalMotor(error);
  }

  // ── Tick ───────────────────────────────────────────────────────────────────────────────────────────────

  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] } {
    if (this.#fatal) throw this.#fatal;
    if (!this.#piscina) this.#arrancar(null);
    const m = this.#mundo, d = this.#d, buzones = this.#buzones, control = this.#control, piscina = this.#piscina!;
    const inicio = performance.now();
    try {
      m.tick++;
      control[CTL.tick] = m.tick;
      // F0: serie y corto. Todos los dueños están detenidos en la barrera.
      buzones.fijarFase(0);
      for (const [chunk, destino] of this.#cesiones.splice(0)) if (destino >= 0) this.#terreno.asignar(chunk, destino);
      this.#regiones();
      this.#rebalancear();
      const resultados = this.#gestos(gestos);
      // Un gesto aplicado aquí escribe la crónica directamente: el contador común sigue desde donde quedó.
      this.#contadores.fijarCronica(m.eventCounter + 1);
      m.invitations = m.invitations.filter(invitacion => invitacion.until > m.tick);
      m.reminders = m.reminders.filter(aviso => aviso.until > m.tick);
      if (this.#altas.length) {
        const altas = this.#altas.splice(0);
        d.anotarAjenas(altas);
        for (let h = 1; h < this.#hilos; h++) d.ordenar(h, [ORDEN.directorio], altas);
      }
      this.#pedirDetalles();
      d.F0();
      const f0 = performance.now();
      // B1 · percibir · B2 · actuar · B3 · aplicar · B4
      buzones.fijarFase(1); piscina.ejecutar(TRAMO.percibir);
      buzones.fijarFase(3); piscina.ejecutar(TRAMO.actuar);
      buzones.fijarFase(5); piscina.ejecutar(TRAMO.aplicar);
      this.#tabla.publicar(m.tick);
      // Cierre en serie: lo que los dueños mandaron al coordinador en el tick (la crónica en orden, altas, resultados).
      this.#recoger();
      this.#cronica();
      if (d.cerrarFoto()) this.#t.fotogramasSaltados++;
      resultados.push(...this.#resultados.splice(0));
      resultados.sort((a, b) => a.order - b.order);
      this.#medir(performance.now() - inicio, f0 - inicio);
      return { tick: m.tick, resultados };
    } catch (error) { throw this.#fallo(error); }
  }

  /** Vacía la cola F0 del coordinador (fase 0): peticiones de ley, partes del tick, resultados y lo demás. */
  #recoger(): void {
    this.#buzones.fijarFase(0);
    this.#d.recibirAvisos();
    const propia = this.#d.parteDelTick();
    if (propia) this.#partesTick.push(propia);
  }

  #aviso(clase: number, i: Intento): void {
    switch (clase) {
      case AVISO.resultado: this.#resultados.push(deserialize(i.bytes!) as GestureResult); break;
      case AVISO.tick: this.#partesTick.push(deserialize(i.bytes!) as ParteTick); break;
      case AVISO.parte: this.#partesMundo.push(deserialize(i.bytes!) as World); break;
      case AVISO.detalle: {
        const persona = i.bytes ? deserialize(i.bytes) as Person : null;
        for (const resolver of this.#detalles.get(i.dato![1]!) ?? []) resolver(persona);
        this.#detalles.delete(i.dato![1]!);
        break;
      }
      case AVISO.chunk: this.#archivar(deserialize(i.bytes!) as MigranteChunk); break;
      // Activar: un dueño pide el chunk (cx, cy); entra como los que pide el halo de una persona.
      case -1: if (i.dato && i.dato.length >= 2) this.#activar(i.dato[0]!, i.dato[1]!, 0); break;
      default: break;
    }
  }

  /**
   * Lo que cada dueño mandó al cerrar el tick. La crónica: los sucesos de todos, en el orden de su número, pasan al
   * diario del mundo; sus ids son los que cada dueño ya dio (`CtxDueno.suceso` toma el número de un contador común que
   * solo él usa). Si un paso heredado escribió la crónica por su cuenta en un dueño, los números dejan de casar: se
   * cuenta en `cronicaDesfasada` y el contador se vuelve a alinear, sin tirar el mundo. Lo visible queda en el dueño 0
   * para el fotograma, y las altas del directorio se reparten en el F0 siguiente.
   */
  #cronica(): void {
    const m = this.#mundo, d = this.#d, sucesos: ChronicleEvent[] = [];
    for (const parte of this.#partesTick.splice(0)) {
      sucesos.push(...parte.sucesos);
      d.visiblesTick.push(...parte.visibles);
      this.#altas.push(...parte.altas);
    }
    sucesos.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    for (const { id, tick: _tick, ...suceso } of sucesos) if (addEvent(m, suceso).id !== id) this.cronicaDesfasada++;
    this.#contadores.fijarCronica(m.eventCounter + 1);
  }
  /** Sucesos cuyo id en el diario no es el que su dueño dio (debe ser 0: ver `#cronica`). */
  cronicaDesfasada = 0;

  #gestos(gestos: readonly Gesture[]): GestureResult[] {
    const m = this.#mundo, d = this.#d, frente = d.frente, propios: GestureResult[] = [];
    gestos.forEach((gesto, orden) => {
      let dueno = 0;
      const ref = gesto.agentId === undefined ? -1 : d.ref(d.uidDe(gesto.agentId));
      if (ref >= 0) dueno = frente.dueno[slotDe(ref)]!;
      else if (validCoordinate(gesto.x) && validCoordinate(gesto.y)) {
        const celda = this.#terreno.celda(gesto.x, gesto.y);
        if (celda >= 0) dueno = this.#terreno.duenoChunk[celda >> 8]!;
      }
      if (dueno > 0) d.enviarGesto(dueno, gesto, orden);
      else propios.push(applyGesture(m, gesto, orden));
    });
    return propios;
  }

  // ── Regiones: qué chunks están vivos lo decide el frente ───────────────────────────────────────────────

  /** F0: los chunks que el halo de alguna persona viva pide se activan (su contenido va a su dueño como `Migrante`) y
   * los que ya nadie pide se mandan retirar. La arena de páginas y la de lotes crecen solo aquí. */
  #regiones(): void {
    const frente = this.#d.frente, { vivo, clase, x, y, dueno, alta } = frente;
    const pedidos = new Map<number, number>();
    for (let s = 0; s < alta; s++) {
      if (!vivo[s] || clase[s] !== Clase.Persona) continue;
      for (const dx of HALO) for (const dy of HALO) {
        const hx = x[s]! + dx, hy = y[s]! + dy;
        if (!validCoordinate(hx) || !validCoordinate(hy)) continue;
        const clave = clavePagina(hx >> 4, hy >> 4);
        if (!pedidos.has(clave)) pedidos.set(clave, dueno[s]!);
      }
    }
    for (const [clave, pide] of pedidos) {
      if (this.#paginas.has(clave)) continue;
      const px = Math.floor(clave / 2 ** 21) - 2 ** 20, py = clave % 2 ** 21 - 2 ** 20;
      this.#activar(px, py, Math.max(0, pide));
    }
    for (const [clave, pagina] of this.#paginas) {
      if (pagina.estado !== 'activo' || pedidos.has(clave)) continue;
      pagina.estado = 'retirando';
      this.#d.ordenar(this.#terreno.duenoChunk[pagina.chunk]!, [ORDEN.ceder, pagina.chunk, -1]);
    }
  }

  #activar(px: number, py: number, pide: Hilo): void {
    const clave = clavePagina(px, py), m = this.#mundo, d = this.#d, terreno = this.#terreno;
    if (this.#paginas.has(clave)) return;
    const paginas = [...this.#paginas.values()];
    const dueno = duenoDeVecino(px, py, paginas.map(p => p.px), paginas.map(p => p.py), paginas.map(p => terreno.duenoChunk[p.chunk]!), pide);
    const key = chunkKey(px * 16, py * 16);
    const { tiles, animals, structures, ...meta } = tomarChunk(m, key, px, py);
    d.reservarMateria(1);
    const previa = terreno.paginaDe(px, py);
    const chunk = previa >= 0 ? previa : terreno.asegurarPagina(px, py, dueno);
    if (previa >= 0) terreno.asignar(chunk, dueno);
    for (const lugar of meta.places) if (!m.places.some(p => p.id === lugar.id)) m.places.push(lugar);
    this.#paginas.set(clave, { chunk, px, py, key, estado: 'activo' });
    d.enviarMigrante(dueno, { tipo: 'chunk', chunk, key, meta, tiles, structures: structures ?? [], animals: animals ?? [], personas: [], inicial: false });
  }

  /** Un dueño devolvió un chunk retirado: queda archivado en el mundo del coordinador, pendiente de guardado. */
  #archivar(mig: MigranteChunk): void {
    const m = this.#mundo;
    archivarChunk(m, { ...mig.meta, lifeVersion: 4, lastTick: m.tick, tiles: mig.tiles, animals: mig.animals, structures: mig.structures });
    for (const [clave, pagina] of this.#paginas) if (pagina.chunk === mig.chunk) { this.#paginas.delete(clave); break; }
  }

  // ── Reparto por coste ──────────────────────────────────────────────────────────────────────────────────

  /** F0: media móvil del coste de cada chunk y, con `v23.rebalanceo`, el reparto que decida m7 al cerrar una ventana. */
  #rebalancear(): void {
    const m = this.#mundo, terreno = this.#terreno, control = this.#control, hilos = this.#hilos;
    if (!paramsOf(m).v23.rebalanceo) return;
    if (this.#costeMs.length < terreno.paginas) { const mayor = new Float64Array(2 * terreno.paginas); mayor.set(this.#costeMs); this.#costeMs = mayor; }
    const activas = [...this.#paginas.values()].filter(p => p.estado === 'activo');
    const porDueno = new Int32Array(hilos), hiloMs = new Float64Array(hilos);
    for (const p of activas) porDueno[terreno.duenoChunk[p.chunk]!]!++;
    for (let h = 0; h < hilos; h++) hiloMs[h] = control[celdaDueno(h, CTL_DUENO.msTick)]!;
    for (const p of activas) {
      const h = terreno.duenoChunk[p.chunk]!;
      this.#costeMs[p.chunk] = ema(this.#costeMs[p.chunk]!, hiloMs[h]! / porDueno[h]!, ALFA_COSTE_CHUNK);
    }
    if (m.tick % VENTANA_REPARTO_TICKS !== 0 || !activas.length) return;
    const medida: MedidaReparto = {
      chunks: Int32Array.from(activas, p => p.chunk), px: Int32Array.from(activas, p => p.px), py: Int32Array.from(activas, p => p.py),
      costeMs: Float64Array.from(activas, p => this.#costeMs[p.chunk]!), dueno: Int16Array.from(activas, p => terreno.duenoChunk[p.chunk]!), hiloMs,
    };
    this.#t.desequilibrio = desequilibrio(medida);
    this.#historial.push(this.#t.desequilibrio);
    if (this.#historial.length > VENTANAS_REPARTO) this.#historial.shift();
    if (!tocaRebalancear(m.tick, this.#historial)) return;
    const nuevo = repartir(medida, hilos);
    for (let i = 0; i < activas.length; i++) {
      const chunk = medida.chunks[i]!, de = medida.dueno[i]!, a = nuevo[i]!;
      if (a === de || a < 0 || a >= hilos) continue;
      this.#d.ordenar(de, [ORDEN.ceder, chunk, a]);
      this.#cesiones.push([chunk, a]);
    }
    this.#historial.length = 0;
  }

  // ── Instantánea, carga y el resto del contrato ─────────────────────────────────────────────────────────

  instantanea(): Instantanea {
    if (this.#fatal) throw this.#fatal;
    if (!this.#piscina) return { world: this.#mundo, materia: null };
    try {
      this.#buzones.fijarFase(0);
      this.#piscina.ejecutar(TRAMO.reunir);
      this.#recoger();
      const partes = this.#partesMundo.splice(0);
      if (partes.length !== this.#hilos - 1) throw new Error(`Instantánea incompleta: ${partes.length} de ${this.#hilos - 1} dueños.`);
      const world = reunir(this.#mundo, this.#cabecera, partes, this.#contadores.siguientes());
      recordSample(world);
      return { world, materia: this.#d.instantaneaMateria(this.#d.pendientes()) };
    } catch (error) { throw this.#fallo(error); }
  }

  cargar(i: Instantanea, epoca: number): void {
    this.#mundo = i.world;
    this.#epoca = epoca;
    this.#arrancar(i.materia);
  }

  enlazar(cinta: DescriptorEnlace): void {
    this.#enlace = cinta;
    if (!this.#piscina) return;
    // Las ranuras de la cinta son memoria compartida que los workers reciben al nacer: se reparte de nuevo.
    const { world, materia } = this.instantanea();
    this.#mundo = world;
    this.#arrancar(materia);
  }

  detalle(uid: number): Promise<Person | null> {
    return new Promise(resolver => {
      const espera = this.#detalles.get(uid);
      if (espera) espera.push(resolver); else this.#detalles.set(uid, [resolver]);
    });
  }

  /** F0: cada detalle pedido va a su dueño, que contesta en su F1; el coordinador contesta los suyos al momento. */
  #pedirDetalles(): void {
    if (!this.#detalles.size) return;
    const d = this.#d, frente = d.frente;
    for (const [uid, resolvedores] of this.#detalles) {
      const ref = d.ref(uid), dueno = ref < 0 ? 0 : frente.dueno[slotDe(ref)]!;
      if (dueno > 0) { d.ordenar(dueno, [ORDEN.detalle, uid]); continue; }
      const persona = ref < 0 ? undefined : d.personas.get(slotDe(ref));
      for (const resolver of resolvedores) resolver(persona?.uid === uid ? structuredClone(persona) : null);
      this.#detalles.delete(uid);
    }
  }

  #medir(msTick: number, msF0: number): void {
    const t = this.#t, control = this.#control, hilos = this.#hilos, max = (campo: number): number => {
      let m = 0;
      for (let h = 0; h < hilos; h++) m = Math.max(m, control[celdaDueno(h, campo)]!);
      return m;
    };
    const suma = (campo: number): number => { let s = 0; for (let h = 0; h < hilos; h++) s += control[celdaDueno(h, campo)]!; return s; };
    t.tick = this.#mundo.tick;
    t.hz = ema(t.hz, 1000 / Math.max(msTick, 1e-3), ALFA_TELEMETRIA);
    t.diasPorMinuto = t.hz * 60 / TICKS_PER_DAY;
    t.faseMs.F0 = ema(t.faseMs.F0, msF0, ALFA_TELEMETRIA);
    t.faseMs.eco = ema(t.faseMs.eco, max(CTL_DUENO.msEco), ALFA_TELEMETRIA);
    t.faseMs.percibir = ema(t.faseMs.percibir, max(CTL_DUENO.msF1) + max(CTL_DUENO.msPercibir), ALFA_TELEMETRIA);
    t.faseMs.actuar = ema(t.faseMs.actuar, max(CTL_DUENO.msActuar), ALFA_TELEMETRIA);
    t.faseMs.aplicar = ema(t.faseMs.aplicar, max(CTL_DUENO.msAplicar), ALFA_TELEMETRIA);
    const paralelo = Math.max(msTick - msF0, 1e-3);
    let mayor = 0;
    for (let h = 0; h < hilos; h++) {
      const ms = control[celdaDueno(h, CTL_DUENO.msTick)]!;
      t.ocupacion[h] = Math.min(1, ms / paralelo);
      mayor = Math.max(mayor, ms);
    }
    t.esperaBarreraMs = ema(t.esperaBarreraMs, Math.max(0, paralelo - mayor), ALFA_TELEMETRIA);
    t.intentos = suma(CTL_DUENO.intentos); t.rechazados = suma(CTL_DUENO.rechazados); t.migraciones = suma(CTL_DUENO.migraciones);
  }

  telemetria(): TelemetriaMotor { return { ...this.#t, faseMs: { ...this.#t.faseMs }, ocupacion: this.#t.ocupacion.slice() }; }

  async cerrar(): Promise<void> {
    const piscina = this.#piscina;
    this.#piscina = null;
    for (const resolvedores of this.#detalles.values()) for (const resolver of resolvedores) resolver(null);
    this.#detalles.clear();
    await piscina?.cerrar();
  }
}
