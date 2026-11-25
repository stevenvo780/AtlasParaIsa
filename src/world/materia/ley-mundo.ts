/**
 * INTERFAZ PUENTE del mundo material (carril w). El esqueleto lo fijó la preparación de la oleada: w rellena los cuerpos
 * y puede añadir exportaciones, pero no cambia estas firmas (las consumen b, f, t1, t2, act, m6 y lab).
 *
 * Con `v23.materia` cada tesela residente tiene tres lotes (Suelo, Agua si hay charca, Vida) y cada página 16 × 16 un
 * lote de Aire; la roca es latente hasta que alguien la saca. Los escalares de `Tile` (comida, agua potable, humedad,
 * vegetación, madera, piedra) pasan a ser VISTAS que w escribe tras cada paso material de la página.
 */
import { KAPPA_SUELO, KAPPA_SUELO_HH } from '../../shared/naturaleza.js';
import type { MatTesela } from '../../shared/materia.js';
import { sinImplementar, type CtxLeyMateria, type Ley } from '../motor/acceso.js';
import type { BaseMundo } from './mundo.js';
import { Rol, type Kappa, type LoteRef, type Plantilla } from './tipos.js';

export const leyMundo: Ley = { id: 'w', interruptor: 'materia', sustituye: ['ecologia', 'kernel'] };

const SIN_CATALISIS: Kappa = [0, 0, 0, 0];
const CATALISIS_SUELO: Kappa = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
/** Catálisis que lleva un lote por su rol (materia.cierre): el suelo y el cadáver descomponen; aire, agua, roca,
 * objetos, piezas, tejido y fuego no catalizan. El digestivo lleva la κ de su plantilla (`Plantilla.kappa`), no esta. */
export const kappaDeRol = (rol: Rol): Kappa => rol === Rol.Suelo || rol === Rol.Cadaver ? CATALISIS_SUELO : SIN_CATALISIS;

/** Ids de las sustancias con nombre del mundo (agua, O₂, CO₂, N₂, madera, proteína…), internadas al crear la materia.
 * Nadie escribe un id de sustancia a mano: se leen de aquí o de Q. */
export function sustanciasDe(c: CtxLeyMateria): BaseMundo { return sinImplementar('w: sustanciasDe'); }

/** Los lotes de una tesela residente y el aire de su página. `agua` es REF_NULA (−1) si la tesela no tiene charca. */
export interface LotesCelda { suelo: LoteRef; agua: LoteRef; vida: LoteRef; aire: LoteRef }
/** Solo para celdas del dueño que llama (las ajenas, por intento `Tomar`/`Depositar` con su `Rol`). */
export function lotesDeCelda(c: CtxLeyMateria, celda: number, out: LotesCelda): LotesCelda { return sinImplementar('w: lotesDeCelda'); }

/** Plantilla de la vegetación dominante de una tesela propia, o null si no tiene (roca, agua). */
export function plantillaVegetal(c: CtxLeyMateria, celda: number): Plantilla | null { return sinImplementar('w: plantillaVegetal'); }

/** Materializa hasta `kg` de la roca latente de una celda propia en un lote nuevo con rol Objeto y sin forma, y lo
 * devuelve (REF_NULA si no queda). La roca latente es una fuente declarada («roca») del libro. */
export function rocaDe(c: CtxLeyMateria, celda: number, kg: number): LoteRef { return sinImplementar('w: rocaDe'); }

/** Lote que arde en una celda propia (REF_NULA si no hay fuego). Un fuego es un lote con rol Objeto que w mantiene
 * tomando aire de su página mientras quede combustible y su T supere la de ignición de lo que contiene. */
export function fuegoEn(c: CtxLeyMateria, celda: number): LoteRef { return sinImplementar('w: fuegoEn'); }
/** Prende `combustible` (lote propio en esa celda) con `julios` de calor de ignición que paga quien enciende (ya
 * debitados de su cuerpo o de otro fuego). Devuelve si quedó ardiendo. Con aire de sobra: O₂ ≥ 1× el estequiométrico. */
export function encender(c: CtxLeyMateria, celda: number, combustible: LoteRef, julios: number): boolean { return sinImplementar('w: encender'); }

/** Temperatura (K) del aire de la página de una celda residente (propia o ajena: solo lectura). */
export function temperaturaDe(c: CtxLeyMateria, celda: number): number { return sinImplementar('w: temperaturaDe'); }

/** `Tile.mat` de una celda propia: hasta 3 pares [sustancia, fracción de masa] de su superficie. */
export function matDeCelda(c: CtxLeyMateria, celda: number): MatTesela { return sinImplementar('w: matDeCelda'); }

/** Recursos de la vista heredada que una ley aún escalar saca de una tesela o le aporta. */
export type RecursoEscalar = 'comida' | 'agua' | 'madera' | 'piedra';
/**
 * Etapa con cuerpos (o fauna, técnica u obra) aún escalares: saca de una tesela propia `cantidad` del recurso, en las
 * unidades de su vista (`Tile.food`, `drinkingWater`, `wood`, `stone`), y manda esa materia al sumidero declarado «uso
 * heredado» del libro. Devuelve lo que salió, en las mismas unidades. Lo llaman las leyes heredadas en lugar de restar
 * del escalar; desaparece cuando la ley que come o recoge pasa a mover lotes.
 */
export function extraerEscalar(c: CtxLeyMateria, celda: number, recurso: RecursoEscalar, cantidad: number): number { return sinImplementar('w: extraerEscalar'); }
/** Lo simétrico: una ley heredada aporta `cantidad` a una tesela propia (sembrar, regar) como fuente declarada «aporte
 * heredado». Devuelve lo aportado. */
export function aportarEscalar(c: CtxLeyMateria, celda: number, recurso: RecursoEscalar, cantidad: number): number { return sinImplementar('w: aportarEscalar'); }

/** Estado del libro en lo que este dueño tiene: por posición (NE elementos y energía), lo que debería haber
 * (inicial + fuentes − sumideros) y lo que hay (Σ lotes + Σ en vuelo). Exacto, en bigint. Lo usan lab y los invariantes. */
export interface BalanceMateria { esperado: bigint[]; hallado: bigint[]; cuentas: Record<string, bigint> }
export function conservacion(c: CtxLeyMateria): BalanceMateria { return sinImplementar('w: conservacion'); }
