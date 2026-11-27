/**
 * INTERFAZ PUENTE de los cuerpos de átomos (carril b). El esqueleto lo fijó la preparación de la oleada: b rellena los
 * cuerpos de las funciones y puede añadir exportaciones, pero no cambia estas firmas (las consumen n, f, t1, t2 y act).
 *
 * Un `Cuerpo` (materia/tipos.ts) son tres lotes ligados al organismo (celda −1): Tejido, Reserva y Digestivo, más el
 * Embrión de `gestacion`. Todo lo que entra o sale pasa por estas funciones, que solo tocan lotes del dueño que llama:
 * lo ajeno llega antes por intento y se abona aquí. Nada se crea ni se destruye salvo en `crearCuerpo` (fuente declarada).
 *
 * Qué guarda cada lote:
 *  - Tejido: unidades de su plantilla (lo estructural). Salud = unidades completas (Liebig) × masa de la unidad / masa adulta.
 *  - Reserva: lo que el cuerpo gasta. Combustibles limpios (solo C, H y O: azúcares, grasas, carbono), el agua libre y los
 *    gases de la respiración. `quemar` solo corre aquí, así que nunca ve proteína ni NH₃.
 *  - Digestivo: lo comido en tránsito. `pasoLote` con la κ de la plantilla (desamina la proteína, carboniza lo que su
 *    familia abre); el cuerpo absorbe cada combustible limpio a la tasa de Arrhenius de su oxidación catalizada, que es
 *    la definición de «digerible» de la arena (`VistaLote.digerible`); el resto sale al Suelo con el tránsito.
 *
 * Decisión del tubo (encargo, punto 4): con κ = KAPPA0 = 60 en las cuatro familias nada se aprovecha (oxidar un
 * combustible tiene barrera γ·D(O=O) − κ = 113 J: 9·10⁻¹¹ por tick a 310 K; desaminar o carbonizar, γ·D(C–H) − κ = 81 J:
 * 2·10⁻⁵). La dieta sale de dar κ por familia a cada plantilla, no de una lista: `KAPPA_HUMANA` abre C–C/C–H con 110
 * (grasa y carbono se absorben a 0,025 por tick: el 94 % antes de que el tránsito los saque), y deja C–O y H–H en
 * KAPPA0: una persona no aprovecha la madera (CH₂O) ni fermenta, y un herbívoro es la misma ley con κ de C–O alta.
 */
import { DEMOGRAPHY_TICKS_PER_DAY } from '../../shared/demography.js';
import type { SustanciaId } from '../../shared/materia.js';
import {
  ABSORCION_AGUA, AGUA_OBJETIVO_KG_KG, BASAL_J_KG_TICK, CAPACIDAD_ATOMO, CAPACIDAD_GAS_KG, CONDUCTANCIA_PIEL_MAX,
  CONDUCTANCIA_PIEL_MIN, ELEMENTOS, ETA, FRACCION_EVAPORATIVA, FRACCION_O2_REFERENCIA, G_SINTESIS, KAPPA0, KAPPA_HUMANA,
  LINAJE_HUMANO, M0, MASA_ADULTA_HUMANA, NE, NU, R, REPARTO_AGUA_TUBO, RESERVA_OBJETIVO_J_KG, TRANSITO_TICKS, TROUTON_J,
  T_CUERPO, UNIDAD_HUMANA, VENTILACION,
} from '../../shared/naturaleza.js';
import type { PersonView } from '../../shared/types.js';
import type { Animal } from '../animals.js';
import { instalarCuerpoMaterial, type BodyState } from '../body.js';
import { acotarSalud } from '../demography.js';
import type { Violacion } from '../invariantes.js';
import type { Person } from '../mundo/tipos.js';
import type { Aplicado, CtxLey, CtxLeyMateria, Ley } from '../motor/acceso.js';
import { CAMPOS_CUERPO, CUERPO_ANCHO, REF_NULA, TipoIntento, slotDe, type Intento, type Registro } from '../motor/contratos.js';
import { necesidadesDeVista } from '../needs.js';
import { PAGE_CELLS, pageOf, pageOffset } from '../soa/region.js';
import { copiar, crearPlantilla, leerPlantilla } from './copiar.js';
import { fluir } from './fluir.js';
import { conservacion, lotesDeCelda, sustanciasDe, temperaturaDe, type LotesCelda } from './ley-mundo.js';
import { anotarReaccionAplicada } from './reaccion-observada.js';
import { pasoLote, type CtxPaso } from './paso.js';
import { esGasA } from './quimica.js';
import { quemar, romper } from './romper.js';
import {
  Parte, Rol, barreraEfectiva, nivelDeLote,
  type ArenaMateria, type Cuerpo, type Gestacion, type Kappa, type LoteRef, type Pedido, type Plantilla, type ServicioQuimico,
  type Sustancia, type VistaCuerpo,
} from './tipos.js';

// ── Constantes físicas del cuerpo: viven en shared/naturaleza.ts (integrador) y se reexportan aquí ───────────

export {
  ABSORCION_AGUA, AGUA_OBJETIVO_KG_KG, BASAL_J_KG_TICK, CAPACIDAD_GAS_KG, CONDUCTANCIA_PIEL_MAX, CONDUCTANCIA_PIEL_MIN,
  FRACCION_EVAPORATIVA, FRACCION_O2_REFERENCIA, KAPPA_HUMANA, LINAJE_HUMANO, MASA_ADULTA_HUMANA, REPARTO_AGUA_TUBO,
  RESERVA_OBJETIVO_J_KG, TRANSITO_TICKS, TROUTON_J, T_CUERPO, UNIDAD_HUMANA, VENTILACION,
};

// ── Acceso al entorno ────────────────────────────────────────────────────────────────────────────────────

/** Lo que el cuerpo lee del mundo material (carril w). Es un objeto para que una prueba unitaria pueda poner el suyo. */
export const entorno = {
  sustancias: sustanciasDe, lotes: lotesDeCelda, temperatura: temperaturaDe, conservacion,
};

const E_H = ELEMENTOS.indexOf('H'), E_C = ELEMENTOS.indexOf('C'), E_O = ELEMENTOS.indexOf('O');
const MG = 1e-6; // kg por mg

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const acotar = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
/** Entero con esperanza x (sin sesgo hacia el flujo nulo cuando x < 1). */
const entero = (x: number, azar: () => number): number => {
  if (!(x > 0)) return 0;
  const piso = Math.floor(x);
  return piso + (azar() < x - piso ? 1 : 0);
};

const EXACTA: Pedido = { parte: Parte.Exacta, esp: 0, cuantos: 0, kappa: null };
const exacta = (esp: SustanciaId, cuantos: number): Pedido => { EXACTA.esp = esp; EXACTA.cuantos = cuantos; return EXACTA; };
const TODO: Pedido = { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null };
const SIN_MATERIA = new Float64Array(0);
/** Solo su signo cuenta para `nivelDeLote`: el metabolismo es enzimático, como en `quemar`. */
const CATALIZADO: Kappa = [1, 1, 1, 1];

const pasos = new WeakMap<object, CtxPaso>();
function pasoDe(c: CtxLeyMateria): CtxPaso {
  let p = pasos.get(c);
  if (!p) {
    p = { arena: c.materia, quimica: c.quimica, azar: () => c.azar() };
    p.anotar = (reaccion, veces, lote) => {
      anotarReaccionAplicada(c.materia, reaccion, veces, lote, c.tick);
      p!.anotar = undefined;
    };
    pasos.set(c, p);
  }
  return p;
}

function conMateria(c: CtxLey): CtxLeyMateria {
  const m = c as Partial<CtxLeyMateria>;
  if (!m.materia || !m.quimica) throw new Error('b: v23.cuerpos exige v23.materia en el contexto del dueño.');
  return c as CtxLeyMateria;
}

// ── Lotes: sumas sobre lo que contienen ──────────────────────────────────────────────────────────────────

let IDS = new Uint32Array(32), CUANTOS = new Float64Array(IDS.length);
/** Las sustancias y sus cantidades valen hasta la siguiente lectura. */
function leer(a: ArenaMateria, l: LoteRef, cantidades = false): number {
  let n = a.especies(l, IDS, cantidades ? CUANTOS : undefined);
  if (n > IDS.length) {
    IDS = new Uint32Array(2 * n);
    CUANTOS = new Float64Array(IDS.length);
    n = a.especies(l, IDS, cantidades ? CUANTOS : undefined);
  }
  return n;
}
/** Copia ordenada por id: lo que ocurre no depende de la ranura, y el bucle puede mover materia. */
const especiesDe = (a: ArenaMateria, l: LoteRef): Uint32Array => IDS.slice(0, leer(a, l)).sort();

function atomosDeSustancia(s: Readonly<Sustancia>): number {
  let n = 0;
  for (let k = 0; k < NE; k++) n += s.atomos[k]!;
  return n;
}
function atomosDe(c: CtxLeyMateria, l: LoteRef): number {
  const q = c.quimica, n = leer(c.materia, l, true);
  let total = 0;
  for (let i = 0; i < n; i++) total += CUANTOS[i]! * atomosDeSustancia(q.sustancia(IDS[i]!));
  return total;
}
/** Masa de un lote en kg. */
export function masaLote(c: CtxLeyMateria, l: LoteRef): number {
  const q = c.quimica, n = leer(c.materia, l, true);
  let mg = 0;
  for (let i = 0; i < n; i++) mg += CUANTOS[i]! * q.sustancia(IDS[i]!).masa;
  return mg * MG;
}
function cuantosTotales(a: ArenaMateria, l: LoteRef): number {
  const n = leer(a, l, true);
  let total = 0;
  for (let i = 0; i < n; i++) total += CUANTOS[i]!;
  return total;
}
function temperaturaLote(c: CtxLeyMateria, l: LoteRef): number {
  const atomos = atomosDe(c, l);
  return atomos > 0 ? c.materia.calor(l) / (CAPACIDAD_ATOMO * atomos) : 0;
}

/** Combustible limpio: solo C, H y O, y arde. Lo que la reserva puede guardar y `quemar` sin perder N ni soltar H₂. */
function limpio(s: Readonly<Sustancia>): boolean {
  for (let k = 0; k < NE; k++) if (k !== E_H && k !== E_C && k !== E_O && s.atomos[k]) return false;
  return s.prop.qOxidacion > 0;
}

// ── Plantillas ───────────────────────────────────────────────────────────────────────────────────────────

const memoPlantillas = new WeakMap<Registro, Map<number, Plantilla>>();
function memoDe(reg: Registro): Map<number, Plantilla> {
  let m = memoPlantillas.get(reg);
  if (!m) memoPlantillas.set(reg, m = new Map());
  return m;
}

/** Plantilla por su id del `Registro`. Lanza si no existe. */
export function plantillaPorId(c: CtxLeyMateria, id: number): Plantilla {
  const reg = c.globales.registro, memo = memoDe(reg);
  let p = memo.get(id);
  if (!p) {
    const bytes = reg.leer(id);
    if (!bytes) throw new Error(`b: la plantilla ${id} no está en el Registro.`);
    memo.set(id, p = leerPlantilla(id, bytes));
  }
  return p;
}

const humanas = new WeakMap<Registro, Plantilla>();
/** La plantilla humana fundadora. Su síntesis es una asimilación (toma del digestivo y de la reserva las mismas
 * sustancias de que está hecha, dH = 0): crecer y gestar se pagan en átomos; el `Registro` da el mismo id en todo hilo. */
export function plantillaHumana(c: CtxLeyMateria): Plantilla {
  const reg = c.globales.registro;
  let p = humanas.get(reg);
  if (p) return p;
  const S = entorno.sustancias(c), U = UNIDAD_HUMANA;
  const nueva = crearPlantilla(c.quimica, reg, {
    partes: [{ id: S.H2O, nu: U.H2O }, { id: S.proteina, nu: U.proteina }, { id: S.CH2, nu: U.CH2 }, { id: S.orgP, nu: U.orgP }],
    entradas: [S.proteina, S.CH2, S.orgP, S.H2O], subproductos: [],
    kappa: KAPPA_HUMANA, captura: 0, masaAdulta: MASA_ADULTA_HUMANA, m0: M0 * MASA_ADULTA_HUMANA, linaje: LINAJE_HUMANO,
  });
  if (!nueva) throw new Error('b: la plantilla humana no se balancea con las sustancias del mundo.');
  p = memoDe(reg).get(nueva.id) ?? nueva;
  memoDe(reg).set(p.id, p);
  humanas.set(reg, p);
  return p;
}

/** Lo que se deriva una vez de una plantilla. */
interface Datos {
  masaMg: number;            // mg de una unidad
  atomos: number;            // cuantos de átomos de una unidad
  masaSecaMg: number;        // mg medios por cuanto de sus partes que no son agua (para pasar kg de comida a cuantos)
  combustible: SustanciaId;  // su parte limpia de más J por mg: con ella se funda la reserva (0: ninguna)
  jCombustible: number;      // J por cuanto de esa parte
  jPorO2: number;            // J que libera por cuanto de O₂ al quemarla (escala de la vista de energía)
  fibra: SustanciaId;        // su parte estructural (ni agua ni combustible) de más masa: lo que se esquila (0: ninguna)
}
const datos = new WeakMap<Plantilla, Datos>();
function datosDe(c: CtxLeyMateria, p: Plantilla): Datos {
  let d = datos.get(p);
  if (d) return d;
  const q = c.quimica, agua = entorno.sustancias(c).H2O;
  let masaMg = 0, atomos = 0, seca = 0, cuantosSecos = 0, combustible = 0, jPorMg = 0, fibra = 0, masaFibra = 0;
  for (const t of p.partes) {
    const s = q.sustancia(t.id), m = t.nu * s.masa;
    masaMg += m;
    atomos += t.nu * atomosDeSustancia(s);
    if (t.id === agua) continue;
    seca += m; cuantosSecos += t.nu;
    if (limpio(s)) { if (s.prop.qOxidacion / s.masa > jPorMg) { jPorMg = s.prop.qOxidacion / s.masa; combustible = t.id; } }
    else if (m > masaFibra) { masaFibra = m; fibra = t.id; }
  }
  let jCombustible = 0, jPorO2 = 0;
  if (combustible) {
    const s = q.sustancia(combustible), o2 = s.atomos[E_C]! + s.atomos[E_H]! / 4 - s.atomos[E_O]! / 2;
    jCombustible = s.prop.qOxidacion;
    jPorO2 = o2 > 0 ? jCombustible / o2 : 0;
  }
  datos.set(p, d = { masaMg, atomos, masaSecaMg: cuantosSecos > 0 ? seca / cuantosSecos : masaMg, combustible, jCombustible, jPorO2, fibra });
  return d;
}

/** Unidades completas de `p` que hay en un lote (ley del mínimo sobre sus partes). */
function unidades(a: ArenaMateria, l: LoteRef, p: Plantilla): number {
  let u = Infinity;
  for (const t of p.partes) u = Math.min(u, a.cuantos(l, t.id) / t.nu);
  return u === Infinity ? 0 : u;
}

// ── Cuerpo: crear y leer ─────────────────────────────────────────────────────────────────────────────────

/** T del aire que vio cada cuerpo en su último `metabolizar` (para `basalJ`, que no recibe la celda). Solo acelera:
 * si falta (cuerpo recién llegado a este dueño), `basalJ` devuelve el mantenimiento sin el coste del frío. */
const ambiente = new WeakMap<Cuerpo, number>();
/** Contexto del dueño de cada cuerpo, para las funciones heredadas de `body.ts`, que solo reciben el cuerpo escalar. */
const contextos = new WeakMap<Cuerpo, CtxLeyMateria>();

export const leyCuerpos: Ley = {
  id: 'b', interruptor: 'cuerpos',
  iniciar, alAdoptar, F4, F6, aplicar: { Golpear: aplicarGolpe }, proyectar: { persona: proyectarPersona }, comprobar,
};

/** Cuerpo nuevo de `masaKg` kg con la plantilla `plantilla` (id del `Registro`), como FUENTE DECLARADA («fundación»): solo
 * para fundadores, S e I y la fauna que se materializa con su chunk. Las crías nacen con `parir`, que no crea nada. */
export function crearCuerpo(c: CtxLeyMateria, plantilla: number, masaKg: number): Cuerpo {
  return fundarCuerpo(c, plantilla, masaKg, 1, 1);
}

/** Como `crearCuerpo`, eligiendo cuánto de la reserva de energía y del agua libre trae (fracción de su objetivo): así un
 * mundo que enciende la ley a mitad de vida funda cada cuerpo con el hambre y la sed que su persona tenía. */
export function fundarCuerpo(c: CtxLeyMateria, plantilla: number, masaKg: number, reserva: number, agua: number): Cuerpo {
  const a = c.materia, q = c.quimica, S = entorno.sustancias(c), p = plantillaPorId(c, plantilla), d = datosDe(c, p);
  if (!(masaKg > 0) || !(d.masaMg > 0)) throw new RangeError(`b: masa de cuerpo inválida (${masaKg} kg).`);
  const cuerpo: Cuerpo = {
    tejido: a.nuevo(Rol.Tejido, -1, 0), reserva: a.nuevo(Rol.Reserva, -1, 0), digestivo: a.nuevo(Rol.Digestivo, -1, 0),
    plantilla, gestacion: undefined,
  };
  const u = Math.max(1, Math.round(masaKg / (d.masaMg * MG))), kg = u * d.masaMg * MG;
  const pares: number[] = [];
  for (const t of p.partes) pares.push(t.id, t.nu * u);
  pares.push(0, Math.round(T_CUERPO * CAPACIDAD_ATOMO * u * d.atomos));
  a.fuente(cuerpo.tejido, Float64Array.from(pares), c.libro);

  pares.length = 0;
  let atomos = 0;
  const poner = (id: SustanciaId, cuantos: number): void => {
    if (!(cuantos >= 1)) return;
    pares.push(id, cuantos);
    atomos += cuantos * atomosDeSustancia(q.sustancia(id));
  };
  if (d.combustible) poner(d.combustible, Math.round(clamp01(reserva) * RESERVA_OBJETIVO_J_KG * kg / d.jCombustible));
  poner(S.H2O, Math.round(clamp01(agua) * AGUA_OBJETIVO_KG_KG * kg / (q.sustancia(S.H2O).masa * MG)));
  poner(S.O2, Math.round(CAPACIDAD_GAS_KG * FRACCION_O2_REFERENCIA * kg));
  if (atomos > 0) {
    pares.push(0, Math.round(T_CUERPO * CAPACIDAD_ATOMO * atomos));
    a.fuente(cuerpo.reserva, Float64Array.from(pares), c.libro);
  }
  contextos.set(cuerpo, c);
  return cuerpo;
}

/** La plantilla de un cuerpo (leída del `Registro`). */
export function plantillaDe(c: CtxLeyMateria, cuerpo: Cuerpo): Plantilla { return plantillaPorId(c, cuerpo.plantilla); }

type VistaNecesidades = Pick<VistaCuerpo, 'hambre' | 'sed' | 'energia' | 'salud'>;

/** Rellena las necesidades y la salud de tejido. Devuelve los kg de tejido para la vista completa. */
function vistaNecesidades(c: CtxLeyMateria, cuerpo: Cuerpo, out: VistaNecesidades): number {
  const a = c.materia, S = entorno.sustancias(c), p = plantillaDe(c, cuerpo), d = datosDe(c, p);
  const tejido = masaLote(c, cuerpo.tejido);
  // Los objetivos crecen con el tejido; sin tejido no hay objetivo y todo lo que falta, falta entero.
  const hay = tejido > 0;
  const j = reservaJ(c, cuerpo);
  out.hambre = hay ? 1 - clamp01(j / (RESERVA_OBJETIVO_J_KG * tejido)) : 1;
  out.sed = hay ? 1 - clamp01(a.cuantos(cuerpo.reserva, S.H2O) * c.quimica.sustancia(S.H2O).masa * MG / (AGUA_OBJETIVO_KG_KG * tejido)) : 1;
  // Lo que puede gastar de golpe lo limita el reactivo más escaso de `quemar`: el O₂ de la reserva o el combustible.
  // Sin combustible no hay trabajo que pagar aunque el pulmón esté lleno.
  const o2J = a.cuantos(cuerpo.reserva, S.O2) * d.jPorO2;
  const lleno = CAPACIDAD_GAS_KG * FRACCION_O2_REFERENCIA * tejido;
  out.energia = !hay ? 0 : d.jPorO2 > 0 ? clamp01(Math.min(o2J, j) / (lleno * d.jPorO2)) : clamp01(a.cuantos(cuerpo.reserva, S.O2) / lleno);
  out.salud = clamp01(unidades(a, cuerpo.tejido, p) * d.masaMg * MG / p.masaAdulta);
  return tejido;
}

/** Rellena `out` con las vistas del cuerpo: lo que `choose` y la columna `cuerpo` del frente leen. `carga` queda en 0:
 * el cuerpo no sabe qué lleva su organismo (la pone quien tiene la lista, con `cargaKg`). */
export function vistaCuerpo(c: CtxLeyMateria, cuerpo: Cuerpo, out: VistaCuerpo): VistaCuerpo {
  const tejido = vistaNecesidades(c, cuerpo, out);
  out.masa = tejido + masaLote(c, cuerpo.reserva) + masaLote(c, cuerpo.digestivo);
  out.carga = 0;
  out.T = temperaturaLote(c, cuerpo.tejido);
  return out;
}

/** Masa total en kg (tejido + reserva + digestivo; sin embrión ni carga). */
export function masaDe(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  return masaLote(c, cuerpo.tejido) + masaLote(c, cuerpo.reserva) + masaLote(c, cuerpo.digestivo);
}

/** J que libera la oxidación completa de la reserva: lo que el cuerpo puede pagar. */
export function reservaJ(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  const q = c.quimica, n = leer(c.materia, cuerpo.reserva, true);
  let j = 0;
  for (let i = 0; i < n; i++) j += CUANTOS[i]! * q.sustancia(IDS[i]!).prop.qOxidacion;
  return j;
}

/** J de trabajo que da la reserva de O₂ llena: la escala de la vista de energía (lo que el cuerpo puede gastar de golpe). */
export function energiaObjetivoJ(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  const d = datosDe(c, plantillaDe(c, cuerpo));
  return CAPACIDAD_GAS_KG * FRACCION_O2_REFERENCIA * masaLote(c, cuerpo.tejido) * d.jPorO2;
}

/** J que el metabolismo basal de este cuerpo quema en `dt` ticks (crece con la masa y con la T del aire que lo rodea).
 * Es el mayor de dos gastos: el mantenimiento (por kg de tejido) y el calor que hay que producir para sostener T_CUERPO
 * con la piel cerrada, que sube cuanto más frío está el aire que el cuerpo vio en su último paso. */
export function basalJ(c: CtxLeyMateria, cuerpo: Cuerpo, dt: number): number {
  const masa = masaLote(c, cuerpo.tejido), mantenimiento = BASAL_J_KG_TICK * masa * dt, aire = ambiente.get(cuerpo);
  if (aire === undefined) return mantenimiento;
  const frio = CONDUCTANCIA_PIEL_MIN * masa ** (2 / 3) * (T_CUERPO - aire) * dt;
  return Math.max(mantenimiento, FRACCION_EVAPORATIVA * mantenimiento + frio);
}

/** Máximo de J que una gestación completa puede retirar de la reserva. Las entradas que solo están en el tubo se
 * transfieren como materia ya formada: su energía de oxidación no se cobra otra vez. */
export function costeGestacionJ(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  const p = plantillaDe(c, cuerpo), d = datosDe(c, p);
  let jPorUnidad = Math.max(0, p.sintesis.dH) / ETA;
  for (const parte of p.sintesis.entradas) {
    const sustancia = c.quimica.sustancia(parte.id);
    if (limpio(sustancia)) jPorUnidad += parte.nu * sustancia.prop.qOxidacion;
  }
  return p.m0 / (d.masaMg * MG) * jPorUnidad;
}

/** Paga `julios` de trabajo quemando reserva con O₂ (`quemar`, nunca proteína ni NH₃). Devuelve los J pagados
 * (menos si la reserva no alcanza): quien llama hace solo la parte del trabajo que se pagó. El calor queda en el cuerpo
 * y el termostato lo saca en su siguiente paso. Lo que limita un esfuerzo grande es el O₂ de la reserva (la energía). */
export function pagar(c: CtxLeyMateria, cuerpo: Cuerpo, julios: number): number {
  if (!(julios > 0)) return 0;
  return Math.min(julios, quemar(c.materia, c.quimica, cuerpo.reserva, entorno.sustancias(c).O2, julios));
}

// ── Metabolismo ──────────────────────────────────────────────────────────────────────────────────────────

const CELDA: LotesCelda = { suelo: REF_NULA, agua: REF_NULA, vida: REF_NULA, aire: REF_NULA };
// J/cuanto: durante la síntesis humana se conserva el N ligado. A 310 K la desaminación a κ_C–N = 72 consume
// más de la mitad de la proteína en 300 ticks, menos de un tránsito digestivo.
const KAPPA_ASIMILACION_HUMANA: Kappa = [KAPPA_HUMANA[0], KAPPA0, KAPPA_HUMANA[2], KAPPA_HUMANA[3]];

/** Un paso de `dt` ticks del cuerpo: digestión (`pasoLote` del digestivo con la κ de su plantilla), absorción hacia la
 * reserva y el tejido, basal pagado, intercambio de gases y calor con el aire de `celda` y excreción a su Suelo. */
export function metabolizar(c: CtxLeyMateria, cuerpo: Cuerpo, celda: number, dt: number): void {
  if (!(dt > 0)) return;
  const a = c.materia, p = plantillaDe(c, cuerpo);
  const lotes = entorno.lotes(c, celda, CELDA), aire = lotes.aire, suelo = lotes.suelo;
  const masa = masaLote(c, cuerpo.tejido);
  contextos.set(cuerpo, c);
  if (leer(a, cuerpo.digestivo) > 0) {
    const sintetiza = p === humanas.get(c.globales.registro) && (masa < p.masaAdulta || cuerpo.gestacion !== undefined);
    pasoLote(pasoDe(c), cuerpo.digestivo, dt, sintetiza ? KAPPA_ASIMILACION_HUMANA : p.kappa);
    absorber(c, cuerpo, p, dt);
  }
  if (aire >= 0) respirar(c, cuerpo, aire, masa, dt);
  pagar(c, cuerpo, BASAL_J_KG_TICK * masa * dt);
  termorregular(c, cuerpo, aire, aire >= 0 ? entorno.temperatura(c, celda) : T_CUERPO, masa, dt);
  if (suelo >= 0) excretar(c, cuerpo, suelo, dt);
}

/** 1/tick: tasa a la que un tubo con catálisis `kappa` a T K entrega un combustible limpio a la reserva: la de Arrhenius
 * de su oxidación catalizada, la misma con que la arena define lo digerible. 0 si no es combustible limpio. */
function tasaAbsorcion(q: ServicioQuimico, kappa: Kappa, id: SustanciaId, O2: SustanciaId, T: number): number {
  if (id === O2 || !limpio(q.sustancia(id))) return 0;
  const r = q.reaccion(id, O2, nivelDeLote(T, kappa));
  if (!r || r.dH >= 0) return 0;
  return NU * Math.exp(-barreraEfectiva(r, kappa) / (R * T));
}

/** Del tubo a la reserva: cada combustible limpio a su tasa catalizada (transporte activo, en un solo sentido) y el agua
 * por ósmosis en los dos (`fluir`): lo bebido entra y un tubo vacío retiene su parte del agua libre, que sale con las heces. */
function absorber(c: CtxLeyMateria, cuerpo: Cuerpo, p: Plantilla, dt: number): void {
  const a = c.materia, q = c.quimica, S = entorno.sustancias(c), tubo = cuerpo.digestivo, azar = pasoDe(c).azar;
  const T = temperaturaLote(c, tubo);
  if (T > 0) {
    for (const id of especiesDe(a, tubo)) {
      const k = tasaAbsorcion(q, p.kappa, id, S.O2, T);
      if (!(k > 0)) continue;
      const n = entero(a.cuantos(tubo, id) * -Math.expm1(-k * dt), azar);
      if (n > 0) a.moverParte(tubo, cuerpo.reserva, exacta(id, n));
    }
  }
  fluir(pasoDe(c), tubo, cuerpo.reserva, S.H2O, ABSORCION_AGUA * REPARTO_AGUA_TUBO, REPARTO_AGUA_TUBO, 1, 0, dt);
}

/** Qué gases cruzan el pulmón: los que a T_CUERPO son gas y no arden con O₂ (O₂, CO₂, N₂…). Un gas combustible o con N
 * (H₂, NH₃) no entra en la reserva: `quemar` lo quemaría. El agua sale por evaporación, no por aquí. */
const pulmonar = new WeakMap<ServicioQuimico, Map<SustanciaId, boolean>>();
function cruzaPulmon(c: CtxLeyMateria, id: SustanciaId, O2: SustanciaId, agua: SustanciaId): boolean {
  if (id === O2) return true;
  if (id === agua) return false;
  let memo = pulmonar.get(c.quimica);
  if (!memo) pulmonar.set(c.quimica, memo = new Map());
  const sabido = memo.get(id);
  if (sabido !== undefined) return sabido;
  const s = c.quimica.sustancia(id);
  if (!esGasA(s, T_CUERPO)) { memo.set(id, false); return false; }
  const r = c.quimica.reaccion(id, O2, nivelDeLote(T_CUERPO, CATALIZADO));
  if (r === undefined) return false; // Q aún no la tiene: este tick no cruza
  const cruza = r === null || r.dH >= 0;
  memo.set(id, cruza);
  return cruza;
}

/** Gases entre la reserva y el aire de la página: cada uno hacia el equilibrio con su fracción molar en el aire. */
function respirar(c: CtxLeyMateria, cuerpo: Cuerpo, aire: LoteRef, masa: number, dt: number): void {
  const a = c.materia, S = entorno.sustancias(c), total = cuantosTotales(a, aire), capacidad = CAPACIDAD_GAS_KG * masa;
  if (!(total > 0 && capacidad > 0)) return;
  const paso = pasoDe(c), g = VENTILACION * capacidad;
  for (const id of especiesDe(a, aire)) {
    if (cruzaPulmon(c, id, S.O2, S.H2O)) fluir(paso, aire, cuerpo.reserva, id, g, total, capacidad, 0, dt);
  }
  // Lo que solo está en la reserva (el CO₂ recién quemado en un aire sin CO₂) también sale.
  for (const id of especiesDe(a, cuerpo.reserva)) {
    if (a.cuantos(aire, id) === 0 && cruzaPulmon(c, id, S.O2, S.H2O)) fluir(paso, cuerpo.reserva, aire, id, g, capacidad, total, 0, dt);
  }
}

/** Reparte el calor de los lotes del cuerpo en proporción a sus átomos (la sangre los deja a la misma T). */
function repartirCalor(c: CtxLeyMateria, lotes: readonly LoteRef[]): void {
  const a = c.materia, atomos: number[] = [];
  let calor = 0, total = 0, mayor = 0;
  for (let i = 0; i < lotes.length; i++) {
    atomos.push(atomosDe(c, lotes[i]!));
    total += atomos[i]!; calor += a.calor(lotes[i]!);
    if (atomos[i]! > atomos[mayor]!) mayor = i;
  }
  if (!(total > 0)) return;
  const objetivo = atomos.map((n) => Math.min(calor, Math.floor(calor * (n / total))));
  for (let i = 0; i < lotes.length; i++) {
    if (i === mayor) continue;
    const sobra = a.calor(lotes[i]!) - objetivo[i]!;
    if (sobra > 0) a.moverCalor(lotes[i]!, lotes[mayor]!, sobra);
  }
  for (let i = 0; i < lotes.length; i++) {
    if (i === mayor) continue;
    const falta = objetivo[i]! - a.calor(lotes[i]!);
    if (falta > 0) a.moverCalor(lotes[mayor]!, lotes[i]!, falta);
  }
}

function calorDe(a: ArenaMateria, lotes: readonly LoteRef[]): number {
  let j = 0;
  for (const l of lotes) j += a.calor(l);
  return j;
}

/**
 * Termostato. Cuenta todo el calor que hay en el cuerpo, venga de donde venga (lo quemado, la digestión, lo que `copiar`
 * trajo con cada entrada, la comida fría): primero la evaporación obligada de la respiración, después la piel conduce
 * hacia el aire con la conductancia que más acerca a T_CUERPO dentro de su intervalo, lo que aún sobra se suda (agua
 * libre que se lleva su calor de vaporización al aire) y lo que falta se tirita (quemar reserva). Todo son traslados
 * entre lotes: el calor del cuerpo acaba en el aire de la página, que es de W.
 */
function termorregular(c: CtxLeyMateria, cuerpo: Cuerpo, aire: LoteRef, tAire: number, masa: number, dt: number): void {
  const a = c.materia, q = c.quimica, S = entorno.sustancias(c), azar = pasoDe(c).azar;
  const lotes = lotesDe(cuerpo, []);
  let atomos = 0;
  for (const l of lotes) atomos += atomosDe(c, l);
  if (!(atomos > 0)) return;
  const capacidad = CAPACIDAD_ATOMO * atomos, objetivo = T_CUERPO * capacidad;
  if (aire >= 0 && a.calor(cuerpo.tejido) > 0) {
    ambiente.set(cuerpo, tAire);
    const vapor = TROUTON_J * q.sustancia(S.H2O).prop.tEbullicion; // J por cuanto de agua evaporada
    const evaporar = (julios: number): void => {
      const n = Math.min(entero(julios / vapor, azar), a.cuantos(cuerpo.reserva, S.H2O));
      if (n <= 0) return;
      const salio = a.moverParte(cuerpo.reserva, aire, exacta(S.H2O, n));
      a.moverCalor(cuerpo.tejido, aire, Math.round(salio * vapor));
    };
    evaporar(FRACCION_EVAPORATIVA * BASAL_J_KG_TICK * masa * dt);
    let calor = calorDe(a, lotes);
    const tCuerpo = calor / capacidad, salto = tCuerpo - tAire, area = masa ** (2 / 3);
    const piel = area * (salto > 0 && calor > objetivo
      ? acotar((calor - objetivo) / (salto * area * dt), CONDUCTANCIA_PIEL_MIN, CONDUCTANCIA_PIEL_MAX) : CONDUCTANCIA_PIEL_MIN);
    // El aire de la página es un baño frente al cuerpo: relajación exponencial, nunca cruza el equilibrio.
    const flujo = Math.abs(salto) * capacidad * -Math.expm1(-piel * dt / capacidad);
    if (salto > 0) calor -= a.moverCalor(cuerpo.tejido, aire, entero(flujo, azar));
    else if (salto < 0) calor += a.moverCalor(aire, cuerpo.tejido, entero(flujo, azar));
    if (calor > objetivo) evaporar(calor - objetivo);
  }
  const falta = objetivo - calorDe(a, lotes);
  if (falta >= 1) quemar(a, q, cuerpo.reserva, S.O2, falta);
  repartirCalor(c, lotes);
}

/** Tránsito: en `dt` sale al Suelo la fracción 1 − e^(−dt/TRANSITO_TICKS) de todo lo que queda en el tubo. */
function excretar(c: CtxLeyMateria, cuerpo: Cuerpo, suelo: LoteRef, dt: number): void {
  const a = c.materia, azar = pasoDe(c).azar, f = -Math.expm1(-dt / TRANSITO_TICKS);
  for (const id of especiesDe(a, cuerpo.digestivo)) {
    const n = entero(a.cuantos(cuerpo.digestivo, id) * f, azar);
    if (n > 0) a.moverParte(cuerpo.digestivo, suelo, exacta(id, n));
  }
}

/** Hambre y sed que un cuerpo en reposo y en aire templado gana por tick (para las previsiones de `needRates`): el
 * mantenimiento sobre el objetivo de la reserva, y la evaporación obligada más el agua que el tránsito saca sobre el
 * objetivo de agua. No dependen de la masa: gasto y objetivo crecen los dos con el tejido. */
export function tasasBasales(c: CtxLeyMateria, out: { hunger: number; thirst: number }): { hunger: number; thirst: number } {
  const agua = c.quimica.sustancia(entorno.sustancias(c).H2O);
  out.hunger = BASAL_J_KG_TICK / RESERVA_OBJETIVO_J_KG;
  out.thirst = aguaBasalPorTick(agua);
  return out;
}

/** Fracción de la reserva de agua que se pierde por tick en reposo y con aire templado. */
function aguaBasalPorTick(agua: Readonly<Sustancia>): number {
  const evaporada = FRACCION_EVAPORATIVA * BASAL_J_KG_TICK / (TROUTON_J * agua.prop.tEbullicion) * agua.masa * MG;
  return evaporada / AGUA_OBJETIVO_KG_KG + REPARTO_AGUA_TUBO / (1 + REPARTO_AGUA_TUBO) / TRANSITO_TICKS;
}

// ── Síntesis: crecer y gestar ────────────────────────────────────────────────────────────────────────────

/** Sintetiza en `destino` hasta `maxUnidades` de `p` con átomos de la reserva y el digestivo de `cuerpo`. Si la síntesis
 * es endotérmica, quema antes dH/η por unidad (η queda en enlaces, el resto es calor del cuerpo). Devuelve las hechas. */
function sintetizar(c: CtxLeyMateria, cuerpo: Cuerpo, p: Plantilla, destino: LoteRef, maxUnidades: number): number {
  const a = c.materia, q = c.quimica, e = p.sintesis;
  let n = entero(maxUnidades, pasoDe(c).azar), energia = 0;
  if (n <= 0) return 0;
  if (e.dH > 0) {
    // Liebig antes de quemar: no se paga la síntesis de lo que no hay con qué hacer.
    for (const t of e.entradas) n = Math.min(n, Math.floor((a.cuantos(cuerpo.reserva, t.id) + a.cuantos(cuerpo.digestivo, t.id)) / t.nu));
    if (n <= 0) return 0;
    const quemado = quemar(a, q, cuerpo.reserva, entorno.sustancias(c).O2, n * e.dH / ETA);
    n = Math.min(n, Math.floor(quemado * ETA / e.dH));
    if (n <= 0) return 0;
    energia = a.moverCalor(cuerpo.reserva, destino, n * e.dH);
  }
  return copiar(a, q, p, destino, [cuerpo.reserva, cuerpo.digestivo], cuerpo.digestivo, energia, n);
}

/** La síntesis humana incorpora nutrientes ya formados del tubo. Solo puede usar grasa y agua libres por encima del
 * mantenimiento de un día. El alimento en tránsito cuenta en ese balance: también puede abastecer el mantenimiento. */
function sintetizarTejidoHumano(c: CtxLeyMateria, cuerpo: Cuerpo, p: Plantilla, destino: LoteRef, maxUnidades: number): number {
  const a = c.materia, q = c.quimica, { H2O, CH2 } = entorno.sustancias(c);
  const { digestivo, reserva } = cuerpo;
  let n = entero(maxUnidades, pasoDe(c).azar);
  if (n <= 0) return 0;
  for (const { id, nu } of p.sintesis.entradas) {
    if (id === CH2) n = Math.min(n, Math.floor(grasaTrasBasal(c, cuerpo, CH2) / nu));
    if (id === H2O) n = Math.min(n, Math.floor(aguaTrasBasal(c, cuerpo, H2O) / nu));
  }
  return n > 0 ? copiar(a, q, p, destino, [digestivo, reserva], digestivo, 0, n) : 0;
}

function grasaTrasBasal(c: CtxLeyMateria, cuerpo: Cuerpo, id: SustanciaId): number {
  const a = c.materia, q = c.quimica, sobrante = reservaJ(c, cuerpo) - basalJ(c, cuerpo, DEMOGRAPHY_TICKS_PER_DAY);
  return a.cuantos(cuerpo.digestivo, id) + Math.min(a.cuantos(cuerpo.reserva, id), sobrante / q.sustancia(id).prop.qOxidacion);
}

function aguaTrasBasal(c: CtxLeyMateria, cuerpo: Cuerpo, id: SustanciaId): number {
  const a = c.materia, agua = c.quimica.sustancia(id), masa = masaLote(c, cuerpo.tejido);
  const basal = aguaBasalPorTick(agua) * DEMOGRAPHY_TICKS_PER_DAY * AGUA_OBJETIVO_KG_KG * masa / (agua.masa * MG);
  return a.cuantos(cuerpo.digestivo, id) + a.cuantos(cuerpo.reserva, id) - basal;
}

/** Repone en el tejido la parte que falta para completar unidades (tras esquilar o perder una sola sustancia) con la que
 * haya tal cual en el digestivo o la reserva, al ritmo de la síntesis. Sin esto, crecer por unidades enteras nunca
 * cerraría un déficit de una sola parte. */
function reponer(c: CtxLeyMateria, cuerpo: Cuerpo, p: Plantilla, dt: number): void {
  const a = c.materia, azar = pasoDe(c).azar;
  let marco = 0;
  for (const t of p.partes) marco = Math.max(marco, a.cuantos(cuerpo.tejido, t.id) / t.nu);
  if (!(marco > 0)) return;
  for (const t of p.partes) {
    const falta = Math.floor(marco * t.nu - a.cuantos(cuerpo.tejido, t.id));
    if (falta < 1) continue;
    let n = Math.min(falta, entero(G_SINTESIS * marco * t.nu * dt, azar));
    if (n > 0) n -= a.moverParte(cuerpo.digestivo, cuerpo.tejido, exacta(t.id, n));
    if (n > 0) a.moverParte(cuerpo.reserva, cuerpo.tejido, exacta(t.id, n));
  }
}

/** Crecimiento del tejido hacia la masa adulta de la plantilla durante `dt` ticks (`copiar` desde reserva y digestivo).
 * Devuelve los kg de tejido ganados si se solicita la medida. Curar una herida también recupera masa de tejido. */
export function crecer(c: CtxLeyMateria, cuerpo: Cuerpo, dt: number, medir?: true): number;
export function crecer(c: CtxLeyMateria, cuerpo: Cuerpo, dt: number, medir: false): void;
export function crecer(c: CtxLeyMateria, cuerpo: Cuerpo, dt: number, medir = true): number | void {
  const p = plantillaDe(c, cuerpo), d = datosDe(c, p), antes = medir ? masaLote(c, cuerpo.tejido) : 0;
  reponer(c, cuerpo, p, dt);
  const tiene = masaLote(c, cuerpo.tejido) / (d.masaMg * MG), falta = p.masaAdulta / (d.masaMg * MG) - tiene;
  if (falta > 0) {
    const sintetizarTejido = p === humanas.get(c.globales.registro) ? sintetizarTejidoHumano : sintetizar;
    sintetizarTejido(c, cuerpo, p, cuerpo.tejido, Math.min(falta, G_SINTESIS * tiene * dt));
  }
  if (!medir) return;
  return masaLote(c, cuerpo.tejido) - antes;
}

// ── Comer y beber ────────────────────────────────────────────────────────────────────────────────────────

function unidadesEnTransito(c: CtxLeyMateria, cuerpo: Cuerpo, p: Plantilla): number {
  const masa = masaLote(c, cuerpo.tejido);
  const crecerKg = Math.max(0, Math.min(p.masaAdulta - masa, G_SINTESIS * masa * TRANSITO_TICKS));
  const g = cuerpo.gestacion;
  const gestarKg = g ? Math.max(0, Math.min(p.m0 - masaLote(c, g.embrion), G_SINTESIS * p.m0 * TRANSITO_TICKS)) : 0;
  return Math.floor((crecerKg + gestarKg) / (datosDe(c, p).masaMg * MG));
}

/** Fracción del nutriente estructural que falta para el tejido que puede formarse durante un tránsito del tubo. */
export function apetitoDeTejido(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  const p = plantillaDe(c, cuerpo);
  if (p !== humanas.get(c.globales.registro)) return 0;
  const unidades = unidadesEnTransito(c, cuerpo, p), a = c.materia;
  if (unidades <= 0) return 0;
  const { proteina, orgP } = entorno.sustancias(c);
  let carencia = 0;
  for (const { id, nu } of p.sintesis.entradas) {
    if (id !== proteina && id !== orgP) continue;
    const hay = a.cuantos(cuerpo.digestivo, id) + a.cuantos(cuerpo.reserva, id);
    carencia = Math.max(carencia, 1 - hay / (unidades * nu));
  }
  return carencia;
}

/** kg de agua que faltan para incorporar al tejido los demás nutrientes ya disponibles. */
export function aguaParaTejido(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  const p = plantillaDe(c, cuerpo);
  if (p !== humanas.get(c.globales.registro)) return 0;
  let unidades = unidadesEnTransito(c, cuerpo, p), aguaPorUnidad = 0;
  if (unidades <= 0) return 0;
  const a = c.materia, { H2O, CH2 } = entorno.sustancias(c);
  for (const { id, nu } of p.sintesis.entradas) {
    if (id === H2O) { aguaPorUnidad = nu; continue; }
    const hay = id === CH2 ? grasaTrasBasal(c, cuerpo, id) : a.cuantos(cuerpo.digestivo, id) + a.cuantos(cuerpo.reserva, id);
    unidades = Math.min(unidades, Math.floor(hay / nu));
  }
  if (unidades <= 0) return 0;
  return Math.max(0, unidades * aguaPorUnidad - aguaTrasBasal(c, cuerpo, H2O)) * c.quimica.sustancia(H2O).masa * MG;
}

/** Lo que este cuerpo pide para comer `kg` de un lote: parte Digerible con su κ. */
export function pedidoComida(c: CtxLeyMateria, cuerpo: Cuerpo, kg: number): Pedido {
  const p = plantillaDe(c, cuerpo), d = datosDe(c, p);
  return { parte: Parte.Digerible, esp: 0, cuantos: kg > 0 ? Math.ceil(kg / (d.masaSecaMg * MG)) : 0, kappa: p.kappa };
}

/** Come de un lote PROPIO del dueño (la Vida o un montón de su celda, un objeto que lleva): mueve lo pedido al
 * digestivo. Devuelve los kg ingeridos. De un lote ajeno se come con un intento `Tomar` y luego `abonar`. */
export function ingerir(c: CtxLeyMateria, cuerpo: Cuerpo, de: LoteRef, pedido: Pedido): number {
  const antes = masaLote(c, cuerpo.digestivo);
  c.materia.moverParte(de, cuerpo.digestivo, pedido);
  return masaLote(c, cuerpo.digestivo) - antes;
}

/** Fracción de un cuanto de `id` que este cuerpo aprovecha si lo come: 1 si es una entrada de su síntesis (tejido), y si
 * no, lo que su tubo llega a absorber o a transformar antes de que el tránsito lo saque, k/(k + 1/TRANSITO_TICKS). */
export function provecho(c: CtxLeyMateria, p: Plantilla, id: SustanciaId): number {
  const q = c.quimica, S = entorno.sustancias(c);
  if (id === S.H2O || id === S.O2) return 0;
  for (const t of p.sintesis.entradas) if (t.id === id) return 1;
  let k = tasaAbsorcion(q, p.kappa, id, S.O2, T_CUERPO);
  const sola = q.reaccion(id, 0, nivelDeLote(T_CUERPO, p.kappa));
  if (sola && sola.dH < 0) k += NU * Math.exp(-barreraEfectiva(sola, p.kappa) / (R * T_CUERPO));
  return k > 0 ? k / (k + 1 / TRANSITO_TICKS) : 0;
}

/** Energía comestible y masa de la ración prevista, usando la misma selección que la boca. */
export function energiaAlimento(c: CtxLeyMateria, cuerpo: Cuerpo, lote: LoteRef, kg: number): number {
  return energiaDeLote(c, plantillaDe(c, cuerpo), lote, kg);
}

export type EvaluarAlimento = (lote: LoteRef, kg: number) => number;
type EspecieAlimento = { sustancia: Readonly<Sustancia>; fraccion: number };

/** Solo para una elección síncrona. La primera consulta a Q de cada especie conserva su lugar y sus efectos.
 * No se publica una barrera química entre candidatos, y la composición de cada lote se relee en cada consulta. */
export function evaluadorAlimento(c: CtxLeyMateria, cuerpo: Cuerpo): EvaluarAlimento {
  let plantilla: Plantilla | undefined;
  let especies: Map<SustanciaId, EspecieAlimento> | undefined;
  return (lote, kg) => energiaDeLote(c, plantilla ??= plantillaDe(c, cuerpo), lote, kg, especies ??= new Map());
}

function energiaDeLote(c: CtxLeyMateria, p: Plantilla, lote: LoteRef, kg: number,
  especies?: Map<SustanciaId, EspecieAlimento>): number {
  const n = leer(c.materia, lote, true);
  let energia = 0, masa = 0;
  for (let i = 0; i < n; i++) {
    const id = IDS[i]!, guardada = especies?.get(id);
    const sustancia = guardada?.sustancia ?? c.quimica.sustancia(id);
    const fraccion = guardada?.fraccion ?? provecho(c, p, id);
    if (!guardada) especies?.set(id, { sustancia, fraccion });
    const cuantos = CUANTOS[i]! * fraccion;
    masa += cuantos * sustancia.masa * MG;
    energia += cuantos * sustancia.prop.qOxidacion;
  }
  return masa > 0 ? energia * Math.min(1, kg / masa) : 0;
}

/** Come hasta `kg` de un lote propio eligiendo: de cada sustancia toma en proporción a lo que su cuerpo aprovecha de ella
 * (`provecho`), así que quien no digiere la madera no se llena el tubo de madera. Devuelve los kg ingeridos. */
export function ingerirSelecto(c: CtxLeyMateria, cuerpo: Cuerpo, de: LoteRef, kg: number): number {
  return trasladarAlimento(c, cuerpo, de, cuerpo.digestivo, kg);
}

// Independientes del scratch de masaLote: el traslado usa ambos antes de consumir la selección.
const IDS_ALIMENTO = new Uint32Array(32);
const PARTES_ALIMENTO = new Float64Array(IDS_ALIMENTO.length);

export function trasladarAlimento(c: CtxLeyMateria, cuerpo: Cuerpo, de: LoteRef, destino: LoteRef, kg: number): number {
  if (!(kg > 0)) return 0;
  const a = c.materia, q = c.quimica, p = plantillaDe(c, cuerpo), azar = pasoDe(c).azar;
  const nEspecies = a.especies(de, IDS_ALIMENTO, PARTES_ALIMENTO);
  let ids: Uint32Array = IDS_ALIMENTO, partes = PARTES_ALIMENTO;
  if (nEspecies <= IDS_ALIMENTO.length) {
    // El orden numérico determina la suma y el turno de cada sorteo.
    for (let i = 1; i < nEspecies; i++) {
      const id = ids[i]!, cantidad = partes[i]!;
      let j = i;
      for (; j > 0 && ids[j - 1]! > id; j--) {
        ids[j] = ids[j - 1]!;
        partes[j] = partes[j - 1]!;
      }
      ids[j] = id;
      partes[j] = cantidad;
    }
  } else {
    // Los lotes muy diversos conservan la ordenación nativa, sin un coste cuadrático.
    ids = especiesDe(a, de);
    partes = new Float64Array(ids.length);
    for (let i = 0; i < ids.length; i++) partes[i] = a.cuantos(de, ids[i]!);
  }
  let ofrecido = 0;
  for (let i = 0; i < nEspecies; i++) {
    const id = ids[i]!;
    partes[i] = partes[i]! * provecho(c, p, id);
    ofrecido += partes[i]! * q.sustancia(id).masa * MG;
  }
  if (!(ofrecido > 0)) return 0;
  const escala = Math.min(1, kg / ofrecido), antes = masaLote(c, destino);
  for (let i = 0; i < nEspecies; i++) {
    const n = entero(partes[i]! * escala, azar);
    if (n > 0) a.moverParte(de, destino, exacta(ids[i]!, n));
  }
  return masaLote(c, destino) - antes;
}

/** Bebe hasta `kg` de agua de un lote propio del dueño (charca de su celda, vasija que lleva). Devuelve los kg bebidos. */
export function beber(c: CtxLeyMateria, cuerpo: Cuerpo, de: LoteRef, kg: number): number {
  if (!(kg > 0)) return 0;
  const mg = c.quimica.sustancia(entorno.sustancias(c).H2O).masa;
  const pedido: Pedido = { parte: Parte.Agua, esp: 0, cuantos: Math.ceil(kg / (mg * MG)), kappa: null };
  return c.materia.moverParte(de, cuerpo.digestivo, pedido) * mg * MG;
}

/** Come de la vegetación de una celda propia (su lote Vida), eligiendo lo que aprovecha. Devuelve los kg ingeridos. */
export function comerEnCelda(c: CtxLeyMateria, cuerpo: Cuerpo, celda: number, kg: number): number {
  const vida = entorno.lotes(c, celda, CELDA).vida;
  return vida >= 0 ? ingerirSelecto(c, cuerpo, vida, kg) : 0;
}

/** Bebe de la charca de una celda propia (su lote Agua). Devuelve los kg bebidos (0 si la celda no tiene charca). */
export function beberEnCelda(c: CtxLeyMateria, cuerpo: Cuerpo, celda: number, kg: number): number {
  const agua = entorno.lotes(c, celda, CELDA).agua;
  return agua >= 0 ? beber(c, cuerpo, agua, kg) : 0;
}

/** Abona en el digestivo una garantía recibida (`Concedido` de un `Tomar`) y la descuenta de `c.libro.enVuelo`. */
export function abonar(c: CtxLeyMateria, cuerpo: Cuerpo, garantia: Float64Array): void {
  if (garantia.length > 0) c.materia.abonar(cuerpo.digestivo, garantia, c.libro);
}

// ── Heridas, extracción y muerte ─────────────────────────────────────────────────────────────────────────

const propia = (c: CtxLeyMateria, celda: number): boolean =>
  celda >= 0 && c.terreno.duenoChunk[c.terreno.chunkDe(celda)] === c.hilo;

/** Suma una garantía (pares [id, cuantos]; id 0 = calor) a un acumulado por id. */
function sumarPares(acumulado: Map<number, number>, pares: Float64Array): void {
  for (let i = 0; i + 1 < pares.length; i += 2) acumulado.set(pares[i]!, (acumulado.get(pares[i]!) ?? 0) + pares[i + 1]!);
}
function paresDe(acumulado: Map<number, number>): Float64Array {
  const out = new Float64Array(2 * acumulado.size);
  let i = 0;
  for (const [id, n] of [...acumulado].sort((x, y) => (x[0] === 0 ? 1 : y[0] === 0 ? -1 : x[0] - y[0]))) { out[i++] = id; out[i++] = n; }
  return out;
}

/** Manda una garantía ya debitada al lote de `rol` de una celda de otro dueño. */
export function depositar(c: CtxLeyMateria, celda: number, rol: Rol, forma: number, materia: Float64Array): void {
  if (materia.length === 0) return;
  const dueno = c.terreno.duenoChunk[c.terreno.chunkDe(celda)]!;
  c.buzon.enviar(Math.max(0, dueno), {
    tipo: TipoIntento.Depositar, de: REF_NULA, a: REF_NULA, celda, lote: REF_NULA, nonce: c.id('nonce'),
    materia, dato: Float64Array.of(rol, forma), bytes: null,
  });
}

/** Deja en `celda` un lote que el organismo llevaba (celda −1): pasa entero, con su forma y su calor, a un lote Objeto
 * de la celda (o viaja en un `Depositar` si la celda es de otro dueño) y libera el que se llevaba. Devuelve el lote que
 * queda en el suelo, o REF_NULA si viajó o ya no existía. */
export function soltar(c: CtxLeyMateria, lote: LoteRef, celda: number): LoteRef {
  const a = c.materia;
  if (!a.propio(lote)) return REF_NULA;
  if (celda < 0) throw new Error('b: no se puede soltar un lote fuera de una celda residente.');
  const forma = a.vista(lote).forma;
  let queda: LoteRef = REF_NULA;
  if (propia(c, celda)) {
    queda = a.nuevo(Rol.Objeto, celda, forma);
    a.moverParte(lote, queda, TODO);
  } else depositar(c, celda, Rol.Objeto, forma, Float64Array.from(a.garantizar(lote, TODO, c.libro)));
  a.liberar(lote);
  return queda;
}

/** Golpe recibido (`DATO_GOLPEAR`): desprende tejido con la ley de romper hacia un lote nuevo (carne) que devuelve, y
 * baja la salud en lo desprendido. REF_NULA si el golpe no arrancó nada. La carne nace ligada al organismo (celda −1):
 * quien aplica el golpe la deja en el suelo con `soltar` o se la da a quien golpeó. */
export function herir(c: CtxLeyMateria, cuerpo: Cuerpo, golpe: Float64Array, fraccionEnlaces?: number): LoteRef {
  const a = c.materia, carne = a.nuevo(Rol.Objeto, -1, 0);
  const { cuantos } = romper(a, c.quimica, cuerpo.tejido, carne, golpe, pasoDe(c).azar, fraccionEnlaces);
  if (cuantos > 0) return carne;
  a.liberar(carne);
  return REF_NULA;
}

/** Extracción no letal (f): saca hasta `kg` de la reserva o de la fibra del tejido como garantía para quien la pidió.
 * De la reserva sale la misma fracción de todo lo que no es gas (grasa y agua: la leche); del tejido, su parte
 * estructural de más masa. Lo que se saca del tejido baja la salud hasta que `crecer` lo repone. */
export function extraer(c: CtxLeyMateria, cuerpo: Cuerpo, parte: 'reserva' | 'fibra', kg: number): Float64Array {
  if (!(kg > 0)) return SIN_MATERIA;
  const a = c.materia, q = c.quimica;
  if (parte === 'fibra') {
    const fibra = datosDe(c, plantillaDe(c, cuerpo)).fibra;
    const n = fibra ? Math.floor(kg / (q.sustancia(fibra).masa * MG)) : 0;
    return n > 0 ? Float64Array.from(a.garantizar(cuerpo.tejido, exacta(fibra, n), c.libro)) : SIN_MATERIA;
  }
  const ids = especiesDe(a, cuerpo.reserva).filter((id) => !esGasA(q.sustancia(id), T_CUERPO));
  let masa = 0;
  for (const id of ids) masa += a.cuantos(cuerpo.reserva, id) * q.sustancia(id).masa * MG;
  if (!(masa > 0)) return SIN_MATERIA;
  const f = Math.min(1, kg / masa), acumulado = new Map<number, number>(), azar = pasoDe(c).azar;
  for (const id of ids) {
    const n = entero(a.cuantos(cuerpo.reserva, id) * f, azar);
    if (n > 0) sumarPares(acumulado, a.garantizar(cuerpo.reserva, exacta(id, n), c.libro));
  }
  return paresDe(acumulado);
}

/** La percepción puede vaciarse al retirar una página aunque todavía conserve material en esas coordenadas. */
export function celdaDeMuerte(c: CtxLeyMateria, x: number, y: number): number {
  const t = c.terreno, celda = t.celda(x, y);
  if (celda >= 0) return celda;
  const px = pageOf(x), py = pageOf(y), desplazamiento = pageOffset(x, y), sinLeer = new Float64Array(0);
  for (let pagina = 0; pagina < t.paginas; pagina++) {
    if (t.duenoChunk[pagina]! < 0 || t.paginaX[pagina] !== px || t.paginaY[pagina] !== py) continue;
    const material = pagina * PAGE_CELLS + desplazamiento;
    if (c.materia.lotes(material, Rol.Suelo, sinLeer) > 0) return material;
  }
  throw new Error(`b: falta la celda material de la defunción en (${x}, ${y}).`);
}

/** Muerte: funde tejido, reserva, digestivo y embrión en un lote Cadaver en `celda` (si la celda es de otro chunk, la
 * materia viaja en un `Depositar`) y libera los lotes del cuerpo. Devuelve el cadáver, o REF_NULA si viajó. */
export function morir(c: CtxLeyMateria, cuerpo: Cuerpo, celda: number): LoteRef {
  if (celda < 0) throw new Error('b: un cuerpo no puede morir fuera de una celda residente.');
  const a = c.materia, lotes = lotesDe(cuerpo, []).filter((l) => a.propio(l));
  let cadaver: LoteRef = REF_NULA;
  if (propia(c, celda)) {
    cadaver = a.nuevo(Rol.Cadaver, celda, 0);
    for (const l of lotes) a.moverParte(l, cadaver, TODO);
    if (leer(a, cadaver) === 0 && a.calor(cadaver) === 0) { a.liberar(cadaver); cadaver = REF_NULA; }
  } else {
    const acumulado = new Map<number, number>();
    for (const l of lotes) sumarPares(acumulado, a.garantizar(l, TODO, c.libro));
    depositar(c, celda, Rol.Cadaver, 0, paresDe(acumulado));
  }
  for (const l of lotes) a.liberar(l);
  cuerpo.gestacion = undefined;
  ambiente.delete(cuerpo); contextos.delete(cuerpo);
  return cadaver;
}

// ── Gestación ────────────────────────────────────────────────────────────────────────────────────────────

/** Abre una gestación en `madre` (crea el lote Embrión vacío). La pareja solo aportó información. */
export function concebir(c: CtxLeyMateria, madre: Cuerpo, g: Omit<Gestacion, 'embrion' | 'bajoBasalDesde'>): void {
  if (madre.gestacion) throw new Error('b: el cuerpo ya gesta.');
  madre.gestacion = {
    embrion: c.materia.nuevo(Rol.Embrion, -1, 0), otro: g.otro, genoma: g.genoma, politica: g.politica, inicio: g.inicio,
    bajoBasalDesde: -1,
  };
}

/** Hace crecer el embrión `dt` ticks con átomos de la reserva y el digestivo de la madre (`copiar`; la síntesis se paga
 * quemando reserva). Devuelve la masa del embrión en kg tras el paso; las unidades hechas pueden ser menos que las
 * pedidas. Actualiza `gestacion.bajoBasalDesde`. El embrión se hace con la plantilla de la madre. */
export function gestar(c: CtxLeyMateria, madre: Cuerpo, dt: number): number {
  const g = madre.gestacion;
  if (!g) return 0;
  const p = plantillaDe(c, madre), d = datosDe(c, p);
  const alNacer = p.m0 / (d.masaMg * MG), falta = alNacer - masaLote(c, g.embrion) / (d.masaMg * MG);
  // Una gestación se sostiene si la reserva cubre un día de basal Y el embrión crece (o ya está hecho): un embrión al
  // que la madre no puede dar alguna de sus partes (N, P) no crece y, como el que no se paga, se pierde a los DIAS_ABORTO.
  const sintetizarEmbrion = p === humanas.get(c.globales.registro) ? sintetizarTejidoHumano : sintetizar;
  const hechas = falta > 0 && dt > 0 ? sintetizarEmbrion(c, madre, p, g.embrion, Math.min(falta, G_SINTESIS * alNacer * dt)) : 0;
  const crece = !(falta > 0) || hechas > 0 || !(dt > 0);
  const paga = crece && reservaJ(c, madre) >= basalJ(c, madre, DEMOGRAPHY_TICKS_PER_DAY);
  g.bajoBasalDesde = paga ? -1 : g.bajoBasalDesde < 0 ? c.tick : g.bajoBasalDesde;
  return masaLote(c, g.embrion);
}

/** Aborto: los átomos del embrión vuelven al digestivo de la madre; borra `gestacion`. */
export function abortar(c: CtxLeyMateria, madre: Cuerpo): void {
  const g = madre.gestacion;
  if (!g) return;
  if (c.materia.propio(g.embrion)) {
    c.materia.moverParte(g.embrion, madre.digestivo, TODO);
    c.materia.liberar(g.embrion);
  }
  madre.gestacion = undefined;
}

/** Parto: el embrión pasa a ser el tejido de un cuerpo nuevo, que devuelve; borra `gestacion` de la madre. La reserva de
 * la madre (combustible, agua libre y gases: lo que la placenta comparte) se reparte entre las dos en proporción a su
 * tejido, así que la cría nace con el hambre y la sed de su madre en ese momento. El digestivo nace vacío. No crea ni
 * destruye nada: todo son traslados de la madre a la cría. */
export function parir(c: CtxLeyMateria, madre: Cuerpo): Cuerpo {
  const g = madre.gestacion, a = c.materia;
  if (!g) throw new Error('b: parir exige una gestación abierta.');
  const cria: Cuerpo = {
    tejido: a.nuevo(Rol.Tejido, -1, 0), reserva: a.nuevo(Rol.Reserva, -1, 0), digestivo: a.nuevo(Rol.Digestivo, -1, 0),
    plantilla: madre.plantilla, gestacion: undefined,
  };
  a.moverParte(g.embrion, cria.tejido, TODO);
  a.liberar(g.embrion);
  madre.gestacion = undefined;
  const m = masaLote(c, cria.tejido), f = m / (m + masaLote(c, madre.tejido));
  if (f > 0) {
    for (const id of especiesDe(a, madre.reserva)) {
      const n = Math.floor(a.cuantos(madre.reserva, id) * f);
      if (n > 0) a.moverParte(madre.reserva, cria.reserva, exacta(id, n));
    }
    repartirCalor(c, [cria.tejido, cria.reserva]);
  }
  contextos.set(cria, c);
  return cria;
}

/** Lotes de un cuerpo (tejido, reserva, digestivo y embrión si lo hay), para adoptarlos tras migrar o guardarlos. */
export function lotesDe(cuerpo: Cuerpo, out: LoteRef[]): LoteRef[] {
  out.push(cuerpo.tejido, cuerpo.reserva, cuerpo.digestivo);
  if (cuerpo.gestacion) out.push(cuerpo.gestacion.embrion);
  return out;
}

/** Carga a cuestas en kg: Σ masa de los lotes de `carga` (los `LoteRef` de `Person.carga`). Mover cuesta
 * C_MOVER·(masa + carga)·distancia J, que quien se mueve paga con `pagar`. */
export function cargaKg(c: CtxLeyMateria, carga: readonly LoteRef[]): number {
  let kg = 0;
  for (const l of carga) if (c.materia.vivo(l)) kg += masaLote(c, l);
  return kg;
}

// ── La ley ───────────────────────────────────────────────────────────────────────────────────────────────

const VISTA: VistaCuerpo = { hambre: 0, sed: 0, energia: 0, salud: 0, masa: 0, carga: 0, T: 0 };
const NECESIDADES: VistaNecesidades = { hambre: 0, sed: 0, energia: 0, salud: 0 };
const esPersona = (o: Person | Animal): o is Person => 'demography' in o;
const vive = (persona: Person): boolean => persona.demography.deathCause === null;

/** Vistas del cuerpo de una persona, con lo que lleva a cuestas. */
export function vistaPersona(c: CtxLeyMateria, persona: Person & { cuerpo: Cuerpo }, out: VistaCuerpo): VistaCuerpo {
  vistaCuerpo(c, persona.cuerpo, out);
  out.carga = persona.carga ? cargaKg(c, persona.carga) : 0;
  return out;
}

const conCuerpo = (c: CtxLeyMateria, persona: Person): persona is Person & { cuerpo: Cuerpo } =>
  persona.cuerpo !== undefined && vive(persona) && c.materia.propio(persona.cuerpo.tejido);

/** Funda el cuerpo de las personas propias que no lo tienen. La masa es la que su edad habría alcanzado creciendo sin
 * hambre (m0·e^(G_SINTESIS·edad), hasta la adulta) por la salud que traía; reserva y agua, las de su hambre y su sed. */
function iniciar(c: CtxLey): void {
  const m = conMateria(c), p = plantillaHumana(m);
  for (const persona of c.mundo.people) {
    if (!vive(persona)) continue;
    if (persona.cuerpo && m.materia.vivo(persona.cuerpo.tejido)) { contextos.set(persona.cuerpo, m); continue; }
    const madurez = Math.min(1, M0 * Math.exp(G_SINTESIS * persona.demography.age));
    const masa = p.masaAdulta * madurez * clamp01(persona.demography.health);
    persona.cuerpo = fundarCuerpo(m, p.id, masa > 0 ? masa : p.m0, 1 - persona.hunger, 1 - persona.thirst);
    if (!persona.carga) persona.carga = [];
  }
}

function alAdoptar(c: CtxLey, organismo: Person | Animal): void {
  if (!esPersona(organismo) || !organismo.cuerpo) return; // la fauna adopta los suyos en su ley (f)
  const m = conMateria(c);
  for (const l of lotesDe(organismo.cuerpo, [])) m.materia.adoptar(l);
  if (organismo.carga) for (const l of organismo.carga) if (m.materia.vivo(l)) m.materia.adoptar(l);
  contextos.set(organismo.cuerpo, m);
}

/** F4: cada persona propia metaboliza y crece un tick. La fatiga sigue siendo escalar. */
function F4(c: CtxLey): void {
  const m = conMateria(c);
  for (const persona of c.mundo.people) {
    if (!conCuerpo(m, persona)) continue;
    const celda = c.terreno.celda(persona.x, persona.y);
    if (celda < 0) continue;
    // En F1 ya se abonaron las extracciones del tick anterior: los lotes vacíos son rechazos o cargas consumidas.
    const carga = persona.carga;
    for (let i = (carga?.length ?? 0) - 1; i >= 0; i--) {
      const lote = carga![i]!;
      if (!m.materia.propio(lote) || leer(m.materia, lote) !== 0 || m.materia.calor(lote) !== 0) continue;
      m.materia.liberar(lote);
      carga!.splice(i, 1);
    }
    metabolizar(m, persona.cuerpo, celda, 1);
    crecer(m, persona.cuerpo, 1, false);
    vistaNecesidades(m, persona.cuerpo, NECESIDADES);
    // Un cuerpo sin una sola unidad de tejido completa no sostiene nada: lo que falta, falta entero.
    if (!(NECESIDADES.salud > 0)) {
      NECESIDADES.hambre = 1; NECESIDADES.sed = 1; NECESIDADES.energia = 0;
      acotarSalud(persona.demography, 0);
    }
    necesidadesDeVista(persona, NECESIDADES);
  }
}

/** F6: publica la columna `cuerpo` del frente (`CAMPOS_CUERPO`) de las filas propias. */
function F6(c: CtxLey): void {
  const m = conMateria(c), col = c.escritura.f32('cuerpo'), K = CAMPOS_CUERPO;
  for (const persona of c.mundo.people) {
    if (persona.uid === undefined || !conCuerpo(m, persona)) continue;
    const r = c.ref(persona.uid);
    if (r === REF_NULA) continue;
    const slot = slotDe(r), base = slot * CUERPO_ANCHO;
    vistaPersona(m, persona, VISTA);
    c.escritura.fila(slot);
    col[base + K.hambre] = VISTA.hambre; col[base + K.sed] = VISTA.sed; col[base + K.energia] = VISTA.energia;
    col[base + K.salud] = VISTA.salud; col[base + K.masa] = VISTA.masa; col[base + K.carga] = VISTA.carga; col[base + K.T] = VISTA.T;
  }
}

/** Golpear sobre una persona propia: la hiere y la carne arrancada queda en el suelo de su celda. Lo que no es una
 * persona con cuerpo pasa a la ley siguiente (la fauna, f). */
function aplicarGolpe(c: CtxLey, i: Intento): Aplicado {
  if (i.a === REF_NULA || !i.dato) return 'paso';
  const persona = c.personas.get(slotDe(i.a)), m = conMateria(c);
  if (!persona || persona.uid === undefined || c.ref(persona.uid) !== i.a || !conCuerpo(m, persona)) return 'paso';
  const cuerpo = persona.cuerpo, plantilla = plantillaDe(m, cuerpo);
  const antes = unidades(m.materia, cuerpo.tejido, plantilla);
  const carne = herir(m, cuerpo, i.dato);
  if (carne !== REF_NULA) {
    // Una herida se mide sobre el tejido previo al golpe. Una cría pequeña puede tener todo su tejido sano.
    if (antes > 0) acotarSalud(persona.demography, persona.demography.health * unidades(m.materia, cuerpo.tejido, plantilla) / antes);
    soltar(m, carne, c.terreno.celda(persona.x, persona.y));
  }
  return 'hecho';
}

function proyectarPersona(c: CtxLey, persona: Person, vista: PersonView): void {
  const m = conMateria(c);
  if (!conCuerpo(m, persona)) return;
  const cuerpo = persona.cuerpo, p = plantillaDe(m, cuerpo), g = cuerpo.gestacion;
  vistaPersona(m, persona, VISTA);
  vista.cuerpoVisto = {
    masa: VISTA.masa, masaAdulta: p.masaAdulta, reserva: 1 - VISTA.hambre, agua: 1 - VISTA.sed,
    digestivo: masaLote(m, cuerpo.digestivo), carga: VISTA.carga, T: VISTA.T, principal: m.materia.vista(cuerpo.tejido).principal,
    embrion: g ? { masa: masaLote(m, g.embrion), m0: p.m0, otro: g.otro } : undefined,
  };
}

/** Invariantes del carril sobre lo que este dueño tiene: cada cuerpo vivo tiene sus lotes, son suyos y de nadie más,
 * ningún lote vacío guarda calor, y el libro del dueño cuadra (lo dice w). La arena no lista los lotes ligados a
 * organismo, así que un lote de cuerpo sin cuerpo solo se ve por el libro del mundo, no aquí. */
function comprobar(c: CtxLey): Violacion[] {
  const m = conMateria(c), a = m.materia, v: Violacion[] = [], vistos = new Set<LoteRef>();
  const falla = (id: string, detalle: string, contexto: Record<string, unknown>): void => {
    v.push({ id, gravedad: 'dura', tick: c.tick, detalle, contexto });
  };
  for (const persona of c.mundo.people) {
    if (!vive(persona)) continue;
    if (!persona.cuerpo) { falla('b.sin-cuerpo', 'Persona viva sin cuerpo de átomos.', { persona: persona.id }); continue; }
    for (const l of lotesDe(persona.cuerpo, [])) {
      if (!a.propio(l)) falla('b.lote-perdido', 'Un lote del cuerpo no existe o no es de este dueño.', { persona: persona.id, lote: l });
      else if (vistos.has(l)) falla('b.lote-compartido', 'Dos cuerpos comparten un lote.', { persona: persona.id, lote: l });
      else if (leer(a, l) === 0 && a.calor(l) !== 0) falla('b.calor-sin-materia', 'Lote vacío con calor.', { persona: persona.id, lote: l });
      vistos.add(l);
    }
  }
  const balance = entorno.conservacion(m);
  const descuadre = balance.esperado.findIndex((x, i) => x !== balance.hallado[i]);
  if (descuadre >= 0) {
    falla('b.libro', 'El libro no cuadra: Σ lotes + Σ en vuelo ≠ inicial + fuentes − sumideros.',
      { posicion: descuadre, esperado: String(balance.esperado[descuadre]), hallado: String(balance.hallado[descuadre]) });
  }
  return v;
}

// Con un cuerpo de átomos, el esfuerzo que las funciones heredadas de body.ts cobran en «energía» se paga quemando
// reserva: `fraccion` de la energía llena (el O₂ de la reserva) en julios.
instalarCuerpoMaterial({
  esfuerzo(body: BodyState, fraccion: number): void {
    const cuerpo = (body as { cuerpo?: Cuerpo }).cuerpo, c = cuerpo && contextos.get(cuerpo);
    if (cuerpo && c && fraccion > 0 && c.materia.propio(cuerpo.reserva)) pagar(c, cuerpo, fraccion * energiaObjetivoJ(c, cuerpo));
  },
});
