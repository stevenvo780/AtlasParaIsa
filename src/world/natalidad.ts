/**
 * Natalidad pagada, sin cupo ni ventana (carril n, `v23.natalidad`): sustituye a `reproduce` (paso heredado
 * 'reproduccion'). `natalidad-local.ts` y `demografia/nacer.ts → reproduce` quedan para el mundo con la ley apagada.
 *
 * LA LEY
 *   aporta(p)  = mortal ∧ edad ∈ [madurez, vejez) ∧ salud ≥ SALUD_FERTIL            (puede dar su genoma)
 *   fértil(p)  = aporta(p) ∧ sin gestación ∧ enfriamiento (gen) ∧ reserva(p) ≥ coste(p) + basal(p, T_MIN)
 *   concebir   : p fértil toma el genoma del mejor q que aporta, no pariente, a ≤ `poblacion.radioPareja` celdas, por
 *                cercanía y por el vínculo que p le tiene (no se exige vínculo mutuo). q no cambia: solo dio información,
 *                así que varias gestantes pueden elegirlo a la vez y en una pareja mutua pueden gestar las dos; cada
 *                gestación la paga y la escribe solo su gestante.
 *   gestar     : cada tick pasa de la reserva al embrión lo que sobra tras guardar un día de basal, sin superar
 *                m0 / T_MIN por tick; de lo pagado, η queda en el embrión y el resto es calor.
 *   abortar    : si la reserva no cubre un día de basal durante DIAS_ABORTO seguidos, lo gestado vuelve a la gestante.
 *   parir      : cuando el embrión llega a m0 (M0 · masa adulta) y han pasado T_MIN días; la cría nace con esa masa.
 *   criar      : la cría depende de sus cuidadores (la gestante y quien dio el genoma) hasta que su masa llega a la adulta.
 *
 * POR QUÉ HAY EQUILIBRIO (la ecuación completa está en el informe del carril). Sea e la ingesta por persona y día, B el
 * basal y C = m0/η el coste de una cría, todo en la misma moneda. Los nacimientos por persona y día son
 *   b = min( (e − B)⁺ / C ,  1 / (T_MIN + enfriamiento) )
 * y e la reparte el suelo: e = min(e_max, P / (N/A)) con P la producción primaria accesible por celda y N/A la densidad.
 * Al subir la densidad e baja, b baja con ella y se anula en N/A = P / B: ese es el techo, y lo pone la comida, no una
 * constante. Con pocos, e = e_max > B y b > 0: lo único que falta es encontrarse, y de eso se ocupan la cohesión y el
 * candidato de cortejo. No hay cupo, ni ventana, ni umbral de alimento local, ni `poblacion.maxima` como regulador.
 *
 * UN SOLO ESCRITOR (ARQ-motor §3.2): en F5 el dueño de la gestante es el único que la cambia. A los demás se les lee
 * por el frente: `pareja` (≥ 0 = aporta), `genoma`, y las columnas que esta ley registra (`progenitores`, `generacion`).
 *
 * La ley se escribe contra `Balance` (reserva, coste, transferir), con dos implementaciones: átomos (`materia/cuerpo.ts`,
 * con `v23.cuerpos`) y escalar (inventario y hambre de hoy, en unidades de alimento).
 */
import { DIAS_ABORTO, ETA, M0, SALUD_FERTIL } from '../shared/naturaleza.js';
import type { PersonView } from '../shared/types.js';
import { APETITO_BASE, APETITO_POR_RASGO, costeCamino, madurezDe, slotPropio } from './cohesion.js';
import type { Candidate } from './decision/sentidos.js';
import { crearCria } from './demografia/nacer.js';
import { demographicTraits } from './demography.js';
import { SHARE_AMOUNT } from './family.js';
import { HAMBRE_POR_PASO, HAMBRE_POR_UNIDAD } from './ecologia-constantes.js';
import { DEFAULT_MUTATION_RATE, inheritGenome, type Genome } from './genetics.js';
import type { Violacion } from './invariantes.js';
import { abortar, basalJ, concebir, gestar, masaDe, parir, plantillaDe, reservaJ, vistaCuerpo } from './materia/cuerpo.js';
import type { Cuerpo, VistaCuerpo } from './materia/tipos.js';
import { ctxSi, type CtxLey, type CtxLeyMateria, type Ley } from './motor/acceso.js';
import { COLUMNAS_CEREBRO, Clase, GENOMA_ANCHO, REF_NULA, TipoIntento, slotDe } from './motor/contratos.js';
import { cercanos } from './motor/vecinos.js';
import { remember } from './mundo/crear.js';
import { clamp } from './mundo/geometria.js';
import { TICKS_PER_DAY, type Person, type World } from './mundo/tipos.js';
import { ley, paramsOf } from './params.js';
import { founderPolicy, inheritPolicy, type PolicyGenome } from './politica.js';
import { vecinos } from './rejilla.js';
import { count } from './statistics.js';

// ── Constantes físicas de la ley (el integrador las reúne en shared/naturaleza.ts) ───────────────────────

/** Días: periodo mínimo de gestación. El embrión no puede crecer más deprisa que m0 / T_GESTACION_MIN. */
export const T_GESTACION_MIN = 0.5;
/** Unidades de alimento (las de `inventory` y `Tile.food`) que vale un cuerpo adulto en el mundo escalar. Fijada para
 * que la cría nazca con M0 · MASA_ADULTA_UA = 0,10 ua, la reserva con que nacía hasta hoy. Sin efecto con `v23.cuerpos`. */
export const MASA_ADULTA_UA = 2;
/** Vínculo, en [0, 1], entre la cría y cada cuidador al nacer: el apego de crianza es entero. */
export const APEGO_NACER = 1;

const TICKS_GESTACION_MIN = T_GESTACION_MIN * TICKS_PER_DAY;
const TICKS_ABORTO = DIAS_ABORTO * TICKS_PER_DAY;
const MG_POR_KG = 1e6;

// ── Fertilidad: funciones puras ──────────────────────────────────────────────────────────────────────────

/** Lo que la ley mira de una persona para saber si puede criar. Reserva y coste van en la moneda del balance. */
export interface EstadoCria {
  mortal: boolean;
  edad: number; madurez: number; vejez: number;       // ticks
  salud: number;                                      // [0, 1]
  gestando: boolean;
  desdeParto: number; enfriamiento: number;           // ticks
  reserva: number; coste: number;                     // coste = síntesis de la cría + basal de la gestación mínima
}

export type CausaNoCria = 'rol' | 'inmadura' | 'vejez' | 'salud' | 'gestando' | 'enfriamiento' | 'reserva';

/** Por qué no puede dar su genoma (null: puede). */
export function causaNoAporta(e: EstadoCria): CausaNoCria | null {
  if (!e.mortal) return 'rol';
  if (e.edad < e.madurez) return 'inmadura';
  if (e.edad >= e.vejez) return 'vejez';
  if (!(e.salud >= SALUD_FERTIL)) return 'salud';
  return null;
}

/** Primera causa por la que no puede concebir ahora (null: es fértil). El orden es el de la ley. */
export function causaNoCria(e: EstadoCria): CausaNoCria | null {
  const previa = causaNoAporta(e);
  if (previa) return previa;
  if (e.gestando) return 'gestando';
  if (e.desdeParto < e.enfriamiento) return 'enfriamiento';
  if (!(e.reserva >= e.coste)) return 'reserva';
  return null;
}

/** Texto de cada causa para las fichas (srv y vfichas). */
export const TEXTO_CAUSA: Readonly<Record<CausaNoCria, string>> = {
  rol: 'No es mortal: S e I no gestan.',
  inmadura: 'Aún no ha madurado.',
  vejez: 'Ha entrado en la vejez.',
  salud: 'Su salud no alcanza para criar.',
  gestando: 'Ya está gestando.',
  enfriamiento: 'Se recupera de su último parto.',
  reserva: 'Su reserva no paga una cría: necesita comer más de lo que gasta.',
};

/** Clave numérica estable (53 bits, nunca 0) del id de texto de una persona: lo que viaja en la columna `progenitores`.
 * No es el uid: el directorio olvida el uid de un muerto al día y los hermanos dejarían de reconocerse. */
export function claveDeId(id: string): number {
  let bajo = 0x811c9dc5, alto = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    bajo = Math.imul(bajo ^ ch, 0x01000193);
    alto = Math.imul(alto ^ ch, 0x85ebca6b) + i;
  }
  return ((alto >>> 11) * 4294967296 + (bajo >>> 0)) || 1;
}

/** Id de texto de quien nace con esta ley. Lleva el uid, que es único en la vida del mundo con un dueño o con muchos. */
export const idDeCria = (uid: number): string => `nacido-${uid}`;

// ── Balance ──────────────────────────────────────────────────────────────────────────────────────────────

/** Gestación en curso, vista igual en los dos balances. `masa` y `m0` van en kg (átomos) o en ua (escalar). */
export interface EnCurso {
  otro: number;            // uid de quien dio el genoma
  genoma: number[];        // alelos de la cría y, tras ellos, [generación, mutaciones]
  politica?: number[];
  inicio: number;          // tick
  bajoBasalDesde: number;  // tick desde el que la reserva no cubre un día de basal; −1 si lo cubre
  masa: number;
  m0: number;
  grano: number;           // menor incremento de masa posible: el parto no espera a una unidad que ya no cabe
}

/** Lo que la cría recibe al nacer: el embrión entero. */
export interface Dote { inventario: number; cuerpo?: Cuerpo; carga?: number[] }

/** Adaptador de la moneda en que se paga una cría. Nada se crea: todo lo que llega al embrión sale de la gestante. */
export interface Balance {
  readonly unidad: 'J' | 'ua';
  /** Lo que el cuerpo puede pagar. */
  reserva(p: Person): number;
  /** Lo que su metabolismo basal quema en `dt` ticks. */
  basal(p: Person, dt: number): number;
  /** Lo que cuesta sintetizar una cría entera, calor incluido (m0/η). */
  coste(p: Person): number;
  salud(p: Person): number;
  /** Masa sobre masa adulta (átomos) o edad sobre edad de madurez (escalar), sin recortar. */
  madurez(p: Person): number;
  enCurso(p: Person): EnCurso | undefined;
  concebir(p: Person, g: { otro: number; genoma: number[]; politica?: number[]; inicio: number }): void;
  /** Transfiere reserva → embrión durante `dt` ticks y devuelve la masa del embrión. */
  gestar(p: Person, dt: number, tick: number): number;
  /** Transfiere embrión → gestante y cierra la gestación. */
  abortar(p: Person): void;
  /** Cierra la gestación: el embrión pasa a ser la cría. */
  parir(p: Person): Dote;
}

/** Gestaciones del mundo escalar. Viven junto a la persona sin cambiarle la forma; no se guardan con el mundo (ver el
 * pedido al integrador en el informe: `Person.gestacion`). Con `v23.cuerpos` la gestación va en `Cuerpo.gestacion`. */
const gestacionesEscalares = new WeakMap<Person, EnCurso>();

type Rasgos = ReturnType<typeof demographicTraits>;
const rasgosPorGenoma = new WeakMap<Genome, { ley: object; rasgos: Rasgos }>();
/** Rasgos demográficos de un genoma (edades, enfriamiento, demanda), calculados una vez por genoma y ley de longevidad. */
function rasgosDe(world: World, p: Person): Rasgos {
  const cuerpo = paramsOf(world).cuerpo, previo = rasgosPorGenoma.get(p.genome);
  if (previo && previo.ley === cuerpo) return previo.rasgos;
  const rasgos = demographicTraits(p.genome, cuerpo);
  rasgosPorGenoma.set(p.genome, { ley: cuerpo, rasgos });
  return rasgos;
}

/** Paga `ua` unidades de alimento: primero de lo que lleva, después de lo ya comido (el hambre sube). */
function pagarUA(p: Person, ua: number): void {
  const deInventario = Math.min(p.inventory, ua);
  p.inventory -= deInventario;
  p.hunger = clamp(p.hunger + (ua - deInventario) * HAMBRE_POR_UNIDAD);
}

/** Balance del mundo escalar, en unidades de alimento. La reserva es lo que lleva más lo que ha comido y aún no ha
 * gastado; el calor de síntesis (1 − η de lo pagado) se disipa, como el hambre de cada paso. */
export function balanceEscalar(world: World): Balance {
  const m0 = M0 * MASA_ADULTA_UA;
  const reserva = (p: Person): number => p.inventory + Math.max(0, 1 - p.hunger) / HAMBRE_POR_UNIDAD;
  const basal = (p: Person, dt: number): number => HAMBRE_POR_PASO * rasgosDe(world, p).foodDemand * dt / HAMBRE_POR_UNIDAD;
  return {
    unidad: 'ua',
    reserva, basal,
    coste: () => m0 / ETA,
    salud: p => p.demography.health,
    madurez: p => p.demography.age / rasgosDe(world, p).maturityAge,
    enCurso: p => gestacionesEscalares.get(p),
    concebir(p, g) { gestacionesEscalares.set(p, { ...g, bajoBasalDesde: -1, masa: 0, m0, grano: m0 * 1e-9 }); },
    gestar(p, dt, tick) {
      const g = gestacionesEscalares.get(p);
      if (!g) return 0;
      const sobra = reserva(p) - basal(p, TICKS_PER_DAY);
      if (!(sobra > 0)) { if (g.bajoBasalDesde < 0) g.bajoBasalDesde = tick; return g.masa; }
      g.bajoBasalDesde = -1;
      const dm = Math.min(sobra * ETA, m0 * dt / TICKS_GESTACION_MIN, m0 - g.masa);
      if (dm > 0) { pagarUA(p, dm / ETA); g.masa += dm; }
      return g.masa;
    },
    abortar(p) {
      const g = gestacionesEscalares.get(p);
      if (!g) return;
      p.inventory += g.masa;
      gestacionesEscalares.delete(p);
    },
    parir(p) {
      const g = gestacionesEscalares.get(p);
      gestacionesEscalares.delete(p);
      return { inventario: g ? g.masa : 0 };
    },
  };
}

const sinCuerpo = (p: Person): never => { throw new Error(`${p.id} no tiene cuerpo de átomos: v23.cuerpos exige que quien lo crea se lo ponga.`); };
const cuerpoDe = (p: Person): Cuerpo => p.cuerpo ?? sinCuerpo(p);

/** Balance sobre cuerpos de átomos, en julios: todo pasa por las funciones del carril b, que mueven lotes de la arena. */
export function balanceAtomos(c: CtxLeyMateria): Balance {
  const vista: VistaCuerpo = { hambre: 0, sed: 0, energia: 0, salud: 0, masa: 0, carga: 0, T: 0 };
  /** kg de una unidad de plantilla: el grano con que crece el embrión. */
  const granoDe = (cuerpo: Cuerpo): number => {
    let mg = 0;
    for (const parte of plantillaDe(c, cuerpo).partes) mg += parte.nu * c.quimica.sustancia(parte.id).masa;
    return mg / MG_POR_KG;
  };
  return {
    unidad: 'J',
    reserva: p => reservaJ(c, cuerpoDe(p)),
    basal: (p, dt) => basalJ(c, cuerpoDe(p), dt),
    // m0 · Q_tejido / η: la energía que queda en los enlaces de la cría es η de la que la gestante quema o cede.
    coste(p) {
      const cuerpo = cuerpoDe(p), tejido = c.materia.vista(cuerpo.tejido);
      return tejido.masa > 0 ? plantillaDe(c, cuerpo).m0 * (tejido.energia / tejido.masa) / ETA : Infinity;
    },
    salud: p => vistaCuerpo(c, cuerpoDe(p), vista).salud,
    madurez(p) {
      const cuerpo = cuerpoDe(p);
      return masaDe(c, cuerpo) / plantillaDe(c, cuerpo).masaAdulta;
    },
    enCurso(p) {
      const cuerpo = p.cuerpo, g = cuerpo?.gestacion;
      if (!cuerpo || !g) return undefined;
      return { otro: g.otro, genoma: g.genoma, politica: g.politica, inicio: g.inicio, bajoBasalDesde: g.bajoBasalDesde,
        masa: c.materia.vista(g.embrion).masa, m0: plantillaDe(c, cuerpo).m0, grano: granoDe(cuerpo) };
    },
    concebir(p, g) { concebir(c, cuerpoDe(p), g); },
    // Las unidades hechas pueden ser menos que las pedidas (`copiar`): vale la masa que `gestar` devuelve.
    gestar: (p, dt) => gestar(c, cuerpoDe(p), dt),
    abortar(p) { abortar(c, cuerpoDe(p)); },
    parir: p => ({ inventario: 0, cuerpo: parir(c, cuerpoDe(p)), carga: [] }),
  };
}

const balances = new WeakMap<object, Balance>();

/** El balance de un dueño: átomos con `v23.cuerpos`, escalar sin él. */
export function balanceDe(c: CtxLey): Balance {
  let b = balances.get(c);
  if (!b) {
    b = ley(c.mundo, 'cuerpos') ? balanceAtomos(c as CtxLeyMateria) : balanceEscalar(c.mundo);
    balances.set(c, b);
  }
  return b;
}

/** El balance de un mundo fuera de un gancho (`choose`, fichas). `undefined` si hace falta el motor y aún no lo hay. */
export function balanceDeMundo(world: World): Balance | undefined {
  const c = ctxSi(world);
  if (c) return balanceDe(c);
  if (ley(world, 'cuerpos')) return undefined;
  let b = balances.get(world);
  if (!b) { b = balanceEscalar(world); balances.set(world, b); }
  return b;
}

// ── Fertilidad sobre el mundo ────────────────────────────────────────────────────────────────────────────

/** El estado completo de una persona ante la ley (para fichas e instrumentos; la ley usa el camino corto de abajo). */
export function estadoCria(world: World, p: Person, b: Balance): EstadoCria {
  const rasgos = rasgosDe(world, p);
  return {
    mortal: p.role === 'neighbor', edad: p.demography.age, madurez: rasgos.maturityAge, vejez: rasgos.senescenceStart,
    salud: b.salud(p), gestando: b.enCurso(p) !== undefined,
    desdeParto: world.tick - p.lastBirth, enfriamiento: rasgos.fertilityCooldown,
    reserva: b.reserva(p), coste: b.coste(p) + b.basal(p, TICKS_GESTACION_MIN),
  };
}

/** ¿Puede dar su genoma? Lo que publica la columna `pareja`. */
function aporta(world: World, p: Person, b: Balance): boolean {
  if (p.role !== 'neighbor') return false;
  const rasgos = rasgosDe(world, p), edad = p.demography.age;
  return edad >= rasgos.maturityAge && edad < rasgos.senescenceStart && b.salud(p) >= SALUD_FERTIL;
}

/** Primera causa por la que `p` no puede concebir ahora (null: es fértil). Para srv y vfichas: `TEXTO_CAUSA[causa]`.
 * `undefined` si el mundo tiene cuerpos de átomos y aún no pasó por el motor. */
export function porQueNoCria(world: World, p: Person): CausaNoCria | null | undefined {
  const b = balanceDeMundo(world);
  return b ? causaNoCria(estadoCria(world, p, b)) : undefined;
}

/** ¿Puede concebir ahora? (la piden los instrumentos del laboratorio para no duplicar la ley). */
export function fertil(world: World, p: Person): boolean {
  return porQueNoCria(world, p) === null;
}

// ── Parentesco y elección de pareja ──────────────────────────────────────────────────────────────────────

const clavesPorPersona = new WeakMap<Person, Float64Array>();
/** [clave propia, clave de cada progenitor (0 si no lo tiene)]. */
function clavesDe(p: Person): Float64Array {
  let k = clavesPorPersona.get(p);
  if (!k) {
    const padres = p.genome.parents;
    k = Float64Array.of(claveDeId(p.id), padres[0] !== undefined ? claveDeId(padres[0]) : 0, padres[1] !== undefined ? claveDeId(padres[1]) : 0);
    clavesPorPersona.set(p, k);
  }
  return k;
}

/** Parentesco cercano entre `p` (propia) y la fila `s` del frente: progenitor y cría, o hermanos de algún progenitor. */
function parienteDe(c: CtxLey, p: Person, s: number, progenitores: ArrayLike<number>): boolean {
  const mias = clavesDe(p), q0 = progenitores[s * 2]!, q1 = progenitores[s * 2 + 1]!;
  if (q0 === mias[0] || q1 === mias[0]) return true;
  if (mias[1] !== 0 && (mias[1] === q0 || mias[1] === q1)) return true;
  if (mias[2] !== 0 && (mias[2] === q0 || mias[2] === q1)) return true;
  const id = c.idDe(c.frente.uid[s]!);
  return id !== undefined && p.genome.parents.includes(id);
}

/** Lo mismo entre dos personas del mismo heap (mundo sin motor). */
function parientes(a: Person, b: Person): boolean {
  if (a.genome.parents.includes(b.id) || b.genome.parents.includes(a.id)) return true;
  return a.genome.parents.some(id => b.genome.parents.includes(id));
}

/** Candidato a dar su genoma, leído del frente. */
export interface Pretendiente { uid: number; slot: number; x: number; y: number; d: number; afinidad: number }

/** El mejor que aporta, no pariente, a ≤ `radio` celdas de `p`: afinidad = cercanía en unidades del radio más el vínculo
 * que `p` le tiene. Los empates los rompe el azar del dueño. */
export function mejorPareja(c: CtxLey, p: Person, slot: number, radio: number): Pretendiente | undefined {
  const f = c.frente, pareja = f.pareja, progenitores = f.col('progenitores');
  let mejor: Pretendiente | undefined, empates = 0;
  cercanos(c, p.x, p.y, radio, Clase.Persona, (s, d2) => {
    if (s === slot || !(pareja[s]! >= 0) || parienteDe(c, p, s, progenitores)) return;
    const d = Math.sqrt(d2), uid = f.uid[s]!, id = c.idDe(uid);
    const afinidad = (radio > 0 ? 1 - d / radio : 1) + (id !== undefined ? p.bonds[id] ?? 0 : 0);
    if (!mejor || afinidad > mejor.afinidad) { mejor = { uid, slot: s, x: f.x[s]!, y: f.y[s]!, d, afinidad }; empates = 1; }
    else if (afinidad === mejor.afinidad && c.azar() * ++empates < 1) mejor = { uid, slot: s, x: f.x[s]!, y: f.y[s]!, d, afinidad };
  });
  return mejor;
}

/** A quién cortejaría `p` a ≤ `radio` celdas, con motor (frente) o sin él (rejilla heredada, para pruebas). */
function pretendienteDe(world: World, p: Person, b: Balance, radio: number): { x: number; y: number; d: number } | undefined {
  const c = ctxSi(world);
  if (c) return mejorPareja(c, p, slotPropio(c, p), radio);
  let mejor: Person | undefined, afinidadMejor = -Infinity;
  for (const otro of vecinos(world, p, radio + 1, o => o !== p && o.id !== p.id, 'natalidad')) {
    const d = Math.hypot(otro.x - p.x, otro.y - p.y);
    if (d > radio || !aporta(world, otro, b) || parientes(p, otro)) continue;
    const afinidad = 1 - d / radio + (p.bonds[otro.id] ?? 0);
    if (afinidad > afinidadMejor || (afinidad === afinidadMejor && mejor !== undefined && otro.id < mejor.id)) { mejor = otro; afinidadMejor = afinidad; }
  }
  return mejor ? { x: mejor.x, y: mejor.y, d: Math.hypot(mejor.x - p.x, mejor.y - p.y) } : undefined;
}

// ── Lo que `choose` consulta ─────────────────────────────────────────────────────────────────────────────

/** Apetito de criar, en puntos de decisión: el doble del apetito de explorar de quien tuviera el cuidado por rasgo. */
export const deseoCria = (p: Person): number => 2 * (APETITO_BASE + APETITO_POR_RASGO * p.traits.care);

/** Cortejo: quien es fértil y percibe a alguien que aporta, no pariente, fuera del alcance de la concepción pero dentro
 * de `poblacion.radioCortejo`, va hacia él. No exige vínculo ni lugar; el camino se paga como cualquier otro. */
export function candidatoCortejo(world: World, p: Person): Candidate | undefined {
  if (!world.reproductionEnabled || p.role !== 'neighbor') return undefined;
  const b = balanceDeMundo(world);
  if (!b || causaNoCria(estadoCria(world, p, b)) !== null) return undefined;
  const { radioPareja, radioCortejo } = paramsOf(world).poblacion;
  const quien = pretendienteDe(world, p, b, Math.max(radioPareja, radioCortejo));
  if (!quien || quien.d <= radioPareja) return undefined;
  return { action: 'approach', target: { x: quien.x, y: quien.y }, score: deseoCria(p) - costeCamino(world, p, quien.d),
    reason: 'Su cuerpo puede pagar una cría y percibe a alguien con quien tenerla; se acerca.' };
}

/** Provisión para criar: lo que le falta a quien podría criar si su reserva alcanzara, o a quien gesta por debajo del
 * basal. `reserveTarget` es el inventario que cubriría la falta (mundo escalar); `comer` dice que la reserva es del
 * cuerpo y se repone comiendo (átomos); `apremio` en [0, 1] es la falta sobre el coste. */
export interface Provision { reserveTarget: number; comer: boolean; apremio: number }

export function provisionCrianza(world: World, p: Person): Provision | null {
  if (!world.reproductionEnabled || p.role !== 'neighbor') return null;
  const b = balanceDeMundo(world);
  if (!b) return null;
  const e = estadoCria(world, p, b), causa = causaNoCria(e);
  let falta = 0;
  if (causa === 'reserva') falta = e.coste - e.reserva;
  else if (causa === 'gestando') {
    const g = b.enCurso(p)!;
    falta = b.coste(p) * Math.max(0, 1 - g.masa / g.m0) + b.basal(p, TICKS_PER_DAY) - e.reserva;
  }
  if (!(falta > 0)) return null;
  return { reserveTarget: b.unidad === 'ua' ? p.inventory + falta : 0, comer: b.unidad === 'J', apremio: Math.min(1, falta / e.coste) };
}

/** Cuidar: quien tiene a la vista una cría a su cargo con más hambre que él y lleva una ración, se la da. */
export function candidatoCuidar(world: World, p: Person, cerca: readonly Person[]): Candidate | undefined {
  if (p.inventory < SHARE_AMOUNT) return undefined;
  let cria: Person | undefined;
  for (const otro of cerca) {
    if (!otro.crianza || otro.hunger <= p.hunger || !otro.crianza.cuidadores.includes(p.id)) continue;
    if (!cria || otro.hunger > cria.hunger) cria = otro;
  }
  if (!cria) return undefined;
  return { action: 'share', target: cria, score: deseoCria(p) * (1 - madurezDe(world, cria)) * (cria.hunger - p.hunger),
    reason: `${cria.name} depende de su cuidado y tiene más hambre; le lleva parte de lo que guarda.` };
}

// ── La ley: ganchos ──────────────────────────────────────────────────────────────────────────────────────

/** Genoma de quien aporta, rehecho de las columnas del frente (los alelos viajan en f32). */
function genomaDelFrente(c: CtxLey, slot: number, id: string): { id: string; genome: Genome } {
  const f = c.frente, alleles: number[] = [];
  for (let i = 0; i < GENOMA_ANCHO; i++) alleles.push(clamp(f.genoma[slot * GENOMA_ANCHO + i]!));
  return { id, genome: { alleles, generation: f.col('generacion')[slot]!, parents: [], mutations: 0, learningRate: 0, cooperation: 0 } };
}

/** Pesos de política de quien aporta: los del frente si la columna existe y está escrita; si no, los fundadores de su id. */
function politicaDelFrente(c: CtxLey, slot: number, id: string): PolicyGenome {
  const f = c.frente;
  if (f.columnas.includes('politica')) {
    const col = f.col('politica'), ancho = COLUMNAS_CEREBRO.politica, weights: number[] = [];
    let escrita = false;
    for (let i = 0; i < ancho; i++) { const w = col[slot * ancho + i]!; weights.push(w); if (w !== 0) escrita = true; }
    if (escrita) return { weights };
  }
  return founderPolicy(c.mundo.seed, id);
}

/** Abre la gestación de `madre` con el genoma de `q`. La cría se sortea aquí: nacer no depende de que `q` siga vivo. */
function concebirCon(c: CtxLey, b: Balance, madre: Person, q: Pretendiente): void {
  const mundo = c.mundo, idOtro = c.idDe(q.uid);
  if (idOtro === undefined || idOtro === madre.id) return;
  const tasa = DEFAULT_MUTATION_RATE * c.params.genes.tasaMutacion, sorteo = `${madre.id}@${c.tick}`;
  const cria = inheritGenome(mundo.seed, sorteo, [{ id: madre.id, genome: madre.genome }, genomaDelFrente(c, q.slot, idOtro)], tasa);
  const politica = c.params.conducta.politicaPeso > 0
    ? inheritPolicy(mundo.seed, sorteo, madre.policy ?? founderPolicy(mundo.seed, madre.id), politicaDelFrente(c, q.slot, idOtro), tasa).weights
    : undefined;
  b.concebir(madre, { otro: q.uid, genoma: [...cria.alleles, cria.generation, cria.mutations], politica, inicio: c.tick });
}

/** Rehace el genoma de la cría de lo guardado al concebir. */
function genomaDeCria(madre: Person, g: EnCurso, idOtro: string | undefined): Genome {
  const alleles = g.genoma.slice(0, GENOMA_ANCHO);
  return {
    alleles, generation: g.genoma[GENOMA_ANCHO] ?? madre.genome.generation + 1,
    parents: idOtro !== undefined ? [madre.id, idOtro] : [madre.id], mutations: g.genoma[GENOMA_ANCHO + 1] ?? 0,
    learningRate: 0.04 + ((alleles[10]! + alleles[11]!) / 2) * 0.16, cooperation: (alleles[12]! + alleles[13]!) / 2,
  };
}

function parto(c: CtxLey, b: Balance, madre: Person): void {
  const mundo = c.mundo, g = b.enCurso(madre);
  if (!g) return;
  const idOtro = c.idDe(g.otro), dote = b.parir(madre), uid = c.id('uid');
  const cuidadores = idOtro !== undefined ? [madre.id, idOtro] : [madre.id];
  const cria = crearCria(mundo, madre, {
    uid, id: idDeCria(uid), genome: genomaDeCria(madre, g, idOtro), policy: g.politica ? { weights: g.politica } : undefined,
    cuidadores, madurez: M0, apego: APEGO_NACER, inventario: dote.inventario, cuerpo: dote.cuerpo, carga: dote.carga,
  });
  madre.lastBirth = c.tick;
  madre.bonds[cria.id] = APEGO_NACER;
  mundo.birthCounter += 1;
  const ref = c.alta(Clase.Persona, cria);
  if (!mundo.people.includes(cria)) mundo.people.push(cria);
  // El otro cuidador se vincula a la cría por su propio dueño; sin intentos, el mundo es un solo heap y se escribe directo.
  if (idOtro !== undefined) {
    const refOtro = c.ref(g.otro);
    if (ley(mundo, 'intentos')) {
      const dueno = refOtro === REF_NULA ? -1 : c.frente.dueno[slotDe(refOtro)]!;
      if (dueno >= 0) c.buzon.enviar(dueno, { tipo: TipoIntento.Vincular, de: ref, a: refOtro, celda: -1, lote: REF_NULA,
        nonce: c.id('nonce'), materia: null, dato: Float64Array.of(APEGO_NACER), bytes: null });
    } else {
      const otro = mundo.people.find(o => o.id === idOtro);
      if (otro) otro.bonds[cria.id] = APEGO_NACER;
    }
  }
  if (!ley(mundo, 'comunidades')) {
    const grupo = mundo.communities.find(k => k.id === madre.communityId);
    if (grupo) grupo.members = [...grupo.members, cria.id];
  }
  count(mundo, 'births');
  const nombreOtro = idOtro !== undefined ? mundo.people.find(o => o.id === idOtro)?.name : undefined;
  const evento = c.suceso({
    kind: 'birth', actors: cuidadores.concat(cria.id), x: cria.x, y: cria.y, source: 'simulation',
    text: `${cria.name} nació de ${madre.name}${nombreOtro ? ` y ${nombreOtro}` : ''}.`,
    cause: `${madre.name} pagó la gestación con su reserva durante ${((c.tick - g.inicio) / TICKS_PER_DAY).toFixed(2)} días; la cría nace con lo gestado y depende de sus cuidadores hasta madurar. ${cria.genome.mutations} variaciones.`,
  });
  remember(cria, mundo, 'Quien lo gestó lo sostuvo hasta su llegada.', evento);
}

function aborto(c: CtxLey, b: Balance, madre: Person): void {
  b.abortar(madre);
  c.suceso({ kind: 'care', actors: [madre.id], x: madre.x, y: madre.y, source: 'simulation',
    text: `${madre.name} perdió la gestación.`,
    cause: `Su reserva no cubrió un día de gasto basal durante ${DIAS_ABORTO} día(s) seguidos; lo gestado volvió a su cuerpo.` });
}

export const leyNatalidad: Ley = {
  id: 'n', interruptor: 'natalidad', sustituye: ['reproduccion'],
  /** `progenitores`: clave (`claveDeId`) del id de cada progenitor, 0 si no lo tiene. `generacion`: la del genoma. */
  columnas: [['progenitores', 'f64', 2], ['generacion', 'i32', 1]],

  /** Tras aplicar los intentos del tick: crianza, gestación, abortos, concepciones y, al final, partos. */
  F5(c) {
    const mundo = c.mundo, tick = c.tick, b = balanceDe(c), radio = c.params.poblacion.radioPareja;
    const partos: Person[] = [];
    for (const [slot, p] of c.personas) {
      if (p.crianza) {
        const madurez = b.madurez(p);
        if (madurez >= 1) p.crianza = undefined;
        else p.crianza.madurez = Math.max(0, madurez);
      }
      if (p.role !== 'neighbor') continue;
      const g = b.enCurso(p);
      if (g) {
        const masa = b.gestar(p, 1, tick), ahora = b.enCurso(p) ?? g;
        if (ahora.bajoBasalDesde >= 0 && tick - ahora.bajoBasalDesde >= TICKS_ABORTO) aborto(c, b, p);
        else if (masa + ahora.grano >= ahora.m0 && tick - ahora.inicio >= TICKS_GESTACION_MIN) partos.push(p);
        continue;
      }
      if (!mundo.reproductionEnabled || !aporta(mundo, p, b)) continue;
      const rasgos = rasgosDe(mundo, p);
      if (tick - p.lastBirth < rasgos.fertilityCooldown) continue;
      if (!(b.reserva(p) >= b.coste(p) + b.basal(p, TICKS_GESTACION_MIN))) continue;
      const q = mejorPareja(c, p, slot, radio);
      if (q) concebirCon(c, b, p, q);
    }
    // Las altas van tras el recorrido: `c.alta` registra a la cría en `c.personas`.
    for (const madre of partos) parto(c, b, madre);
  },

  /** Publica lo que los demás leerán de cada persona propia en t+1: si aporta, su genoma y su parentesco. */
  F6(c) {
    const w = c.escritura, b = balanceDe(c), mundo = c.mundo;
    const pareja = w.f64('pareja'), genoma = w.f32('genoma'), progenitores = w.f64('progenitores'), generacion = w.i32('generacion');
    for (const [slot, p] of c.personas) {
      const claves = clavesDe(p), alelos = p.genome.alleles;
      progenitores[slot * 2] = claves[1]!; progenitores[slot * 2 + 1] = claves[2]!;
      generacion[slot] = p.genome.generation;
      for (let i = 0; i < GENOMA_ANCHO; i++) genoma[slot * GENOMA_ANCHO + i] = alelos[i] ?? 0;
      pareja[slot] = aporta(mundo, p, b) ? 0 : -1;
    }
  },

  proyectar: {
    persona(c: CtxLey, persona: Person, vista: PersonView): void {
      vista.crianza = persona.crianza ? { cuidadores: [...persona.crianza.cuidadores], madurez: persona.crianza.madurez } : undefined;
      if (persona.role !== 'neighbor' || !vista.cuerpoVisto) return;
      const g = balanceDe(c).enCurso(persona);
      vista.cuerpoVisto.embrion = g ? { masa: g.masa, m0: g.m0, otro: g.otro } : undefined;
    },
  },

  comprobar(c): Violacion[] {
    const b = balanceDe(c), fallos: Violacion[] = [];
    const fallo = (id: string, detalle: string, p: Person): void => {
      fallos.push({ id, gravedad: 'dura', tick: c.tick, detalle, contexto: { persona: p.id } });
    };
    for (const p of c.personas.values()) {
      const g = b.enCurso(p);
      if (g) {
        if (p.role !== 'neighbor') fallo('n.gestante-inmortal', 'S e I no gestan.', p);
        if (!(g.otro > 0)) fallo('n.gestacion-sin-pareja', 'Una gestación no tiene el uid de quien dio el genoma.', p);
        if (!(g.masa >= 0) || !(g.masa <= g.m0 + g.grano)) fallo('n.embrion-fuera-de-rango', `El embrión pesa ${g.masa} y nace con ${g.m0}.`, p);
        if (g.inicio > c.tick || g.genoma.length < GENOMA_ANCHO) fallo('n.gestacion-corrupta', 'Inicio en el futuro o genoma incompleto.', p);
      }
      if (p.crianza && !(p.crianza.madurez >= 0 && p.crianza.madurez < 1)) fallo('n.crianza-fuera-de-rango', `Madurez ${p.crianza.madurez} en una cría a cargo.`, p);
    }
    return fallos;
  },
};
