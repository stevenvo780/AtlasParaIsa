import type { Action } from '../shared/types.js';
import type { Person, World } from './index.js';

/**
 * T019 (FR-007/SC-003, research.md decisión 3): índice de diversidad de conducta.
 * `vectorConducta` usa SOLO datos que el mundo ya registra por persona (`activity`,
 * `skills`, `technology`, `experiences`): no añade campos a `World` ni a `Person`,
 * no rompe `assertWorld` ni el snapshot. Determinista: sin `Math.random`/`Date.now`/
 * `performance.now`; mismo estado de mundo → mismo vector siempre.
 * El orquestador (T013) cablea `indiceDiversidad` en `worldStatistics`; este módulo
 * no toca `statistics.ts`.
 */

/** Mismo orden que el tipo `Action` en `shared/types.ts`; fija la dimensión del vector. */
const ACTIONS: readonly Action[] = ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft'];
/** Subconjunto de `ACTIONS` ligado a la provisión/consumo de alimento: distingue
 * estrategias alimentarias (cazador/agricultor/recolector/forrajero/compartidor)
 * a partir de los `skills` ya registrados, sin inventar un campo "tipo de alimento". */
const FOOD_ACTIONS: readonly Action[] = ['eat', 'forage', 'hunt', 'farm', 'gather', 'share'];
/** Cubetas fijas para los `placeId` de `experiences` (memorias recientes, tope
 * `MAX_EXPERIENCES` en index.ts): reparte lugares dinámicos en dimensión fija sin
 * depender del catálogo de `world.places`. */
const PLACE_BUCKETS = 6;
/** Dimensión total y fija de `vectorConducta`, documentada para quien la consuma. */
export const CONDUCTA_DIMENSIONS = ACTIONS.length * 2 + 5 + FOOD_ACTIONS.length + PLACE_BUCKETS;

/** FNV-1a de 32 bits: determinista, sin dependencias, solo para repartir `placeId`
 * en `PLACE_BUCKETS` cubetas fijas (no es una decisión criptográfica). */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

/** Acota a [0,1) de forma monótona y determinista sin fijar un techo arbitrario
 * ligado al tamaño del catálogo de recetas (que crece con la simulación). */
const squash = (x: number): number => x / (1 + Math.abs(x));

/** Acción con mayor conteo acumulado en `person.activity` (mismo criterio que el
 * oficio mostrado al cliente); `null` si la persona aún no ha actuado. Empates se
 * resuelven por el orden fijo de `ACTIONS`, así el resultado es determinista. */
function dominantAction(person: Person): Action | null {
  let best: Action | null = null;
  for (const action of ACTIONS) {
    const count = person.activity[action] ?? 0;
    if (count > 0 && count > (best ? person.activity[best] ?? 0 : 0)) best = action;
  }
  return best;
}

/**
 * Vector normalizado L2 de conducta de una persona; dimensión fija `CONDUCTA_DIMENSIONS`.
 * Grupos, en este orden:
 * 1. Acciones recientes (`ACTIONS.length` dims): fracción de `activity` sobre el total.
 * 2. Oficio dominante (`ACTIONS.length` dims): un-hot sobre `dominantAction`.
 * 3. Competencias y objetos de `person.technology` (5 dims): recetas conocidas, tasa de
 *    éxito y beneficio medios de `competence`, número de objetos y masa total de `items`.
 * 4. Tipos de alimento (`FOOD_ACTIONS.length` dims): `skills` en las acciones de comida.
 * 5. Lugares en memorias recientes (`PLACE_BUCKETS` dims): `placeId` de `experiences`
 *    repartidos por hash determinista.
 * `world` se recibe para mantener la firma pactada con quien integre esta función
 * (T013); hoy toda la entrada sale de `person`, que ya registra lo necesario.
 */
export function vectorConducta(person: Person, _world: World): number[] {
  const vector: number[] = [];
  const totalActivity = ACTIONS.reduce((sum, action) => sum + (person.activity[action] ?? 0), 0);
  for (const action of ACTIONS) vector.push(totalActivity > 0 ? (person.activity[action] ?? 0) / totalActivity : 0);
  const dominant = dominantAction(person);
  for (const action of ACTIONS) vector.push(action === dominant ? 1 : 0);
  const competence = Object.values(person.technology.competence);
  const meanSuccessRate = competence.length ? competence.reduce((sum, c) => sum + c.successes / Math.max(1, c.attempts), 0) / competence.length : 0;
  const meanBenefit = competence.length ? competence.reduce((sum, c) => sum + c.benefit, 0) / competence.length : 0;
  const itemsMass = person.technology.items.reduce((sum, item) => sum + item.mass, 0);
  vector.push(squash(person.technology.knownRecipes.length), meanSuccessRate, squash(meanBenefit), squash(person.technology.items.length), squash(itemsMass));
  for (const action of FOOD_ACTIONS) vector.push(person.skills[action] ?? 0);
  const buckets = new Array(PLACE_BUCKETS).fill(0) as number[];
  const withPlace = person.experiences.filter(experience => experience.placeId !== '');
  for (const experience of withPlace) buckets[hashString(experience.placeId) % PLACE_BUCKETS] += 1;
  for (const count of buckets) vector.push(withPlace.length > 0 ? count / withPlace.length : 0);
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? vector.map(x => x / norm) : vector;
}

/** Distancia coseno en [0,1]: `vectorConducta` solo produce componentes no negativas,
 * así que la similitud coseno ya cae en [0,1] (Cauchy-Schwarz) sin necesitar recorte
 * salvo por el redondeo de punto flotante. Dos vectores en blanco (nadie ha actuado
 * ni tiene memorias ni tecnología todavía) se tratan como clones (0), no como
 * indefinidos; un vector en blanco frente a uno con contenido se trata como máxima
 * distancia (1), no como 0/0. */
function cosineDistance(a: readonly number[], b: readonly number[]): number {
  const normA = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
  const normB = Math.sqrt(b.reduce((sum, x) => sum + x * x, 0));
  if (normA === 0 && normB === 0) return 0;
  if (normA === 0 || normB === 0) return 1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b[i] ?? 0);
  return Math.max(0, Math.min(1, 1 - dot / (normA * normB)));
}

/**
 * FR-007/SC-003: `conducta` = distancia coseno media de `vectorConducta` entre cada
 * par de habitantes vivos (`world.people`, que ya excluye a los difuntos: T019 no
 * filtra nada); `oficios` = entropía normalizada (0..1) de `dominantAction` sobre la
 * población; `total` = media de ambas. O(n²) con n acotado por `poblacion.maxima`
 * (≤ 8.128 pares con 128 habitantes: barato). 0 ó 1 habitante → {0,0,0}, sin excepción.
 */
export function indiceDiversidad(world: World): { conducta: number; oficios: number; total: number } {
  const people = world.people;
  if (people.length < 2) return { conducta: 0, oficios: 0, total: 0 };
  const vectors = people.map(person => vectorConducta(person, world));
  let sum = 0, pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) { sum += cosineDistance(vectors[i]!, vectors[j]!); pairs++; }
  }
  const conducta = pairs > 0 ? sum / pairs : 0;
  const counts = new Map<string, number>();
  for (const person of people) {
    const label = dominantAction(person) ?? '';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let entropy = 0;
  if (counts.size > 1) {
    for (const count of counts.values()) { const share = count / people.length; entropy -= share * Math.log(share); }
    entropy /= Math.log(counts.size);
  }
  return { conducta, oficios: entropy, total: (conducta + entropy) / 2 };
}
