/**
 * Emisión opt-in de vistas lentas de cinta por dueño (Etapa 1).
 *
 * Cada dueño proyecta en F6 (dentro de `escribirFoto`, antes de `emigrar`) sus propias vistas lentas
 * (`pagina`, `estructura`, `persona`, `animal`, `texto`) y un resumen escalar O(1) para cabecera/serie,
 * empaquetando los sucesos en el mismo formato binario del anillo (`[u32 len LE][v8.serialize]`) bajo un
 * límite explícito de bytes por dueño.
 *
 * Invariantes:
 *  - Commit en 2 fases (`confirmado` / `tentativo`) sincronizado por `CTL.fotoDuenosEntregado` y `CTL.fotoDuenosResync`.
 *  - Si un fotograma completo (`f.completo`) o incremental aborta, `confirmado` queda intacto; solo se descarta `tentativo`.
 *  - Ningún dueño emite `pagina: null` al retirar un chunk: el coordinador decide la conservación/baja de `pagina`
 *    según las claves activas de `mundo.chunks` al cerrar el fotograma (semántica exacta de `fuente.ts`).
 *  - En migraciones/cesiones (`destino >= 0`), `A` no emite bajas y transfiere sus firmas `confirmado`/`tentativo`
 *    al receptor `B`, que las reconcilia en F1 contra el estado ya definitivo del tick anterior.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';
import type { LegacyRecord } from '../../shared/demography.js';
import type {
  VistaAnimalFotograma, VistaPaginaFotograma, VistaPersonaFotograma,
} from '../../shared/fotograma.js';
import type { BlueprintView, StructureView } from '../../shared/life.js';
import type { TechnologyKnowledge } from '../../shared/technology.js';
import type { MemoryView, PersonView, PlaceView, Tile } from '../../shared/types.js';
import type { DivineWhisper } from '../../shared/worldmap.js';
import { lecturaResidente } from '../agua.js';
import { especieVisual, projectAnimal } from '../animals.js';
import { demographicTraits } from '../demography.js';
import { parcialDiversidad, reducirDiversidad, type ParcialDiversidad } from '../diversidad.js';
import { escuchaDe } from '../genetics.js';
import { paramsOf } from '../params.js';
import { projectCraft } from '../projection.js';
import { progresoConstruccion, projectTile, specialty } from '../proyeccion.js';
import type { Person, World } from '../mundo/tipos.js';
import type { OrganismosMundo } from '../soa/organismos-mundo.js';
import { PAGE_SIDE } from '../soa/region.js';
import { residentFastAccess } from '../soa/terreno.js';
import { tileLookup } from '../tile-index.js';
import type { CtxLey } from './acceso.js';
import { Clase, REF_NULA, slotDe, type ChunkId, type Hilo, type Terreno } from './contratos.js';
import type { FotogramaEnCurso, SucesoFotograma } from './fotograma.js';
import { nuevosDe } from './reunir.js';

/** Tope por defecto de bytes pre-serializados que un dueño puede transferir en un fotograma (por debajo del anillo de 256 MiB). */
export const LIMITE_BYTES_FOTO_DUENO_DEFECTO = 32 * 1024 * 1024;
/** Tope combinado por defecto entre todos los dueños en un fotograma antes de caer al fallback reunido. */
export const LIMITE_BYTES_FOTO_TOTAL_DEFECTO = 128 * 1024 * 1024;

export const CAMPOS_TEXTO_OPCIONALES = ['recentMemory', 'specialty', 'craftTint', 'craftFocus'] as const;
const CAMPOS_TEXTO_OBLIGATORIOS = ['name', 'color', 'reason', 'need'] as const;
const WORKING_ACTIONS: ReadonlySet<string> = new Set(['gather', 'farm', 'build', 'hunt', 'invent', 'repair', 'research', 'craft', 'forage']);
const PROJECT_ACTIONS: ReadonlySet<string> = new Set(['research', 'craft']);
const SKILLED_ACTIONS: ReadonlySet<string> = new Set(['farm', 'hunt']);
const VACIO = new Uint8Array(0);
const CHUNK_OFFSET = 2 ** 21;
const CHUNK_STRIDE = 2 ** 22;
const TIERRA = 1;
const AGUA = 2;

const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const q2 = (n: number): number => Math.round(n * 100) / 100;
const q2opt = <T extends number | undefined>(n: T): T => (typeof n === 'number' ? q2(n) : n) as T;

export function sinCheckpointTecnologiaFoto(tech: World['technology'] | undefined): unknown {
  if (!tech) return tech;
  const { checkpoint: _checkpoint, ...resto } = tech;
  return resto;
}

function firmaDeBytes(datos: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(datos).digest().subarray(0, 16));
}

function igualFirma(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface FirmaPersona {
  readonly vista: Uint8Array;
  readonly textos: Readonly<Record<string, string>>;
}

interface FirmaAnimal {
  readonly vista: Uint8Array;
  readonly reason: string;
}

/** Estado compacto de cinta que acompaña a un organismo en `MigranteOrganismo` (solo firmas y textos). */
export interface EstadoCintaOrganismo {
  readonly epoca: number;
  readonly resync: number;
  readonly esperadoGen: number;
  readonly confirmado: FirmaPersona | FirmaAnimal | null;
  readonly tentativo?: FirmaPersona | FirmaAnimal | null;
}

/** Estado compacto de cinta que acompaña a un chunk cedido (`destino >= 0`) en `MigranteChunk`. */
export interface EstadoCintaChunk {
  readonly epoca: number;
  readonly resync: number;
  readonly esperadoGen: number;
  readonly paginaConfirmada: Uint8Array | null;
  readonly paginaTentativa?: Uint8Array | null;
  readonly estructuras: readonly { id: string; confirmado: Uint8Array | null; tentativo?: Uint8Array | null }[];
  readonly personas: readonly { uid: number; confirmado: FirmaPersona | null; tentativo?: FirmaPersona | null }[];
  readonly animales: readonly { uid: number; confirmado: FirmaAnimal | null; tentativo?: FirmaAnimal | null }[];
}

export interface ResumenStatsDueno {
  readonly population: number;
  readonly hunger: number;
  readonly energy: number;
  readonly fatigue: number;
  readonly thirst: number;
  readonly materials: { wood: number; stone: number };
  readonly actions: Record<string, number>;
  readonly biomes: Record<string, number>;
  readonly features: Record<string, number>;
  readonly generations: Record<string, number>;
  readonly wildlife: Record<string, number>;
  readonly structures: Record<string, number>;
  readonly freshWater: number;
  readonly cultivatedTiles: number;
  readonly trailTiles: number;
  readonly pavedTiles: number;
  readonly polyominoStructures: number;
  readonly synergyLinks: number;
  readonly neighbors: number;
  readonly identities: number;
  readonly protectedCount: number;
  readonly lifeStage: { juvenile: number; adult: number; senescent: number; unknown: number };
}

export interface ResumenFotoDueno {
  readonly poblacion: number;
  readonly faunaViva: number;
  readonly estructurasVivas: number;
  readonly birthCounter: number;
  readonly discoveredChunks: number;
  readonly settlementCount: number;
  readonly demographyDynamics: World['demographyDynamics'];
  readonly animalDynamics: World['animalDynamics'];
  readonly inventionDynamics: World['inventionDynamics'];
  readonly totals: World['totals'];
  readonly legacy: readonly LegacyRecord[];
  readonly bajasTick: readonly LegacyRecord[];
  readonly nuevos: {
    readonly places: readonly PlaceView[];
    readonly memories: readonly MemoryView[];
    readonly blueprints: readonly BlueprintView[];
    readonly whispers: readonly DivineWhisper[];
  };
  readonly stats: ResumenStatsDueno;
  readonly diversidad?: ParcialDiversidad;
  /** Solo dueño 0: habitantes con inventario o residuo técnico no vacío antes de `emigrar`. */
  readonly actoresConInventario?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly technology: Pick<TechnologyKnowledge, 'items' | 'residue'>;
  }[];
}

export interface ParteFotoDueno {
  readonly hilo: Hilo;
  readonly tick: number;
  readonly desbordado: boolean;
  readonly compatFallback: boolean;
  readonly trasFallback: boolean;
  readonly bytes: number;
  readonly bajasBytes: Uint8Array;
  readonly altasBytes: Uint8Array;
  readonly paginasEscritas: readonly string[];
  readonly estructurasAltasIds: readonly string[];
  readonly estructurasBajasIds: readonly string[];
  readonly resumen: ResumenFotoDueno | null;
}

export interface LoteFotoDuenos {
  readonly hilos: number;
  readonly cabecera: World;
  readonly partes: readonly ParteFotoDueno[];
  readonly clavesActivas: ReadonlySet<string>;
  readonly chunksActivos: readonly ChunkId[];
  readonly conCaras: boolean;
  readonly limiteBytesTotal: number;
  readonly bajasConfirmadas: readonly LegacyRecord[];
  readonly altasTick?: ReadonlyMap<number, string>;
}

export interface TrazaFotogramaDuenos {
  emitidos: number;
  fallbacksLimite: number;
  fallbacksCompat: number;
  abortos: number;
  completosAbortados: number;
  reunionesEvitadas: number;
  bytesEmitidos: number;
  migrantesTransferidos: number;
}

export function trazaFotogramaDuenosVacia(): TrazaFotogramaDuenos {
  return {
    emitidos: 0, fallbacksLimite: 0, fallbacksCompat: 0, abortos: 0,
    completosAbortados: 0, reunionesEvitadas: 0, bytesEmitidos: 0, migrantesTransferidos: 0,
  };
}

interface ConfirmadoDueno {
  epoca: number;
  readonly personas: Map<number, FirmaPersona>;
  readonly animales: Map<number, FirmaAnimal>;
  readonly estructuras: Map<string, Uint8Array>;
  readonly paginas: Map<string, Uint8Array>;
}

interface TentativoDueno {
  readonly tick: number;
  readonly epoca: number;
  readonly resync: number;
  readonly esperadoGen: number;
  readonly reemplazaConfirmado: boolean;
  readonly personas: Map<number, FirmaPersona | null>;
  readonly animales: Map<number, FirmaAnimal | null>;
  readonly estructuras: Map<string, Uint8Array | null>;
  readonly paginas: Map<string, Uint8Array | null>;
}

interface PresupuestoEmpaquetado {
  readonly limite: number;
  usados: number;
  desbordado: boolean;
}

class EmpaquetadorSucesos {
  readonly #trozos: Uint8Array[] = [];
  #bytes = 0;

  constructor(readonly presupuesto: PresupuestoEmpaquetado) {}

  get bytes(): number { return this.#bytes; }

  agregarBytes(cuerpo: Uint8Array): boolean {
    if (this.presupuesto.desbordado) return false;
    const total = 4 + cuerpo.byteLength;
    if (this.presupuesto.usados + total > this.presupuesto.limite) {
      this.presupuesto.desbordado = true;
      this.#trozos.length = 0;
      this.#bytes = 0;
      return false;
    }
    const cabecera = Buffer.allocUnsafe(4);
    cabecera.writeUInt32LE(cuerpo.byteLength, 0);
    this.#trozos.push(cabecera, cuerpo);
    this.#bytes += total;
    this.presupuesto.usados += total;
    return true;
  }

  agregar(suceso: SucesoFotograma): boolean {
    if (this.presupuesto.desbordado) return false;
    return this.agregarBytes(serialize(suceso));
  }

  sellar(): Uint8Array {
    if (!this.#bytes) return VACIO;
    const salida = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const trozo of this.#trozos) {
      salida.set(trozo, offset);
      offset += trozo.byteLength;
    }
    return salida;
  }
}

function proyectarPersonaLenta(world: World, p: Person, cuerpo: ReturnType<typeof paramsOf>['cuerpo']): {
  vista: VistaPersonaFotograma;
  textos: Record<string, string>;
} {
  const life = demographicTraits(p.genome, cuerpo);
  const vista: VistaPersonaFotograma = {
    id: p.id, role: p.role,
    fatigue: q2(p.fatigue),
    traits: { ...p.traits }, escucha: escuchaDe(p.genome),
    skills: { ...p.skills }, materials: { ...p.materials },
    controlMode: p.controlMode, blueprintId: p.blueprintId ?? null,
    target: { x: p.target.x, y: p.target.y },
    foodReserve: q2opt(p.inventory), foodReserveCapacity: 0.25,
    working: !!p.technology.waterPreparation || WORKING_ACTIONS.has(p.action) && distance(p, p.target) < 0.5,
    workProgress: p.technology.waterPreparation
      ? clamp(((p.technology.items.find(item => item.id === p.technology.waterPreparation!.itemId)?.contents?.water ?? 0) - p.technology.waterPreparation.initialQuanta) / (p.technology.waterPreparation.targetQuanta - p.technology.waterPreparation.initialQuanta))
      : PROJECT_ACTIONS.has(p.action)
        ? (p.technology.project ? clamp(p.technology.project.progress / p.technology.project.requiredWork) : 0)
        : p.action === 'build'
          ? progresoConstruccion(world, p)
          : clamp(p.work / (p.action === 'invent' ? 60 : p.action === 'repair' ? 30 : SKILLED_ACTIONS.has(p.action) ? Math.ceil(45 * (1 - (p.skills[p.action] ?? 0) * 0.25)) : Math.ceil(18 * (1 - (p.skills[p.action] ?? 0) * 0.25)))),
    vitality: q2opt(p.demography.vitality),
    continuityProtected: p.role !== 'neighbor',
    lifeStage: p.demography.age < life.maturityAge ? 'juvenile' : p.demography.age < life.senescenceStart ? 'adult' : 'senescent',
    genome: { generation: p.genome.generation, parents: [...p.genome.parents], learningRate: p.genome.learningRate, cooperation: p.genome.cooperation, mutations: p.genome.mutations },
    age: world.tick - p.bornAt, communityId: p.communityId, culture: { ...p.culture },
    ...(p.compounds?.length ? { compounds: p.compounds.map(comp => ({ ...comp, composition: { ...comp.composition }, properties: { ...comp.properties } })) } : {}),
  };
  const craftHolder = {} as PersonView;
  projectCraft(p, craftHolder);
  const textos: Record<string, string> = {
    name: p.name, color: p.color, reason: p.reason, need: p.need,
    specialty: specialty(p),
  };
  if (p.recentMemory != null) textos.recentMemory = p.recentMemory;
  if (craftHolder.craftTint != null) textos.craftTint = craftHolder.craftTint;
  if (craftHolder.craftFocus != null) textos.craftFocus = craftHolder.craftFocus;
  return { vista, textos };
}

function proyectarAnimalLento(animal: World['animals'][number], tick: number): {
  vista: VistaAnimalFotograma;
  reason: string;
} {
  const a = projectAnimal(animal, tick);
  a.fatigue = q2(a.fatigue);
  if (a.reproReserve !== undefined) a.reproReserve = q2(a.reproReserve);
  if (a.age !== undefined) a.age = Math.floor(a.age / 20) * 20;
  const { reason, x: _x, y: _y, action: _accion, energy: _energia, hunger: _hambre, thirst: _sed, health: _salud, ...vista } = a;
  return { vista, reason };
}

function esCompatRemoto(
  hilo: Hilo,
  m: World,
  tecnologiaInicial: unknown,
  quimicaInicial: unknown,
  personasVivas: readonly Person[],
  estructurasVivas: readonly StructureView[],
): boolean {
  if (hilo === 0) return false;
  if (!isDeepStrictEqual(sinCheckpointTecnologiaFoto(m.technology), tecnologiaInicial)) return true;
  for (const p of personasVivas) {
    if (p.technology.items.length > 0) return true;
    const r = p.technology.residue;
    if (r.wood !== 0 || r.stone !== 0 || r.water !== 0) return true;
    if (p.compounds?.length) return true;
  }
  for (const s of estructurasVivas) {
    if (s.installed?.length || s.storedCompounds?.length) return true;
  }
  if (m.chemistry !== undefined || quimicaInicial !== undefined) {
    if (!isDeepStrictEqual(m.chemistry, quimicaInicial)) return true;
  }
  return false;
}

export class EmisorFotoDueno {
  readonly #limiteBytes: number;
  readonly #tecnologiaInicial: unknown;
  readonly #quimicaInicial: unknown;
  readonly #baseListas: {
    readonly places: readonly PlaceView[];
    readonly memories: readonly MemoryView[];
    readonly blueprints: readonly BlueprintView[];
    readonly whispers: readonly DivineWhisper[];
  };
  readonly #confirmado: ConfirmadoDueno = {
    epoca: -1,
    personas: new Map(),
    animales: new Map(),
    estructuras: new Map(),
    paginas: new Map(),
  };
  #tentativo: TentativoDueno | null = null;
  #resyncVisto = 0;
  #trasFallback = false;

  constructor(cabecera: World, opciones: { limiteBytes?: number } = {}) {
    this.#limiteBytes = Math.max(1, opciones.limiteBytes ?? LIMITE_BYTES_FOTO_DUENO_DEFECTO);
    this.#tecnologiaInicial = sinCheckpointTecnologiaFoto(structuredClone(cabecera.technology));
    this.#quimicaInicial = structuredClone(cabecera.chemistry);
    this.#baseListas = {
      places: structuredClone(cabecera.places),
      memories: structuredClone(cabecera.memories),
      blueprints: structuredClone(cabecera.blueprints),
      whispers: structuredClone(cabecera.whispers ?? []),
    };
  }

  /** Reconcilia el último `tentativo` contra `genEntregado` y `resync` publicados en `control`.
   * Si `incluirTickActual` es `false` (durante `emigrar` del mismo tick), deja intacto un `tentativo` aún en vuelo. */
  reconciliar(tickActual: number, epoca: number, genEntregado: number, resync: number, incluirTickActual = true): void {
    if (this.#confirmado.epoca !== epoca) {
      this.#confirmado.epoca = epoca;
      this.#confirmado.personas.clear();
      this.#confirmado.animales.clear();
      this.#confirmado.estructuras.clear();
      this.#confirmado.paginas.clear();
      this.#tentativo = null;
      this.#resyncVisto = resync;
      this.#trasFallback = false;
      return;
    }
    const t = this.#tentativo;
    if (t && (incluirTickActual || t.tick < tickActual)) {
      if (t.epoca === epoca && t.resync === resync && genEntregado >= t.esperadoGen) {
        this.#aplicarTentativo(t);
        this.#trasFallback = false;
      }
      // Si abortó (`genEntregado < t.esperadoGen`) —incluso si `t.reemplazaConfirmado` (f.completo)—
      // descartamos solo `t` y conservamos `#confirmado` íntegro.
      this.#tentativo = null;
    }
    if (resync !== this.#resyncVisto) {
      if (this.#tentativo && this.#tentativo.resync !== resync) this.#tentativo = null;
      this.#resyncVisto = resync;
      this.#trasFallback = true;
    }
  }

  #aplicarTentativo(t: TentativoDueno): void {
    if (t.reemplazaConfirmado) {
      this.#confirmado.personas.clear();
      this.#confirmado.animales.clear();
      this.#confirmado.estructuras.clear();
      this.#confirmado.paginas.clear();
    }
    for (const [uid, f] of t.personas) if (f === null) this.#confirmado.personas.delete(uid); else this.#confirmado.personas.set(uid, f);
    for (const [uid, f] of t.animales) if (f === null) this.#confirmado.animales.delete(uid); else this.#confirmado.animales.set(uid, f);
    for (const [id, f] of t.estructuras) if (f === null) this.#confirmado.estructuras.delete(id); else this.#confirmado.estructuras.set(id, f);
    for (const [key, f] of t.paginas) if (f === null) this.#confirmado.paginas.delete(key); else this.#confirmado.paginas.set(key, f);
  }

  /** F6 (`escribirFoto`, tras `escribirFotograma` exitoso y antes de `emigrar`): produce el lote del dueño. */
  emitir(
    c: CtxLey,
    f: FotogramaEnCurso,
    chunksEscritos: readonly ChunkId[],
    organismos: OrganismosMundo,
    paginaDeCoord: (px: number, py: number) => ChunkId,
    genEntregado: number,
    resync: number,
    conCaras: boolean,
  ): ParteFotoDueno {
    this.reconciliar(c.tick, f.epoca, genEntregado, resync, true);
    const m = c.mundo, t = c.terreno, w = c.escritura;
    const vivo = w.u8('vivo'), dueno = w.i32('dueno'), paginaDe = w.i32('chunk');
    const retiraPos = (x: number, y: number): boolean => {
      const ch = paginaDeCoord(x >> 4, y >> 4);
      return ch >= 0 && c.retiraChunk(ch);
    };

    const personasVivas: Person[] = [];
    for (const [s, p] of organismos.personas.mapa) {
      if (p.uid === undefined || dueno[s] !== c.hilo || vivo[s] !== 1) continue;
      personasVivas.push(p as Person);
    }
    const animalesVivos: World['animals'] = [];
    for (const a of m.animals) {
      if (a.uid === undefined) continue;
      const ref = organismos.fauna.ref(a);
      if (ref === REF_NULA) continue;
      const s = slotDe(ref);
      if (dueno[s] !== c.hilo || vivo[s] !== 1 || c.retiraChunk(paginaDe[s]!)) continue;
      animalesVivos.push(a);
    }
    const estructurasVivas: StructureView[] = [];
    for (const s of m.structures) {
      if (retiraPos(s.x, s.y)) continue;
      estructurasVivas.push(s);
    }

    const compatFallback = esCompatRemoto(c.hilo, m, this.#tecnologiaInicial, this.#quimicaInicial, personasVivas, estructurasVivas);
    if (compatFallback) {
      // No creamos tentativo: el coordinador caerá a `#reunirMundo()` y avanzará `resync` si confirma.
      return {
        hilo: c.hilo, tick: c.tick, desbordado: false, compatFallback: true, trasFallback: this.#trasFallback,
        bytes: 0, bajasBytes: VACIO, altasBytes: VACIO,
        paginasEscritas: [], estructurasAltasIds: [], estructurasBajasIds: [], resumen: null,
      };
    }

    const completo = f.completo;
    const trasFallback = this.#trasFallback;
    const emitirTodo = completo || trasFallback;
    const presupuesto: PresupuestoEmpaquetado = { limite: this.#limiteBytes, usados: 0, desbordado: false };
    const bajas = new EmpaquetadorSucesos(presupuesto);
    const altas = new EmpaquetadorSucesos(presupuesto);
    const tentativo: TentativoDueno = {
      tick: c.tick, epoca: f.epoca, resync, esperadoGen: genEntregado + 1,
      reemplazaConfirmado: completo || trasFallback,
      personas: new Map(), animales: new Map(), estructuras: new Map(), paginas: new Map(),
    };
    const paginasEscritas: string[] = [];
    const estructurasAltasIds: string[] = [];
    const estructurasBajasIds: string[] = [];

    // 1. Estructuras (en orden estable local)
    const idsEstructurasVivas = new Set<string>();
    for (const s of estructurasVivas) {
      idsEstructurasVivas.add(s.id);
      const suceso: SucesoFotograma = { tipo: 'estructura', id: s.id, vista: s };
      const bytes = serialize(suceso);
      const firma = firmaDeBytes(bytes);
      const previa = emitirTodo ? undefined : this.#confirmado.estructuras.get(s.id);
      if (emitirTodo || !igualFirma(previa, firma)) {
        if (!altas.agregarBytes(bytes)) break;
      }
      if (emitirTodo || !this.#confirmado.estructuras.has(s.id)) estructurasAltasIds.push(s.id);
      tentativo.estructuras.set(s.id, firma);
    }
    if (!presupuesto.desbordado && !emitirTodo) {
      for (const id of this.#confirmado.estructuras.keys()) {
        if (idsEstructurasVivas.has(id)) continue;
        if (!bajas.agregar({ tipo: 'estructura', id, vista: null })) break;
        estructurasBajasIds.push(id);
        tentativo.estructuras.set(id, null);
      }
    }

    // 2. Personas + textos
    const cuerpo = paramsOf(m).cuerpo;
    const uidsPersonasVivas = new Set<number>();
    if (!presupuesto.desbordado) {
      for (const p of personasVivas) {
        const uid = p.uid!;
        uidsPersonasVivas.add(uid);
        const { vista, textos } = proyectarPersonaLenta(m, p, cuerpo);
        const suceso: SucesoFotograma = { tipo: 'persona', id: String(uid), vista };
        const bytes = serialize(suceso);
        const firmaVista = firmaDeBytes(bytes);
        const previa = emitirTodo ? undefined : this.#confirmado.personas.get(uid);
        if (emitirTodo || !igualFirma(previa?.vista, firmaVista)) {
          if (!altas.agregarBytes(bytes)) break;
        }
        const textosPrevios = previa?.textos;
        for (const campo of CAMPOS_TEXTO_OBLIGATORIOS) {
          const valor = textos[campo]!;
          if (emitirTodo || textosPrevios?.[campo] !== valor) {
            if (!altas.agregar({ tipo: 'texto', uid, campo, valor })) break;
          }
        }
        if (presupuesto.desbordado) break;
        for (const campo of CAMPOS_TEXTO_OPCIONALES) {
          const valor = textos[campo];
          if (valor !== undefined) {
            if (emitirTodo || textosPrevios?.[campo] !== valor) {
              if (!altas.agregar({ tipo: 'texto', uid, campo, valor })) break;
            }
          } else if (!completo && (trasFallback || textosPrevios?.[campo] !== undefined)) {
            if (!bajas.agregar({ tipo: 'texto', uid, campo, valor: null })) break;
          }
        }
        if (presupuesto.desbordado) break;
        tentativo.personas.set(uid, { vista: firmaVista, textos });
      }
    }
    // Bajas de personas: `vista.ts:149-150` las poda automáticamente desde `f.organismos`;
    // aquí solo se marcan en `tentativo` para limpiar `#confirmado` al confirmar.
    if (!presupuesto.desbordado && !emitirTodo) {
      for (const uid of this.#confirmado.personas.keys()) {
        if (!uidsPersonasVivas.has(uid)) tentativo.personas.set(uid, null);
      }
    }

    // 3. Animales + texto `reason`
    const uidsAnimalesVivos = new Set<number>();
    if (!presupuesto.desbordado) {
      for (const a of animalesVivos) {
        const uid = a.uid!;
        uidsAnimalesVivos.add(uid);
        const { vista, reason } = proyectarAnimalLento(a, m.tick);
        const suceso: SucesoFotograma = { tipo: 'animal', id: String(uid), vista };
        const bytes = serialize(suceso);
        const firmaVista = firmaDeBytes(bytes);
        const previa = emitirTodo ? undefined : this.#confirmado.animales.get(uid);
        if (emitirTodo || !igualFirma(previa?.vista, firmaVista)) {
          if (!altas.agregarBytes(bytes)) break;
        }
        if (emitirTodo || previa?.reason !== reason) {
          if (!altas.agregar({ tipo: 'texto', uid, campo: 'reason', valor: reason })) break;
        }
        tentativo.animales.set(uid, { vista: firmaVista, reason });
      }
    }
    if (!presupuesto.desbordado && !emitirTodo) {
      for (const uid of this.#confirmado.animales.keys()) {
        if (!uidsAnimalesVivos.has(uid)) tentativo.animales.set(uid, null);
      }
    }

    // 4. Páginas escritas en `f.paginas` por este dueño (conservando en `#confirmado.paginas` las no sucias;
    //    la baja `pagina: null` la decide el coordinador según `mundo.chunks` / claves activas).
    //    Tras fallback (`reemplazaConfirmado`), no arrastramos firmas previas al fallback para evitar falsos aciertos.
    if (!presupuesto.desbordado && chunksEscritos.length > 0) {
      const tileIn = tileLookup(m.tiles), fast = residentFastAccess(m.tiles);
      for (const chunk of chunksEscritos) {
        const px = t.paginaX[chunk]!, py = t.paginaY[chunk]!, key = `${px},${py}`;
        paginasEscritas.push(key);
        const celdas: Omit<Tile, 'x' | 'y' | 'mat' | 'T'>[] = [];
        for (let y = py * PAGE_SIDE; y < (py + 1) * PAGE_SIDE; y++) {
          for (let x = px * PAGE_SIDE; x < (px + 1) * PAGE_SIDE; x++) {
            const tile = tileIn(x, y);
            if (!tile) throw new Error(`Falta la tesela ${x},${y} de la página del fotograma.`);
            const { x: _x, y: _y, mat: _mat, T: _T, ...celda } = projectTile(tile, fast);
            celdas.push(celda);
          }
        }
        const suceso: SucesoFotograma = { tipo: 'pagina', id: key, vista: celdas as VistaPaginaFotograma };
        const bytes = serialize(suceso);
        const firma = firmaDeBytes(bytes);
        const previa = emitirTodo ? undefined : this.#confirmado.paginas.get(key);
        if (emitirTodo || !igualFirma(previa, firma)) {
          if (!altas.agregarBytes(bytes)) break;
        }
        tentativo.paginas.set(key, firma);
      }
    }

    if (presupuesto.desbordado) {
      // Límite de transferencia rebasado: no tocamos `#confirmado` ni guardamos `#tentativo`.
      return {
        hilo: c.hilo, tick: c.tick, desbordado: true, compatFallback: false, trasFallback,
        bytes: 0, bajasBytes: VACIO, altasBytes: VACIO,
        paginasEscritas: [], estructurasAltasIds: [], estructurasBajasIds: [], resumen: null,
      };
    }

    const bajasBytes = bajas.sellar();
    const altasBytes = altas.sellar();
    const resumen = this.#resumenDueno(c, personasVivas, animalesVivos, estructurasVivas, retiraPos, conCaras);
    this.#tentativo = tentativo;
    return {
      hilo: c.hilo, tick: c.tick, desbordado: false, compatFallback: false, trasFallback,
      bytes: bajasBytes.byteLength + altasBytes.byteLength,
      bajasBytes, altasBytes,
      paginasEscritas, estructurasAltasIds, estructurasBajasIds,
      resumen,
    };
  }

  #resumenDueno(
    c: CtxLey,
    personasVivas: readonly Person[],
    animalesVivos: World['animals'],
    estructurasVivas: readonly StructureView[],
    retiraPos: (x: number, y: number) => boolean,
    conCaras: boolean,
  ): ResumenFotoDueno {
    const m = c.mundo, cuerpo = paramsOf(m).cuerpo;
    const actions: Record<string, number> = {}, biomes: Record<string, number> = {}, features: Record<string, number> = {};
    const generations: Record<string, number> = {}, wildlife: Record<string, number> = {}, structures: Record<string, number> = {};
    const materials = { wood: 0, stone: 0 };
    const lifeStage = { juvenile: 0, adult: 0, senescent: 0, unknown: 0 };
    let hunger = 0, energy = 0, fatigue = 0, thirst = 0;
    let neighbors = 0, identities = 0, protectedCount = 0;
    for (const p of personasVivas) {
      hunger += p.hunger; energy += p.energy; fatigue += p.fatigue; thirst += p.thirst;
      actions[p.action] = (actions[p.action] ?? 0) + 1;
      generations[p.genome.generation] = (generations[p.genome.generation] ?? 0) + 1;
      materials.wood += p.materials.wood; materials.stone += p.materials.stone;
      if (p.role === 'neighbor') {
        neighbors++;
        const traits = demographicTraits(p.genome, cuerpo);
        const age = p.demography.age;
        if (typeof age !== 'number') lifeStage.unknown++;
        else if (age < traits.maturityAge) lifeStage.juvenile++;
        else if (age < traits.senescenceStart) lifeStage.adult++;
        else lifeStage.senescent++;
      } else {
        identities++; protectedCount++;
      }
    }

    let freshWater = 0, cultivatedTiles = 0, trailTiles = 0, pavedTiles = 0;
    const lectura = lecturaResidente(m.tiles);
    if (lectura) {
      const { fast, cells } = lectura;
      const biomeArr = fast.biomeArr, featureArr = fast.featureArr, waterArr = fast.drinkingWaterArr;
      const cultArr = fast.cultivationArr, trafficArr = fast.trafficArr;
      const biomeNames = fast.BIOME_NAMES, featureNames = fast.FEATURE_NAMES;
      for (let i = 0; i < m.tiles.length; i++) {
        const tile = m.tiles[i]!;
        if (retiraPos(tile.x, tile.y)) continue;
        if ((tile.paved ?? 0) >= 0.5) pavedTiles++;
        const cell = cells[i]!;
        if (cell >= 0) {
          const bcode = biomeArr[cell]!, biome = bcode ? biomeNames[bcode - 1]! : 'grassland';
          const fcode = featureArr[cell]!, feature = fcode ? featureNames[fcode - 1]! : 'none';
          biomes[biome] = (biomes[biome] ?? 0) + 1;
          features[feature] = (features[feature] ?? 0) + 1;
          const water = waterArr[cell]!;
          freshWater += water === water ? water : 0;
          if (cultArr[cell]! > 0.1) cultivatedTiles++;
          if (trafficArr[cell]! > 0.15) trailTiles++;
        } else {
          const biome = tile.biome ?? 'grassland', feature = tile.feature ?? 'none';
          biomes[biome] = (biomes[biome] ?? 0) + 1;
          features[feature] = (features[feature] ?? 0) + 1;
          freshWater += tile.drinkingWater ?? 0;
          if ((tile.cultivation ?? 0) > 0.1) cultivatedTiles++;
          if ((tile.traffic ?? 0) > 0.15) trailTiles++;
        }
      }
    } else {
      for (const tile of m.tiles) {
        if (retiraPos(tile.x, tile.y)) continue;
        if ((tile.paved ?? 0) >= 0.5) pavedTiles++;
        const biome = tile.biome ?? 'grassland', feature = tile.feature ?? 'none';
        biomes[biome] = (biomes[biome] ?? 0) + 1;
        features[feature] = (features[feature] ?? 0) + 1;
        freshWater += tile.drinkingWater ?? 0;
        if ((tile.cultivation ?? 0) > 0.1) cultivatedTiles++;
        if ((tile.traffic ?? 0) > 0.15) trailTiles++;
      }
    }

    for (const animal of animalesVivos) {
      const especie = especieVisual(animal.species);
      wildlife[especie] = (wildlife[especie] ?? 0) + 1;
    }

    let polyominoStructures = 0, synergyLinks = 0;
    for (const structure of estructurasVivas) {
      freshWater += structure.water;
      for (const component of structure.components) structures[component] = (structures[component] ?? 0) + 1;
      if ((structure.cells?.length ?? ((structure.footprint?.width ?? 1) * (structure.footprint?.height ?? 1))) > 1) polyominoStructures++;
      const synergy = structure.synergy;
      synergyLinks += (synergy?.sharedEdges ?? 0) + (synergy?.heated ? 1 : 0) + (synergy?.irrigated ? 1 : 0) + ((synergy?.workshopBonus ?? 0) > 0 ? 1 : 0);
    }

    return {
      poblacion: personasVivas.length,
      faunaViva: animalesVivos.length,
      estructurasVivas: estructurasVivas.length,
      birthCounter: m.birthCounter,
      discoveredChunks: m.discoveredChunks,
      settlementCount: m.settlementCount,
      demographyDynamics: { ...m.demographyDynamics, causes: { ...m.demographyDynamics.causes } },
      animalDynamics: { ...m.animalDynamics },
      inventionDynamics: { ...m.inventionDynamics },
      totals: { ...m.totals },
      legacy: m.legacy.slice(0, 32),
      bajasTick: m.retiredLegacy.filter(p => p.diedAt === m.tick),
      nuevos: {
        places: nuevosDe(this.#baseListas.places, m.places) as PlaceView[],
        memories: nuevosDe(this.#baseListas.memories, m.memories) as MemoryView[],
        blueprints: nuevosDe(this.#baseListas.blueprints, m.blueprints) as BlueprintView[],
        whispers: nuevosDe(this.#baseListas.whispers, m.whispers ?? []) as DivineWhisper[],
      },
      stats: {
        population: personasVivas.length, hunger, energy, fatigue, thirst, materials,
        actions, biomes, features, generations, wildlife, structures,
        freshWater, cultivatedTiles, trailTiles, pavedTiles, polyominoStructures, synergyLinks,
        neighbors, identities, protectedCount, lifeStage,
      },
      ...(conCaras ? { diversidad: parcialDiversidad(personasVivas) } : {}),
      ...(c.hilo === 0 ? {
        actoresConInventario: personasVivas
          .filter(p => p.technology.items.length > 0 || p.technology.residue.wood !== 0 || p.technology.residue.stone !== 0 || p.technology.residue.water !== 0)
          .map(p => ({ id: p.id, x: p.x, y: p.y, technology: { items: p.technology.items, residue: p.technology.residue } })),
      } : {}),
    };
  }

  /** F6 (`emigrar`): extrae y transfiere el estado de cinta de un organismo que cruza a `destino >= 0` sin emitir baja. */
  extraerOrganismo(
    uid: number,
    clase: Clase,
    tickActual: number,
    epoca: number,
    genEntregado: number,
    resync: number,
  ): EstadoCintaOrganismo {
    this.reconciliar(tickActual, epoca, genEntregado, resync, false);
    const t = this.#tentativo;
    const mapaC = clase === Clase.Persona ? this.#confirmado.personas : this.#confirmado.animales;
    const mapaT = t ? (clase === Clase.Persona ? t.personas : t.animales) : undefined;
    const confirmado = mapaC.get(uid) ?? null;
    mapaC.delete(uid);
    let tentativo: FirmaPersona | FirmaAnimal | null | undefined;
    if (mapaT && mapaT.has(uid)) {
      tentativo = mapaT.get(uid) ?? null;
      mapaT.delete(uid);
    }
    return {
      epoca: this.#confirmado.epoca,
      resync: this.#resyncVisto,
      esperadoGen: t?.esperadoGen ?? 0,
      confirmado,
      ...(tentativo !== undefined ? { tentativo } : {}),
    };
  }

  /** F6 (`emigrar`): extrae y transfiere el estado de cinta de un chunk cedido (`destino >= 0`) sin emitir bajas. */
  extraerChunkCedido(
    key: string,
    estructurasIds: readonly string[],
    personasUids: readonly number[],
    animalesUids: readonly number[],
    tickActual: number,
    epoca: number,
    genEntregado: number,
    resync: number,
  ): EstadoCintaChunk {
    this.reconciliar(tickActual, epoca, genEntregado, resync, false);
    const t = this.#tentativo;
    const paginaConfirmada = this.#confirmado.paginas.get(key) ?? null;
    this.#confirmado.paginas.delete(key);
    let paginaTentativa: Uint8Array | null | undefined;
    if (t && t.paginas.has(key)) {
      paginaTentativa = t.paginas.get(key) ?? null;
      t.paginas.delete(key);
    }
    const estructuras = estructurasIds.map(id => {
      const confirmado = this.#confirmado.estructuras.get(id) ?? null;
      this.#confirmado.estructuras.delete(id);
      const tieneT = !!t && t.estructuras.has(id);
      const tentativo = tieneT ? (t!.estructuras.get(id) ?? null) : undefined;
      if (tieneT) t!.estructuras.delete(id);
      return tieneT ? { id, confirmado, tentativo } : { id, confirmado };
    });
    const personas = personasUids.map(uid => {
      const confirmado = this.#confirmado.personas.get(uid) ?? null;
      this.#confirmado.personas.delete(uid);
      const tieneT = !!t && t.personas.has(uid);
      const tentativo = tieneT ? (t!.personas.get(uid) ?? null) : undefined;
      if (tieneT) t!.personas.delete(uid);
      return tieneT ? { uid, confirmado, tentativo } : { uid, confirmado };
    });
    const animales = animalesUids.map(uid => {
      const confirmado = this.#confirmado.animales.get(uid) ?? null;
      this.#confirmado.animales.delete(uid);
      const tieneT = !!t && t.animales.has(uid);
      const tentativo = tieneT ? (t!.animales.get(uid) ?? null) : undefined;
      if (tieneT) t!.animales.delete(uid);
      return tieneT ? { uid, confirmado, tentativo } : { uid, confirmado };
    });
    return {
      epoca: this.#confirmado.epoca,
      resync: this.#resyncVisto,
      esperadoGen: t?.esperadoGen ?? 0,
      paginaConfirmada,
      ...(paginaTentativa !== undefined ? { paginaTentativa } : {}),
      estructuras, personas, animales,
    };
  }

  /** F6 (`emigrar`): cuando un chunk se archiva (`destino < 0`), el dueño olvida su firma local de `pagina`
   * (la baja `pagina: null` la decide el coordinador según `mundo.chunks`), pero conserva las firmas de estructuras
   * en `#confirmado.estructuras` hasta que su baja se confirme. */
  alRetirarChunk(key: string, tickActual: number, epoca: number, genEntregado: number, resync: number): void {
    this.reconciliar(tickActual, epoca, genEntregado, resync, false);
    this.#confirmado.paginas.delete(key);
    this.#tentativo?.paginas.delete(key);
  }

  /** F1 (`#adoptar`): reconcilia el estado de cinta de un organismo migrado directamente en `#confirmado` del receptor. */
  adoptarOrganismo(
    uid: number,
    clase: Clase,
    estado: EstadoCintaOrganismo | undefined,
    tickActual: number,
    epoca: number,
    genEntregado: number,
    resync: number,
  ): void {
    this.reconciliar(tickActual, epoca, genEntregado, resync, true);
    if (!estado || estado.epoca !== epoca || estado.resync !== resync) return;
    const confirmo = estado.esperadoGen > 0 && genEntregado >= estado.esperadoGen;
    const elegido = confirmo && estado.tentativo !== undefined ? estado.tentativo : estado.confirmado;
    if (!elegido) return;
    if (clase === Clase.Persona) this.#confirmado.personas.set(uid, elegido as FirmaPersona);
    else this.#confirmado.animales.set(uid, elegido as FirmaAnimal);
  }

  /** F1 (`#adoptar`): reconcilia el estado de cinta de un chunk cedido directamente en `#confirmado` del receptor. */
  adoptarChunk(
    key: string,
    estado: EstadoCintaChunk | undefined,
    tickActual: number,
    epoca: number,
    genEntregado: number,
    resync: number,
  ): void {
    this.reconciliar(tickActual, epoca, genEntregado, resync, true);
    if (!estado || estado.epoca !== epoca || estado.resync !== resync) return;
    const confirmo = estado.esperadoGen > 0 && genEntregado >= estado.esperadoGen;
    const pag = confirmo && estado.paginaTentativa !== undefined ? estado.paginaTentativa : estado.paginaConfirmada;
    if (pag) this.#confirmado.paginas.set(key, pag);
    for (const e of estado.estructuras) {
      const f = confirmo && e.tentativo !== undefined ? e.tentativo : e.confirmado;
      if (f) this.#confirmado.estructuras.set(e.id, f);
    }
    for (const p of estado.personas) {
      const f = confirmo && p.tentativo !== undefined ? p.tentativo : p.confirmado;
      if (f) this.#confirmado.personas.set(p.uid, f);
    }
    for (const a of estado.animales) {
      const f = confirmo && a.tentativo !== undefined ? a.tentativo : a.confirmado;
      if (f) this.#confirmado.animales.set(a.uid, f);
    }
  }
}

export interface EstadisticasCarasCinta {
  readonly statsTick: number;
  readonly giniRecursosPorRegion: number;
  readonly fraccionCeldasConComida: number;
  readonly distanciaMediaAgua: number;
  readonly regionesSinAgua: number;
  readonly diversidad: { conducta: number; oficios: number; total: number };
}

/** Calcula las 5 métricas caras de `worldStatistics` en el coordinador leyendo directamente `TerrenoPercepcion` SAB
 * y reduciendo los parciales de diversidad enviados por cada dueño (cero serialización de teselas). */
export function estadisticasCarasDesdeTerreno(
  terreno: Terreno,
  chunksActivos: readonly ChunkId[],
  diversidadParciales: readonly ParcialDiversidad[],
  tick: number,
): EstadisticasCarasCinta {
  const nChunks = chunksActivos.length;
  const terrCol = terreno.campo('terreno') as Float64Array;
  const foodCol = terreno.campo('comida') as Float64Array;
  const aguaCol = terreno.campo('aguaPotable') as Float64Array;
  const valoresGini = new Array<number>(nChunks);
  let landFood = 0, withFood = 0;
  let regionesConTierra = 0, regionesSecas = 0;

  // 1. Gini, fracción con comida y regiones sin agua (16×16 = 1 chunk).
  const totalCeldas = nChunks * 256;
  const distances = new Int32Array(totalCeldas).fill(-1);
  const queue = new Int32Array(totalCeldas);
  let tail = 0;
  for (let k = 0; k < nChunks; k++) {
    const chunk = chunksActivos[k]!, base = chunk << 8;
    let foodChunk = 0, mask = 0;
    for (let s = 0; s < 256; s++) {
      const cell = base + s;
      const tc = terrCol[cell]!, fo = foodCol[cell]!, dw = aguaCol[cell]!;
      foodChunk += fo;
      if (tc > 1) {
        landFood++;
        if (fo > 0.1) withFood++;
        mask |= TIERRA;
      }
      if (dw > 0) {
        mask |= AGUA;
        const idx = (k << 8) | s;
        distances[idx] = 0;
        queue[tail++] = idx;
      }
    }
    valoresGini[k] = foodChunk;
    if (mask & TIERRA) {
      regionesConTierra++;
      if (!(mask & AGUA)) regionesSecas++;
    }
  }

  // Gini
  valoresGini.sort((a, b) => a - b);
  let sumGini = 0, weighted = 0;
  for (let i = 0; i < nChunks; i++) { const v = valoresGini[i]!; sumGini += v; weighted += (i + 1) * v; }
  const giniRecursosPorRegion = nChunks === 0 || sumGini === 0 ? 0 : 2 * weighted / (nChunks * sumGini) - (nChunks + 1) / nChunks;
  const fraccionCeldasConComida = landFood === 0 ? 0 : withFood / landFood;
  const regionesSinAgua = regionesConTierra === 0 ? 0 : regionesSecas / regionesConTierra;

  // 2. Distancia media a agua potable (mismo BFS 4-vecinos N, O, E, S por chunks que `statistics.ts`).
  let distanciaMediaAgua = -1;
  if (tail > 0) {
    const index = new Map<number, number>();
    const around = new Int32Array(nChunks * 4).fill(-1);
    const key = (px: number, py: number): number => (px + CHUNK_OFFSET) * CHUNK_STRIDE + (py + CHUNK_OFFSET);
    for (let k = 0; k < nChunks; k++) {
      const chunk = chunksActivos[k]!;
      index.set(key(terreno.paginaX[chunk]!, terreno.paginaY[chunk]!), k);
    }
    for (let k = 0; k < nChunks; k++) {
      const chunk = chunksActivos[k]!, px = terreno.paginaX[chunk]!, py = terreno.paginaY[chunk]!;
      around[k * 4] = index.get(key(px, py - 1)) ?? -1;
      around[k * 4 + 1] = index.get(key(px - 1, py)) ?? -1;
      around[k * 4 + 2] = index.get(key(px + 1, py)) ?? -1;
      around[k * 4 + 3] = index.get(key(px, py + 1)) ?? -1;
    }
    for (let head = 0; head < tail; head++) {
      const origin = queue[head]!, next = distances[origin]! + 1, k = origin >> 8, s = origin & 255;
      let neighbor: number, other: number;
      if (s >= 16) neighbor = origin - 16; else { other = around[k * 4]!; neighbor = other >= 0 ? (other << 8) | (s + 240) : -1; }
      if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
      if ((s & 15) !== 0) neighbor = origin - 1; else { other = around[k * 4 + 1]!; neighbor = other >= 0 ? (other << 8) | (s + 15) : -1; }
      if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
      if ((s & 15) !== 15) neighbor = origin + 1; else { other = around[k * 4 + 2]!; neighbor = other >= 0 ? (other << 8) | (s - 15) : -1; }
      if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
      if (s < 240) neighbor = origin + 16; else { other = around[k * 4 + 3]!; neighbor = other >= 0 ? (other << 8) | (s - 240) : -1; }
      if (neighbor >= 0 && distances[neighbor]! < 0) { distances[neighbor] = next; queue[tail++] = neighbor; }
    }
    let land = 0, total = 0;
    for (let k = 0; k < nChunks; k++) {
      const base = chunksActivos[k]! << 8, off = k << 8;
      for (let s = 0; s < 256; s++) {
        const d = distances[off + s]!;
        if (d >= 0 && terrCol[base + s]! > 1) { land++; total += d; }
      }
    }
    distanciaMediaAgua = land === 0 ? 0 : total / land;
  }

  return {
    statsTick: tick,
    giniRecursosPorRegion,
    fraccionCeldasConComida,
    distanciaMediaAgua,
    regionesSinAgua,
    diversidad: reducirDiversidad(diversidadParciales),
  };
}
