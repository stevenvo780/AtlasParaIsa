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
/** Número de categorías POSIBLES de oficio dominante (las 18 de `Action`), no las
 * observadas en la población. Base fija del denominador de la entropía de `oficios`
 * en `indiceDiversidad` (ronda de arreglo: normalizar por observadas infla la cifra
 * cuando colapsa la RIQUEZA de oficios — un mundo con solo 2 de 18 oficios puntuaba
 * entropía máxima). Exportado para que los tests puedan fijar el valor esperado. */
export const OFICIOS_CATEGORIAS = ACTIONS.length;

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

/** Escala `group` a norma L2 1 y lo añade a `vector` (ronda de arreglo: sin esto,
 * el peso de cada grupo en la distancia coseno final depende de escalas accidentales
 * —p. ej. tecnología con 5 dims casi saturadas pesaba 54,5 % y "tipos de alimento"
 * 0,4 %—, no del diseño). Un grupo en blanco (norma 0, p. ej. tecnología de alguien
 * que no ha fabricado nada) se añade como ceros: no aporta ni resta peso. */
function pushNormalized(vector: number[], group: readonly number[]): void {
  const norm = Math.sqrt(group.reduce((sum, x) => sum + x * x, 0));
  for (const x of group) vector.push(norm > 0 ? x / norm : 0);
}

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
 * Cada grupo se normaliza a norma L2 1 ANTES de concatenar (`pushNormalized`, ronda
 * de arreglo), así los 5 grupos pesan lo mismo en la distancia coseno final con
 * independencia de sus escalas de origen (fracciones que suman 1, one-hot, escalares
 * `squash`, etc.); un grupo en blanco pesa 0, no amortigua a los demás. El vector
 * completo vuelve a normalizarse L2 al final (norma 1 siempre que algún grupo sea
 * no nulo).
 * `world` se recibe para mantener la firma pactada con quien integre esta función
 * (T013); hoy toda la entrada sale de `person`, que ya registra lo necesario.
 */
export function vectorConducta(person: Person, _world: World): number[] {
  const vector: number[] = [];
  const totalActivity = ACTIONS.reduce((sum, action) => sum + (person.activity[action] ?? 0), 0);
  pushNormalized(vector, ACTIONS.map(action => totalActivity > 0 ? (person.activity[action] ?? 0) / totalActivity : 0));
  const dominant = dominantAction(person);
  pushNormalized(vector, ACTIONS.map(action => action === dominant ? 1 : 0));
  const competence = Object.values(person.technology.competence);
  const meanSuccessRate = competence.length ? competence.reduce((sum, c) => sum + c.successes / Math.max(1, c.attempts), 0) / competence.length : 0;
  const meanBenefit = competence.length ? competence.reduce((sum, c) => sum + c.benefit, 0) / competence.length : 0;
  const itemsMass = person.technology.items.reduce((sum, item) => sum + item.mass, 0);
  pushNormalized(vector, [squash(person.technology.knownRecipes.length), meanSuccessRate, squash(meanBenefit), squash(person.technology.items.length), squash(itemsMass)]);
  pushNormalized(vector, FOOD_ACTIONS.map(action => person.skills[action] ?? 0));
  const buckets = new Array(PLACE_BUCKETS).fill(0) as number[];
  const withPlace = person.experiences.filter(experience => experience.placeId !== '');
  for (const experience of withPlace) buckets[hashString(experience.placeId) % PLACE_BUCKETS] += 1;
  pushNormalized(vector, buckets.map(count => withPlace.length > 0 ? count / withPlace.length : 0));
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? vector.map(x => x / norm) : vector;
}

/**
 * Media de la distancia coseno entre todos los pares de vectores no negativos en O(P · d):
 * para vectores unitarios u_i (‖u_i‖ = 1), ‖u_i − u_j‖² = 2·(1 − u_i·u_j), de modo que
 * ∑_{i<j} (1 − u_i·u_j) = ½·(M·∑‖u_i‖² − ‖∑ u_i‖²). Los pares cero–cero aportan 0 y los
 * pares cero–no-cero aportan 1 (Z·M). Elimina el pico cuadrático O(P²) de `worldStatistics`
 * detectado en T144 (712 ms → < 3 ms en P = 2 000) conservando la definición exacta.
 */
function meanCosineDistance(vectors: readonly (readonly number[])[]): number {
  const n = vectors.length;
  if (n < 2) return 0;
  const dim = vectors[0]!.length;
  const sumVec = new Float64Array(dim);
  let nonZero = 0, zero = 0, sumNormSq = 0;
  for (let i = 0; i < n; i++) {
    const v = vectors[i]!;
    let normSq = 0;
    for (let k = 0; k < dim; k++) { const x = v[k]!; normSq += x * x; }
    if (normSq === 0) { zero++; continue; }
    nonZero++;
    const invNorm = 1 / Math.sqrt(normSq);
    let unitNormSq = 0;
    for (let k = 0; k < dim; k++) {
      const u = v[k]! * invNorm;
      sumVec[k]! += u;
      unitNormSq += u * u;
    }
    sumNormSq += unitNormSq;
  }
  let sumSq = 0;
  for (let k = 0; k < dim; k++) { const s = sumVec[k]!; sumSq += s * s; }
  const pairs = (n * (n - 1)) / 2;
  const nonZeroDist = nonZero >= 2 ? Math.max(0, (nonZero * sumNormSq - sumSq) / 2) : 0;
  return Math.max(0, Math.min(1, (zero * nonZero + nonZeroDist) / pairs));
}

/**
 * FR-007/SC-003: `conducta` = distancia coseno media de `vectorConducta` entre cada
 * par de habitantes vivos (`world.people`, que ya excluye a los difuntos: T019 no
 * filtra nada); `oficios` = entropía de Shannon de `dominantAction` sobre la
 * población, normalizada por `Math.log(OFICIOS_CATEGORIAS)` — las categorías
 * POSIBLES (las 18 de `Action`), no las observadas (ronda de arreglo: normalizar
 * por observadas dejaba que un mundo con solo 2 oficios de 18 puntuara entropía
 * máxima, incapaz de detectar el colapso de riqueza de oficios que SC-003 debe
 * poder refutar); recortada a 1 por si el rótulo "sin oficio aún" (`dominantAction`
 * `null`) añadiera una categoría más de las 18 contempladas. `total` = media de
 * ambas. Calculada en O(P · d) mediante identidad exacta de norma L2 (ver
 * `meanCosineDistance`). 0 ó 1 habitante → {0,0,0}, sin excepción.
 */
export function indiceDiversidad(world: World): { conducta: number; oficios: number; total: number } {
  const people = world.people;
  if (people.length < 2) return { conducta: 0, oficios: 0, total: 0 };
  const vectors = people.map(person => vectorConducta(person, world));
  const conducta = meanCosineDistance(vectors);
  const counts = new Map<string, number>();
  for (const person of people) {
    const label = dominantAction(person) ?? '';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let entropy = 0;
  if (counts.size > 1) {
    for (const count of counts.values()) { const share = count / people.length; entropy -= share * Math.log(share); }
    entropy = Math.min(1, entropy / Math.log(OFICIOS_CATEGORIAS));
  }
  return { conducta, oficios: entropy, total: (conducta + entropy) / 2 };
}
