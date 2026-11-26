/**
 * Puente entre las leyes y el motor (oleada V23). No es de ningún carril: cambiarlo es pedirlo al integrador.
 *
 * Qué resuelve: todas las leyes nuevas se escriben a la vez, contra un motor de dueños que también se está
 * escribiendo. Aquí queda fijado cómo ve el mundo una ley (`CtxLey`), por dónde la llama el motor (`Ley`) y cómo se
 * llega al contexto desde una función heredada que solo recibe `World` (`ctxDe`).
 *
 * DISCIPLINA DE DUEÑO (vale para todo código nuevo, con un dueño o con muchos):
 *  - `c.mundo` es la parte del mundo que este dueño tiene en su heap. Con un solo dueño es el mundo entero; con varios,
 *    `c.mundo.people`, `.animals`, `.tiles` y `.structures` son SOLO los de sus chunks. Lo propio se lee y se escribe ahí,
 *    como siempre (una tesela propia se escribe y luego se llama a `marcarTesela`).
 *  - A los demás organismos se les LEE por `c.frente` (un tick atrás) y a las celdas ajenas por `c.terreno`; nunca se
 *    busca a un vecino en `c.mundo.people`. Para recorrer vecinos, `motor/vecinos.ts`.
 *  - A los demás se les ESCRIBE por `c.buzon.enviar`: otro organismo (aunque esté en tu mismo chunk), una celda de otro
 *    chunk o un lote ajeno. El aplicador del dueño destino (`motor/aplicar.ts`) lo resuelve contra su estado actual.
 *  - Identidad: por `uid` (y `Ref` para el frente); nunca por ranura ni por posición en un array.
 *  - Azar: `c.azar()`; ids: `c.id(...)`; sucesos: `c.suceso(...)`. Nada de `Math.random` ni del reloj de pared.
 */
import type { Interruptor } from '../../shared/interruptores.js';
import type { AnimalView, CommunityView, PersonView, PlaceView, Tile, WorldView } from '../../shared/types.js';
import type { Animal } from '../animals.js';
import type { Violacion } from '../invariantes.js';
import type { Person, World } from '../mundo/tipos.js';
import type { WorldParams } from '../params.js';
import type {
  ChunkId, CtxDueno, CtxMateria, Intento, LotePercepcion, Percepcion, Plan, Ref, TipoColumna, TipoIntento,
} from './contratos.js';
import type { PasoMateriaGpu } from '../gpu/materia-gpu.js';

/** El contexto de una ley: el del dueño más su parte del mundo y los parámetros. Lo arma m4a (`motor/contexto.ts`):
 * con un dueño, sobre el `World` de siempre; con varios, uno por worker. */
export interface CtxLey extends CtxDueno {
  /** Parte del mundo en el heap de este dueño (ver DISCIPLINA DE DUEÑO). `mundo.tick === tick`. */
  readonly mundo: World;
  readonly params: Readonly<WorldParams>;
  /** Directorio de identidades: el `id` de texto con que las leyes heredadas nombran a alguien (vínculos, parentesco,
   * miembros de una comunidad) a partir de su uid del frente, y al revés. Es una réplica global que el motor pone al día
   * en F0 con las altas del tick anterior: `undefined` y 0 si aún no se conoce (nacido en otro dueño en este mismo tick)
   * o si ya se olvidó (muerto hace más de un día). Vale para personas y fauna. */
  idDe(uid: number): string | undefined;
  uidDe(id: string): number;
  /** El chunk se va al archivo al cerrar este tick. Una cesión a otro dueño sigue residente. */
  retiraChunk(chunk: ChunkId): boolean;
  /** Percepción en lote del dueño (CPU en piscina o GPU) para las leyes que no son personas (carril f). Opcional: sin
   * ella la ley percibe en CPU por su cuenta. */
  percibir?(lote: LotePercepcion, planes: readonly Plan[]): Percepcion;
}
/** El de las leyes que exigen `v23.materia`: además, la arena de lotes y la química. */
export type CtxLeyMateria = CtxLey & CtxMateria & {
  /** Cliente del paso material en la tarjeta de este dueño (carril g, `v23.materiaGpu`). Opcional hasta que m4a lo
   * inicialice en `motor/contexto.ts` con el paso de `pasosMateria()` del mismo hilo; `null` o ausente = paso en CPU. */
  readonly pasoMateriaGpu?: PasoMateriaGpu | null;
};

/** F0, solo en el coordinador (que es además el dueño 0): lo global. */
export interface CtxF0 extends CtxLey {
  /** Entrega y consume las peticiones `pedirGlobal(tipo, …)` que los dueños mandaron en el tick anterior, sin orden. */
  peticiones(tipo: 'lugar' | 'comunidad'): readonly Uint8Array[];
  /** Sustituye la réplica global; todos los dueños la ven en `globales` desde F1 de este tick. */
  publicarComunidades(comunidades: readonly CommunityView[]): void;
  publicarLugares(lugares: readonly PlaceView[]): void;
}

/** Pasos del tick heredado (`mundo/paso.ts` → `advanceTick`). Una ley encendida que nombra uno en `sustituye` lo
 * reemplaza: el motor deja de llamarlo y llama a los ganchos de la ley en sus fases. */
export type PasoHeredado = 'ecologia' | 'kernel' | 'fauna' | 'estructuras' | 'personas' | 'susurros' | 'encuentros'
  | 'convivir' | 'demografia' | 'comunidades' | 'reproduccion' | 'memoriaTecnica';

/** Qué hizo un aplicador con un intento: lo resolvió, no es suyo (lo prueba la ley siguiente y al final el aplicador
 * genérico de m5) o lo rechaza (m5 devuelve la garantía al emisor con `Devuelto`). */
export type Aplicado = 'hecho' | 'paso' | 'rechazo';

/**
 * Una ley de la V23 vista por el motor. Cada carril de ley exporta la suya desde su fichero (los esqueletos ya están en
 * la base y `motor/leyes.ts` los reúne en orden); el motor llama a los ganchos de las leyes encendidas, en el orden de
 * `LEYES`, dentro de cada fase del tick (ARQ-motor §3.1). Todos son opcionales y todos corren en el hilo dueño salvo F0.
 * Con un dueño y con muchos se llama a los mismos ganchos: una ley no sabe cuántos hilos hay.
 */
export interface Ley {
  readonly id: string;
  readonly interruptor: Interruptor;
  /** Pasos heredados que esta ley reemplaza mientras está encendida. */
  readonly sustituye?: readonly PasoHeredado[];
  /** Columnas que añade al frente público (se registran antes de arrancar, con la ley encendida). */
  readonly columnas?: readonly (readonly [nombre: string, tipo: TipoColumna, ancho: number])[];
  /** Campos del terreno que la ley añade (se registran antes de arrancar, con la ley encendida). */
  readonly camposTerreno?: readonly (readonly [nombre: string, tipo: 'f64' | 'f32' | 'i32' | 'u8', relleno: number])[];
  /** Una vez por dueño al arrancar una época (mundo creado, cargado o ley recién encendida), antes de su primer tick:
   * crea lo que falte (lotes de sus teselas, cuerpos de quien no los tenga). Idempotente: no repite lo ya hecho. */
  iniciar?(c: CtxLey): void;
  /** Un chunk pasa a ser residente de este dueño (F1) o deja de serlo (F6): materializar o guardar lo suyo. */
  alActivar?(c: CtxLey, chunk: ChunkId, cedido?: boolean): void;
  alRetirar?(c: CtxLey, chunk: ChunkId): void;
  /** Un organismo llega a este dueño por migración (F1): adoptar sus lotes ligados (`ArenaMateria.adoptar`). */
  alAdoptar?(c: CtxLey, organismo: Person | Animal): void;
  /** F0, serie y corto: solo el coordinador. */
  F0?(c: CtxF0): void;
  /** F1: tras adoptar migrantes y vaciar la cola B (respuestas del tick anterior). */
  F1?(c: CtxLey): void;
  /** Fase eco: el entorno de los chunks propios (materia del mundo), antes de que nadie perciba. */
  eco?(c: CtxLey): void;
  /** F2: lo que hay que preparar antes de elegir; solo lectura de lo ajeno. */
  F2?(c: CtxLey): void;
  /** F3: elegir. F4: actuar (cuerpo, mover, trabajar): escribe lo propio y manda intentos. */
  F3?(c: CtxLey): void;
  F4?(c: CtxLey): void;
  /** F5: tras vaciar la cola A y aplicar los intentos del tick: nacimientos, muertes y lo que cruza organismos. */
  F5?(c: CtxLey): void;
  /** F6: publicar las columnas propias de sus filas en el frente t+1 (`c.escritura`) y cerrar el tick. */
  F6?(c: CtxLey): void;
  /** Aplicadores de intentos en el dueño destino (F5 para la cola A, F1 para la B). Devuelven `Aplicado`. */
  readonly aplicar?: Partial<Record<keyof typeof TipoIntento, (c: CtxLey, i: Intento) => Aplicado>>;
  /** Lo que la ley añade a las vistas que viajan al cliente y a la cinta (los campos nuevos de `shared/types.ts` y
   * `shared/vistas-v23.ts`). La proyección (m6) llama a cada gancho con la vista ya rellena por lo heredado. */
  readonly proyectar?: {
    tesela?(c: CtxLey, tesela: Tile, vista: Tile): void;
    persona?(c: CtxLey, persona: Person, vista: PersonView): void;
    animal?(c: CtxLey, animal: Animal, vista: AnimalView): void;
    mundo?(c: CtxLey, vista: WorldView): void;
  };
  /** Invariantes propios de la ley sobre lo que este dueño tiene (los corre el laboratorio y el modo verificar). */
  comprobar?(c: CtxLey): Violacion[];
}

const contextos = new WeakMap<object, CtxLey>();

/** m4a: liga el contexto del dueño a su `mundo` (una vez por época; el contexto vive lo que el mundo). */
export function enlazarCtx(mundo: World, c: CtxLey): void { contextos.set(mundo, c); }

/** El contexto del dueño de `mundo`, o `undefined` si ese mundo aún no pasó por el motor (un mundo recién creado en una
 * prueba unitaria): quien lo use fuera del tick decide qué hacer sin él. */
export function ctxSi(mundo: World): CtxLey | undefined { return contextos.get(mundo); }

/** El contexto del dueño de `mundo` desde una función heredada que solo recibe `World`. Lanza si no lo hay. */
export function ctxDe(mundo: World): CtxLey {
  const c = contextos.get(mundo);
  if (!c) throw new Error('Este mundo no tiene contexto de dueño: el motor lo enlaza al arrancar (motor/acceso.ts).');
  return c;
}

/** Como `ctxDe`, para las leyes que exigen `v23.materia`. Lanza si la materia no está en este mundo. */
export function ctxMateriaDe(mundo: World): CtxLeyMateria {
  const c = ctxDe(mundo) as Partial<CtxMateria> & CtxLey;
  if (!c.materia || !c.quimica) throw new Error('Este mundo no tiene materia: exige v23.materia.');
  return c as CtxLeyMateria;
}

/** `Ref` de una persona o animal propio en el frente, por su uid. REF_NULA si no vive. */
export const refDeOrganismo = (c: CtxLey, o: { uid?: number }): Ref => o.uid === undefined ? -1 : c.ref(o.uid);

/** Para los esqueletos de las interfaces puente: lo sustituye el carril dueño del fichero. */
export function sinImplementar(que: string): never { throw new Error(`sin implementar: ${que}`); }
