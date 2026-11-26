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

/** Escala `out[from, to)` a norma L2 1 in situ (ronda de arreglo: sin esto,
 * el peso de cada grupo en la distancia coseno final depende de escalas accidentales
 * —p. ej. tecnología con 5 dims casi saturadas pesaba 54,5 % y "tipos de alimento"
 * 0,4 %—, no del diseño). Un grupo en blanco (norma 0, p. ej. tecnología de alguien
 * que no ha fabricado nada) queda en ceros: no aporta ni resta peso. La norma se suma
 * en el orden del grupo, de modo que el resultado es idéntico bit a bit a la versión con arreglos temporales. */
function normalizeGroup(out: Float64Array, from: number, to: number): void {
  let sum = 0;
  for (let i = from; i < to; i++) { const x = out[i]!; sum += x * x; }
  const norm = Math.sqrt(sum);
  for (let i = from; i < to; i++) out[i] = norm > 0 ? out[i]! / norm : 0;
}

/** Conteos por acción de la persona en curso (reutilizados: el cálculo es síncrono y no reentrante). */
const scratchActivity = new Float64Array(ACTIONS.length);
const scratchPlaces = new Float64Array(PLACE_BUCKETS);

/** Índice de la acción con mayor conteo acumulado en `scratchActivity` (mismo criterio que el
 * oficio mostrado al cliente); `-1` si la persona aún no ha actuado. Empates se resuelven por el
 * orden fijo de `ACTIONS`, así el resultado es determinista. */
function dominantIndex(): number {
  let best = -1;
  for (let i = 0; i < ACTIONS.length; i++) {
    const count = scratchActivity[i]!;
    if (count > 0 && count > (best >= 0 ? scratchActivity[best]! : 0)) best = i;
  }
  return best;
}

/** Carga `scratchActivity` con `person.activity` (ausente = 0) y devuelve su suma en orden de `ACTIONS`. */
function loadActivity(person: Person): number {
  let total = 0;
  for (let i = 0; i < ACTIONS.length; i++) { const count = person.activity[ACTIONS[i]!] ?? 0; scratchActivity[i] = count; total += count; }
  return total;
}

/**
 * Vector normalizado L2 de conducta de una persona; dimensión fija `CONDUCTA_DIMENSIONS`.
 * Grupos, en este orden:
 * 1. Acciones recientes (`ACTIONS.length` dims): fracción de `activity` sobre el total.
 * 2. Oficio dominante (`ACTIONS.length` dims): un-hot sobre el oficio dominante (`dominantIndex`).
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
  const out = new Float64Array(CONDUCTA_DIMENSIONS);
  fillConducta(person, out, 0);
  return Array.from(out);
}

/**
 * Escribe el vector de conducta de `person` en `out[offset, offset + CONDUCTA_DIMENSIONS)` (que debe
 * estar a cero) sin arreglos temporales y con el mismo orden de sumas FP64 que la definición original.
 * Devuelve el oficio dominante (índice en `ACTIONS`, o -1) para que `indiceDiversidad` no lo recalcule.
 */
function fillConducta(person: Person, out: Float64Array, offset: number): number {
  const actions = ACTIONS.length;
  // 1. Acciones recientes.
  const totalActivity = loadActivity(person);
  let end = offset + actions;
  for (let i = 0; i < actions; i++) out[offset + i] = totalActivity > 0 ? scratchActivity[i]! / totalActivity : 0;
  normalizeGroup(out, offset, end);
  // 2. Oficio dominante: un-hot (norma 1, ya normalizado).
  const dominant = dominantIndex();
  if (dominant >= 0) out[end + dominant] = 1;
  let start = end + actions;
  // 3. Competencias y objetos de la tecnología.
  const technology = person.technology;
  let competences = 0, successSum = 0, benefitSum = 0;
  for (const key in technology.competence) {
    const c = technology.competence[key]!;
    competences++; successSum += c.successes / Math.max(1, c.attempts); benefitSum += c.benefit;
  }
  const meanSuccessRate = competences ? successSum / competences : 0;
  const meanBenefit = competences ? benefitSum / competences : 0;
  let itemsMass = 0;
  for (const item of technology.items) itemsMass += item.mass;
  out[start] = squash(technology.knownRecipes.length); out[start + 1] = meanSuccessRate; out[start + 2] = squash(meanBenefit);
  out[start + 3] = squash(technology.items.length); out[start + 4] = squash(itemsMass);
  end = start + 5;
  normalizeGroup(out, start, end);
  // 4. Tipos de alimento.
  start = end; end = start + FOOD_ACTIONS.length;
  for (let i = 0; i < FOOD_ACTIONS.length; i++) out[start + i] = person.skills[FOOD_ACTIONS[i]!] ?? 0;
  normalizeGroup(out, start, end);
  // 5. Lugares en memorias recientes.
  start = end; end = start + PLACE_BUCKETS;
  scratchPlaces.fill(0);
  let withPlace = 0;
  for (const experience of person.experiences) {
    if (experience.placeId === '') continue;
    withPlace++; scratchPlaces[hashString(experience.placeId) % PLACE_BUCKETS]! += 1;
  }
  for (let i = 0; i < PLACE_BUCKETS; i++) out[start + i] = withPlace > 0 ? scratchPlaces[i]! / withPlace : 0;
  normalizeGroup(out, start, end);
  // Vector completo: norma L2 final (sin tocarlo si su norma no es positiva).
  const last = offset + CONDUCTA_DIMENSIONS;
  let sum = 0;
  for (let i = offset; i < last; i++) { const x = out[i]!; sum += x * x; }
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = offset; i < last; i++) out[i] = out[i]! / norm;
  return dominant;
}

/**
 * Media de la distancia coseno entre todos los pares de vectores no negativos en O(P · d):
 * para vectores unitarios u_i (‖u_i‖ = 1), ‖u_i − u_j‖² = 2·(1 − u_i·u_j), de modo que
 * ∑_{i<j} (1 − u_i·u_j) = ½·(M·∑‖u_i‖² − ‖∑ u_i‖²). Los pares cero–cero aportan 0 y los
 * pares cero–no-cero aportan 1 (Z·M). Elimina el pico cuadrático O(P²) de `worldStatistics`
 * detectado en T144 (712 ms → < 3 ms en P = 2 000) conservando la definición exacta.
 */
function meanCosineDistance(vectors: Float64Array, n: number, dim: number): number {
  if (n < 2) return 0;
  const sumVec = new Float64Array(dim);
  let nonZero = 0, zero = 0, sumNormSq = 0;
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let normSq = 0;
    for (let k = 0; k < dim; k++) { const x = vectors[base + k]!; normSq += x * x; }
    if (normSq === 0) { zero++; continue; }
    nonZero++;
    const invNorm = 1 / Math.sqrt(normSq);
    let unitNormSq = 0;
    for (let k = 0; k < dim; k++) {
      const u = vectors[base + k]! * invNorm;
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
 * filtra nada); `oficios` = entropía de Shannon del oficio dominante (`dominantIndex`) sobre la
 * población, normalizada por `Math.log(OFICIOS_CATEGORIAS)` — las categorías
 * POSIBLES (las 18 de `Action`), no las observadas (ronda de arreglo: normalizar
 * por observadas dejaba que un mundo con solo 2 oficios de 18 puntuara entropía
 * máxima, incapaz de detectar el colapso de riqueza de oficios que SC-003 debe
 * poder refutar); recortada a 1 por si el rótulo "sin oficio aún" (`dominantIndex`
 * = -1) añadiera una categoría más de las 18 contempladas. `total` = media de
 * ambas. Calculada en O(P · d) mediante identidad exacta de norma L2 (ver
 * `meanCosineDistance`). 0 ó 1 habitante → {0,0,0}, sin excepción.
 */
/** Contribución aditiva de un subconjunto de habitantes a `indiceDiversidad` (para reducir entre dueños). */
export interface ParcialDiversidad {
  readonly total: number;
  readonly nonZero: number;
  readonly zero: number;
  readonly sumNormSq: number;
  readonly sumVec: Float64Array;
  readonly counts: Int32Array;
  readonly order: readonly number[];
}

/** Calcula la contribución aditiva de `people` a `indiceDiversidad`, en el mismo orden FP64 que el recorrido global. */
export function parcialDiversidad(people: readonly Person[]): ParcialDiversidad {
  const sumVec = new Float64Array(CONDUCTA_DIMENSIONS);
  const counts = new Int32Array(ACTIONS.length + 1), order: number[] = [];
  const vector = new Float64Array(CONDUCTA_DIMENSIONS);
  let nonZero = 0, zero = 0, sumNormSq = 0;
  for (let p = 0; p < people.length; p++) {
    vector.fill(0);
    const dominant = fillConducta(people[p]!, vector, 0);
    const label = dominant >= 0 ? dominant : ACTIONS.length;
    if (counts[label]!++ === 0) order.push(label);
    let normSq = 0;
    for (let k = 0; k < CONDUCTA_DIMENSIONS; k++) { const x = vector[k]!; normSq += x * x; }
    if (normSq === 0) { zero++; continue; }
    nonZero++;
    const invNorm = 1 / Math.sqrt(normSq);
    let unitNormSq = 0;
    for (let k = 0; k < CONDUCTA_DIMENSIONS; k++) {
      const u = vector[k]! * invNorm;
      sumVec[k]! += u;
      unitNormSq += u * u;
    }
    sumNormSq += unitNormSq;
  }
  return { total: people.length, nonZero, zero, sumNormSq, sumVec, counts, order };
}

/** Reduce los parciales de varios dueños (en orden determinista 0..H-1) al mismo índice que `indiceDiversidad`. */
export function reducirDiversidad(parciales: readonly ParcialDiversidad[]): { conducta: number; oficios: number; total: number } {
  let n = 0, nonZero = 0, zero = 0, sumNormSq = 0;
  const sumVec = new Float64Array(CONDUCTA_DIMENSIONS);
  const counts = new Int32Array(ACTIONS.length + 1), order: number[] = [];
  for (const parte of parciales) {
    n += parte.total;
    nonZero += parte.nonZero;
    zero += parte.zero;
    sumNormSq += parte.sumNormSq;
    for (let k = 0; k < CONDUCTA_DIMENSIONS; k++) sumVec[k]! += parte.sumVec[k]!;
    for (const label of parte.order) {
      if (counts[label]! === 0) order.push(label);
      counts[label]! += parte.counts[label]!;
    }
  }
  if (n < 2) return { conducta: 0, oficios: 0, total: 0 };
  let sumSq = 0;
  for (let k = 0; k < CONDUCTA_DIMENSIONS; k++) { const s = sumVec[k]!; sumSq += s * s; }
  const pairs = (n * (n - 1)) / 2;
  const nonZeroDist = nonZero >= 2 ? Math.max(0, (nonZero * sumNormSq - sumSq) / 2) : 0;
  const conducta = Math.max(0, Math.min(1, (zero * nonZero + nonZeroDist) / pairs));
  let entropy = 0;
  if (order.length > 1) {
    for (const label of order) { const share = counts[label]! / n; entropy -= share * Math.log(share); }
    entropy = Math.min(1, entropy / Math.log(OFICIOS_CATEGORIAS));
  }
  return { conducta, oficios: entropy, total: (conducta + entropy) / 2 };
}

export function indiceDiversidad(world: World): { conducta: number; oficios: number; total: number } {
  const people = world.people;
  if (people.length < 2) return { conducta: 0, oficios: 0, total: 0 };
  // Matriz plana P × d: un solo bloque en vez de un arreglo por habitante; el oficio dominante sale del mismo recorrido.
  const vectors = new Float64Array(people.length * CONDUCTA_DIMENSIONS);
  // `counts[ACTIONS.length]` = «sin oficio aún»; `order` conserva el orden de primera aparición (fija el orden de la suma de la entropía).
  const counts = new Int32Array(ACTIONS.length + 1), order: number[] = [];
  for (let p = 0; p < people.length; p++) {
    const dominant = fillConducta(people[p]!, vectors, p * CONDUCTA_DIMENSIONS);
    const label = dominant >= 0 ? dominant : ACTIONS.length;
    if (counts[label]!++ === 0) order.push(label);
  }
  const conducta = meanCosineDistance(vectors, people.length, CONDUCTA_DIMENSIONS);
  let entropy = 0;
  if (order.length > 1) {
    for (const label of order) { const share = counts[label]! / people.length; entropy -= share * Math.log(share); }
    entropy = Math.min(1, entropy / Math.log(OFICIOS_CATEGORIAS));
  }
  return { conducta, oficios: entropy, total: (conducta + entropy) / 2 };
}
