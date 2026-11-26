import type { ChronicleEvent, CommunityView, PersonView } from '../shared/types.js';
import type { Person, World } from './index.js';
import { localRandom } from './genetics.js';
import { effectiveLimits, ley, paramsOf } from './params.js';
import { effectiveCommunityCap } from './natalidad-local.js';
import { count } from './statistics.js';
import { tileAt } from './spatial.js';
import { activeSiteAt, contributeConstruction, partnerConstructionCost, storedMaterialsNear, structureDistance, waterAvailable } from './inventions.js';
import { CAPABILITIES, itemCapacities, MASS_UNIT, materialCapacities, recetaTecnicaParaEnsenar, shareTechnology, transferTechnologyItem } from './technology.js';
import type { Capability, MaterialBatch, TechnologyProgram, TechnologyRecipe } from '../shared/technology.js';
import { resolveTechnologyRecipe, withRecipeSession } from './technology-catalogue.js';
import { algunoCerca, filtrarCerca } from './indice-puntos.js';
import { primerVecino, vecinos } from './rejilla.js';
import { tileLookup } from './tile-index.js';
import { residentFastAccess } from './soa/terreno.js';
import { defaultChemistryState, exchangeComplementaryCompounds } from './chemistry.js';
import { VINCULO_MINIMO } from '../shared/naturaleza.js';
import { ctxSi } from './motor/acceso.js';
import { REF_NULA, slotDe, TipoIntento } from './motor/contratos.js';

type Emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => ChronicleEvent;
export type Culture = NonNullable<PersonView['culture']>;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const CULTURE_KEYS = ['sharing', 'stewardship', 'openness'] as const;
export function initialCulture(seed: number, id: string): Culture {
  const random = localRandom(seed, `culture:${id}`);
  return { sharing: 0.15 + random() * 0.7, stewardship: 0.15 + random() * 0.7, openness: 0.15 + random() * 0.7 };
}
export function culturalDistance(a: Culture, b: Culture): number { return (Math.abs(a.sharing - b.sharing) + Math.abs(a.stewardship - b.stewardship) + Math.abs(a.openness - b.openness)) / 3; }
/** Revisión de prácticas tras un resultado (`social.derivaCultural`, default 0 = histórico).
 * Con 0 son exactamente las dos subidas monótonas de siempre. Con > 0 cada dimensión tiene
 * presión en los dos sentidos según el cuerpo y la pertenencia: la extracción silvestre con
 * éxito y hambre baja el cuidado, la privación aguda baja el compartir, el sedentarismo
 * comunitario cierra y explorar abre. Pura salvo la cultura de la persona. */
export function updateCulturalNormsOnOutcome(world: World, person: Person, action: string, useful: boolean): void {
  const derivaCultural = paramsOf(world).social.derivaCultural;
  if (!(derivaCultural > 0)) {
    const rate = person.genome.learningRate * 0.04;
    if ((!useful && ['gather','hunt','forage'].includes(action)) || (useful && action === 'farm')) person.culture.stewardship = clamp(person.culture.stewardship + rate);
    if (useful && ['cooperate','share'].includes(action)) person.culture.sharing = clamp(person.culture.sharing + rate);
    return;
  }
  const rate = person.genome.learningRate * 0.04 * derivaCultural;
  const wild = ['gather','hunt','forage'].includes(action);
  // V18: el cuidado sube con lo que regenera (cultivar, reparar, construir) y con la extracción
  // fallida, y baja con la extracción que sale bien (cazar, recolectar, o forrajear con hambre).
  // Un refuerzo suave de la práctica ya aprendida (±20 % en los extremos, ×1 en 0,5) separa los
  // nichos sin saturar: los topes blandos 0,95 y 0,08 son puntos fijos inalcanzables (en V17 el
  // suelo `Math.max(0,1, s − 0,08)` de la bajada llevaba a 0 con extracción sostenida; por encima
  // de 0,18 los dos dan lo mismo).
  const steward = person.culture.stewardship;
  if ((!useful && wild) || (useful && (action === 'farm' || action === 'repair' || action === 'build'))) person.culture.stewardship = clamp(steward + rate * 1.15 * (0.95 - steward) * (1 + 0.4 * (steward - 0.5)));
  else if (useful && wild && (action === 'hunt' || action === 'gather' || person.hunger > 0.15)) person.culture.stewardship = clamp(steward - rate * 0.7 * Math.max(0, steward - 0.08) * (1 + 0.4 * (0.5 - steward)));
  const need = Math.max(person.hunger, person.thirst);
  if (useful && ['cooperate','share'].includes(action) && need < 0.6) person.culture.sharing = clamp(person.culture.sharing + rate * 0.9 * (0.95 - person.culture.sharing));
  else if (need > 0.72) person.culture.sharing = clamp(person.culture.sharing - rate * 1.1 * Math.max(0.1, person.culture.sharing - 0.08));
  else if (useful && ['forage','hunt'].includes(action) && (!person.communityId || person.hunger > 0.55)) person.culture.sharing = clamp(person.culture.sharing - rate * 0.45 * Math.max(0.1, person.culture.sharing - 0.1));
  const acuerdos = paramsOf(world).social.acuerdosMateriales;
  if (acuerdos) { /* V19/S: ni construir ni explorar mueven la apertura; sólo acuerdos y cooperación cumplidos. */ }
  else if (useful && ['farm','build'].includes(action) && person.communityId) person.culture.openness = clamp(person.culture.openness - rate * 0.3 * Math.max(0.1, person.culture.openness - 0.15));
  else if (useful && action === 'explore' && person.culture.openness < 0.85) person.culture.openness = clamp(person.culture.openness + rate * 0.25 * (0.85 - person.culture.openness));
}
/** Herencia cultural vertical. Con `derivaCultural <= 0`, la media exacta de siempre; con
 * > 0, la media más una variación determinista por cría acotada a [0,05, 0,98], para que la
 * varianza entre comunidades no se colapse por 1/√2 en cada generación. */
export function inheritCulture(seed: number, childId: string, parentA: Culture, parentB: Culture, derivaCultural: number): Culture {
  if (!(derivaCultural > 0)) return { sharing: (parentA.sharing + parentB.sharing) / 2, stewardship: (parentA.stewardship + parentB.stewardship) / 2, openness: (parentA.openness + parentB.openness) / 2 };
  const random = localRandom(seed, 'culture-child:' + childId);
  return {
    sharing: Math.max(0.05, Math.min(0.98, (parentA.sharing + parentB.sharing) / 2 + (random() - 0.5) * 0.12 * Math.min(2, derivaCultural))),
    stewardship: Math.max(0.05, Math.min(0.98, (parentA.stewardship + parentB.stewardship) / 2 + (random() - 0.5) * 0.12 * Math.min(2, derivaCultural))),
    openness: Math.max(0.05, Math.min(0.98, (parentA.openness + parentB.openness) / 2 + (random() - 0.5) * 0.12 * Math.min(2, derivaCultural))),
  };
}
export function bond(world: World, a: Person, b: Person, amount: number): void {
  if (ley(world, 'intentos')) { vincularPorLado(world, a, b, amount, {}); return; }
  a.bonds[b.id] = clamp((a.bonds[b.id] ?? 0.2) + amount); b.bonds[a.id] = clamp((b.bonds[a.id] ?? 0.2) + amount);
  if (!world.cooperationEnabled || amount <= 0) return;
  const derivaCultural = paramsOf(world).social.derivaCultural;
  if (!(derivaCultural > 0)) {
    const similarity = 1 - culturalDistance(a.culture, b.culture);
    for (const key of CULTURE_KEYS) {
      const delta = (b.culture[key] - a.culture[key]) * 0.015 * similarity;
      a.culture[key] = clamp(a.culture[key] + delta); b.culture[key] = clamp(b.culture[key] - delta);
    }
    return;
  }
  if (a.communityId !== null && a.communityId === b.communityId) {
    const similarity = 1 - culturalDistance(a.culture, b.culture);
    for (const key of CULTURE_KEYS) {
      const delta = (b.culture[key] - a.culture[key]) * 0.004 * similarity;
      a.culture[key] = clamp(a.culture[key] + delta); b.culture[key] = clamp(b.culture[key] - delta);
    }
  } else if (a.communityId !== b.communityId && amount > 0 && !paramsOf(world).social.acuerdosMateriales) {
    a.culture.openness = clamp(a.culture.openness + 0.006 * derivaCultural);
    b.culture.openness = clamp(b.culture.openness + 0.006 * derivaCultural);
  }
}
/**
 * Lo que un acto social le hace al OTRO (V23, `v23.intentos`). Con la ley viaja en un intento Vincular a su dueño, que
 * lo aplica en `leyComunidades.aplicar.Vincular` (`aplicarEfectoSocial`); cada lado solo lo escribe su dueño. Sin
 * contexto de motor (un mundo de prueba) se aplica aquí mismo.
 */
export interface EfectoSocial {
  /** Cuánto sube (o baja) el lado del receptor hacia el emisor; ausente vale 0,2, como en `bond`. */
  vinculo?: number;
  /** El lado del receptor hacia el emisor sube al menos a su lado hacia `copia` (1 si `copia` es el propio receptor):
   * el tiempo que pasó con el embrión del emisor fue su tiempo con quien lo gestaba. */
  copia?: string;
  /** Resultado observado de lo acordado con el emisor (`observeAgreementOutcome`). */
  resultado?: 0 | 1;
  /** Cambios de cultura del receptor: compartir, custodia, apertura. */
  cultura?: readonly [number, number, number];
  fatiga?: number; tension?: number;
  /** Disputó en este tick: marca `lastDispute`. */
  disputa?: boolean;
  /** Cede: se retira y vuelve a decidir dentro de estos ticks. */
  retirada?: number;
  /** Fuente disputada o acordada. */
  fuente?: { x: number; y: number };
  /** Recordar la fuente cedida (`conflictMemory`, ley `social.memoriaDisputa`). */
  memoria?: boolean;
  /** Acuerdo pendiente con el emisor sobre la fuente, medido con esta necesidad. */
  acuerdo?: 'hunger' | 'thirst';
  razon?: string;
  experiencia?: { texto: string; causa: string };
}
/** Posiciones en `Intento.dato` de un Vincular (NaN = ausente). La 0 es la del contrato; las demás las añade esta ley. */
export const DATO_VINCULAR = { vinculo: 0, resultado: 1, cultura: 2, fatiga: 5, tension: 6, disputa: 7, retirada: 8, fuenteX: 9, fuenteY: 10,
  memoria: 11, acuerdo: 12, ancho: 13 } as const;
const textos = new TextEncoder(), lector = new TextDecoder();

export function efectoADato(e: EfectoSocial): { dato: Float64Array; bytes: Uint8Array | null } {
  const D = DATO_VINCULAR, dato = new Float64Array(D.ancho).fill(NaN);
  if (e.vinculo !== undefined) dato[D.vinculo] = e.vinculo;
  if (e.resultado !== undefined) dato[D.resultado] = e.resultado;
  if (e.cultura) for (let k = 0; k < 3; k++) dato[D.cultura + k] = e.cultura[k]!;
  if (e.fatiga !== undefined) dato[D.fatiga] = e.fatiga;
  if (e.tension !== undefined) dato[D.tension] = e.tension;
  if (e.disputa) dato[D.disputa] = 1;
  if (e.retirada !== undefined) dato[D.retirada] = e.retirada;
  if (e.fuente) { dato[D.fuenteX] = e.fuente.x; dato[D.fuenteY] = e.fuente.y; }
  if (e.memoria) dato[D.memoria] = 1;
  if (e.acuerdo) dato[D.acuerdo] = e.acuerdo === 'thirst' ? 2 : 1;
  const texto = e.copia !== undefined || e.razon !== undefined || e.experiencia !== undefined
    ? JSON.stringify({ k: e.copia, r: e.razon, x: e.experiencia?.texto, c: e.experiencia?.causa }) : undefined;
  return { dato, bytes: texto === undefined ? null : textos.encode(texto) };
}

export function datoAEfecto(dato: Float64Array | null, bytes: Uint8Array | null): EfectoSocial {
  const D = DATO_VINCULAR, e: EfectoSocial = {};
  const v = (k: number) => dato && k < dato.length && !Number.isNaN(dato[k]!) ? dato[k]! : undefined;
  e.vinculo = v(D.vinculo);
  const resultado = v(D.resultado);
  if (resultado === 0 || resultado === 1) e.resultado = resultado;
  if (v(D.cultura) !== undefined) e.cultura = [v(D.cultura) ?? 0, v(D.cultura + 1) ?? 0, v(D.cultura + 2) ?? 0];
  e.fatiga = v(D.fatiga); e.tension = v(D.tension); e.disputa = v(D.disputa) === 1; e.retirada = v(D.retirada);
  const fx = v(D.fuenteX), fy = v(D.fuenteY);
  if (fx !== undefined && fy !== undefined) e.fuente = { x: fx, y: fy };
  e.memoria = v(D.memoria) === 1;
  const acuerdo = v(D.acuerdo);
  if (acuerdo === 1 || acuerdo === 2) e.acuerdo = acuerdo === 2 ? 'thirst' : 'hunger';
  if (bytes && bytes.length) {
    const t = JSON.parse(lector.decode(bytes)) as { k?: string; r?: string; x?: string; c?: string };
    if (typeof t.k === 'string') e.copia = t.k;
    if (typeof t.r === 'string') e.razon = t.r;
    if (typeof t.x === 'string') e.experiencia = { texto: t.x, causa: typeof t.c === 'string' ? t.c : '' };
  }
  return e;
}

/** Aplica al receptor (propio) lo que le hizo el emisor. Solo escribe al receptor. */
export function aplicarEfectoSocial(world: World, receptor: Person, emisorId: string, e: EfectoSocial, tick: number): void {
  if (e.cultura) {
    receptor.culture.sharing = clamp(receptor.culture.sharing + e.cultura[0]);
    receptor.culture.stewardship = clamp(receptor.culture.stewardship + e.cultura[1]);
    receptor.culture.openness = clamp(receptor.culture.openness + e.cultura[2]);
  }
  if (e.vinculo !== undefined) receptor.bonds[emisorId] = clamp((receptor.bonds[emisorId] ?? 0.2) + e.vinculo);
  if (e.copia !== undefined) {
    const v = e.copia === receptor.id ? 1 : receptor.bonds[e.copia] ?? 0;
    if (v >= VINCULO_MINIMO && v > (receptor.bonds[emisorId] ?? 0)) receptor.bonds[emisorId] = v;
  }
  if (e.resultado !== undefined) observarAcuerdo(world, receptor, emisorId, e.resultado);
  if (e.fatiga !== undefined) receptor.fatigue = clamp(receptor.fatigue + e.fatiga);
  if (e.tension !== undefined) receptor.socialLoad = clamp(receptor.socialLoad + e.tension);
  if (e.disputa) receptor.lastDispute = tick;
  if (e.acuerdo && e.fuente) receptor.agreement = { partner: emisorId, x: e.fuente.x, y: e.fuente.y, tick, metric: e.acuerdo, level: receptor[e.acuerdo] };
  if (e.retirada !== undefined) {
    receptor.action = 'retreat'; receptor.target = { x: receptor.x, y: receptor.y }; receptor.decisionAt = tick + e.retirada;
    if (e.razon !== undefined) receptor.reason = e.razon;
  }
  if (e.memoria && e.fuente) receptor.conflictMemory = { x: e.fuente.x, y: e.fuente.y, tick };
  if (e.experiencia) {
    receptor.experiences.push({ tick, text: e.experiencia.texto, causeId: e.experiencia.causa, placeId: '' });
    receptor.experiences = receptor.experiences.slice(-8); receptor.recentMemory = e.experiencia.texto;
  }
}

/** Manda a `receptor` (por uid) lo que le hace `emisor`. Con `v23.intentos` y motor, un Vincular a su dueño; si no,
 * se aplica directo sobre `receptor` (sin motor solo hay un dueño y todos son propios). */
export function afectar(world: World, emisor: Person, receptor: Person | undefined, receptorUid: number | undefined, e: EfectoSocial): void {
  const c = ley(world, 'intentos') ? ctxSi(world) : undefined;
  if (!c) { if (receptor) aplicarEfectoSocial(world, receptor, emisor.id, e, world.tick); return; }
  const a = receptorUid === undefined ? REF_NULA : c.ref(receptorUid), de = emisor.uid === undefined ? REF_NULA : c.ref(emisor.uid);
  if (a === REF_NULA || de === REF_NULA) return;
  const { dato, bytes } = efectoADato(e), destino = c.frente.dueno[slotDe(a)]!;
  c.buzon.enviar(destino >= 0 ? destino : c.hilo, { tipo: TipoIntento.Vincular, de, a, celda: -1, lote: REF_NULA, nonce: c.id('nonce'), materia: null, dato, bytes });
}

/** Distancia a otra persona: con `v23.intentos` y motor, a donde la muestra el frente (Infinity si ya no vive). */
function distanciaAlOtro(world: World, person: Person, other: Person): number {
  const c = ley(world, 'intentos') ? ctxSi(world) : undefined;
  if (!c || other.uid === undefined) return distance(person, other);
  const r = c.ref(other.uid);
  if (r === REF_NULA) return Infinity;
  const s = slotDe(r);
  return Math.hypot(person.x - c.frente.x[s]!, person.y - c.frente.y[s]!);
}

/** `bond` por lados: `a` escribe el suyo y la cultura propia; el lado de `b` y su cultura van en el efecto. */
function vincularPorLado(world: World, a: Person, b: Person, amount: number, extra: EfectoSocial): void {
  a.bonds[b.id] = clamp((a.bonds[b.id] ?? 0.2) + amount);
  const cultura: [number, number, number] = [0, 0, 0];
  if (extra.cultura) for (let k = 0; k < 3; k++) cultura[k] = extra.cultura[k]!;
  if (world.cooperationEnabled && amount > 0) {
    const derivaCultural = paramsOf(world).social.derivaCultural;
    const acercar = (tasa: number) => {
      const similarity = 1 - culturalDistance(a.culture, b.culture);
      CULTURE_KEYS.forEach((key, k) => {
        const delta = (b.culture[key] - a.culture[key]) * tasa * similarity;
        a.culture[key] = clamp(a.culture[key] + delta); cultura[k]! -= delta;
      });
    };
    if (!(derivaCultural > 0)) acercar(0.015);
    else if (a.communityId !== null && a.communityId === b.communityId) acercar(0.004);
    else if (a.communityId !== b.communityId && !paramsOf(world).social.acuerdosMateriales) {
      a.culture.openness = clamp(a.culture.openness + 0.006 * derivaCultural); cultura[2] += 0.006 * derivaCultural;
    }
  }
  const { cultura: _previa, ...resto } = extra;
  afectar(world, a, b, b.uid, cultura.some(d => d !== 0) ? { ...resto, vinculo: amount, cultura } : { ...resto, vinculo: amount });
}
/**
 * Convivencia (hipótesis cohorte, 2026-09-22; `social.vinculoConvivencia`, default 0 = hoy). Diagnóstico
 * (`scripts/lab/diagnostico-natalidad.ts`, semilla 20260919): hay fértiles con comunidad y lugar pero sin
 * vínculo mutuo ≥ 0,3 con otro fértil, porque el vínculo sólo sube al cooperar, compartir o acompañar.
 * Ley local: dos personas a ≤ `RADIO_CONVIVENCIA` celdas ganan, en cada paso que comparten, vínculo mutuo
 * `vinculoConvivencia · (sociabilidad media)`. No cuesta ni produce recursos: el único precio es el tiempo
 * que pasan cerca, que no pasan en otra cosa. Está acotada por `TECHO_CONVIVENCIA`: la cercanía hace
 * conocidos, no íntimos; por encima de 0,5 sólo cooperar o compartir siguen subiendo el vínculo. No usa
 * `bond()` a propósito: `bond()` además acerca la cultura un 1,5 % por llamada, y llamado en cada paso de
 * cercanía homogeneizaría la cultura en unos cientos de pasos, que no es lo que esta ley afirma.
 * Un vínculo ausente vale 0,2, como en `bond()`. Coste: índice espacial del paso por casillas de lado
 * `RADIO_CONVIVENCIA`, O(P) más los pares realmente cercanos, sin recorrer todos los pares.
 */
export const RADIO_CONVIVENCIA = 2;
export const TECHO_CONVIVENCIA = 0.5;
function acercar(a: Person, b: Person, ganancia: number): void {
  const actual = a.bonds[b.id] ?? 0.2;
  if (actual < TECHO_CONVIVENCIA) a.bonds[b.id] = Math.min(TECHO_CONVIVENCIA, actual + ganancia);
}
export function convivir(world: World): void {
  const tasa = paramsOf(world).social.vinculoConvivencia;
  if (!(tasa > 0)) return;
  const people = world.people, celda = (n: number) => Math.floor(n / RADIO_CONVIVENCIA);
  const casillas = new Map<string, number[]>();
  for (let i = 0; i < people.length; i++) {
    const key = `${celda(people[i]!.x)},${celda(people[i]!.y)}`;
    const lista = casillas.get(key);
    if (lista) lista.push(i); else casillas.set(key, [i]);
  }
  for (let i = 0; i < people.length; i++) {
    const a = people[i]!, cx = celda(a.x), cy = celda(a.y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const bucket = casillas.get(`${cx + dx},${cy + dy}`);
      if (!bucket) continue;
      for (const j of bucket) {
        const b = people[j]!;
        if (j <= i || distance(a, b) > RADIO_CONVIVENCIA) continue;
        const ganancia = tasa * (a.sociability + b.sociability) / 2;
        acercar(a, b, ganancia); acercar(b, a, ganancia);
      }
    }
  }
}
export interface Opportunity {
  person: Person; kind: 'supply' | 'assist' | 'teach' | 'trade' | 'tools' | 'site'; score: number;
  siteId?: string;
  recipeId?: string; supplyMaterial?: 'wood' | 'stone';
  exchange?: { itemId: string; material: 'wood' | 'stone'; amount: number };
}
/** Instruction helps a material task the learner is actually undertaking. A skill
 * received from a lesson is not evidence that its holder has practised it. */
function practicedSkillToTeach(world: World, teacher: Person, learner: Person): string | undefined {
  if (!world.learningEnabled || distance(learner, learner.target) > 7) return;
  const skill = learner.action;
  if (!['gather', 'farm', 'hunt', 'forage'].includes(skill) || (teacher.activity[skill] ?? 0) <= 0 ||
    (teacher.skills[skill] ?? 0) <= (learner.skills[skill] ?? 0) + 0.08) return;
  const tile = tileAt(world, learner.target);
  if (!tile) return;
  const useful = skill === 'gather' ? ((tile.wood ?? 0) >= 1 && learner.materials.wood < 12) || ((tile.stone ?? 0) >= 1 && learner.materials.stone < 8)
    : skill === 'farm' ? learner.materials.wood >= 1 && tile.terrain !== 'shelter' && tile.moisture > 0.2 && tile.vegetation < 0.9 && (tile.cultivation ?? 0) < 1
    : skill === 'hunt' ? (tile.fauna ?? 0) >= 1
    : tile.food > 0 && learner.inventory < 0.25;
  return useful ? skill : undefined;
}

/** Desempate puro de habilidades por valor: gana la de mayor valor y, en empate, la primera en
 * el orden de inserción dado (sin él, el de `Object.keys`). Es el desempate que el SoA de
 * personas (T147) conserva con su columna de orden explícita; no lee ni escribe el mundo. */
export function topSkillByInsertionOrder(skills: Record<string, number>, insertionOrder?: readonly string[]): string | undefined {
  const ordered: string[] = [];
  if (insertionOrder) for (const key of insertionOrder) if (key in skills && !ordered.includes(key)) ordered.push(key);
  for (const key of Object.keys(skills)) if (!ordered.includes(key)) ordered.push(key);
  let best: string | undefined;
  for (const key of ordered) if (best === undefined || skills[key]! > skills[best]!) best = key;
  return best;
}

/** This is a local prospect, not a withdrawal: supplies still require collection
 * or exchange and fabrication still pays the physical execution's full costs. */
function localRecipeInputs(world: World, teacher: Person, learner: Person): (program: TechnologyProgram, prospectiveProductId?: string) => boolean {
  const carriedWood = (learner.materials.wood + teacher.materials.wood) * MASS_UNIT, carriedStone = (learner.materials.stone + teacher.materials.stone) * MASS_UNIT;
  // El terreno sólo suma cantidades validadas ≥ 0 a lo que llevan los dos: si lo llevado ya cubre lo
  // pedido, la comparación con la suma completa da lo mismo y el recorrido no hace falta.
  let raw: { wood: number; stone: number; water: number } | undefined;
  const learnerItems = learner.technology.items, teacherItems = teacher.technology.items, stock = learner.technology.residue;
  let powers: Record<Capability, number> | undefined;
  // Masa por receta de producto, sumada en el orden aprendiz + maestro como el `filter` + `reduce` de siempre.
  const massByRecipe = new Map<string | null | undefined, number>();
  const productMass = (id: string | undefined): number => {
    let mass = massByRecipe.get(id);
    if (mass === undefined) {
      mass = 0;
      for (const item of learnerItems) if (item.recipeId === id) mass += item.mass;
      for (const item of teacherItems) if (item.recipeId === id) mass += item.mass;
      massByRecipe.set(id, mass);
    }
    return mass;
  };
  // Las tres condiciones son puras: se evalúan en otro orden, con las mismas sumas en el orden de `inputs`.
  return (program, prospectiveProductId) => {
    const { inputs, steps } = program;
    let needWood = 0, needStone = 0, needWater = 0, usedWood = 0, usedStone = 0, usedWater = 0, fuel = 0;
    for (const input of inputs) {
      if (input.source === 'product') continue;
      if (input.source === 'raw') {
        if (input.material === 'wood') needWood += input.mass; else if (input.material === 'stone') needStone += input.mass; else if (input.material === 'water') needWater += input.mass;
      } else if (input.material === 'wood') usedWood += input.mass; else if (input.material === 'stone') usedStone += input.mass; else if (input.material === 'water') usedWater += input.mass;
    }
    for (const step of steps) fuel += step.op === 'heat' ? step.intensity * 50 : 0;
    needWood += Math.max(0, fuel - Math.max(0, stock.wood - usedWood));
    if (!(usedWood <= stock.wood && usedStone <= stock.stone && usedWater <= stock.water)) return false;
    if (!(needWood <= carriedWood && needStone <= carriedStone && needWater <= 0)) {
      if (!raw) {
        raw = { wood: carriedWood, stone: carriedStone, water: 0 };
        const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
        for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
          if (dx * dx + dy * dy > 49) continue;
          const x = learner.x + dx, y = learner.y + dy, tile = tileIn(x, y);
          if (!tile) continue;
          const cell = fast ? (fast.exact ? fast.exact.cellAt(x, y) : fast.cellOf(tile)) : -1;
          if (cell >= 0) {
            if (fast!.terrainArr[cell] === fast!.TERRAIN_WATER) continue;
            const wood = fast!.woodArr[cell]!, water = fast!.drinkingWaterArr[cell]!;
            raw.wood += (wood === wood ? wood : 0) * MASS_UNIT;
            raw.stone += (tile.stone ?? 0) * MASS_UNIT;
            raw.water += (water === water ? water : 0) * 50_000;
          } else if (tile.terrain !== 'water') {
            raw.wood += (tile.wood ?? 0) * MASS_UNIT; raw.stone += (tile.stone ?? 0) * MASS_UNIT; raw.water += (tile.drinkingWater ?? 0) * 50_000;
          }
        }
      }
      if (!(needWood <= raw.wood && needStone <= raw.stone && needWater <= raw.water)) return false;
    }
    for (const step of steps) {
      if (!step.requiredCatalyst) continue;
      powers ??= itemCapacities([...learnerItems, ...teacherItems]);
      if (!(powers[step.requiredCatalyst] >= 0.1)) return false;
    }
    // Cada receta de producto una vez (su primera entrada), con su masa total sumada desde 0 en orden.
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!, id = input.recipeId;
      if (input.source !== 'product' || id === prospectiveProductId) continue;
      let seen = false;
      for (let j = 0; j < i && !seen; j++) seen = inputs[j]!.source === 'product' && inputs[j]!.recipeId === id;
      if (seen) continue;
      let needed = 0;
      for (let j = i; j < inputs.length; j++) if (inputs[j]!.source === 'product' && inputs[j]!.recipeId === id) needed += inputs[j]!.mass;
      if (!(productMass(id) >= needed)) return false;
    }
    return true;
  };
}
/** Recetas que el maestro ha practicado con éxito, en el orden de sus instrucciones. No depende del
 * aprendiz: `cooperationOpportunity` la calcula una vez por decisión (nada cambia mientras evalúa). */
function practicedRecipes(teacher: Person): string[] {
  const ids: string[] = [];
  for (const id of teacher.technology.knownRecipes) if (!((teacher.technology.competence[id]?.successes ?? 0) <= 0)) ids.push(id);
  return ids;
}
function practicedRecipeToTeach(world: World, teacher: Person, learner: Person, practiced?: readonly string[], census?: { counts?: Map<string, number> }): string | undefined {
  if (!world.learningEnabled) return;
  // V23 (`v23.tecnica`): se enseña una receta de lotes que recuerda (`recetaParaEnsenar`), no el catálogo viejo.
  const deLotes = recetaTecnicaParaEnsenar(world, teacher, learner);
  if (deLotes !== null) return deLotes;
  const practicedIds = practiced ?? practicedRecipes(teacher);
  if (!practicedIds.length) return;
  // Mismas recetas resueltas en el mismo orden que `knownRecipes.flatMap(…)` con los dos filtros puros.
  const candidates: TechnologyRecipe[] = [];
  for (const id of practicedIds) {
    if (learner.technology.knownRecipes.includes(id)) continue;
    const recipe = resolveTechnologyRecipe(world, id); if (recipe) candidates.push(recipe);
  }
  if (!candidates.length) return;
  const inputsAvailable = localRecipeInputs(world, teacher, learner);
  // Las resoluciones (que tocan la ventana de recetas) van en el orden de siempre: recordadas y luego
  // pedidas. Lo demás es puro y se calcula sólo si alguna candidata tiene sus insumos.
  const remembered: TechnologyRecipe[] = [];
  for (const id of learner.technology.knownRecipes) { const recipe = resolveTechnologyRecipe(world, id); if (recipe) remembered.push(recipe); }
  // An intermediate can unblock instructions already remembered before a craft
  // action is possible. Assess only those instructions (or the learner's own active
  // program), with the other substrates still required locally; the world catalogue
  // supplies no new desires and no product is credited until fabrication pays for it.
  const requested = requestedPrograms(world, learner);
  const unblocks = (program: TechnologyProgram, id: string) =>
    program.inputs.some(input => input.source === 'product' && input.recipeId === id) && inputsAvailable(program, id);
  // V18 ola 2: `unblocks(p, id)` sólo puede ser verdadero si `id` es la receta de alguna entrada de
  // producto de `p`. Los ids que aparecen así en lo recordado o pedido se reúnen una vez; para una
  // candidata fuera de ese conjunto los dos `some` dan `false` sin evaluar nada (todo es puro aquí:
  // `inputsAvailable` sólo rellena sus memorias locales), y dentro de él se evalúan como siempre.
  let unblockable: Set<string | undefined> | undefined;
  const mayUnblock = (id: string): boolean => {
    if (!unblockable) {
      unblockable = new Set();
      for (const known of remembered) for (const input of known.program.inputs) if (input.source === 'product') unblockable.add(input.recipeId);
      for (const program of requested) for (const input of program.inputs) if (input.source === 'product') unblockable.add(input.recipeId);
    }
    return unblockable.has(id);
  };
  let powers: Record<Capability, number> | undefined;
  const viable: { recipe: TechnologyRecipe; gain: number }[] = [];
  for (const recipe of candidates) {
    if (!inputsAvailable(recipe.program)) continue;
    // Possessing a tool does not teach its replacement. Compare reproducible
    // instructions, not the world catalogue or the teacher's lifetime popularity.
    // `Math.max` plegado de izquierda a derecha: el mismo resultado (NaN y ±0 incluidos) sin copias. Una
    // receta que no supera ningún poder ya reunido no lo cambia, tenga o no sus insumos.
    if (!powers) {
      powers = { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
      for (const known of remembered) {
        if (CAPABILITIES.every(capability => known.capacities[capability] <= powers![capability]) || !inputsAvailable(known.program)) continue;
        for (const capability of CAPABILITIES) powers[capability] = Math.max(powers[capability], known.capacities[capability]);
      }
    }
    let best = -Infinity;
    for (const capability of CAPABILITIES) best = Math.max(best, recipe.capacities[capability] - powers[capability]);
    const gain = best + (mayUnblock(recipe.id) && (remembered.some(known => unblocks(known.program, recipe.id)) || requested.some(program => unblocks(program, recipe.id))) ? 1 : 0);
    if (gain > 0.12) viable.push({ recipe, gain });
  }
  // Con una sola viable (o ninguna) el orden no decide nada: ni rareza ni desempates.
  if (viable.length < 2) return viable[0]?.recipe.id;
  // Ley candidata `social.ensenanzaRareza`: ordenar sólo por `gain` reenseña siempre la
  // misma receta y la transmisión se apaga cuando todos la saben. La rareza medida —la
  // fracción de vivos que NO la recuerdan— entra en la clave de orden; con el default 0
  // la clave vuelve a ser `gain` y el orden es exactamente el histórico. El filtro
  // `gain > 0.12` y los dos desempates (beneficio del maestro, id) no se tocan.
  const rareza = paramsOf(world).social.ensenanzaRareza;
  const holders = rareza > 0 ? census ? census.counts ??= recipeHolders(world) : recipeHolders(world) : undefined;
  const alive = Math.max(1, world.people.length);
  // El primero del `sort` de siempre (clave, beneficio del maestro, id) sin copiar ni ordenar: los ids
  // son únicos, así que el comparador es un orden total y su mínimo es el mismo elemento.
  const competence = teacher.technology.competence;
  let bestRecipe = viable[0]!.recipe, bestKey = viable[0]!.gain + (holders ? rareza * (1 - (holders.get(bestRecipe.id) ?? 0) / alive) : 0);
  for (let i = 1; i < viable.length; i++) {
    const recipe = viable[i]!.recipe, key = viable[i]!.gain + (holders ? rareza * (1 - (holders.get(recipe.id) ?? 0) / alive) : 0);
    if ((bestKey - key || (competence[bestRecipe.id]?.benefit ?? 0) - (competence[recipe.id]?.benefit ?? 0) || recipe.id.localeCompare(bestRecipe.id)) < 0) { bestRecipe = recipe; bestKey = key; }
  }
  return bestRecipe.id;
}
/** One population fold per decision, reused by every learner's candidate ranking.
 * Counts occurrences, including repeated ids, exactly as the original nested loop. */
function recipeHolders(world: World): Map<string, number> {
  const counts = new Map<string, number>();
  for (const person of world.people) for (const id of person.technology.knownRecipes) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
/** A request comes from the recipient's active program, or a recipe they actually know
 * while attempting fabrication. The world's catalogue is never a source of desires. */
function requestedPrograms(world: World, person: Person): TechnologyProgram[] {
  if (!['research', 'craft'].includes(person.action)) return [];
  if (person.technology.project) return [person.technology.project.program];
  if (person.action !== 'craft') return [];
  const programs: TechnologyProgram[] = [];
  for (const id of person.technology.knownRecipes) { const recipe = resolveTechnologyRecipe(world, id); if (recipe) programs.push(recipe.program); }
  return programs;
}
function processMaterialNeed(world: World, person: Person): { wood: number; stone: number } {
  const deficit = { wood: 0, stone: 0 };
  for (const program of requestedPrograms(world, person)) {
    const required = { wood: 0, stone: 0 };
    for (const input of program.inputs) if (input.source === 'raw' && (input.material === 'wood' || input.material === 'stone')) required[input.material] += input.mass / MASS_UNIT;
    // Los mismos pliegues desde 0 y en el mismo orden que `reduce`/`filter`+`reduce`, sin arreglos intermedios.
    let fuel = 0;
    for (const step of program.steps) fuel += step.op === 'heat' ? step.intensity * 50 : 0;
    let scrapUsed = 0;
    for (const input of program.inputs) if (input.source === 'residue' && input.material === 'wood') scrapUsed += input.mass;
    required.wood += Math.max(0, fuel - Math.max(0, person.technology.residue.wood - scrapUsed)) / MASS_UNIT;
    for (const material of ['wood', 'stone'] as const) deficit[material] = Math.max(deficit[material], required[material] - person.materials[material]);
  }
  return deficit;
}
function itemNeed(world: World, person: Person, item: MaterialBatch, excludingItem = false): number {
  const items = person.technology.items;
  // Sin excluir es `itemCapacities(items)` tal cual; excluyendo, el mismo pliegue de máximos
  // en el mismo orden saltando `item.id`, sin copiar el inventario con `filter`.
  let powers: Record<Capability, number>;
  if (excludingItem) {
    powers = { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
    for (const held of items) {
      if (held.id === item.id) continue;
      const heldPowers = materialCapacities(held);
      for (const c of CAPABILITIES) powers[c] = Math.max(powers[c], heldPowers[c]);
    }
  } else powers = itemCapacities(items);
  const capacities = materialCapacities(item); let need = 0;
  for (const program of requestedPrograms(world, person)) {
    // Las mismas sumas desde 0 y en el mismo orden que `filter`+`reduce`, sin arreglos intermedios.
    let requiredMass = 0;
    for (const input of program.inputs) if (input.source === 'product' && input.recipeId === item.recipeId) requiredMass += input.mass;
    let availableMass = 0;
    for (const held of items) if (!(excludingItem && held.id === item.id) && held.recipeId === item.recipeId) availableMass += held.mass;
    if (requiredMass > availableMass) need = Math.max(need, 0.5 + Math.min(0.3, item.mass / Math.max(1, requiredMass) * 0.3));
    for (const step of program.steps) if (step.requiredCatalyst && powers[step.requiredCatalyst] < 0.1 && capacities[step.requiredCatalyst] >= 0.1) need = Math.max(need, 0.75);
  }
  if (distance(person, person.target) <= 7) {
    const tile = tileAt(world, person.target); let useful: Capability | undefined;
    if (person.action === 'gather') {
      const material = person.materials.wood < 6 ? 'wood' : 'stone';
      if ((tile?.[material] ?? 0) > 1 && person.materials[material] < (material === 'wood' ? 11 : 7)) useful = material === 'wood' ? 'cutting' : 'abrasion';
    } else if (person.action === 'farm' && tile && tile.terrain !== 'shelter' && tile.moisture > 0.2 && (tile.cultivation ?? 0) < 1 && person.materials.wood >= 1) useful = 'cultivation';
    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);
  }
  return need;
}
function productExchange(world: World, seller: Person, buyer: Person): Opportunity['exchange'] | undefined {
  if (buyer.technology.items.length >= world.technology.budgets.maxItems) return;
  if (seller.technology.items.length === 0) return;
  const item = seller.technology.items.filter(i => itemNeed(world, buyer, i) > 0 && itemNeed(world, seller, i, true) === 0)
    .sort((a, b) => itemNeed(world, buyer, b) - itemNeed(world, buyer, a) || a.id.localeCompare(b.id))[0];
  if (!item) return;
  // Fuera de `research`/`craft` no hay programas pedidos: las dos necesidades comparadas son 0
  // (y ninguna resolución de receta se saltaba en ese camino), así que la comparación se pliega.
  const processFree = !['research', 'craft'].includes(buyer.action);
  const material = (['wood', 'stone'] as const).filter(m => buyer.materials[m] >= 1 && seller.materials[m] <= (m === 'wood' ? 11 : 7))
    .filter(m => (processFree || processMaterialNeed(world, { ...buyer, materials: { ...buyer.materials, [m]: buyer.materials[m] - 1 } })[m] <= processMaterialNeed(world, buyer)[m]) && !(buyer.action === 'farm' && m === 'wood' && buyer.materials.wood < 2))
    .sort((a, b) => seller.materials[a] - seller.materials[b] || a.localeCompare(b))[0];
  if (!material) return;
  return { itemId: item.id, material, amount: 1 };
}
/** A home is an observed useful place, not a birth faction or a movement boundary. */
export function settlementOpportunity(world: World, person: Person): { target: {x:number;y:number}; score: number; reason: string } | undefined {
  if (!world.cooperationEnabled) return;
  const r = paramsOf(world).social.hogarTrabajo;
  const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);
  // `viable` es pura durante la llamada (sólo lee): el hogar suele ser uno de los lugares a ≤ 6, y su
  // valor ya calculado se reutiliza en vez de recorrer otra vez las 49 celdas, estructuras y vecinos.
  let memoX = NaN, memoY = NaN, memo = 0;
  const viable = (place: {x:number;y:number}) => {
    if (place.x === memoX && place.y === memoY) return memo;
    let food = 0, water = 0, wood = 0, stone = 0, fauna = 0;
    for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) {
      if (dx*dx+dy*dy>16) continue;
      const x = place.x + dx, y = place.y + dy, tile = tileIn(x, y);
      if (!tile) continue;
      const cell = fast ? (fast.exact ? fast.exact.cellAt(x, y) : fast.cellOf(tile)) : -1;
      if (cell >= 0) {
        if (fast!.terrainArr[cell] !== fast!.TERRAIN_WATER) {
          food += fast!.foodArr[cell]!;
          const dw = fast!.drinkingWaterArr[cell]!; water += dw === dw ? dw : 0;
        }
        if (r > 0) { const w = fast!.woodArr[cell]!; wood += w === w ? w : 0; stone += tile.stone ?? 0; fauna += tile.fauna ?? 0; }
      } else {
        if (tile.terrain !== 'water') { food += tile.food; water += tile.drinkingWater ?? 0; }
        if (r > 0) { wood += tile.wood ?? 0; stone += tile.stone ?? 0; fauna += tile.fauna ?? 0; }
      }
    }
    const facilities = paramsOf(world).construccion.poliminosYSinergia
      // A valid six-cell hall can extend five cells from its anchor. Bound the
      // anchor as well: the observed home can already be seven cells away.
      ? filtrarCerca(world.structures, place, 5, s => Math.abs(s.x - place.x) <= 5 && Math.abs(s.y - place.y) <= 5
        && (!s.site || !!s.site.expansion) && structureDistance(place, s) <= 3 && s.condition > 0.1)
      : filtrarCerca(world.structures, place, 5, s=>distance(s,place)<=4 && s.condition>0.1);
    food += facilities.reduce((sum,s)=>sum+s.food,0); water += facilities.reduce((sum,s)=>sum+s.water,0);
    const peers = vecinos(world, place, 7, p=>p!==person && distance(p,place)<=6, 'settlementOpportunity');
    const trust = peers.reduce((sum,p)=>sum+(person.bonds[p.id]??0.15),0)/Math.max(1,peers.length);
    let provision = Math.min(clamp(food/0.8),clamp(water/0.12));
    // H-B: sólo el parche ya percibido modifica la provisión; con r=0 no se lee trabajo.
    if (r > 0) provision *= 1 - r * (1 - clamp((wood + stone) / 12 + fauna / 2));
    memoX = place.x; memoY = place.y;
    return memo = provision * (0.45 + (facilities.length ? 0.25 : 0) + trust*0.3);
  };
  if (person.home && distance(person,person.home)<=7) {
    person.home.quality = viable(person.home); person.home.observedAt = world.tick;
    if (person.home.quality < 0.12) person.home = undefined;
  }
  const nearby = filtrarCerca(world.places, person, 7, p=>distance(person,p)<=6).map(p=>({place:p,quality:viable(p)}))
    .sort((a,b)=>b.quality-a.quality || distance(person,a.place)-distance(person,b.place));
  const best = nearby[0];
  if (best && best.quality>0.4 && (!person.home || best.quality>person.home.quality+0.12)) person.home={x:best.place.x,y:best.place.y,quality:best.quality,observedAt:world.tick};
  const home=person.home;
  if (!home) return;
  // Old observations decay. An explorer cannot read distant regenerated resources.
  const confidence=Math.max(0,1-(world.tick-home.observedAt)/2400), quality=home.quality*confidence;
  if (quality<0.2 || Math.max(person.hunger,person.thirst)>0.82 || person.socialLoad>0.75) return;
  const away=distance(person,home);
  if (away<2) return;
  return {target:{x:home.x,y:home.y},score:quality*(0.55+person.sociability*0.25+(1-person.curiosity)*0.2)+Math.min(0.18,away*0.012),reason:'Vuelve a un lugar conocido con agua, alimento, techo o cooperación; compara esos beneficios con sus necesidades actuales.'};
}
export function cooperationOpportunity(world: World, person: Person): Opportunity | undefined {
  if (!world.cooperationEnabled) return;
  // Evaluación pura (nada del mundo cambia salvo la ventana de recetas): sesión de resolución.
  return withRecipeSession(world, () => evaluateCooperation(world, person));
}
function evaluateCooperation(world: World, person: Person): Opportunity | undefined {
  const opportunities: Opportunity[] = [];
  // Only this synchronous, read-only decision shares the census. Never cache across
  // people decisions: teaching, births and deaths can change it within one tick.
  const census: { counts?: Map<string, number> } = {};
  let practiced: string[] | undefined;
  if (world.tick - person.lastSocial < 30) return;
  const { construccion, v23 } = paramsOf(world);
  for (const other of vecinos(world, person, 8, other => !(other === person || distance(person, other) > 7), 'cooperationOpportunity')) {
    const same = person.communityId && person.communityId === other.communityId;
    const trust = person.bonds[other.id] ?? 0.2;
    const openness = other.communityId !== person.communityId && !same ? person.culture.openness : 1;
    const score = 0.22 + person.genome.cooperation * 0.35 + trust * 0.16 + openness * 0.07;
    const obraEscalar = !v23.obra && other.action === 'build';
    const cazaEscalar = !v23.fauna && other.action === 'hunt';
    if (obraEscalar && construccion.modular) {
      const structure = activeSiteAt(world, other), site = structure?.site;
      const stored = structure ? storedMaterialsNear(world, person) : { wood: 0, stone: 0 };
      if (structure && site && distance(other, structure) <= 0.5 && distance(person, structure) <= 1.5
        && ((site.depositedWood < site.requiredWood && person.materials.wood + stored.wood > 0)
          || (site.depositedStone < site.requiredStone && person.materials.stone + stored.stone > 0)
          || (site.completedWork < site.requiredWork && (person.work > 0 || person.energy >= 0.005)))) {
        opportunities.push({ person: other, kind: 'site', siteId: structure.id, score: score + 0.3 });
      }
    }
    // El coste de obra sólo se lee cuando el otro construye (las dos ramas de abajo); calcularlo
    // para cada vecino era trabajo puro tirado. La necesidad de proceso fuera de
    // `research`/`craft` es {0,0} sin resolver ninguna receta: mismo valor, sin la llamada.
    let costWood = 0, costStone = 0, costWork = 0;
    if (obraEscalar) { const cost = partnerConstructionCost(world, other); costWood = cost.wood; costStone = cost.stone; costWork = cost.work; }
    const processNeed = !v23.tecnica && ['research', 'craft'].includes(other.action) ? processMaterialNeed(world, other) : { wood: 0, stone: 0 };
    const supplyMaterial = (['wood', 'stone'] as const).find(m => processNeed[m] > 0 && person.materials[m] >= 1 && other.materials[m] <= (m === 'wood' ? 11 : 7));
    const recipeId = practicedRecipeToTeach(world, person, other, world.learningEnabled ? practiced ??= practicedRecipes(person) : undefined, census);
    const exchange = !v23.tecnica && !v23.obra ? productExchange(world, person, other) : undefined;
    if (exchange) opportunities.push({ person: other, kind: 'tools', exchange, score: score + 0.24 });
    if (supplyMaterial) opportunities.push({ person: other, kind: 'supply', supplyMaterial, score: score + 0.22 });
    if (recipeId) opportunities.push({ person: other, kind: 'teach', recipeId, score: score + 0.06 });
    if (obraEscalar && ((other.materials.wood < costWood && person.materials.wood > 0) || (other.materials.stone < costStone && person.materials.stone > 0))) opportunities.push({ person: other, kind: 'supply', score: score + 0.22 });
    else if ((obraEscalar || cazaEscalar) && other.work > 0 && other.work < (other.action === 'build' ? costWork : Math.ceil(45*(1-(other.skills.hunt??0)*0.25))) - 1) opportunities.push({ person: other, kind: 'assist', score: score + 0.16 });
    else if (!v23.obra && person.materials.wood >= 2 && person.materials.stone < 2 && other.materials.stone >= 2 && other.materials.wood < 6) opportunities.push({ person: other, kind: 'trade', score: score + 0.08 });
    else if (practicedSkillToTeach(world, person, other)) opportunities.push({ person: other, kind: 'teach', score });
  }
  return opportunities.sort((a, b) => b.score - a.score || distance(person, a.person) - distance(person, b.person) || a.person.id.localeCompare(b.person.id))[0];
}
export function cooperate(world: World, person: Person, emit: Emit): boolean {
  const opportunity = cooperationOpportunity(world, person);
  if (!opportunity || distanciaAlOtro(world, person, opportunity.person) > 1.5) return false;
  const other = opportunity.person; let detail = '', helperPaid = false;
  if (opportunity.kind === 'site') {
    const structure = world.structures.find(s => s.id === opportunity.siteId), site = structure?.site;
    if (!structure || !site || distance(person, structure) > 1.5) return false;
    // The social action can supply joining work, paid from the helper's own body.
    const paid = person.work > 0 ? 0 : Math.min(12, site.requiredWork - site.completedWork, Math.floor(person.energy / 0.0003));
    person.energy = clamp(person.energy - paid * 0.0003); person.fatigue = clamp(person.fatigue + paid * 0.00025);
    person.work += paid;
    if (!contributeConstruction(world, person, structure, emit)) return false;
    helperPaid = paid > 0; count(world, 'constructionHelp');
    detail = `Entregó materiales y trabajo pagado en la obra compartida ${structure.name}.`;
  } else if (opportunity.kind === 'supply') {
    const material = opportunity.supplyMaterial ?? (other.materials.wood < partnerConstructionCost(world, other).wood && person.materials.wood > 0 ? 'wood' : 'stone');
    if (person.materials[material] < 1 || other.materials[material] > (material === 'wood' ? 11 : 7) || (opportunity.supplyMaterial && processMaterialNeed(world, other)[material] <= 0)) return false;
    person.materials[material]--; other.materials[material]++;
    detail = `Aportó una unidad de ${material === 'wood' ? 'madera' : 'piedra'} al trabajo de ${other.name}.`;
  } else if (opportunity.kind === 'assist') {
    const before = other.work;
    const ceiling = (other.action === 'build' ? partnerConstructionCost(world, other).work : Math.ceil(45*(1-(other.skills.hunt??0)*0.25))) - 1;
    if (before >= ceiling) return false;
    other.work = Math.min(ceiling, other.work + 12); count(world, 'constructionHelp');
    detail = `Aportó ${other.work - before} unidades de trabajo a ${other.action === 'build' ? 'la obra' : 'la caza'} de ${other.name}.`;
  } else if (opportunity.kind === 'trade') {
    person.materials.wood--; other.materials.wood++; other.materials.stone--; person.materials.stone++; count(world, 'trade');
    detail = `Intercambiaron una madera por una piedra; ambos resolvieron una carencia.`;
  } else if (opportunity.kind === 'tools') {
    const exchange = opportunity.exchange;
    if (!exchange || other.materials[exchange.material] < exchange.amount || person.materials[exchange.material] + exchange.amount > (exchange.material === 'wood' ? 12 : 8) || productExchange(world, person, other)?.itemId !== exchange.itemId) return false;
    const item = person.technology.items.find(i => i.id === exchange.itemId);
    if (!item || itemNeed(world, other, item) <= 0 || itemNeed(world, person, item, true) > 0 || !transferTechnologyItem(world, person, other, item.id)) return false;
    other.materials[exchange.material] -= exchange.amount; person.materials[exchange.material] += exchange.amount; count(world, 'trade');
    const capacities = materialCapacities(item), strongest = [...CAPABILITIES].sort((a, b) => capacities[b] - capacities[a])[0]!;
    const words: Record<Capability, string> = { cutting: 'corte', storage: 'contención', insulation: 'aislamiento', cultivation: 'palanca para cultivo', binding: 'unión', abrasion: 'abrasión' };
    detail = `Entregó el objeto ${item.id}, con ${item.mass} unidades de masa y capacidad de ${words[strongest]}, a cambio de una unidad de ${exchange.material === 'wood' ? 'madera' : 'piedra'}; resuelve una carencia observable sin duplicar el lote.`;
  } else if (opportunity.recipeId) {
    if (practicedRecipeToTeach(world, person, other) !== opportunity.recipeId || !shareTechnology(world, person, other, emit, opportunity.recipeId)) return false;
    helperPaid = true; count(world, 'teaching');
    // Con la técnica de lotes el id es del registro, no del catálogo viejo (null = no rige).
    const recipe = recetaTecnicaParaEnsenar(world, person, other) === null ? resolveTechnologyRecipe(world, opportunity.recipeId) : undefined;
    detail = recipe ? `Mostró las operaciones practicadas ${recipe.program.steps.map(s => s.op).join(' → ')}; ${other.name} aprendió la receta por esta interacción cercana.`
      : `Mostró un proceso material que practica; ${other.name} lo recuerda por esta interacción cercana.`;
  } else {
    const skill = practicedSkillToTeach(world, person, other);
    if (!skill) return false;
    other.skills[skill] = clamp((other.skills[skill] ?? 0) + Math.min(0.012, (person.skills[skill]! - (other.skills[skill] ?? 0)) * other.genome.learningRate)); count(world, 'teaching');
    detail = `Mostró una técnica practicada de ${skill}; ${other.name} aprendió mediante observación.`;
  }
  // V23 (`quimica.emergente`): regional elemental deficit trade. Partners carrying complementary compounds
  // (e.g. Fe/Si from mountains against C fuel or Ca lime from forest/wetland) swap exact half-lots, so
  // matter flows across regions to distant workshops. Pure halving: elemental mass is conserved bit for bit.
  if (!ley(world, 'tecnica') && paramsOf(world).quimica.emergente && person.compounds?.length && other.compounds?.length) {
    const traded = exchangeComplementaryCompounds(person, other, world.chemistry ??= defaultChemistryState());
    if (traded) detail += ` Además intercambiaron medio lote químico: ${person.name} dio uno rico en ${traded.elements[0]} y recibió uno rico en ${traded.elements[1]}.`;
  }
  person.lastSocial = world.tick;
  if (!helperPaid) { person.energy = clamp(person.energy - 0.005); person.fatigue = clamp(person.fatigue + 0.004); }
  if (ley(world, 'intentos')) return cooperarPorLado(world, person, other, opportunity.kind, detail, emit);
  bond(world, person, other, 0.12); count(world, 'cooperation');
  const derivaCultural = paramsOf(world).social.derivaCultural;
  if (paramsOf(world).social.acuerdosMateriales) {
    // V19/S: la cooperación SÍ entregó recursos o trabajo (pasos anteriores): evidencia observada de cumplimiento,
    // igual para dentro y fuera de la comunidad; la etiqueta de comunidad no cuenta.
    observeAgreementOutcome(world, person, other, 1); observeAgreementOutcome(world, other, person, 1);
  } else if (derivaCultural > 0) {
    const opennessDelta = person.communityId !== other.communityId ? 0.015 * derivaCultural : -0.003 * derivaCultural;
    person.culture.openness = clamp(person.culture.openness + opennessDelta);
    other.culture.openness = clamp(other.culture.openness + opennessDelta);
  }
  const group = world.communities.find(c => c.id === person.communityId); if (group) group.cooperation++;
  const event = emit({ kind: 'cooperation', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} cooperó con ${other.name}. ${detail}`, cause: `Estrategia ${opportunity.kind}; recursos o trabajo transferidos realmente; confianza reforzada y prácticas locales aproximadas.` });
  for (const p of [person, other]) { p.experiences.push({ tick: world.tick, text: detail, causeId: event.id, placeId: '' }); p.experiences = p.experiences.slice(-8); p.recentMemory = detail; }
  return true;
}

/** Cierre social de `cooperate` con `v23.intentos`: lo mismo que la ley de hoy, pero al otro solo le llega un Vincular
 * (vínculo, cultura, resultado del acuerdo y la experiencia vivida). */
function cooperarPorLado(world: World, person: Person, other: Person, kind: Opportunity['kind'], detail: string, emit: Emit): boolean {
  count(world, 'cooperation');
  const extra: EfectoSocial = {}, derivaCultural = paramsOf(world).social.derivaCultural;
  if (paramsOf(world).social.acuerdosMateriales) {
    observeAgreementOutcome(world, person, other, 1); extra.resultado = 1;
  } else if (derivaCultural > 0) {
    const opennessDelta = person.communityId !== other.communityId ? 0.015 * derivaCultural : -0.003 * derivaCultural;
    person.culture.openness = clamp(person.culture.openness + opennessDelta);
    extra.cultura = [0, 0, opennessDelta];
  }
  const group = world.communities.find(c => c.id === person.communityId); if (group) group.cooperation++;
  const event = emit({ kind: 'cooperation', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} cooperó con ${other.name}. ${detail}`, cause: `Estrategia ${kind}; recursos o trabajo transferidos realmente; confianza reforzada y prácticas locales aproximadas.` });
  person.experiences.push({ tick: world.tick, text: detail, causeId: event.id, placeId: '' }); person.experiences = person.experiences.slice(-8); person.recentMemory = detail;
  extra.experiencia = { texto: detail, causa: event.id };
  vincularPorLado(world, person, other, 0.12, extra);
  return true;
}
const COMMUNITY_SYLLABLES = ['Sauce','Brisa','Lumbre','Junco','Piedra','Semilla','Rocío','Sendero'];
const COMMUNITY_COLORS = ['#dfba67','#76b8be','#c498b8','#a3bb6c'];
const COMMUNITY_FORMAS = ['Círculo','Casa','Senda','Rama','Lumbre','Aldea','Valle','Orilla','Refugio','Nido'];
const COMMUNITY_RAICES = ['Sauce','Brisa','Junco','Piedra','Semilla','Rocío','Roble','Lluvia','Cauce','Musgo','Alba','Niebla','Arena','Ceniza','Espiga','Raíz'];
const COMMUNITY_EPITETOS = ['Alta','Clara','Viva','del Sur','del Norte','del Oeste','del Este','Honda','Serena','Nueva','Verde','Antigua'];
/** Nombre de una comunidad nueva. Sin deriva cultural, el histórico de 8 sílabas por
 * semilla e id; con deriva, una de 10×16×12 = 1 920 combinaciones según el número monótono
 * del id: el paso 37 es coprimo con 1 920, así que ninguna se repite en 1 920 fundaciones
 * consecutivas y no hace falta recorrer las comunidades activas para desambiguar. */
function communityName(world: World, id: string): string {
  if (!(paramsOf(world).social.derivaCultural > 0)) {
    const random = localRandom(world.seed, id);
    return `Círculo de ${COMMUNITY_SYLLABLES[Math.floor(random() * COMMUNITY_SYLLABLES.length)]}`;
  }
  const numero = Number(id.slice('community-'.length));
  const m = ((Number.isFinite(numero) ? numero : world.communityCounter) * 37) % 1920;
  return `${COMMUNITY_FORMAS[m % 10]} de ${COMMUNITY_RAICES[Math.floor(m / 10) % 16]} ${COMMUNITY_EPITETOS[Math.floor(m / 160)]}`;
}
/** Nombre de la comunidad número `numero` (V23): una de las 1 920 combinaciones, como con deriva cultural. */
export function nombreDeComunidad(numero: number): string {
  const m = (numero * 37) % 1920;
  return `${COMMUNITY_FORMAS[m % 10]} de ${COMMUNITY_RAICES[Math.floor(m / 10) % 16]} ${COMMUNITY_EPITETOS[Math.floor(m / 160)]}`;
}
export const colorDeComunidad = (numero: number): string => COMMUNITY_COLORS[numero % COMMUNITY_COLORS.length]!;
/** Vecino de confianza: el mismo predicado con el que `updateCommunities` une y funda (≤ 6 celdas,
 * confianza propia ≥ 0,25, prácticas a menos de 0,3). */
const trustedNeighbor = (person: Person, other: Person): boolean => other !== person && distance(person, other) <= 6
  && (person.bonds[other.id] ?? 0) >= 0.25 && culturalDistance(person.culture, other.culture) < 0.3;
/** Comunidad a la que pertenecen más vecinos de confianza; empate por id. */
function trustedMajority(nearby: readonly Person[]): { id: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const p of nearby) if (p.communityId) counts.set(p.communityId, (counts.get(p.communityId) ?? 0) + 1);
  let best: { id: string; count: number } | undefined;
  for (const [id, n] of counts) if (!best || n > best.count || (n === best.count && id < best.id)) best = { id, count: n };
  return best;
}
/** COM-D′ (crítica de COM-D, 2026-09-28), R0: sólo quien puede morir sostiene una comunidad. S e I
 * nunca cuentan para fundar, fisionar ni disolver; siguen la regla de mayoría como cualquiera. */
const isMortalMember = (p: Person): boolean => p.role === 'neighbor';

/** Personas por `communityId` en orden de slot, en una pasada: sustituye un `world.people.filter(p =>
 * p.communityId === id)` por grupo (O(P·G)). Una lista sigue valiendo mientras nadie ENTRE en su grupo:
 * quien sale se descarta al leerla con `p.communityId === id`, y el orden de slot se conserva. */
function porComunidad(people: readonly Person[]): Map<string | null, Person[]> {
  const grupos = new Map<string | null, Person[]>();
  for (const person of people) {
    const lista = grupos.get(person.communityId);
    if (lista) lista.push(person); else grupos.set(person.communityId, [person]);
  }
  return grupos;
}

/** Holgura bajo la cual la media aproximada se rehace con el pliegue de siempre.
 * El error medido de la aproximación frente a ese pliegue queda por debajo de 1e-11
 * incluso con un millón de pares; 1e-9 no cambia ninguna comparación lejana y obliga
 * al pliegue exacto en el filo de `confianzaSalida`. */
const MARGEN_MEDIA_CONFIANZA = 1e-9;
interface GrupoSalida { id: string; miembros: readonly Person[]; ids: ReadonlySet<string>; salidos: Set<string>; }
function grupoSalidaDe(id: string, iniciales: Map<string | null, Person[]>, cache: Map<string, GrupoSalida>): GrupoSalida {
  const previo = cache.get(id);
  if (previo) return previo;
  const miembros = iniciales.get(id) ?? [];
  const ids = new Set<string>();
  for (const p of miembros) ids.add(p.id);
  const grupo: GrupoSalida = { id, miembros, ids, salidos: new Set() };
  cache.set(id, grupo);
  return grupo;
}
/** Misma media que `peers.reduce((sum, p) => sum + (bonds[p.id] ?? 0,2), 0) / peers.length`
 * (o 0,2 si no queda nadie), sin reescanear el grupo por persona. Un lazo ausente vale 0,2:
 * la media es `0,2 + exceso / n`, y el exceso sólo recorre lazos guardados hacia quien sigue
 * dentro. En este bucle sólo se sale, así que `salidos` son las bajas ya decididas, en orden
 * de `world.people`. El resultado sólo se compara con el umbral. */
function mediaConfianza(person: Person, grupo: GrupoSalida, umbral: number): number {
  const n = grupo.miembros.length - 1 - grupo.salidos.size;
  if (n <= 0) return 0.2;
  let extra = 0;
  for (const id in person.bonds) {
    if (!Object.hasOwn(person.bonds, id) || id === person.id || !grupo.ids.has(id) || grupo.salidos.has(id)) continue;
    extra += (person.bonds[id] ?? 0.2) - 0.2;
  }
  const aprox = (0.2 * n + extra) / n;
  if (Math.abs(aprox - umbral) > MARGEN_MEDIA_CONFIANZA) return aprox;
  let sum = 0, count = 0;
  for (const peer of grupo.miembros) {
    if (peer === person || peer.communityId !== grupo.id) continue;
    sum += person.bonds[peer.id] ?? 0.2;
    count++;
  }
  return count ? sum / count : 0.2;
}

/**
 * Ley candidata `social.radioConvivencia` (hipótesis COM, 2026-09-22): la pertenencia es con quién
 * convivo y en quién confío, no una etiqueta de nacimiento. Dos reglas locales, sin umbrales nuevos
 * salvo el radio:
 * 1. Fisión: quien vive a más de `radius` celdas del centro de su comunidad y tiene al menos dos vecinos
 *    de confianza de su misma comunidad funda con ellos una propia (mismos requisitos que una fundación:
 *    tres personas, un lugar a ≤ 7 celdas y el tope `social.maxComunidades`), siempre que el grupo de
 *    origen conserve a alguien. Una fisión por comunidad y revisión.
 * 2. Mayoría: quien tiene al menos dos vecinos de confianza de otra comunidad, y más que de la suya,
 *    pasa a esa comunidad (se revisa en orden de `world.people`, así que un par aislado no se intercambia).
 * Nada se crea ni se paga: sólo cambia a qué grupo cuenta cada uno. Cada cambio deja un evento con causa.
 *
 * COM-D′ (crítica de COM-D, 2026-09-28), sólo con `social.disolucion=1` (`disolver`): R0 hace que el
 * umbral de fisión cuente MORTALES, no a todos (R1: el grupo nuevo y el de origen retienen cada uno
 * ≥ 3); y tras la mayoría, una pasada de disolución (R2–R4) retira las comunidades con ≤ 1 mortal.
 */
function reviseByCohabitation(world: World, emit: Emit, radius: number, iniciales: Map<string | null, Person[]>, disolver: boolean): void {
  const params = paramsOf(world);
  const cap = effectiveCommunityCap(params.social.maxComunidades, effectiveLimits(params).comunidades);
  // Fisión orgánica (sólo con deriva cultural): la fricción social estrecha el radio de cohesión
  // de los grupos grandes y permite varias separaciones limpias en una misma revisión. Sin
  // deriva, el radio efectivo es el de siempre y sólo cabe una fisión por grupo y revisión.
  const organica = params.social.derivaCultural > 0;
  for (const group of [...world.communities]) {
    // Hasta aquí sólo hubo salidas (a null) y fisiones de grupos anteriores (hacia ids nuevos, que esta
    // copia de `world.communities` no recorre): nadie entró en `group` desde que se hizo `iniciales`.
    const members = (iniciales.get(group.id) ?? []).filter(p => p.communityId === group.id);
    if (members.length < 4 || world.communities.length >= cap) continue;
    // Un solo pliegue por coordenada, el mismo orden que los dos `reduce`: el centroide no se mueve.
    let sumX = 0, sumY = 0;
    for (const p of members) { sumX += p.x; sumY += p.y; }
    const center = { x: sumX / members.length, y: sumY / members.length };
    const memberSet = new Set(members);
    const effectiveRadius = organica && members.length > 48 ? Math.max(4, radius * Math.sqrt(48 / members.length)) : radius;
    const maxSplits = organica && members.length > 64 ? Math.min(4, Math.floor(members.length / 40)) : 1;
    // V18, núcleo urbano denso (sólo con deriva): en un grupo de más de 96 la mitad puede vivir
    // apretada dentro del radio efectivo (V17 vivo: 233 con distP50 6,9 y radio 5,45). Tras la
    // pasada de siempre, una segunda con un radio más estrecho deja separarse a los sub-núcleos de
    // la periferia, con los mismos requisitos locales y hasta `n / 32` fisiones (como mucho 6).
    const denso = organica && members.length > 96;
    const radiosDeFision = denso ? [effectiveRadius, Math.max(2.5, radius * Math.sqrt(40 / members.length))] : [effectiveRadius];
    const topeDeFisiones = denso ? Math.max(maxSplits, Math.min(6, Math.floor(members.length / 32))) : maxSplits;
    let splits = 0;
    // R1 cuenta mortales del origen. No cambia mientras se busca al primer núcleo: `isMortalMember`
    // lee el rol, y la fisión reasigna `communityId` sólo después de esta cuenta.
    let mortalesDeOrigen = disolver ? members.filter(isMortalMember).length : 0;
    pasadas: for (let pasada = 0; pasada < radiosDeFision.length; pasada++) {
      // La primera pasada conserva su tope de siempre; la del núcleo denso sigue hasta el suyo.
      const umbral = radiosDeFision[pasada]!, tope = pasada === 0 ? maxSplits : topeDeFisiones;
      if (splits >= tope) continue;
      for (const person of members) {
        if (!memberSet.has(person)) continue;
        const away = distance(person, center);
        if (away <= umbral) continue;
        const core = vecinos(world, person, 7, p => memberSet.has(p) && trustedNeighbor(person, p), 'updateCommunities:cohabitation');
        const founders = [person, ...core];
        let mortalFounders = 0;
        if (disolver) {
          // R1: arreglo en origen. El grupo nuevo y el de origen retienen cada uno ≥ 3 MORTALES
          // (antes bastaba con que el origen conservara a alguien, cualquiera; eso fabricaba restos).
          mortalFounders = founders.filter(isMortalMember).length;
          const originMortalsAfter = mortalesDeOrigen - mortalFounders;
          if (mortalFounders < 3 || originMortalsAfter < 3 || !algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)) continue;
        } else if (core.length < 2 || core.length + 1 >= members.length || !algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)) continue;
        const id = `community-${++world.communityCounter}`;
        const name = communityName(world, id);
        const ids = founders.map(p => p.id);
        world.communities.push({ id, name, x: person.x, y: person.y, members: ids, color: COMMUNITY_COLORS[world.communityCounter % 4]!, culture: { ...person.culture }, formedAt: world.tick, cooperation: 0, disputes: 0 });
        for (const p of founders) p.communityId = id;
        // Arreglo propio para el evento: la fisión no reproduce el alias de la fundación (nota de abajo).
        emit({ kind: 'community', actors: [...ids], x: person.x, y: person.y, source: 'simulation', text: `${name} se separó de ${group.name} entre ${founders.map(p => p.name).join(', ')}.`, cause: `Viven a ${away.toFixed(1)} celdas del centro de ${group.name} (más de ${radius}) y confían entre sí; la pertenencia sigue a la convivencia, no a la etiqueta de origen. Mismos requisitos que una fundación: tres personas, un lugar cercano y el tope de comunidades.` });
        // Quienes ya se separaron no vuelven a elegirse en esta revisión ni cuentan para la siguiente fisión.
        mortalesDeOrigen -= mortalFounders;
        for (const p of founders) memberSet.delete(p);
        splits++;
        if (world.communities.length >= cap) break pasadas;
        if (splits >= tope) break;
      }
    }
  }
  for (const person of world.people) {
    if (!person.communityId) continue;
    const nearby = vecinos(world, person, 7, p => trustedNeighbor(person, p), 'updateCommunities:cohabitation');
    const own = nearby.filter(p => p.communityId === person.communityId).length;
    const best = trustedMajority(nearby.filter(p => p.communityId !== person.communityId));
    if (!best || best.count < 2 || best.count <= own) continue;
    const from = world.communities.find(c => c.id === person.communityId), to = world.communities.find(c => c.id === best.id);
    if (!to) continue;
    // V18, gracia de fundación (sólo con deriva): en V17 los fundadores de una fisión, que aún viven
    // junto a la madre, votaban volver a ella en la misma revisión y dejaban restos de un mortal.
    // Durante sus tres primeras revisiones (< 360 pasos) una comunidad conserva a quien sigue
    // conviviendo con alguien de confianza de ella, y en su revisión de nacimiento a todos.
    if (organica && from && world.tick - from.formedAt < 360 && (own >= 1 || from.formedAt === world.tick)) continue;
    person.communityId = to.id;
    emit({ kind: 'community', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} dejó ${from?.name ?? 'su comunidad'} y se unió a ${to.name}.`, cause: `${best.count} de sus vecinos de confianza son de ${to.name} y ${own} de la suya; la pertenencia sigue a la convivencia y la confianza.` });
  }
  if (disolver) disolverPorEscasezDeMortales(world, emit);
}

/**
 * COM-D′ (crítica de COM-D, 2026-09-28), R2–R4: una comunidad con ≤ 1 mortal se disuelve (R2,
 * histéresis sin estado: fundar exige 3, disolver 1, y con 2 no pasa nada — evita el bucle
 * fundar↔disolver↔refundar de la crítica). Sus miembros —mortales, S e I por igual (R0: siguen la
 * regla de mayoría como cualquiera)— se unen a la mayoría de sus vecinos de confianza ENTRE LAS
 * COMUNIDADES QUE NO SE DISUELVEN esta misma revisión (R3), o quedan sin comunidad; no pueden
 * refundar en esta revisión porque fundar exige 3 mortales libres (R0) y una comunidad disuelta
 * aporta como mucho uno. Una comunidad nacida en esta revisión no se disuelve (R4: `formedAt ===
 * world.tick`), así que fisión y disolución nunca chocan en el mismo paso. `updateCommunities` se
 * encarga de vaciar `group.members` (al reagrupar) y de quitar la comunidad de `world.communities`
 * (al filtrar por miembros al final): aquí sólo se mueve a quién pertenece cada persona.
 */
function disolverPorEscasezDeMortales(world: World, emit: Emit): void {
  const porGrupo = porComunidad(world.people);
  const disueltas = new Set<string>();
  for (const group of world.communities) {
    if (group.formedAt === world.tick) continue;
    if ((porGrupo.get(group.id) ?? []).filter(isMortalMember).length <= 1) disueltas.add(group.id);
  }
  if (!disueltas.size) return;
  for (const group of world.communities) {
    if (!disueltas.has(group.id)) continue;
    const members = porGrupo.get(group.id) ?? [], mortales = members.filter(isMortalMember).length;
    for (const person of members) {
      const nearby = vecinos(world, person, 7, p => trustedNeighbor(person, p), 'updateCommunities:disolucion');
      const best = trustedMajority(nearby.filter(p => p.communityId !== null && !disueltas.has(p.communityId)));
      const to = best ? world.communities.find(c => c.id === best.id) : undefined;
      person.communityId = to ? to.id : null;
      emit({ kind: 'community', actors: [person.id], x: person.x, y: person.y, source: 'simulation',
        text: to ? `${person.name} dejó ${group.name}, disuelta, y se unió a ${to.name}.` : `${person.name} quedó sin comunidad al disolverse ${group.name}.`,
        cause: `${group.name} se disolvió con ${mortales} mortal(es) de convivencia; la pertenencia exige convivencia sostenida, no una etiqueta que sobrevive sola.` });
    }
  }
}

/** Local trust and cultural similarity form groups; group identity alone never causes a dispute. */
export function updateCommunities(world: World, emit: Emit): void {
  if (!world.cooperationEnabled || world.tick % 120 !== 0) return;
  // Membership can change when lived practices and trust cease to fit a group.
  // Nearby compatible contacts are required; geographical isolation alone is insufficient.
  // Leyes candidatas `social.confianzaSalida` y `social.distanciaAlternativa`: cada
  // cooperación suma +0,12 de confianza, así que la media satura y la salida queda
  // cerrada; y las alternativas vienen de grupos que divergen, así que exigirles menos
  // de 0,2 de distancia cultural las descarta siempre. Los defaults son esos dos números.
  const { confianzaSalida, distanciaAlternativa, radioConvivencia, disolucion } = paramsOf(world).social;
  // COM-D′ (crítica de COM-D, 2026-09-28): sólo actúa con las dos leyes activas a la vez (R0 en
  // adelante); con `disolucion=0` (default) todo camino de abajo toma la rama de siempre.
  const comD = radioConvivencia > 0 && disolucion === 1;
  const iniciales = porComunidad(world.people);
  // Una foto por grupo que de verdad revisa a alguien. Quien no llega a distancia cultural 0,3
  // no la construye: en el paso típico este bucle sale en O(P).
  const salida = new Map<string, GrupoSalida>();
  const comunidadesPorId = new Map<string, CommunityView>();
  for (const group of world.communities) comunidadesPorId.set(group.id, group);
  for (const person of world.people) {
    const group = person.communityId ? comunidadesPorId.get(person.communityId) : undefined;
    if (!group || culturalDistance(person.culture, group.culture) < 0.3) continue;
    // En este bucle sólo se sale (a null). La media usa la foto inicial y las bajas ya hechas,
    // que es el filtro `p !== person && p.communityId === group.id` de antes, en orden de slot.
    const grupo = grupoSalidaDe(group.id, iniciales, salida);
    const trust = mediaConfianza(person, grupo, confianzaSalida);
    const alternatives = vecinos(world, person, 7, p => p !== person && p.communityId !== group.id && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.3 && culturalDistance(person.culture, p.culture) < distanciaAlternativa, 'updateCommunities:alternatives');
    if (trust >= confianzaSalida || alternatives.length < 2) continue;
    person.communityId = null;
    grupo.salidos.add(person.id);
    emit({ kind: 'community', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} dejó ${group.name} y buscó otra comunidad cercana.`, cause: 'Prácticas distintas, confianza interna baja y al menos dos contactos cercanos compatibles; la pertenencia es revisable.' });
  }
  if (radioConvivencia > 0) reviseByCohabitation(world, emit, radioConvivencia, iniciales, disolucion === 1);
  // La mayoría de la convivencia AÑADE miembros a grupos existentes: se reagrupa, una pasada.
  const actuales = porComunidad(world.people);
  for (const group of world.communities) {
    const members = actuales.get(group.id) ?? [];
    const ids: string[] = [];
    for (const p of members) ids.push(p.id);
    group.members = ids;
    if (members.length) {
      // Un pliegue por campo, en orden de slot: los mismos bits que cinco `reduce` seguidos.
      let sharing = 0, stewardship = 0, openness = 0, sx = 0, sy = 0;
      for (const p of members) {
        sharing += p.culture.sharing; stewardship += p.culture.stewardship; openness += p.culture.openness;
        sx += p.x; sy += p.y;
      }
      const n = members.length;
      group.culture.sharing = sharing / n; group.culture.stewardship = stewardship / n; group.culture.openness = openness / n;
      group.x = Math.round(sx / n); group.y = Math.round(sy / n);
    }
  }
  const gruposActuales = new Map<string, CommunityView>();
  for (const group of world.communities) gruposActuales.set(group.id, group);
  for (const person of world.people) {
    if (person.communityId) continue;
    const nearby = vecinos(world, person, 7, p => p !== person && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.25 && culturalDistance(person.culture, p.culture) < 0.3, 'updateCommunities:foundation');
    // Con `social.radioConvivencia` > 0 quien no tiene comunidad (una cría, un recién llegado) se une a la
    // de la mayoría de sus vecinos de confianza; con 0, a la del primero que encuentra, como siempre.
    const joined = radioConvivencia > 0 ? trustedMajority(nearby)?.id : nearby.find(p => p.communityId)?.communityId;
    if (joined) { person.communityId = joined; gruposActuales.get(joined)?.members.push(person.id); continue; }
    const free = nearby.filter(p => !p.communityId);
    // Tope de FUNDACIÓN = `social.maxComunidades` (regla de conducta; default 8 = la de siempre).
    // La admisión `limites.comunidades` es otra cosa: lanza al validar, nunca decide aquí.
    // COM-D′ (R0): fundar exige ≥ 3 MORTALES (S e I pueden sumarse, pero no cuentan para el umbral).
    if (comD ? [person, ...free].filter(isMortalMember).length < 3 : free.length < 2) continue;
    const communityCap = effectiveCommunityCap(paramsOf(world).social.maxComunidades, effectiveLimits(paramsOf(world)).comunidades);
    if (world.communities.length >= communityCap || !algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)) continue;
    const members = [person, ...free], id = `community-${++world.communityCounter}`;
    const name = communityName(world, id);
    const group: CommunityView = { id, name, x: person.x, y: person.y, members: members.map(p => p.id), color: COMMUNITY_COLORS[world.communityCounter % 4]!, culture: { ...person.culture }, formedAt: world.tick, cooperation: 0, disputes: 0 };
    for (const p of members) p.communityId = id;
    world.communities.push(group);
    gruposActuales.set(id, group);
    // NOTA (2026-09-22): este evento COMPARTE el arreglo con `group.members`. Un nacimiento
    // del MISMO paso lo extiende retroactivamente, y esa lista extendida es la que hoy
    // guardan las instantáneas de producción. Copiarlo aquí cambiaría historias ya escritas
    // (medido: el digesto de las semillas 51926 y 42 se mueve), así que no se toca en esta
    // tarea; `reproduce` evita el alias sólo en el camino que lo rompería (index.ts).
    // Reglas ≥ 10: el evento lleva su propia copia; los mundos V9 conservan su historia.
    emit({ kind: 'community', actors: world.version >= 10 ? [...group.members] : group.members, x: person.x, y: person.y, source: 'simulation', text: `${name} tomó forma entre ${members.map(p => p.name).join(', ')}.`, cause: 'Confianza ganada en interacciones cercanas, prácticas compatibles y un lugar compartido; no se asignó una facción al nacer.' });
  }
  world.communities = world.communities.filter(group => group.members.length > 0);
}
/** V19/S: estimador acotado `o ← o + α(y − o)` de lo que `person` espera de `other` (confianza propia en la
 * pareja y apertura cultural), con `y = 1` si lo acordado se cumplió y `y = 0` si no. `α = 1 / memoriaResultadosDias`:
 * la memoria de resultados es finita (con 10 días, cada observación pesa un 10 %). */
export function observeAgreementOutcome(world: World, person: Person, other: Person, y: 0 | 1): void {
  observarAcuerdo(world, person, other.id, y);
}
/** Solo escribe a `person`: su confianza en `otherId` y su apertura. */
function observarAcuerdo(world: World, person: Person, otherId: string, y: 0 | 1): void {
  const alpha = 1 / paramsOf(world).social.memoriaResultadosDias, trust = person.bonds[otherId] ?? 0.2;
  person.bonds[otherId] = clamp(trust + alpha * (y - trust));
  person.culture.openness = clamp(person.culture.openness + alpha * (y - person.culture.openness));
}
/** Ticks que quien cedió espera a que la fuente le dé antes de contar el acuerdo como incumplido. */
const PLAZO_ACUERDO = 300;
/** V19/S: resuelve el acuerdo pendiente de `person` con lo que su cuerpo y la fuente muestran. Cumplido: su
 * hambre o sed bajó junto a la fuente. Incumplido: pasada la espera, la fuente se agotó sin que le llegara nada, o
 * venció el plazo. Si bajó lejos de la fuente (otra comida) no hay evidencia sobre el acuerdo y se descarta. */
/** Id de `id` si vive: con `v23.intentos` y motor lo dice el frente; si no, `world.people`. */
function companeroVivo(world: World, id: string): string | undefined {
  const c = ley(world, 'intentos') ? ctxSi(world) : undefined;
  if (!c) return world.people.some(p => p.id === id) ? id : undefined;
  const uid = c.uidDe(id);
  return uid > 0 && c.ref(uid) !== REF_NULA ? id : undefined;
}
export function settleAgreement(world: World, person: Person): void {
  const agreement = person.agreement;
  if (!agreement) return;
  const other = companeroVivo(world, agreement.partner);
  const age = world.tick - agreement.tick;
  const delivered = agreement.level - person[agreement.metric] >= 0.08;
  if (delivered) {
    person.agreement = undefined;
    if (other !== undefined && distance(person, agreement) <= 2) observarAcuerdo(world, person, other, 1);
    return;
  }
  if (age < 12) return;
  const source = tileAt(world, agreement), water = agreement.metric === 'thirst';
  const stock = water ? waterAvailable(world, agreement) : Math.max(source?.food ?? 0, source?.fauna ?? 0);
  if (age < PLAZO_ACUERDO && stock >= (water ? 0.012 : 0.006)) return;
  person.agreement = undefined;
  if (other === undefined) return;
  // La espera costó tiempo y no dio nada: evidencia en contra de quien pidió esperar y de lo acordado.
  observarAcuerdo(world, person, other, 0);
  person.socialLoad = clamp(person.socialLoad + 0.06);
}
export function resourceDispute(world: World, person: Person, emit: Emit): boolean {
  // Leyes candidatas `social.disputaNecesidad`, `social.disputaEscasez` y
  // `social.disputaRadio`: las tres condiciones tienen que darse A LA VEZ (necesidad
  // urgente, fuente casi agotada y otra persona con el mismo destino al lado), y con los
  // números de hoy no coinciden nunca — cero disputas y cero turnos en toda la medición.
  // `disputaEscasez` multiplica los tres umbrales de stock (comida, agua, fauna) a la vez;
  // `disputaDestino` es cuánto tienen que coincidir los dos destinos y `disputaEspera` los
  // ticks de calma que guarda cada lado tras disputar.
  const { disputaNecesidad, disputaEscasez, disputaRadio, disputaDestino, disputaEspera, memoriaDisputa, derivaCultural, acuerdosMateriales } = paramsOf(world).social;
  if (!world.cooperationEnabled || !person.communityId || world.tick - person.lastDispute < disputaEspera || Math.max(person.hunger, person.thirst) < disputaNecesidad) return false;
  const source = tileAt(world, person.target);
  const stock = person.action === 'drink' ? waterAvailable(world,person.target) : person.action === 'hunt' ? source?.fauna ?? 0 : source?.food ?? 0;
  if (!source || !['eat','drink','hunt'].includes(person.action) || stock <= 0 || stock > disputaEscasez * (person.action === 'drink' ? 0.12 : person.action === 'hunt' ? 1 : 0.06)) return false;
  const other = primerVecino(world, person, disputaRadio + 1, p => p !== person && !!p.communityId && p.action === person.action && distance(person, p) <= disputaRadio && distance(person.target, p.target) < disputaDestino && Math.max(p.hunger, p.thirst) > disputaNecesidad && world.tick - p.lastDispute >= disputaEspera, 'resourceDispute');
  if (!other) return false;
  if (ley(world, 'intentos') && distanciaAlOtro(world, person, other) > disputaRadio) return false;
  const trust = person.bonds[other.id] ?? 0.2;
  // Conflicto legible (hipótesis CONFL, `social.memoriaDisputa`, default 0 = hoy). Diagnóstico
  // (`scripts/lab/diagnostico-disputas.ts`, base del carril de la noche): hoy cede quien llega antes a esta
  // comprobación —el primero en `world.people`—, no quien menos lo necesita (en 12 de 27 disputas medidas cedió
  // el MÁS necesitado), y queda treinta pasos inmóvil: ni sed ni hambre por encima de 0,9 le dejan volver a
  // elegir (`agreedWait`, index.ts). Luego nada le aparta de la fuente perdida (en las disputas por agua de la
  // semilla 51926, 5 de 8 vuelven a la misma celda). En una sequía eso puede costarle la vida a quien más sed
  // tenía. Con la ley cede quien menos lo necesita (empate: el de id mayor), vuelve a elegir al paso siguiente
  // y recuerda un día la fuente disputada (`choose`: le parece `memoriaDisputa` celdas más lejos). Nada se
  // crea ni se regala: el coste de la disputa (fatiga, tensión, confianza) es el mismo para los dos.
  const legible = memoriaDisputa > 0, necesidad = (p: Person) => Math.max(p.hunger, p.thirst);
  const cedeOtro = legible && (necesidad(other) < necesidad(person) || (necesidad(other) === necesidad(person) && other.id > person.id));
  const cede = cedeOtro ? other : person, sigue = cedeOtro ? person : other, fuente = { x: person.target.x, y: person.target.y };
  // V19/S: la predisposición (confianza o apertura) ya no basta; el turno tiene que ser factible con el stock que
  // se percibe aquí y ahora. Quien cede necesita `unidad · necesidad` de lo que queda después de que el otro tome lo
  // suyo; la fracción que el stock cubre de la demanda de ambos, ponderada por la apertura que ha aprendido quien
  // espera, es la probabilidad que da al cumplimiento y debe cubrir su propia urgencia. Sin stock suficiente, o con
  // una apertura que la experiencia ya rebajó, el desacuerdo cuesta fatiga y confianza aunque la apertura sea 0,95.
  const unidad = person.action === 'drink' ? 0.12 : person.action === 'hunt' ? 1 : 0.06;
  const cubierto = acuerdosMateriales ? Math.min(1, stock / (unidad * (necesidad(cede) + necesidad(sigue)))) : 1;
  const turnoViable = !acuerdosMateriales || cubierto * cede.culture.openness >= necesidad(cede);
  const predispuestos = trust >= 0.55 || (person.culture.openness + other.culture.openness) / 2 >= 0.65;
  if (ley(world, 'intentos')) return disputarPorLado(world, person, other, emit, { cedeOtro, fuente, legible, predispuestos, turnoViable, trust });
  if (predispuestos && turnoViable) {
    person.lastDispute = other.lastDispute = world.tick;
    if (acuerdosMateriales) {
      // El acuerdo no entrega nada ni premia al firmarse: queda pendiente hasta ver si quien esperó recibió.
      const metric = person.action === 'drink' ? 'thirst' : 'hunger';
      cede.agreement = { partner: sigue.id, x: fuente.x, y: fuente.y, tick: world.tick, metric, level: cede[metric] };
    } else {
      bond(world, person, other, 0.04);
      if (derivaCultural > 0 && person.communityId !== other.communityId) {
        person.culture.openness = clamp(person.culture.openness + 0.012 * derivaCultural);
        other.culture.openness = clamp(other.culture.openness + 0.012 * derivaCultural);
      }
    }
    cede.action = 'retreat'; cede.target = { x: cede.x, y: cede.y }; cede.decisionAt = world.tick + 12;
    cede.reason = legible ? 'Acordó un turno ante la escasez: su vecino lo necesita más y accede primero.' : 'Acordó un turno ante la escasez: deja acceder primero a su vecino.';
    count(world, 'cooperation');
    emit({ kind: 'cooperation', actors: [cede.id, sigue.id], x: cede.x, y: cede.y, source: 'simulation', text: `${cede.name} y ${sigue.name} acordaron turnarse ante una fuente escasa.`, cause: legible
      ? 'Confianza o apertura aprendida permiten coordinar el acceso; espera doce pasos quien menos lo necesita y el recurso no aumenta.'
      : 'Confianza o apertura aprendida permiten coordinar el acceso; el primero espera doce pasos y el recurso no aumenta.' });
    return true;
  }
  // V19/S: la confianza entre miembros de una comunidad ya no exime del desacuerdo cuando el turno que su
  // predisposición pedía es materialmente inviable: el recurso no alcanza para los dos.
  if (person.communityId === other.communityId && trust >= 0.25 && !(acuerdosMateriales && predispuestos)) return false;
  person.lastDispute = world.tick; other.lastDispute = world.tick;
  person.socialLoad = clamp(person.socialLoad + 0.12); other.socialLoad = clamp(other.socialLoad + 0.12);
  person.fatigue = clamp(person.fatigue + 0.015); other.fatigue = clamp(other.fatigue + 0.015);
  if (derivaCultural > 0) {
    person.culture.sharing = clamp(person.culture.sharing - 0.025 * derivaCultural);
    other.culture.sharing = clamp(other.culture.sharing - 0.025 * derivaCultural);
    if (!acuerdosMateriales && person.communityId !== other.communityId) {
      person.culture.openness = clamp(person.culture.openness - 0.03 * derivaCultural);
      other.culture.openness = clamp(other.culture.openness - 0.03 * derivaCultural);
    }
  }
  // V19/S: el obstáculo físico real (dos reclamos sobre una fuente que no alcanza) es evidencia en contra para ambos,
  // pertenezcan o no a la misma comunidad.
  if (acuerdosMateriales) { observeAgreementOutcome(world, person, other, 0); observeAgreementOutcome(world, other, person, 0); }
  bond(world, person, other, -0.08); count(world, 'conflicts');
  for (const p of [person, other]) { const group = world.communities.find(c => c.id === p.communityId); if (group) group.disputes++; }
  // Yield one contested attempt, producing an observable cost without forced violence or theft.
  cede.action = 'retreat'; cede.target = { x: cede.x, y: cede.y }; cede.decisionAt = world.tick + (legible ? 1 : 30);
  if (legible) {
    cede.conflictMemory = { x: fuente.x, y: fuente.y, tick: world.tick };
    cede.reason = 'Cedió una fuente escasa a quien la necesitaba más; la recordará y buscará otra antes de volver.';
    emit({ kind: 'conflict', actors: [cede.id, sigue.id], x: cede.x, y: cede.y, source: 'simulation', text: `${cede.name} y ${sigue.name} disputaron una fuente escasa; cedió ${cede.name}.`, cause: 'Necesidades urgentes, mismo destino, confianza baja y prácticas de apertura reducida. Fatiga y tensión aumentan en los dos; cede quien menos lo necesita, que recordará esa fuente un día y preferirá otra. La diferencia de grupo por sí sola no dispara conflicto.' });
    return true;
  }
  person.reason = 'Una fuente escasa quedó disputada; cede el intento y busca otra posibilidad.';
  emit({ kind: 'conflict', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} y ${other.name} disputaron una fuente escasa.`, cause: 'Necesidades urgentes, mismo destino, confianza baja y prácticas de apertura reducida. Fatiga y tensión aumentan; uno cede el intento. La diferencia de grupo por sí sola no dispara conflicto.' });
  return true;
}

/** `resourceDispute` con `v23.intentos`: las mismas reglas, pero `person` solo escribe lo suyo y lo que le toca a
 * `other` (marca de disputa, tensión, fatiga, cultura, vínculo, acuerdo pendiente, retirada) le llega en un Vincular. */
function disputarPorLado(world: World, person: Person, other: Person, emit: Emit,
  k: { cedeOtro: boolean; fuente: { x: number; y: number }; legible: boolean; predispuestos: boolean; turnoViable: boolean; trust: number }): boolean {
  const { derivaCultural, acuerdosMateriales } = paramsOf(world).social;
  const { cedeOtro, fuente, legible } = k, tick = world.tick;
  const cede = cedeOtro ? other : person, sigue = cedeOtro ? person : other;
  const otro: EfectoSocial = { disputa: true };
  const retirarse = (ticks: number, razon: string) => {
    if (cedeOtro) { otro.retirada = ticks; otro.razon = razon; return; }
    person.action = 'retreat'; person.target = { x: person.x, y: person.y }; person.decisionAt = tick + ticks; person.reason = razon;
  };
  if (k.predispuestos && k.turnoViable) {
    person.lastDispute = tick;
    let vinculo = 0;
    if (acuerdosMateriales) {
      const metric = person.action === 'drink' ? 'thirst' : 'hunger';
      if (cedeOtro) { otro.acuerdo = metric; otro.fuente = fuente; }
      else person.agreement = { partner: other.id, x: fuente.x, y: fuente.y, tick, metric, level: person[metric] };
    } else {
      vinculo = 0.04;
      if (derivaCultural > 0 && person.communityId !== other.communityId) {
        person.culture.openness = clamp(person.culture.openness + 0.012 * derivaCultural);
        otro.cultura = [0, 0, 0.012 * derivaCultural];
      }
    }
    retirarse(12, legible ? 'Acordó un turno ante la escasez: su vecino lo necesita más y accede primero.' : 'Acordó un turno ante la escasez: deja acceder primero a su vecino.');
    count(world, 'cooperation');
    emit({ kind: 'cooperation', actors: [cede.id, sigue.id], x: cede.x, y: cede.y, source: 'simulation', text: `${cede.name} y ${sigue.name} acordaron turnarse ante una fuente escasa.`, cause: legible
      ? 'Confianza o apertura aprendida permiten coordinar el acceso; espera doce pasos quien menos lo necesita y el recurso no aumenta.'
      : 'Confianza o apertura aprendida permiten coordinar el acceso; el primero espera doce pasos y el recurso no aumenta.' });
    if (vinculo) vincularPorLado(world, person, other, vinculo, otro); else afectar(world, person, other, other.uid, otro);
    return true;
  }
  if (person.communityId === other.communityId && k.trust >= 0.25 && !(acuerdosMateriales && k.predispuestos)) return false;
  person.lastDispute = tick;
  person.socialLoad = clamp(person.socialLoad + 0.12); otro.tension = 0.12;
  person.fatigue = clamp(person.fatigue + 0.015); otro.fatiga = 0.015;
  if (derivaCultural > 0) {
    const apertura = !acuerdosMateriales && person.communityId !== other.communityId ? -0.03 * derivaCultural : 0;
    person.culture.sharing = clamp(person.culture.sharing - 0.025 * derivaCultural);
    person.culture.openness = clamp(person.culture.openness + apertura);
    otro.cultura = [-0.025 * derivaCultural, 0, apertura];
  }
  if (acuerdosMateriales) { observarAcuerdo(world, person, other.id, 0); otro.resultado = 0; }
  count(world, 'conflicts');
  for (const p of [person, other]) { const group = world.communities.find(c => c.id === p.communityId); if (group) group.disputes++; }
  if (legible) {
    const razon = 'Cedió una fuente escasa a quien la necesitaba más; la recordará y buscará otra antes de volver.';
    retirarse(1, razon);
    if (cedeOtro) { otro.memoria = true; otro.fuente = fuente; } else person.conflictMemory = { x: fuente.x, y: fuente.y, tick };
    emit({ kind: 'conflict', actors: [cede.id, sigue.id], x: cede.x, y: cede.y, source: 'simulation', text: `${cede.name} y ${sigue.name} disputaron una fuente escasa; cedió ${cede.name}.`, cause: 'Necesidades urgentes, mismo destino, confianza baja y prácticas de apertura reducida. Fatiga y tensión aumentan en los dos; cede quien menos lo necesita, que recordará esa fuente un día y preferirá otra. La diferencia de grupo por sí sola no dispara conflicto.' });
  } else {
    retirarse(30, 'Una fuente escasa quedó disputada; cede el intento y busca otra posibilidad.');
    emit({ kind: 'conflict', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} y ${other.name} disputaron una fuente escasa.`, cause: 'Necesidades urgentes, mismo destino, confianza baja y prácticas de apertura reducida. Fatiga y tensión aumentan; uno cede el intento. La diferencia de grupo por sí sola no dispara conflicto.' });
  }
  vincularPorLado(world, person, other, -0.08, otro);
  return true;
}
