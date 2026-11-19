/**
 * Acumuladores agregados fuera del worker (T153, FR-023, vía a).
 *
 * El worker no suma. Emite un `Intent` por contribución y el coordinador los aplica en orden
 * canónico `(actorSlot, secuenciaLocal)` —nunca por región ni por orden de llegada— con la misma
 * saturación que `count`: `Math.min(1e12, actual + cantidad)` en cada suma. `secuenciaLocal` es
 * único por `actorSlot` dentro del lote del paso (el orden de programa de ese actor).
 *
 * El reloj no vive aquí (`performance.now` está prohibido en `src/world`). Quien mida la fracción
 * serial (T151/FR-021) inyecta el reloj; sin reloj, `ms` es 0 y `eventos` sigue contando.
 */
import type { DemographicDeathCause } from '../../shared/demography.js';
import type { AnimalDynamics, InventionDynamics } from '../../shared/life.js';
import type { TechnologyState } from '../../shared/technology.js';
import type { World } from '../index.js';
import { TOTAL_KEYS, saturateTotal } from '../statistics.js';

export const AGGREGATE_BOOKS = ['totals', 'inventionDynamics', 'ledger', 'demographyDynamics', 'animalDynamics'] as const;
export type AggregateBook = typeof AGGREGATE_BOOKS[number];

const LEDGER_SCALARS = ['work', 'energy', 'fuelMass', 'attempts', 'failures', 'crafted', 'toolUses', 'shared', 'recycled'] as const;
const MATERIALS = ['wood', 'stone', 'water'] as const;
const CAUSES = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;
const DEMOGRAPHY_SCALARS = ['deaths', 'foodLost', 'woodLost', 'stoneLost'] as const;
const INVENTION_KEYS = ['attempts', 'accepted', 'repairs', 'waterCollected', 'foodStored', 'foodTaken'] as const;
const ANIMAL_KEYS = ['births', 'deaths', 'predations', 'humanHunts', 'waterConsumed', 'plantConsumed'] as const;

const compositionKeys = (parent: 'imported' | 'estateLoss'): string[] => MATERIALS.map(material => `${parent}.${material}`);
const causeKeys = CAUSES.map(cause => `causes.${cause}`);

/** Claves declaradas. Cualquier otra contribución se rechaza: no hay acumulador anónimo. */
export const AGGREGATE_KEYS: { readonly [B in AggregateBook]: readonly string[] } = {
  totals: TOTAL_KEYS,
  inventionDynamics: INVENTION_KEYS,
  ledger: [...LEDGER_SCALARS, ...compositionKeys('imported'), ...compositionKeys('estateLoss')],
  demographyDynamics: [...DEMOGRAPHY_SCALARS, ...causeKeys],
  animalDynamics: ANIMAL_KEYS,
};

/**
 * Contadores que hoy solo crecen de uno en uno. La reducción no los trunca: aplica `cantidad`
 * tal como llega. El resto de cada libro es magnitud (comida, masa, agua, energía).
 */
export const INTEGER_AGGREGATE_KEYS: { readonly [B in AggregateBook]: readonly string[] } = {
  totals: ['hunts', 'cooperation', 'teaching', 'trade', 'conflicts', 'births', 'cultivations', 'constructionHelp'],
  inventionDynamics: ['attempts', 'accepted', 'repairs'],
  ledger: ['work', 'attempts', 'failures', 'crafted', 'toolUses', 'shared', 'recycled'],
  demographyDynamics: ['deaths', ...causeKeys],
  animalDynamics: ['births', 'deaths', 'predations', 'humanHunts'],
};

const KEYS: { readonly [B in AggregateBook]: ReadonlySet<string> } = {
  totals: new Set(AGGREGATE_KEYS.totals),
  inventionDynamics: new Set(AGGREGATE_KEYS.inventionDynamics),
  ledger: new Set(AGGREGATE_KEYS.ledger),
  demographyDynamics: new Set(AGGREGATE_KEYS.demographyDynamics),
  animalDynamics: new Set(AGGREGATE_KEYS.animalDynamics),
};

/** Contribución de acumulador. Es el `Intent` de la spec reducido a lo que el coordinador suma. */
export interface Intent {
  fase: 'agregado';
  tipoRecurso: AggregateBook;
  recursoId: string;
  actorSlot: number;
  secuenciaLocal: number;
  cantidad: number;
}

export interface AggregateBooks {
  totals: Record<string, number>;
  inventionDynamics: InventionDynamics;
  ledger: TechnologyState['ledger'];
  demographyDynamics: {
    deaths: number;
    causes: Record<DemographicDeathCause, number>;
    foodLost: number;
    woodLost: number;
    stoneLost: number;
  };
  animalDynamics: AnimalDynamics;
}

/** Coste de la reducción en el coordinador. `ms / presupuestoDelPaso` entra en la fracción serial. */
export interface ReductionCost {
  ms: number;
  eventos: number;
}

const NO_CLOCK = (): number => 0;

export function emptyAggregateBooks(): AggregateBooks {
  const zeros = (): { wood: number; stone: number; water: number } => ({ wood: 0, stone: 0, water: 0 });
  return {
    totals: Object.fromEntries(TOTAL_KEYS.map(key => [key, 0])),
    inventionDynamics: { attempts: 0, accepted: 0, repairs: 0, waterCollected: 0, foodStored: 0, foodTaken: 0 },
    ledger: {
      imported: zeros(), estateLoss: zeros(), work: 0, energy: 0, fuelMass: 0,
      attempts: 0, failures: 0, crafted: 0, toolUses: 0, shared: 0, recycled: 0,
    },
    demographyDynamics: {
      deaths: 0, causes: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 },
      foodLost: 0, woodLost: 0, stoneLost: 0,
    },
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 },
  };
}

/** Alias de los libros vivos. No copia: aplicar aquí escribe el mundo. */
export function booksFromWorld(world: World): AggregateBooks {
  return {
    totals: world.totals,
    inventionDynamics: world.inventionDynamics,
    ledger: world.technology.ledger,
    demographyDynamics: world.demographyDynamics,
    animalDynamics: world.animalDynamics,
  };
}

/** Parte del presupuesto de un paso que se llevó esta reducción. T151 la suma a la fracción serial. */
export function serialShare(cost: ReductionCost, stepBudgetMs: number): number {
  if (!(stepBudgetMs > 0) || !Number.isFinite(stepBudgetMs) || !Number.isFinite(cost.ms) || cost.ms < 0) {
    throw new RangeError('La fracción serial necesita un presupuesto positivo y un coste finito.');
  }
  return cost.ms / stepBudgetMs;
}

function isBook(value: string): value is AggregateBook {
  return (AGGREGATE_BOOKS as readonly string[]).includes(value);
}

function isLedgerScalar(key: string): key is typeof LEDGER_SCALARS[number] {
  return (LEDGER_SCALARS as readonly string[]).includes(key);
}

function isMaterial(key: string): key is typeof MATERIALS[number] {
  return (MATERIALS as readonly string[]).includes(key);
}

function isCause(key: string): key is DemographicDeathCause {
  return (CAUSES as readonly string[]).includes(key);
}

function isDemoScalar(key: string): key is typeof DEMOGRAPHY_SCALARS[number] {
  return (DEMOGRAPHY_SCALARS as readonly string[]).includes(key);
}

function isInventionKey(key: string): key is typeof INVENTION_KEYS[number] {
  return (INVENTION_KEYS as readonly string[]).includes(key);
}

function isAnimalKey(key: string): key is typeof ANIMAL_KEYS[number] {
  return (ANIMAL_KEYS as readonly string[]).includes(key);
}

function applyIntent(books: AggregateBooks, intent: Intent): void {
  const { tipoRecurso: book, recursoId: key, cantidad } = intent;
  if (book === 'totals') { books.totals[key] = saturateTotal(books.totals[key], cantidad); return; }
  if (book === 'inventionDynamics' && isInventionKey(key)) {
    books.inventionDynamics[key] = saturateTotal(books.inventionDynamics[key], cantidad); return;
  }
  if (book === 'animalDynamics' && isAnimalKey(key)) {
    books.animalDynamics[key] = saturateTotal(books.animalDynamics[key], cantidad); return;
  }
  if (book === 'demographyDynamics') {
    if (key.startsWith('causes.')) {
      const cause = key.slice('causes.'.length);
      if (isCause(cause)) { books.demographyDynamics.causes[cause] = saturateTotal(books.demographyDynamics.causes[cause], cantidad); return; }
    }
    if (isDemoScalar(key)) { books.demographyDynamics[key] = saturateTotal(books.demographyDynamics[key], cantidad); return; }
  }
  if (book === 'ledger') {
    if (isLedgerScalar(key)) { books.ledger[key] = saturateTotal(books.ledger[key], cantidad); return; }
    const dot = key.indexOf('.');
    const parent = key.slice(0, dot);
    const material = key.slice(dot + 1);
    if ((parent === 'imported' || parent === 'estateLoss') && isMaterial(material)) {
      books.ledger[parent][material] = saturateTotal(books.ledger[parent][material], cantidad); return;
    }
  }
  throw new TypeError(`Clave de acumulador no resoluble: ${book}.${key}`);
}

function ordinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} tiene que ser un entero ≥ 0.`);
}

function validate(intent: Intent): void {
  if (!intent || intent.fase !== 'agregado') throw new TypeError('La contribución agregada lleva fase "agregado".');
  if (!isBook(intent.tipoRecurso) || !KEYS[intent.tipoRecurso].has(intent.recursoId)) {
    throw new TypeError(`Acumulador no declarado: ${String(intent.tipoRecurso)}.${String(intent.recursoId)}`);
  }
  ordinal(intent.actorSlot, 'actorSlot');
  ordinal(intent.secuenciaLocal, 'secuenciaLocal');
  if (typeof intent.cantidad !== 'number' || !Number.isFinite(intent.cantidad)) {
    throw new TypeError('cantidad tiene que ser un número finito.');
  }
}

function compareIntents(left: Intent, right: Intent): number {
  if (left.actorSlot !== right.actorSlot) return left.actorSlot < right.actorSlot ? -1 : 1;
  if (left.secuenciaLocal !== right.secuenciaLocal) return left.secuenciaLocal < right.secuenciaLocal ? -1 : 1;
  return 0;
}

/**
 * Aplica el lote en orden canónico. No muta el array de entrada: el orden de llegada se descarta.
 * Dos contribuciones con el mismo `(actorSlot, secuenciaLocal)` se rechazan; su desempate sería
 * el orden de llegada.
 */
export function reduceAggregates(books: AggregateBooks, intents: readonly Intent[], now: () => number = NO_CLOCK): ReductionCost {
  const start = now();
  const ordered = intents.slice();
  for (const intent of ordered) validate(intent);
  ordered.sort(compareIntents);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!, current = ordered[index]!;
    if (previous.actorSlot === current.actorSlot && previous.secuenciaLocal === current.secuenciaLocal) {
      throw new Error(`Contribución duplicada: actorSlot ${current.actorSlot}, secuenciaLocal ${current.secuenciaLocal}.`);
    }
  }
  for (const intent of ordered) applyIntent(books, intent);
  return { ms: now() - start, eventos: ordered.length };
}
