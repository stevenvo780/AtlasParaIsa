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
import { isDeepStrictEqual } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import type { DescriptorEnlace } from '../../shared/fotograma.js';
import type { FuenteFotograma } from './fotograma.js';
import type { RepartoVisible } from '../../shared/vistas-v23.js';
import type { ChronicleEvent, FaseNombre, Gesture, GestureResult } from '../../shared/types.js';
import type { LegacyRecord } from '../../shared/demography.js';
import { applyGesture } from '../actuar/gestos.js';
import { syncFauna } from '../animals.js';
import { olvidarPercepcion } from '../decision/percepcion.js';
import { TerrenoPercepcion } from '../decision/terreno-percepcion.js';
import { BrokerPercepcionGpu, resolverDuenosPercepcionGpu,
  type DuenosBroker, type EpocaBrokerPercepcion, type PercibidorBroker } from '../gpu/broker-percepcion.js';
import { pruneBonds } from '../lineage.js';
import { cerrarMateriaGpu } from '../materia/ley-mundo.js';
import { cargarSustancias, crearServicioQuimico } from '../materia/servicio.js';
import type { MateriaCheckpoint } from '../materia/tipos.js';
import { appendWorldEvent } from '../mundo/crear.js';
import { stepWorld, type FaseMedicion } from '../mundo/paso.js';
import { TICKS_PER_DAY, type Person, type World } from '../mundo/tipos.js';
import { paramsOf } from '../params.js';
import { ErrorFatalMotor } from '../paralelo/barrera.js';
import { Piscina, type DiagnosticoPiscina } from '../paralelo/piscina.js';
import { olvidarOrganismos } from '../soa/organismos-mundo.js';
import { RESERVA_FILAS_DUENOS, TablaOrganismosSoA } from '../soa/organismos.js';
import { residentFastAccess } from '../soa/terreno.js';
import { archivarChunk, bindWorldContext, tomarChunk, validCoordinate, worldContext } from '../spatial.js';
import { recordSample, ESTADISTICAS_CARAS_CADA_TICKS } from '../statistics.js';
import { chunkKey } from '../terrain.js';
import { tileLookup } from '../tile-index.js';
import { duenoDeVecino, pesosInicialesPorPoblacion, repartirPorTramos } from './bloques.js';
import { Buzones } from './buzon.js';
import { Contadores, crearLibros } from './contadores.js';
import {
  AVISO, CTL, CTL_DUENO, Dueno, ORDEN, celdaDueno, destinatariosDeGarantias, duenoDe, duenoSi,
  type Migrante, type MigranteChunk, type ParteTick,
} from './contexto.js';
import { Clase, TipoIntento, slotDe, type CargaChunk, type ChunkId, type FrentePublico, type Hilo, type Instantanea, type Intento, type Motor, type MotorConfig, type MuestraCargaMotor, type PerfilPasoMotor, type PerfilTramoMotor, type TelemetriaMotor } from './contratos.js';
import { TRAMO, azarDeHilo, crearDueno, faseDueno, ligarCompartido, type DatosDueno } from './dueno-worker.js';
import {
  LIMITE_BYTES_FOTO_TOTAL_DEFECTO, trazaFotogramaDuenosVacia,
  type LoteFotoDuenos, type ParteFotoDueno, type TrazaFotogramaDuenos,
} from './fotograma-dueno.js';
import { leyesActivas } from './leyes.js';
import { CanalesCorte } from './mensajes-corte.js';
import { desequilibrio, repartir, tocaRebalancear, type MedidaReparto } from './rebalanceo.js';
import { RegistroContenido } from './registro.js';
import { cabeceraDe, fundir, reunir } from './reunir.js';
import { crearArenasMateria, validarReservaLotesMateria } from './reserva-materia.js';

function sinCheckpointTecnologia(tech: World['technology'] | undefined): unknown {
  if (!tech) return tech;
  const { checkpoint: _checkpoint, ...resto } = tech;
  return resto;
}

/** Comprueba por igualdad estructural profunda (jamás por contadores ni longitudes) que las partes remotas
 * no divergieron de su tecnología inicial y que `fundir` reproducirá exactamente la tecnología confirmada. */
export function tecnologiaEquivalenteParaConfirmar(
  cabecera: World['technology'] | undefined,
  tecnologiaInicialRemota: unknown,
  partesRemotas: readonly (World['technology'] | undefined)[],
  confirmada: World['technology'] | undefined,
): boolean {
  for (const parte of partesRemotas) {
    if (!isDeepStrictEqual(sinCheckpointTecnologia(parte), tecnologiaInicialRemota)) return false;
  }
  const candidata = sinCheckpointTecnologia(confirmada);
  const fusionada = sinCheckpointTecnologia(fundir(sinCheckpointTecnologia(cabecera), [
    candidata,
    ...Array.from({ length: partesRemotas.length }, () => tecnologiaInicialRemota),
  ]) as World['technology'] | undefined);
  return isDeepStrictEqual(fusionada, candidata);
}

let falloConfirmarGuardadoPrueba: number | null = null;
/** Solo pruebas: inyecta un fallo de una sola vez al confirmar guardado (`h > 0`: worker `h` tras vaciar `retiredLegacy`;
 * `0`: coordinador tras completar la barrera de workers). */
export function inyectarFalloConfirmarGuardadoParaPrueba(hilo: number | null): void {
  falloConfirmarGuardadoPrueba = hilo;
}

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

function medirTramo(piscina: Piscina<DatosDueno>, tramo: PerfilTramoMotor['tramo']): PerfilTramoMotor {
  const { tiempoTotalMs, esperaBarreraMs } = piscina.diagnostico();
  return { tramo, paredMs: tiempoTotalMs, esperaCoordinadorMs: esperaBarreraMs };
}

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
  if (config.reservaLotesMateria !== undefined) validarReservaLotesMateria(config.reservaLotesMateria);
  if (config.repartoInicial !== undefined && config.repartoInicial !== 'poblacion') throw new RangeError('Reparto inicial inválido.');
  const duenosGpu = resolverDuenosPercepcionGpu(hilos, config.gpu, config.duenosPercepcionGpu, config.gruposPercepcionGpu);
  if ((config.duenosPercepcionGpu !== undefined || config.gruposPercepcionGpu !== undefined) && !duenosGpu) {
    throw new RangeError('Asignación de dueños CUDA inválida.');
  }
  if (hilos === 1) return new MotorUnico(mundo, config);
  if (!paramsOf(mundo).v23.duenos) throw new Error('Un motor de varios dueños exige v23.duenos (y con él todas las leyes de la V23).');
  return new MotorDuenos(mundo, config, hilos, duenosGpu);
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
  readonly #medirPaso: boolean;
  readonly #reservaLotesMateria: number | undefined;
  #perfilPaso: PerfilPasoMotor | undefined;

  constructor(mundo: World, config: MotorConfig) {
    this.#mundo = mundo;
    this.#medirPaso = config.medirPaso === true;
    this.#reservaLotesMateria = config.reservaLotesMateria;
  }

  vista(): World { return this.#mundo; }

  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] } {
    const inicio = performance.now(), fases = this.#medicion.fases = {} as Partial<Record<FaseNombre, number>>;
    // El paso por intentos separa preparación, acciones y aplicación como el motor repartido.
    // En modos mixtos o históricos el paquete «personas» conserva su medición de siempre.
    const interruptores = paramsOf(this.#mundo).v23;
    if (interruptores.materia && this.#reservaLotesMateria !== undefined)
      duenoDe(this.#mundo, undefined, this.#reservaLotesMateria);
    this.#medicion.v23 = interruptores.intentos ? {} : undefined;
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
    if (this.#medirPaso && v23?.F0 !== undefined) this.#perfilPaso = {
      tick: t.tick, epoca: this.#epoca, paredMs: ms, F0Ms: v23.F0, cierreMs: null, tramos: [],
      fasesPorDuenoMs: [{ F1: v23.F1!, eco: v23.eco!, F2: v23.F2!, F3F4: v23['F3-F4']!, F3: null, F4: null,
        F5: v23.F5!, F6: v23.F6! }],
    };
    return { tick: this.#mundo.tick, resultados };
  }

  instantanea(): Instantanea {
    const d = duenoSi(this.#mundo);
    return { world: this.#mundo, materia: d ? d.instantaneaMateria(d.pendientes()) : null };
  }

  confirmarGuardado(guardado: Instantanea): boolean {
    return guardado.world === this.#mundo;
  }

  cargar(i: Instantanea, epoca: number): void {
    cerrarMateriaGpu(this.#mundo);
    if (i.world !== this.#mundo) duenoSi(this.#mundo)?.cerrarMateriaFria();
    this.#mundo = i.world;
    this.#epoca = epoca;
    this.#perfilPaso = undefined;
    const activo = leyesActivas(paramsOf(i.world).v23).length > 0 || this.#enlace !== null;
    if (!activo && !i.materia) return;
    const d = duenoDe(i.world, i.materia?.sustancias, this.#reservaLotesMateria);
    d.epoca = epoca;
    d.enlazar(this.#enlace, this.#fuente);
    try { d.abrirEpoca(i.materia); }
    catch (error) { d.cerrarMateriaFria(); throw error; }
  }

  enlazar(cinta: DescriptorEnlace, fuente?: FuenteFotograma): void {
    this.#enlace = cinta;
    this.#fuente = fuente;
    const d = duenoDe(this.#mundo, undefined, this.#reservaLotesMateria);
    d.epoca = this.#epoca;
    d.enlazar(cinta, fuente);
  }

  detalle(uid: number): Promise<Person | null> {
    const persona = this.#mundo.people.find(p => p.uid === uid);
    return Promise.resolve(persona ? structuredClone(persona) : null);
  }

  telemetria(): TelemetriaMotor { return { ...this.#t, faseMs: { ...this.#t.faseMs }, ocupacion: this.#t.ocupacion.slice() }; }

  muestraPerfilPaso(): PerfilPasoMotor | undefined {
    if (this.#perfilPaso?.tick === this.#mundo.tick) return this.#perfilPaso;
  }

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
    this.#perfilPaso = undefined;
    cerrarMateriaGpu(this.#mundo);
    duenoSi(this.#mundo)?.cerrarMateriaFria();
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
  readonly #partesFoto = new Map<Hilo, ParteFotoDueno>();
  #ultimaCarasFoto = -1;
  readonly #trazaFotoDuenos: TrazaFotogramaDuenos = trazaFotogramaDuenosVacia();
  #fuenteReunida(): FuenteFotograma | undefined {
    const fuente = this.#fuente;
    if (!fuente) return undefined;
    let caminoEnCurso: 'ninguno' | 'duenos' | 'reunido' = 'ninguno';
    let bytesEnCurso = 0;
    let conCarasEnCurso = false;
    return {
      corte: (c, f, paginas) => {
        caminoEnCurso = 'ninguno';
        bytesEnCurso = 0;
        conCarasEnCurso = false;
        if (this.#config.emisionFotogramaDuenos && fuente.cortePorDuenos) {
          const limiteTotal = Math.max(1, this.#config.limiteBytesFotoTotal ?? LIMITE_BYTES_FOTO_TOTAL_DEFECTO);
          const partes: ParteFotoDueno[] = [];
          let faltante = false, desbordado = false, compatFallback = false, totalBytes = 0;
          for (let h = 0; h < this.#hilos; h++) {
            const parte = this.#partesFoto.get(h);
            if (!parte) { faltante = true; break; }
            if (parte.desbordado) desbordado = true;
            if (parte.compatFallback) compatFallback = true;
            totalBytes += parte.bytes;
            partes.push(parte);
          }
          if (desbordado || totalBytes > limiteTotal) {
            this.#trazaFotoDuenos.fallbacksLimite++;
          } else if (faltante || compatFallback) {
            this.#trazaFotoDuenos.fallbacksCompat++;
          } else {
            const clavesActivas = new Set<string>();
            const chunksActivos: ChunkId[] = [];
            for (const pagina of this.#paginas.values()) {
              clavesActivas.add(pagina.key);
              chunksActivos.push(pagina.chunk);
            }
            const bajasConfirmadas = this.#bajasConfirmadas?.tick === this.#mundo.tick ? this.#bajasConfirmadas.bajas : [];
            const conCaras = this.#control[CTL.fotoCaras] === 1;
            const altasTick = new Map(this.#altas);
            const lote: LoteFotoDuenos & { readonly altasTick?: ReadonlyMap<number, string> } = {
              hilos: this.#hilos, cabecera: this.#cabecera, partes,
              clavesActivas, chunksActivos, conCaras, limiteBytesTotal: limiteTotal, bajasConfirmadas, altasTick,
            };
            const salida = fuente.cortePorDuenos(c, f, paginas, lote);
            if (salida !== null) {
              caminoEnCurso = 'duenos';
              bytesEnCurso = totalBytes;
              conCarasEnCurso = conCaras;
              return salida;
            }
            this.#trazaFotoDuenos.fallbacksCompat++;
          }
        }
        caminoEnCurso = 'reunido';
        return fuente.corte(c, f, paginas, this.#reunirMundo().world);
      },
      confirmar: f => {
        fuente.confirmar(f);
        if (this.#config.emisionFotogramaDuenos) {
          if (caminoEnCurso === 'duenos') {
            this.#control[CTL.fotoDuenosEntregado]!++;
            if (conCarasEnCurso) this.#ultimaCarasFoto = f.tick;
            this.#trazaFotoDuenos.emitidos++;
            this.#trazaFotoDuenos.reunionesEvitadas++;
            this.#trazaFotoDuenos.bytesEmitidos += bytesEnCurso;
          } else if (caminoEnCurso === 'reunido') {
            this.#control[CTL.fotoDuenosResync]!++;
          }
        }
      },
    };
  }
  #piscina: Piscina<DatosDueno> | null = null;
  readonly #duenosBrokerGpu: DuenosBroker[] | undefined;
  #materiaGpuDeArranque?: boolean;
  #brokersGpu: (BrokerPercepcionGpu | undefined)[] = [];
  #clienteGpu?: PercibidorBroker;
  #fatal: ErrorFatalMotor | undefined;
  // Vigentes mientras hay piscina (los arma `#arrancar`).
  #d!: Dueno;
  #buzones!: Buzones;
  #contadores!: Contadores;
  #control!: Float64Array;
  #perfilActuar: Float64Array<SharedArrayBuffer> | undefined;
  #perfilPaso: PerfilPasoMotor | undefined;
  #terreno!: TerrenoPercepcion;
  #tabla!: TablaOrganismosSoA;
  #cabecera!: World;
  #tecnologiaInicial: unknown;
  #ultimaInstantanea: {
    world: WeakRef<World>;
    tick: number;
    eventCounter: number;
    tecnologiaRemotaEquivalente: boolean;
    bajasTick: LegacyRecord[];
  } | null = null;
  #bajasConfirmadas: { tick: number; bajas: LegacyRecord[] } | null = null;
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
  #canalesCorte: CanalesCorte | undefined;
  #cierrePendiente = Promise.resolve();
  #altas: [number, string][] = [];
  readonly #detalles = new Map<number, ((p: Person | null) => void)[]>();
  readonly #t: TelemetriaMotor;

  constructor(mundo: World, config: MotorConfig, hilos: number, duenosGpu?: DuenosBroker[]) {
    this.#mundo = mundo; this.#config = config; this.#hilos = hilos;
    this.#duenosBrokerGpu = process.env.CARTA_PERCEPCION_DUENOS === '1' && process.env.COMPUTE_NVRTC ? duenosGpu : undefined;
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
    if (this.#duenosBrokerGpu) this.#materiaGpuDeArranque ??= materiaGpu;
    void this.#cerrarPiscina().catch(() => {});
    this.#fatal = undefined;
    this.#perfilPaso = undefined;
    this.#ultimaInstantanea = null;
    this.#bajasConfirmadas = null;
    olvidarPercepcion(m); olvidarOrganismos(m);
    this.#paginas.clear(); this.#cesiones = []; this.#historial.length = 0;
    this.#activacionesPendientes = 0;
    this.#resultados = []; this.#partesTick = []; this.#partesMundo.clear(); this.#partesFoto.clear(); this.#altas = [];
    this.#ultimaCarasFoto = -1;

    // Memoria compartida de la época. La reserva de filas crece con el mundo que se carga: agotarla es fatal y la
    // recarga siguiente la abre mayor.
    let reserva = RESERVA_FILAS_DUENOS;
    while (reserva < 8 * (m.people.length + m.animals.length)) reserva *= 2;
    const tabla = this.#tabla = new TablaOrganismosSoA(verificar, {
      reservaFilas: reserva, indiceUidCompartido: this.#config.indiceUidCompartido,
    });
    const contadores = this.#contadores = new Contadores(hilos, {
      uid: m.siguienteUid ?? 1, comunidad: m.communityCounter + 1, estructura: m.structureCounter + 1,
      nonce: Math.min(2 ** 52, (m.tick + 1) * 2 ** 22),
    });
    contadores.fijarCronica(m.eventCounter + 1);
    const terreno = this.#terreno = new TerrenoPercepcion(verificar);
    terreno.usarDuenos();
    const brokersGpuPorDueno: (EpocaBrokerPercepcion | undefined)[] = new Array(hilos).fill(undefined);
    if (this.#duenosBrokerGpu && !materiaGpu) {
      this.#brokersGpu = this.#duenosBrokerGpu.map((duenos, i) => {
        try {
          return this.#brokersGpu[i] ?? new BrokerPercepcionGpu(undefined, this.#config.medirBrokerGpu, this.#config.gpu[i]!, duenos,
            this.#config.gruposPercepcionGpu !== undefined);
        } catch { return undefined; } // El dueño de esa tarjeta conserva la ruta CPU.
      });
      this.#duenosBrokerGpu.forEach((duenos, i) => {
        const epoca = this.#brokersGpu[i]?.abrirEpoca(this.#epoca);
        for (const dueno of duenos) if (dueno !== null) brokersGpuPorDueno[dueno] = epoca;
      });
    }
    this.#clienteGpu = ligarCompartido(m, tabla, terreno, contadores, brokersGpuPorDueno[0]);
    for (const ley of leyesActivas(params.v23)) for (const [nombre, tipo, ancho] of ley.columnas ?? []) tabla.columna(nombre, tipo, ancho);
    const buzones = this.#buzones = new Buzones(hilos), libros = crearLibros(hilos), registro = new RegistroContenido(hilos);
    const control = this.#control = new Float64Array(new SharedArrayBuffer((CTL.porDueno + hilos * CTL_DUENO.celdas) * Float64Array.BYTES_PER_ELEMENT));
    const perfilActuar = this.#perfilActuar = this.#config.medirPaso
      ? new Float64Array(new SharedArrayBuffer(hilos * Float64Array.BYTES_PER_ELEMENT)) : undefined;
    control[CTL.tick] = m.tick; control[CTL.epoca] = this.#epoca; control[CTL.fotoRanura] = -1;
    control[CTL.fotoCaras] = 0; control[CTL.fotoDuenosEntregado] = 0; control[CTL.fotoDuenosResync] = 0;
    const azar = azarDeHilo(this.#config.semilla, 0);
    const conMateria = params.v23.materia;
    const registroSustancias = conMateria ? new RegistroContenido(hilos) : null;
    const opcionesQuimica = { modo: 'inmediato', registroSustancias: registroSustancias ?? undefined } as const;
    const quimica = !conMateria ? null : materia ? cargarSustancias(materia.sustancias, opcionesQuimica) : crearServicioQuimico(opcionesQuimica);
    const arenas = conMateria ? crearArenasMateria(this.#config.reservaLotesMateria, this.#config.materiaFisicaSeparada) : null;
    const d = this.#d = new Dueno(m, {
      hilo: 0, hilos, buzones, buzon: buzones.dueno(0, azar), libros, contadores, registro, azar, control, enlace: this.#enlace,
      materia: quimica && arenas ? { ...arenas, quimica } : null,
    });
    if (this.#fuente) d.enlazar(this.#enlace, this.#fuenteReunida());
    d.epoca = this.#epoca;
    d.avisar = (clase, i) => this.#aviso(clase, i);
    d.prepararEpoca();

    // Aún no hay coste medido: los tramos Morton tienen peso uniforme salvo en el brazo de población.
    const claves = Object.keys(m.chunks), px = Int32Array.from(claves, k => m.chunks[k]!.cx), py = Int32Array.from(claves, k => m.chunks[k]!.cy);
    const pesos = this.#config.repartoInicial === 'poblacion' ? pesosInicialesPorPoblacion(claves, m.people) : undefined;
    const duenos = repartirPorTramos(px, py, hilos, pesos), chunks = new Int32Array(claves.length);
    for (let i = 0; i < claves.length; i++) {
      const chunk = chunks[i] = terreno.asegurarPagina(px[i]!, py[i]!, duenos[i]!);
      d.tenerChunk(chunk, claves[i]!);
      this.#paginas.set(clavePagina(px[i]!, py[i]!), { chunk, px: px[i]!, py: py[i]!, key: claves[i]!, estado: 'activo' });
    }
    buzones.fijarFase(0);
    const garantias = materia ? d.cargarMateria(materia) : [];
    // Cada dueño materializa en su `Ley.iniciar` los chunks que no traen lotes: la arena compartida solo crece aquí.
    d.reservarMateria(materia ? 0 : claves.length);
    const cabecera = serialize(cabeceraDe(m));
    this.#cabecera = deserialize(cabecera) as World;
    this.#tecnologiaInicial = this.#config.confirmarGuardadoVivo
      ? sinCheckpointTecnologia(structuredClone(this.#cabecera.technology)) : undefined;
    if (this.#config.emisionFotogramaDuenos) d.activarEmisionFoto(this.#cabecera, this.#config.limiteBytesFotoDueno);
    d.repartirChunksIniciales(chunks, duenos);
    const tileIn = tileLookup(m.tiles), fast = residentFastAccess(m.tiles);
    for (let i = 0; i < claves.length; i++) if (duenos[i] === 0) terreno.sincronizarPagina(chunks[i]!, tileIn, fast);

    const datos: DatosDueno = {
      hilos, tabla: tabla.compartirTabla(), terreno: terreno.compartir(), buzones: buzones.memoria!, contadores: contadores.memoria!,
      registro: registro.memoria!, libros, lotes: arenas?.lotes.compartir() ?? null, desborde: arenas?.desborde.compartir() ?? null,
      contenido: arenas?.contenido?.compartir(),
      sustancias: registroSustancias?.memoria ?? null, control: control.buffer as SharedArrayBuffer, enlace: this.#enlace,
      semilla: this.#config.semilla, cabecera, params, epoca: this.#epoca,
      brokersGpuPorDueno, conMateriaCargada: materia !== null, perfilActuar,
      destinatariosGarantias: destinatariosDeGarantias(garantias),
      emisionFotogramaDuenos: this.#config.emisionFotogramaDuenos, limiteBytesFotoDueno: this.#config.limiteBytesFotoDueno,
    };
    const canalesCorte = this.#canalesCorte = this.#config.instantaneaTransferible === true ? CanalesCorte.abrir(hilos - 1) : undefined;
    try {
      datos.solicitudCorte = canalesCorte?.solicitud;
      const piscina = this.#piscina = new Piscina<DatosDueno>({
        hilos, datos, puertosRemotos: canalesCorte?.puertosRemotos, moduleURL: new URL('./dueno-worker.js', import.meta.url), exportName: crearDueno.name,
        crear: (hilo, dd) => hilo === 0
          ? tramo => faseDueno(d, tramo, control, dd.conMateriaCargada, dd.destinatariosGarantias, dd.perfilActuar)
          : crearDueno(hilo, dd),
      });
      buzones.fijarFase(1);
      piscina.ejecutar(TRAMO.cargar);
      tabla.publicar(m.tick);
      buzones.fijarFase(0);
      d.reponer(garantias, datos.destinatariosGarantias);
      this.#recoger();
      this.#cronica();
    } catch (error) {
      const fallo = this.#fallo(error);
      if (canalesCorte) void this.#cerrarPiscina().catch(() => {});
      throw fallo;
    }
  }

  #fallo(error: unknown): ErrorFatalMotor {
    return this.#fatal = error instanceof ErrorFatalMotor ? error : new ErrorFatalMotor(error);
  }

  // ── Tick ───────────────────────────────────────────────────────────────────────────────────────────────

  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] } {
    if (this.#fatal) throw this.#fatal;
    if (!this.#piscina) this.#arrancar(null);
    const m = this.#mundo, d = this.#d, buzones = this.#buzones, control = this.#control, piscina = this.#piscina!;
    const perfilActuar = this.#perfilActuar, tramos: PerfilTramoMotor[] | undefined = perfilActuar && [];
    const inicio = performance.now();
    try {
      this.#ultimaInstantanea = null;
      this.#bajasConfirmadas = null;
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
      d.prepararMateriaParaGestos(gestos);
      const resultados = this.#gestos(gestos);
      m.invitations = m.invitations.filter(invitacion => invitacion.until > m.tick);
      m.reminders = m.reminders.filter(aviso => aviso.until > m.tick);
      this.#cabecera.invitations = this.#cabecera.invitations.filter(invitacion => invitacion.until > m.tick);
      this.#cabecera.reminders = this.#cabecera.reminders.filter(aviso => aviso.until > m.tick);
      if (this.#altas.length) {
        const altas = this.#altas.splice(0);
        d.anotarAjenas(altas);
        for (let h = 1; h < this.#hilos; h++) d.ordenar(h, [ORDEN.directorio], altas);
      }
      this.#pedirDetalles();
      d.F0();
      if (this.#config.emisionFotogramaDuenos && control[CTL.fotoRanura]! >= 0) {
        const completo = control[CTL.fotoCompleto] === 1;
        control[CTL.fotoCaras] = completo || this.#ultimaCarasFoto < 0 || m.tick < this.#ultimaCarasFoto
          || m.tick - this.#ultimaCarasFoto >= ESTADISTICAS_CARAS_CADA_TICKS ? 1 : 0;
      } else {
        control[CTL.fotoCaras] = 0;
      }
      if (this.#activacionesPendientes) d.reservarMateria(this.#activacionesPendientes);
      d.prepararMateriaAntesDeF1();
      control[CTL.lluvia] = Number(m.weather === 'rain');
      const f0 = performance.now();
      buzones.fijarFase(1); piscina.ejecutar(TRAMO.percibir);
      tramos?.push(medirTramo(piscina, 'percibir'));
      this.#activacionesPendientes = 0;
      buzones.fijarFase(3); piscina.ejecutar(TRAMO.actuar);
      tramos?.push(medirTramo(piscina, 'actuar'));
      buzones.fijarFase(5); piscina.ejecutar(TRAMO.aplicar);
      tramos?.push(medirTramo(piscina, 'aplicar'));
      const f5 = tramos && Array.from({ length: this.#hilos }, (_, h) => control[celdaDueno(h, CTL_DUENO.msAplicar)]!);
      buzones.fijarFase(6); piscina.ejecutar(TRAMO.publicar);
      tramos?.push(medirTramo(piscina, 'publicar'));
      const desdeCierre = tramos && performance.now();
      this.#tabla.publicar(m.tick);
      // Cierre en serie: lo que los dueños mandaron al coordinador en el tick (la crónica en orden, altas, resultados).
      this.#recoger();
      this.#cronica();
      const fotoAbierta = control[CTL.fotoRanura]! >= 0;
      const fotoCompleta = control[CTL.fotoCompleto] === 1;
      if (fotoAbierta && this.#config.emisionFotogramaDuenos && this.#canalesCorte) {
        for (const parte of this.#canalesCorte.recibirFotos(this.#epoca, m.tick)) this.#partesFoto.set(parte.hilo, parte);
      }
      const fotoPerdida = d.cerrarFoto();
      this.#partesFoto.clear();
      if (fotoPerdida) {
        this.#t.fotogramasSaltados++;
        if (this.#config.emisionFotogramaDuenos && fotoAbierta) {
          this.#trazaFotoDuenos.abortos++;
          if (fotoCompleta) this.#trazaFotoDuenos.completosAbortados++;
        }
      }
      resultados.push(...this.#resultados.splice(0));
      resultados.sort((a, b) => a.order - b.order);
      const fin = performance.now();
      this.#medir(fin - inicio, f0 - inicio);
      if (tramos && perfilActuar && f5 && desdeCierre !== undefined) this.#perfilPaso = {
        tick: m.tick, epoca: this.#epoca, paredMs: fin - inicio, F0Ms: f0 - inicio, cierreMs: fin - desdeCierre, tramos,
        fasesPorDuenoMs: f5.map((F5, h) => {
          const F3F4 = control[celdaDueno(h, CTL_DUENO.msActuar)]!, F3 = perfilActuar[h]!;
          return { F1: control[celdaDueno(h, CTL_DUENO.msF1)]!, eco: control[celdaDueno(h, CTL_DUENO.msEco)]!,
            F2: control[celdaDueno(h, CTL_DUENO.msPercibir)]!, F3F4, F3, F4: F3F4 - F3, F5,
            F6: control[celdaDueno(h, CTL_DUENO.msAplicar)]! - F5 };
        }),
      };
      return { tick: m.tick, resultados };
    } catch (error) { throw this.#fallo(error); }
  }

  /** Vacía la cola F0 del coordinador (fase 0): peticiones de ley, partes del tick, resultados y lo demás. */
  #recoger(): void {
    this.#buzones.fijarFase(0);
    this.#d.recibirAvisos();
    const propia = this.#d.parteDelTick();
    if (propia) this.#partesTick.push(propia);
    const fotoLocal = this.#d.tomarParteFotoLocal();
    if (fotoLocal) this.#partesFoto.set(0, fotoLocal);
  }

  #aviso(clase: number, i: Intento): void {
    switch (clase) {
      case AVISO.resultado: this.#resultados.push(deserialize(i.bytes!) as GestureResult); break;
      case AVISO.tick: this.#partesTick.push(deserialize(i.bytes!) as ParteTick); break;
      case AVISO.parte: this.#partesMundo.set(i.dato![1]!, deserialize(i.bytes!) as World); break;
      case AVISO.foto: this.#partesFoto.set(i.dato![1]!, deserialize(i.bytes!) as ParteFotoDueno); break;
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
      for (const suceso of parte.sucesos) sucesos.push(suceso);
      for (const visible of parte.visibles) d.visiblesTick.push(visible);
      // Al cargar, un dueño puede comunicar más identificadores que los argumentos que admite V8.
      for (const alta of parte.altas) this.#altas.push(alta);
    }
    sucesos.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    for (const { id, tick: _tick, ...suceso } of sucesos) if (appendWorldEvent(m, suceso).id !== id) this.cronicaDesfasada++;
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
    const previa = terreno.paginaDe(px, py);
    if (previa >= 0) d.reponerMateriaParaCeder(previa);
    const { tiles, animals, structures, ...meta } = tomarChunk(m, key, px, py);
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
      const paraConfirmar = this.#config.confirmarGuardadoVivo === true;
      const { world, pendientes, tecnologiaRemotaEquivalente, bajas } = this.#reunirMundo(paraConfirmar);
      recordSample(world);
      const materia = this.#d.instantaneaMateria(pendientes);
      if (paraConfirmar) this.#ultimaInstantanea = {
        world: new WeakRef(world), tick: this.#mundo.tick, eventCounter: this.#mundo.eventCounter,
        tecnologiaRemotaEquivalente, bajasTick: bajas.map(b => structuredClone(b)),
      };
      return { world, materia };
    } catch (error) { throw this.#fallo(error); }
  }

  confirmarGuardado(guardado: Instantanea): boolean {
    if (this.#fatal) throw this.#fatal;
    if (!this.#config.confirmarGuardadoVivo || !this.#piscina) return false;
    const meta = this.#ultimaInstantanea;
    this.#ultimaInstantanea = null;
    const m = this.#mundo, w = guardado.world;
    // Fase 1 (solo lectura y copias previas): cualquier `false` rechaza antes de tocar estado vivo.
    if (!meta || meta.world.deref() !== w || meta.tick !== m.tick || meta.eventCounter !== m.eventCounter) return false;
    if (!meta.tecnologiaRemotaEquivalente) return false;
    // Con cooperación apagada, la próxima fase de comunidades no actualiza el padrón vivo.
    if (!m.cooperationEnabled && meta.bajasTick.length) return false;
    if (w.retiredChunks.length !== 0 || w.retiredLegacy.length !== 0) return false;
    const cronica = w.chronicleJournal;
    if (!cronica || cronica.pending.length !== 0 || cronica.committedThrough !== m.eventCounter) return false;
    const tech = w.technology;
    if (!tech?.journal || tech.journal.pending.length !== 0) return false;
    if (!tech.catalogue || tech.catalogue.pending.length !== 0) return false;
    const candidataTech = structuredClone(tech);
    const partesBase = Array.from({ length: this.#hilos - 1 }, () => this.#tecnologiaInicial as World['technology'] | undefined);
    if (!tecnologiaEquivalenteParaConfirmar(this.#cabecera.technology, this.#tecnologiaInicial, partesBase, candidataTech)) return false;

    const diarioConfirmado = structuredClone(cronica);
    const historiaConfirmada = structuredClone(w.history);
    const tecnologiaConfirmada = { ...candidataTech, checkpoint: undefined };
    const contextoGuardado = worldContext(w);

    // Fase 2 (mutación viva tras COMMIT): nunca toca buzones ni garantías en vuelo.
    // Si falla a medias en un worker o en el coordinador tras mutar workers, la piscina queda fatal y lanza.
    try {
      const falloPrueba = falloConfirmarGuardadoPrueba;
      if (falloPrueba !== null) {
        falloConfirmarGuardadoPrueba = null;
        if (falloPrueba > 0) this.#control[CTL.falloConfirmar] = falloPrueba;
      }
      this.#buzones.fijarFase(0);
      this.#piscina.ejecutar(TRAMO.confirmarGuardado);
      if (falloPrueba === 0) throw new Error('Fallo inyectado al confirmar guardado en el coordinador tras mutar workers.');
      m.chronicleJournal = diarioConfirmado;
      m.history = historiaConfirmada;
      m.retiredChunks = [];
      m.retiredLegacy = [];
      m.technology = tecnologiaConfirmada;
      if (contextoGuardado.loadChunk || contextoGuardado.loadLegacy || contextoGuardado.catalogueReader) {
        bindWorldContext(m, { ...worldContext(m), ...contextoGuardado });
      }
      this.#bajasConfirmadas = meta.bajasTick.length ? { tick: meta.tick, bajas: meta.bajasTick } : null;
      return true;
    } catch (error) {
      throw this.#fallo(error);
    }
  }

  /** Diagnóstico de la piscina viva (p. ej. `threadIds` y `fatal` para comprobar persistencia de dueños). */
  get diagnosticoPiscina(): DiagnosticoPiscina | undefined {
    return this.#piscina?.diagnostico();
  }

  /** Laboratorio: contadores de la emisión de vistas lentas de fotograma por dueño. */
  get trazaFotogramaDuenos(): Readonly<TrazaFotogramaDuenos> {
    let migrantesTransferidos = 0;
    if (this.#control) {
      for (let h = 0; h < this.#hilos; h++) migrantesTransferidos += this.#control[celdaDueno(h, CTL_DUENO.migrantesFoto)] ?? 0;
    }
    return { ...this.#trazaFotoDuenos, migrantesTransferidos };
  }

  #reunirMundo(paraConfirmar = false): { world: World; pendientes: Intento[]; tecnologiaRemotaEquivalente: boolean; bajas: LegacyRecord[] } {
    const canales = this.#canalesCorte, solicitud = canales?.pedir();
    this.#buzones.fijarFase(0);
    this.#piscina!.ejecutar(TRAMO.reunir);
    this.#recoger();
    const partes = canales ? canales.recibir(solicitud!, this.#epoca, this.#mundo.tick) : Array.from({ length: this.#hilos - 1 }, (_, i) => {
      const parte = this.#partesMundo.get(i + 1);
      if (!parte) throw new Error(`Instantánea incompleta: falta el dueño ${i + 1}.`);
      return parte;
    });
    this.#partesMundo.clear();
    const tecnologiaRemotaEquivalente = paraConfirmar && partes.every(parte =>
      isDeepStrictEqual(sinCheckpointTecnologia(parte.technology), this.#tecnologiaInicial));
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
    // El padrón de F0 todavía puede contener las bajas que se confirmaron en F5 (incluidas las ya archivadas en este mismo tick).
    const bajasNuevas = world.retiredLegacy.filter(persona => persona.diedAt === world.tick);
    const bajasPrevias = this.#bajasConfirmadas?.tick === world.tick ? this.#bajasConfirmadas.bajas : [];
    const bajas = bajasPrevias.length
      ? [...bajasPrevias, ...bajasNuevas.filter(p => !bajasPrevias.some(prev => prev.id === p.id))]
      : bajasNuevas;
    if (bajas.length) {
      pruneBonds(world.people, bajas);
      const ids = new Set(bajas.map(persona => persona.id));
      world.communities = world.communities.filter(comunidad => {
        if (!comunidad.members.some(id => ids.has(id))) return true;
        comunidad.members = comunidad.members.filter(id => !ids.has(id));
        if (comunidad.memberCount !== undefined) comunidad.memberCount = comunidad.members.length;
        return comunidad.members.length > 0;
      });
    }
    if (paramsOf(world).v23.fauna) syncFauna(world.tiles, world.animals);
    return { world, pendientes, tecnologiaRemotaEquivalente, bajas };
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

  muestraPerfilPaso(): PerfilPasoMotor | undefined {
    const perfil = this.#perfilPaso;
    if (this.#piscina && !this.#fatal && perfil?.tick === this.#d.frente.tick && perfil.epoca === this.#epoca) return perfil;
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

  async prepararBrokerGpu(): Promise<boolean> {
    if (!this.#duenosBrokerGpu) return false;
    if (!this.#piscina) this.#arrancar(null);
    const listas = await Promise.all(this.#brokersGpu.map(broker => broker?.listo ?? false));
    return listas.length > 0 && listas.every(Boolean);
  }

  telemetria(): TelemetriaMotor {
    const gpus = this.#brokersGpu.map(broker => broker?.medidas());
    const unica = gpus.length === 1 ? gpus[0]?.detalle : undefined;
    return { ...this.#t, faseMs: { ...this.#t.faseMs }, ocupacion: this.#t.ocupacion.slice(), ...(gpus.length > 0 && {
      gpuEstado: gpus.map(gpu => gpu?.lista && gpu.aceptaEnEpoca ? 'ok' : 'cpu'),
      gpuMs: gpus.map(gpu => gpu?.ms ?? 0), gpuBytes: gpus.map(gpu => gpu?.bytes ?? 0),
      gpuBrokers: gpus.map((gpu, i) => ({ dispositivo: this.#config.gpu[i]!, lista: gpu?.lista ?? false,
        duenosPorRanura: this.#duenosBrokerGpu?.[i], detalle: gpu?.detalle })),
      ...(unica && { gpuBroker: unica }),
    }) };
  }

  async cerrar(): Promise<void> {
    for (const resolvedores of this.#detalles.values()) for (const resolver of resolvedores) resolver(null);
    this.#detalles.clear();
    try { await this.#cerrarPiscina(); }
    finally { await Promise.all(this.#brokersGpu.map(broker => broker?.cerrar())); }
  }

  async #cerrarPiscina(): Promise<void> {
    this.#clienteGpu?.cerrar();
    this.#clienteGpu = undefined;
    const canalesCorte = this.#canalesCorte;
    this.#canalesCorte = undefined;
    canalesCorte?.cerrar();
    const piscina = this.#piscina;
    const anterior = this.#cierrePendiente;
    if (!piscina) return anterior;
    this.#piscina = null;
    const cierre = this.#retirarPiscina(piscina);
    // Una apertura puede retirar la piscina anterior sin esperar. El cierre explícito sí espera a todas.
    this.#cierrePendiente = Promise.all([anterior, cierre.catch(() => {})]).then(() => {});
    return cierre.finally(() => anterior);
  }

  async #retirarPiscina(piscina: Piscina<DatosDueno>): Promise<void> {
    try {
      if (this.#fatal || !paramsOf(this.#d.mundo).v23.materiaGpu) cerrarMateriaGpu(this.#d.mundo);
      else piscina.ejecutar(TRAMO.cerrar);
    } finally { await piscina.cerrar(); }
  }
}
