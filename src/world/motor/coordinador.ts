/**
 * INTERFAZ PUENTE del motor de dueños (carril m4a; ARQ-motor §3 y contrato `Motor`). El esqueleto lo fijó la
 * preparación de la oleada: m4a rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consumen srv, lab y los bancos).
 *
 * Con un hilo, `MotorUnico` es una fachada de `stepWorld`: el hilo que llama es el único dueño. Con más,
 * `MotorDuenos` es el coordinador (y dueño 0): reparte el mundo en tramos Morton, lanza un worker por dueño sobre una
 * `Piscina` conduce los tramos percibir, actuar, aplicar y publicar. F0 y el cierre son en serie.
 * Toda la memoria compartida se crea al abrir la época (un SAB no viaja por un buzón): cargar, o enlazar una cinta con
 * los workers ya en marcha, cierra la piscina y abre otra.
 */
import { availableParallelism } from 'node:os';
import { deserialize, serialize } from 'node:v8';
import type { DescriptorEnlace } from '../../shared/fotograma.js';
import type { FuenteFotograma } from './fotograma.js';
import type { RepartoVisible } from '../../shared/vistas-v23.js';
import type { ChronicleEvent, FaseNombre, Gesture, GestureResult } from '../../shared/types.js';
import { applyGesture } from '../actuar/gestos.js';
import { syncFauna } from '../animals.js';
import { olvidarPercepcion } from '../decision/percepcion.js';
import { TerrenoPercepcion } from '../decision/terreno-percepcion.js';
import { BrokerPercepcionGpu, type PercibidorBroker } from '../gpu/broker-percepcion.js';
import { cerrarMateriaGpu } from '../materia/ley-mundo.js';
import { cargarSustancias, crearServicioQuimico } from '../materia/servicio.js';
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
  type Migrante, type MigranteChunk, type ParteTick,
} from './contexto.js';
import { Clase, TipoIntento, slotDe, type CargaChunk, type ChunkId, type FrentePublico, type Hilo, type Instantanea, type Intento, type Motor, type MotorConfig, type MuestraCargaMotor, type TelemetriaMotor } from './contratos.js';
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

function cargaChunk(chunk: ChunkId, px: number, py: number, dueno: Hilo): CargaChunk {
  return { chunk, px, py, dueno, personas: 0, fauna: 0, personasVencen: 0, faunaVence: 0 };
}

function cargaDelFrente(frente: FrentePublico, epoca: number, chunks: CargaChunk[], fasesPorDuenoMs: MuestraCargaMotor['fasesPorDuenoMs']): MuestraCargaMotor {
  const { tick, alta, vivo, chunk, clase, decideEn, dueno } = frente;
  const porChunk = new Map(chunks.map(carga => [carga.chunk, carga]));
  let ranurasVivas = 0, fueraDeChunkActivo = 0, conOtroDueno = 0, claseDesconocida = 0;
  for (let slot = 0; slot < alta; slot++) {
    if (vivo[slot] !== 1) continue;
    ranurasVivas++;
    const carga = porChunk.get(chunk[slot]!);
    if (!carga) { fueraDeChunkActivo++; continue; }
    if (dueno[slot] !== carga.dueno) conOtroDueno++;
    const vence = decideEn[slot]! <= tick + 1 ? 1 : 0;
    switch (clase[slot]) {
      case Clase.Persona: carga.personas++; carga.personasVencen += vence; break;
      case Clase.Animal: carga.fauna++; carga.faunaVence += vence; break;
      default: claseDesconocida++;
    }
  }
  return { fuente: 'frenteConfirmado', tick, epoca, chunks, ranurasVivas, fueraDeChunkActivo, conOtroDueno, claseDesconocida, fasesPorDuenoMs };
}

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
  #fuente?: FuenteFotograma;
  #epoca = 0;
  readonly #t = telemetriaVacia(1);
  readonly #medicion: FaseMedicion = { clock: () => performance.now(), fases: {} };

  constructor(mundo: World) { this.#mundo = mundo; }

  vista(): World { return this.#mundo; }

  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] } {
    const inicio = performance.now(), fases = this.#medicion.fases = {} as Partial<Record<FaseNombre, number>>;
    // El paso por intentos separa preparación, acciones y aplicación como el motor repartido.
    // En modos mixtos o históricos el paquete «personas» conserva su medición de siempre.
    this.#medicion.v23 = paramsOf(this.#mundo).v23.intentos ? {} : undefined;
    const resultados = stepWorld(this.#mundo, [...gestos], undefined, this.#medicion);
    const v23 = this.#medicion.v23;
    const ms = performance.now() - inicio, t = this.#t, d = duenoSi(this.#mundo), de = (n: FaseNombre): number => fases[n] ?? 0;
    t.tick = this.#mundo.tick;
    t.hz = ema(t.hz, 1000 / Math.max(ms, 1e-3), ALFA_TELEMETRIA);
    t.diasPorMinuto = t.hz * 60 / TICKS_PER_DAY;
    t.faseMs.F0 = ema(t.faseMs.F0, v23?.F0 ?? de('maintainRegions'), ALFA_TELEMETRIA);
    t.faseMs.eco = ema(t.faseMs.eco, v23?.eco ?? (de('ecologia') + de('kernel') + de('fauna')), ALFA_TELEMETRIA);
    t.faseMs.percibir = v23 ? ema(t.faseMs.percibir, (v23.F1 ?? 0) + (v23.F2 ?? 0), ALFA_TELEMETRIA) : 0;
    t.faseMs.actuar = ema(t.faseMs.actuar, v23?.['F3-F4'] ?? de('personas'), ALFA_TELEMETRIA);
    t.faseMs.aplicar = ema(t.faseMs.aplicar, v23 ? (v23.F5 ?? 0) + (v23.F6 ?? 0)
      : de('encuentros') + de('demografia') + de('comunidades') + de('reproduccion'), ALFA_TELEMETRIA);
    t.ocupacion[0] = 1;
    if (d) { t.intentos = d.cuentas[0]!; t.rechazados = d.cuentas[1]!; t.migraciones = d.cuentas[2]!; t.fotogramasSaltados = d.fotogramasPerdidos; }
    return { tick: this.#mundo.tick, resultados };
  }

  instantanea(): Instantanea {
    const d = duenoSi(this.#mundo);
    return { world: this.#mundo, materia: d ? d.instantaneaMateria(d.pendientes()) : null };
  }

  cargar(i: Instantanea, epoca: number): void {
    cerrarMateriaGpu(this.#mundo);
    this.#mundo = i.world;
    this.#epoca = epoca;
    const activo = leyesActivas(paramsOf(i.world).v23).length > 0 || this.#enlace !== null;
    if (!activo && !i.materia) return;
    const d = duenoDe(i.world, i.materia?.sustancias);
    d.epoca = epoca;
    d.enlazar(this.#enlace, this.#fuente);
    d.abrirEpoca(i.materia);
  }

  enlazar(cinta: DescriptorEnlace, fuente?: FuenteFotograma): void {
    this.#enlace = cinta;
    this.#fuente = fuente;
    const d = duenoDe(this.#mundo);
    d.epoca = this.#epoca;
    d.enlazar(cinta, fuente);
  }

  detalle(uid: number): Promise<Person | null> {
    const persona = this.#mundo.people.find(p => p.uid === uid);
    return Promise.resolve(persona ? structuredClone(persona) : null);
  }

  telemetria(): TelemetriaMotor { return { ...this.#t, faseMs: { ...this.#t.faseMs }, ocupacion: this.#t.ocupacion.slice() }; }

  reparto(): RepartoVisible | undefined {
    const d = duenoSi(this.#mundo);
    if (!d) return;
    const t = d.terreno;
    return { paginas: Array.from(d.chunks, c => [t.paginaX[c]!, t.paginaY[c]!, 0]),
      msPorHilo: this.#t.hz > 0 ? [1000 / this.#t.hz] : [] };
  }

  muestraCarga(): MuestraCargaMotor | undefined {
    const d = duenoSi(this.#mundo);
    if (!d || d.frente.tick !== this.#mundo.tick) return undefined;
    const t = d.terreno;
    return cargaDelFrente(d.frente, this.#epoca, Array.from(d.chunks, c => cargaChunk(c, t.paginaX[c]!, t.paginaY[c]!, 0)), null);
  }

  cerrar(): Promise<void> {
    cerrarMateriaGpu(this.#mundo);
    return Promise.resolve();
  }
}

// ── Varios dueños ────────────────────────────────────────────────────────────────────────────────────────

interface Pagina { chunk: ChunkId; px: number; py: number; key: string; estado: 'activo' | 'retirando' }

class MotorDuenos implements Motor {
  #mundo: World;
  readonly #config: MotorConfig;
  readonly #hilos: number;
  #epoca = 0;
  #enlace: DescriptorEnlace | null = null;
  #fuente?: FuenteFotograma;
  #fuenteReunida(): FuenteFotograma | undefined {
    const fuente = this.#fuente;
    if (fuente) return {
      corte: (c, f, paginas) => fuente.corte(c, f, paginas, this.#reunirMundo().world),
      confirmar: f => fuente.confirmar(f),
    };
  }
  #piscina: Piscina<DatosDueno> | null = null;
  readonly #brokerConfigurado: boolean;
  #materiaGpuDeArranque?: boolean;
  #brokerGpu?: BrokerPercepcionGpu;
  #clienteGpu?: PercibidorBroker;
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
  #activacionesPendientes = 0;
  #costeMs = new Float64Array(0);
  readonly #historial: number[] = [];
  // Lo que llega por la cola F0 del coordinador.
  #resultados: GestureResult[] = [];
  #partesTick: ParteTick[] = [];
  readonly #partesMundo = new Map<Hilo, World>();
  #altas: [number, string][] = [];
  readonly #detalles = new Map<number, ((p: Person | null) => void)[]>();
  readonly #t: TelemetriaMotor;

  constructor(mundo: World, config: MotorConfig, hilos: number) {
    this.#mundo = mundo; this.#config = config; this.#hilos = hilos;
    this.#brokerConfigurado = process.env.CARTA_PERCEPCION_DUENOS === '1' && !!process.env.COMPUTE_NVRTC
      && hilos === 2 && config.gpu.length === 1 && config.gpu[0] === 0;
    this.#t = telemetriaVacia(hilos);
  }

  // ── Época: memoria compartida, reparto y workers ───────────────────────────────────────────────────────

  #validarModoGpu(materiaGpu: boolean): void {
    // Cargar es síncrono y los contextos CUDA anteriores se cierran de forma asíncrona.
    if (this.#materiaGpuDeArranque !== undefined && materiaGpu !== this.#materiaGpuDeArranque) {
      throw new Error('Cambiar entre percepción CUDA compartida y química CUDA requiere cerrar y crear un motor nuevo.');
    }
  }

  #arrancar(materia: MateriaCheckpoint | null): void {
    const m = this.#mundo, hilos = this.#hilos, params = paramsOf(m), verificar = this.#config.verificar || params.motor.depuracion;
    const materiaGpu = params.v23.materiaGpu;
    this.#validarModoGpu(materiaGpu);
    if (this.#brokerConfigurado) this.#materiaGpuDeArranque ??= materiaGpu;
    void this.#cerrarPiscina().catch(() => {});
    this.#fatal = undefined;
    olvidarPercepcion(m); olvidarOrganismos(m);
    this.#paginas.clear(); this.#cesiones = []; this.#historial.length = 0;
    this.#activacionesPendientes = 0;
    this.#resultados = []; this.#partesTick = []; this.#partesMundo.clear(); this.#altas = [];

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
    const usarBroker = this.#brokerConfigurado && !materiaGpu;
    if (usarBroker && !this.#brokerGpu) {
      try { this.#brokerGpu = new BrokerPercepcionGpu(undefined, this.#config.medirBrokerGpu); }
      catch { /* Crear un corredor es opcional: los dueños ya tienen la ruta CPU. */ }
    }
    const brokerGpu = usarBroker ? this.#brokerGpu?.abrirEpoca(this.#epoca) : undefined;
    this.#clienteGpu = ligarCompartido(m, tabla, terreno, contadores, brokerGpu);
    for (const ley of leyesActivas(params.v23)) for (const [nombre, tipo, ancho] of ley.columnas ?? []) tabla.columna(nombre, tipo, ancho);
    const buzones = this.#buzones = new Buzones(hilos), libros = crearLibros(hilos), registro = new RegistroContenido(hilos);
    const control = this.#control = new Float64Array(new SharedArrayBuffer((CTL.porDueno + hilos * CTL_DUENO.celdas) * Float64Array.BYTES_PER_ELEMENT));
    control[CTL.tick] = m.tick; control[CTL.epoca] = this.#epoca; control[CTL.fotoRanura] = -1;
    const azar = azarDeHilo(this.#config.semilla, 0);
    const conMateria = params.v23.materia;
    const registroSustancias = conMateria ? new RegistroContenido(hilos) : null;
    const opcionesQuimica = { modo: 'inmediato', registroSustancias: registroSustancias ?? undefined } as const;
    const quimica = !conMateria ? null : materia ? cargarSustancias(materia.sustancias, opcionesQuimica) : crearServicioQuimico(opcionesQuimica);
    const lotes = conMateria ? new PageArena(RESERVA_LOTES) : null, desborde = conMateria ? new PageArena(RESERVA_DESBORDE) : null;
    const d = this.#d = new Dueno(m, {
      hilo: 0, hilos, buzones, buzon: buzones.dueno(0, azar), libros, contadores, registro, azar, control, enlace: this.#enlace,
      materia: quimica && lotes && desborde ? { lotes, desborde, quimica } : null,
    });
    if (this.#fuente) d.enlazar(this.#enlace, this.#fuenteReunida());
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
    // Cada dueño materializa en su `Ley.iniciar` los chunks que no traen lotes: la arena compartida solo crece aquí.
    d.reservarMateria(materia ? 0 : claves.length);
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
      sustancias: registroSustancias?.memoria ?? null, control: control.buffer as SharedArrayBuffer, enlace: this.#enlace,
      semilla: this.#config.semilla, cabecera, params, epoca: this.#epoca, brokerGpu, conMateriaCargada: materia !== null,
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
      for (const [chunk, destino] of this.#cesiones.splice(0)) {
        this.#terreno.asignar(chunk, destino);
        this.#terreno.duenoSiguiente[chunk] = -1;
      }
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
      if (this.#activacionesPendientes) d.reservarMateria(this.#activacionesPendientes);
      control[CTL.lluvia] = Number(m.weather === 'rain');
      const f0 = performance.now();
      buzones.fijarFase(1); piscina.ejecutar(TRAMO.percibir);
      this.#activacionesPendientes = 0;
      buzones.fijarFase(3); piscina.ejecutar(TRAMO.actuar);
      buzones.fijarFase(5); piscina.ejecutar(TRAMO.aplicar);
      buzones.fijarFase(6); piscina.ejecutar(TRAMO.publicar);
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
      case AVISO.parte: this.#partesMundo.set(i.dato![1]!, deserialize(i.bytes!) as World); break;
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
    const previa = terreno.paginaDe(px, py);
    const chunk = previa >= 0 ? previa : terreno.asegurarPagina(px, py, dueno);
    if (previa >= 0) terreno.asignar(chunk, dueno);
    for (const lugar of meta.places) if (!m.places.some(p => p.id === lugar.id)) m.places.push(lugar);
    this.#paginas.set(clave, { chunk, px, py, key, estado: 'activo' });
    d.enviarMigrante(dueno, { tipo: 'chunk', chunk, key, meta, tiles, structures: structures ?? [], animals: animals ?? [], personas: [], inicial: false });
    this.#activacionesPendientes++;
  }

  /** Un dueño devolvió un chunk retirado: queda archivado en el mundo del coordinador, pendiente de guardado. */
  #archivar(mig: MigranteChunk): void {
    const m = this.#mundo;
    if (paramsOf(m).v23.fauna) syncFauna(mig.tiles, mig.animals);
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
      terreno.duenoSiguiente[chunk] = a;
      this.#cesiones.push([chunk, a]);
    }
    this.#historial.length = 0;
  }

  // ── Instantánea, carga y el resto del contrato ─────────────────────────────────────────────────────────

  vista(): World {
    if (this.#fatal) throw this.#fatal;
    if (!this.#piscina) return this.#mundo;
    try {
      const { world } = this.#reunirMundo();
      recordSample(world);
      return world;
    } catch (error) { throw this.#fallo(error); }
  }

  instantanea(): Instantanea {
    if (this.#fatal) throw this.#fatal;
    if (!this.#piscina) return { world: this.#mundo, materia: null };
    try {
      const { world, pendientes } = this.#reunirMundo();
      recordSample(world);
      return { world, materia: this.#d.instantaneaMateria(pendientes) };
    } catch (error) { throw this.#fallo(error); }
  }

  #reunirMundo(): { world: World; pendientes: Intento[] } {
    this.#buzones.fijarFase(0);
    this.#piscina!.ejecutar(TRAMO.reunir);
    this.#recoger();
    const partes = Array.from({ length: this.#hilos - 1 }, (_, i) => {
      const parte = this.#partesMundo.get(i + 1);
      if (!parte) throw new Error(`Instantánea incompleta: falta el dueño ${i + 1}.`);
      return parte;
    });
    this.#partesMundo.clear();
    const world = reunir(this.#mundo, this.#cabecera, partes, this.#contadores.siguientes());
    const pendientes = this.#d.pendientes();
    for (const i of pendientes) if (i.tipo === TipoIntento.Migrante) {
      // El frente ya publicó la cesión, pero el siguiente dueño aún no abrió su buzón de migrantes.
      const mig = deserialize(i.bytes!) as Migrante;
      if (mig.tipo === 'chunk') {
        world.chunks[mig.key] = mig.meta;
        world.tiles.push(...mig.tiles);
        world.structures.push(...mig.structures);
        world.animals.push(...mig.animals);
        for (const p of mig.personas) world.people.push(p.persona);
      } else {
        if (mig.persona) world.people.push(mig.persona.persona);
        if (mig.animal) world.animals.push(mig.animal.animal);
      }
    }
    if (paramsOf(world).v23.fauna) syncFauna(world.tiles, world.animals);
    return { world, pendientes };
  }

  cargar(i: Instantanea, epoca: number): void {
    this.#validarModoGpu(paramsOf(i.world).v23.materiaGpu);
    this.#mundo = i.world;
    this.#epoca = epoca;
    this.#arrancar(i.materia);
  }

  enlazar(cinta: DescriptorEnlace, fuente?: FuenteFotograma): void {
    const nuevo = this.#enlace !== cinta;
    this.#enlace = cinta;
    this.#fuente = fuente;
    if (!this.#piscina) return;
    if (!nuevo) {
      this.#d.enlazar(cinta, this.#fuenteReunida());
      return;
    }
    // Las ranuras de la cinta son memoria compartida que los workers reciben al nacer: se reparte de nuevo.
    const { world, materia } = this.instantanea();
    this.#mundo = world;
    this.#arrancar(materia);
  }

  reparto(): RepartoVisible | undefined {
    if (!this.#piscina) return;
    return {
      paginas: [...this.#paginas.values()].filter(p => p.estado === 'activo')
        .map(({ px, py, chunk }) => [px, py, this.#terreno.duenoChunk[chunk]!]),
      msPorHilo: Array.from({ length: this.#hilos }, (_, h) => this.#control[celdaDueno(h, CTL_DUENO.msTick)]!),
    };
  }

  muestraCarga(): MuestraCargaMotor | undefined {
    if (!this.#piscina || this.#fatal) return undefined;
    const frente = this.#d.frente;
    if (frente.tick !== this.#mundo.tick) return undefined;
    const chunks: CargaChunk[] = [];
    for (const p of this.#paginas.values()) if (p.estado === 'activo') chunks.push(cargaChunk(p.chunk, p.px, p.py, this.#terreno.duenoChunk[p.chunk]!));
    const control = this.#control;
    const fasesPorDuenoMs = frente.tick === this.#t.tick && control[celdaDueno(0, CTL_DUENO.msTick)]! > 0
      ? Array.from({ length: this.#hilos }, (_, h) => ({
        F1: control[celdaDueno(h, CTL_DUENO.msF1)]!, eco: control[celdaDueno(h, CTL_DUENO.msEco)]!,
        F2: control[celdaDueno(h, CTL_DUENO.msPercibir)]!, F3F4: control[celdaDueno(h, CTL_DUENO.msActuar)]!,
        F5F6: control[celdaDueno(h, CTL_DUENO.msAplicar)]!, total: control[celdaDueno(h, CTL_DUENO.msTick)]!,
      })) : null;
    return cargaDelFrente(frente, this.#epoca, chunks, fasesPorDuenoMs);
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

  prepararBrokerGpu(): Promise<boolean> {
    if (!this.#brokerConfigurado) return Promise.resolve(false);
    if (!this.#piscina) this.#arrancar(null);
    return this.#brokerGpu?.listo ?? Promise.resolve(false);
  }

  telemetria(): TelemetriaMotor {
    const gpu = this.#brokerGpu?.medidas();
    return { ...this.#t, faseMs: { ...this.#t.faseMs }, ocupacion: this.#t.ocupacion.slice(), ...(gpu && {
      gpuEstado: [gpu.lista && gpu.completadas.some(n => n > 0) ? 'ok' : 'cpu'],
      gpuMs: [gpu.ms], gpuBytes: [gpu.bytes],
      ...(gpu.detalle && { gpuBroker: gpu.detalle }),
    }) };
  }

  async cerrar(): Promise<void> {
    for (const resolvedores of this.#detalles.values()) for (const resolver of resolvedores) resolver(null);
    this.#detalles.clear();
    try { await this.#cerrarPiscina(); }
    finally { await this.#brokerGpu?.cerrar(); }
  }

  async #cerrarPiscina(): Promise<void> {
    this.#clienteGpu?.cerrar();
    this.#clienteGpu = undefined;
    const piscina = this.#piscina;
    if (!piscina) return;
    this.#piscina = null;
    try {
      if (this.#fatal || !paramsOf(this.#d.mundo).v23.materiaGpu) cerrarMateriaGpu(this.#d.mundo);
      else piscina.ejecutar(TRAMO.cerrar);
    } finally { await piscina.cerrar(); }
  }
}
