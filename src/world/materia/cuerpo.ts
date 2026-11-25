/**
 * INTERFAZ PUENTE de los cuerpos de átomos (carril b). El esqueleto lo fijó la preparación de la oleada: b rellena los
 * cuerpos de las funciones y puede añadir exportaciones, pero no cambia estas firmas (las consumen n, f, t1, t2 y act).
 *
 * Un `Cuerpo` (materia/tipos.ts) son tres lotes ligados al organismo (celda −1): Tejido, Reserva y Digestivo, más el
 * Embrión de `gestacion`. Todo lo que entra o sale pasa por estas funciones, que solo tocan lotes del dueño que llama:
 * lo ajeno llega antes por intento y se abona aquí. Nada se crea ni se destruye salvo en `crearCuerpo` (fuente declarada).
 */
import { sinImplementar, type CtxLeyMateria, type Ley } from '../motor/acceso.js';
import type { Cuerpo, Gestacion, LoteRef, Pedido, Plantilla, VistaCuerpo } from './tipos.js';

export const leyCuerpos: Ley = { id: 'b', interruptor: 'cuerpos' };

/** Cuerpo nuevo de `masaKg` kg con la plantilla `plantilla` (id del `Registro`), como FUENTE DECLARADA («fundación»): solo
 * para fundadores, S e I y la fauna que se materializa con su chunk. Las crías nacen con `parir`, que no crea nada. */
export function crearCuerpo(c: CtxLeyMateria, plantilla: number, masaKg: number): Cuerpo { return sinImplementar('b: crearCuerpo'); }
/** La plantilla de un cuerpo (leída del `Registro`). */
export function plantillaDe(c: CtxLeyMateria, cuerpo: Cuerpo): Plantilla { return sinImplementar('b: plantillaDe'); }
/** Rellena `out` con las vistas del cuerpo: lo que `choose` y la columna `cuerpo` del frente leen. */
export function vistaCuerpo(c: CtxLeyMateria, cuerpo: Cuerpo, out: VistaCuerpo): VistaCuerpo { return sinImplementar('b: vistaCuerpo'); }
/** Masa total en kg (tejido + reserva + digestivo; sin embrión ni carga). */
export function masaDe(c: CtxLeyMateria, cuerpo: Cuerpo): number { return sinImplementar('b: masaDe'); }

/** J que libera la oxidación completa de la reserva: lo que el cuerpo puede pagar. */
export function reservaJ(c: CtxLeyMateria, cuerpo: Cuerpo): number { return sinImplementar('b: reservaJ'); }
/** J que el metabolismo basal de este cuerpo quema en `dt` ticks (crece con la masa y con la T del aire que lo rodea). */
export function basalJ(c: CtxLeyMateria, cuerpo: Cuerpo, dt: number): number { return sinImplementar('b: basalJ'); }
/** Paga `julios` de trabajo quemando reserva con O₂ (`quemar`, nunca proteína ni NH₃). Devuelve los J pagados
 * (menos si la reserva no alcanza): quien llama hace solo la parte del trabajo que se pagó. */
export function pagar(c: CtxLeyMateria, cuerpo: Cuerpo, julios: number): number { return sinImplementar('b: pagar'); }
/** Un paso de `dt` ticks del cuerpo: digestión (`pasoLote` del digestivo con la κ de su plantilla), absorción hacia la
 * reserva y el tejido, basal pagado, intercambio de gases y calor con el aire de `celda` y excreción a su Suelo. */
export function metabolizar(c: CtxLeyMateria, cuerpo: Cuerpo, celda: number, dt: number): void { return sinImplementar('b: metabolizar'); }
/** Crecimiento del tejido hacia la masa adulta de la plantilla durante `dt` ticks (`copiar` desde reserva y digestivo).
 * Devuelve los kg de tejido ganados. */
export function crecer(c: CtxLeyMateria, cuerpo: Cuerpo, dt: number): number { return sinImplementar('b: crecer'); }

/** Lo que este cuerpo pide para comer `kg` de un lote: parte Digerible con su κ. */
export function pedidoComida(c: CtxLeyMateria, cuerpo: Cuerpo, kg: number): Pedido { return sinImplementar('b: pedidoComida'); }
/** Come de un lote PROPIO del dueño (la Vida o un montón de su celda, un objeto que lleva): mueve lo pedido al
 * digestivo. Devuelve los kg ingeridos. De un lote ajeno se come con un intento `Tomar` y luego `abonar`. */
export function ingerir(c: CtxLeyMateria, cuerpo: Cuerpo, de: LoteRef, pedido: Pedido): number { return sinImplementar('b: ingerir'); }
/** Bebe hasta `kg` de agua de un lote propio del dueño (charca de su celda, vasija que lleva). Devuelve los kg bebidos. */
export function beber(c: CtxLeyMateria, cuerpo: Cuerpo, de: LoteRef, kg: number): number { return sinImplementar('b: beber'); }
/** Abona en el digestivo una garantía recibida (`Concedido` de un `Tomar`) y la descuenta de `c.libro.enVuelo`. */
export function abonar(c: CtxLeyMateria, cuerpo: Cuerpo, garantia: Float64Array): void { return sinImplementar('b: abonar'); }

/** Golpe recibido (`DATO_GOLPEAR`): desprende tejido con la ley de romper hacia un lote nuevo (carne) que devuelve, y
 * baja la salud en lo desprendido. REF_NULA si el golpe no arrancó nada. */
export function herir(c: CtxLeyMateria, cuerpo: Cuerpo, golpe: Float64Array): LoteRef { return sinImplementar('b: herir'); }
/** Extracción no letal (f): saca hasta `kg` de la reserva o de la fibra del tejido como garantía para quien la pidió. */
export function extraer(c: CtxLeyMateria, cuerpo: Cuerpo, parte: 'reserva' | 'fibra', kg: number): Float64Array { return sinImplementar('b: extraer'); }
/** Muerte: funde tejido, reserva, digestivo y embrión en un lote Cadaver en `celda` (si la celda es de otro chunk, la
 * materia viaja en un `Depositar`) y libera los lotes del cuerpo. Devuelve el cadáver, o REF_NULA si viajó. */
export function morir(c: CtxLeyMateria, cuerpo: Cuerpo, celda: number): LoteRef { return sinImplementar('b: morir'); }

/** Abre una gestación en `madre` (crea el lote Embrión vacío). La pareja solo aportó información. */
export function concebir(c: CtxLeyMateria, madre: Cuerpo, g: Omit<Gestacion, 'embrion' | 'bajoBasalDesde'>): void { return sinImplementar('b: concebir'); }
/** Hace crecer el embrión `dt` ticks con átomos de la reserva y el digestivo de la madre (`copiar`; la síntesis se paga
 * quemando reserva). Devuelve la masa del embrión en kg tras el paso; las unidades hechas pueden ser menos que las
 * pedidas. Actualiza `gestacion.bajoBasalDesde`. */
export function gestar(c: CtxLeyMateria, madre: Cuerpo, dt: number): number { return sinImplementar('b: gestar'); }
/** Aborto: los átomos del embrión vuelven al digestivo de la madre; borra `gestacion`. */
export function abortar(c: CtxLeyMateria, madre: Cuerpo): void { return sinImplementar('b: abortar'); }
/** Parto: el embrión pasa a ser el tejido de un cuerpo nuevo (con reserva y digestivo vacíos), que devuelve; borra
 * `gestacion` de la madre. No crea ni destruye nada. */
export function parir(c: CtxLeyMateria, madre: Cuerpo): Cuerpo { return sinImplementar('b: parir'); }

/** Lotes de un cuerpo (tejido, reserva, digestivo y embrión si lo hay), para adoptarlos tras migrar o guardarlos. */
export function lotesDe(cuerpo: Cuerpo, out: LoteRef[]): LoteRef[] { return sinImplementar('b: lotesDe'); }
/** Carga a cuestas en kg: Σ masa de los lotes de `carga` (los `LoteRef` de `Person.carga`). Mover cuesta
 * C_MOVER·(masa + carga)·distancia J, que quien se mueve paga con `pagar`. */
export function cargaKg(c: CtxLeyMateria, carga: readonly LoteRef[]): number { return sinImplementar('b: cargaKg'); }
