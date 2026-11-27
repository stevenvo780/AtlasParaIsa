/**
 * INTERFAZ PUENTE de los procesos técnicos sobre lotes (carril t1; ARQ-materia §3.5). El esqueleto lo fijó la
 * preparación de la oleada: t1 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consumen t2 y act).
 *
 * Un proceso es una lista de `Paso` que ocurre en el mundo, tick a tick, sobre un lote: romper talla, unir añade masa,
 * calentar lo deja junto a un fuego y mojar en agua. Nada se crea ni se destruye: lo que sale al romper queda como
 * montón en la celda, lo que se une viene de otro lote, el calor llega por conducción desde un fuego o el agua y los gases
 * que suelta el lote van al aire de su página. Las recetas (listas de pasos) se registran en `c.globales.registro`.
 */
import { FRACTURA } from '../../shared/naturaleza.js';
import { codigoForma, formaDeCodigo, type Forma, type SustanciaId, type SustanciaVista } from '../../shared/materia.js';
import type { LoteVisible } from '../../shared/vistas-v23.js';
import type { Tile, WorldView } from '../../shared/types.js';
import type { Violacion } from '../invariantes.js';
import type { Person } from '../mundo/tipos.js';
import type { Aplicado, CtxLey, CtxLeyMateria, Ley } from '../motor/acceso.js';
import { DATO_GOLPEAR, genDe, slotDe, type Intento, type Registro } from '../motor/contratos.js';
import { pagar } from './cuerpo.js';
import { encender, fuegoEn, kappaDeRol, lotesDeCelda, type LotesCelda } from './ley-mundo.js';
import { pasoLote, type CtxPaso } from './paso.js';
import { fluirCalor } from './fluir.js';
import { desprender, reparto, romper } from './romper.js';
import { Parte, Rol, type Cuerpo, type LoteRef, type Paso, type ProcesoMaterial, type VistaLote } from './tipos.js';
import { tecnicaVisible } from '../../shared/tecnica-visible.js';
import { anotarReaccionAplicada, reaccionObservadaDe } from './reaccion-observada.js';
import { aprenderReceta, avanzarTecnicaDelMundo, decodificarEnsenanza, iniciarTecnica, mantenerTecnica } from '../technology.js';

// ── Constantes físicas: viven en shared/naturaleza.ts (integrador) y se reexportan aquí ─────────────────────
import { POTENCIA_TRABAJO, SEGUNDOS_TICK, TRABAJO_UNIR, G_FUEGO, G_AGUA, TAU_MOJAR, J_ENCENDER } from '../../shared/naturaleza.js';
export { POTENCIA_TRABAJO, SEGUNDOS_TICK, TRABAJO_UNIR, G_FUEGO, G_AGUA, TAU_MOJAR, J_ENCENDER };

/** mg/kg y L/m³. */
const MG_POR_KG = 1e6, L_POR_M3 = 1000;

// ── Recetas: formato canónico en el `Registro` ───────────────────────────────────────────────────────────

const MAGIA = [0x54, 0x31, 0x52, 0x01]; // «T1R» y versión 1
const OP = { romper: 1, unir: 2, calentar: 3, mojar: 4 } as const;

/**
 * Bytes canónicos de una receta: «T1R», versión, nº de pasos (u32) y cada paso (little endian):
 * romper = op, `codigoForma` (u32); unir = op, insumo (u32), forma (u32), masa (f64, kg);
 * calentar / mojar = op, banderas (1 = T, 2 = ticks), T (f64, K), ticks (f64). La forma va cuantizada con
 * `codigoForma`, así que dos recetas que solo difieren por debajo de su resolución son la misma.
 */
export function codificarReceta(pasos: readonly Paso[]): Uint8Array {
  let n = 8;
  for (const p of pasos) n += p.op === 'romper' ? 5 : p.op === 'unir' ? 17 : 18;
  const b = new Uint8Array(n), d = new DataView(b.buffer);
  b.set(MAGIA, 0);
  d.setUint32(4, pasos.length, true);
  let o = 8;
  for (const p of pasos) {
    b[o++] = OP[p.op];
    if (p.op === 'romper') { d.setUint32(o, codigoForma(p.forma), true); o += 4; }
    else if (p.op === 'unir') {
      d.setUint32(o, p.insumo, true); d.setUint32(o + 4, p.forma, true); d.setFloat64(o + 8, p.masa, true); o += 16;
    } else {
      const { T, ticks } = p.hasta;
      b[o++] = (T !== undefined ? 1 : 0) | (ticks !== undefined ? 2 : 0);
      d.setFloat64(o, T ?? 0, true); d.setFloat64(o + 8, ticks ?? 0, true); o += 16;
    }
  }
  return b;
}

/** Inversa de `codificarReceta`; null si los bytes no son una receta (otra entrada del registro). */
export function decodificarReceta(b: Uint8Array): Paso[] | null {
  if (b.length < 8 || MAGIA.some((m, i) => b[i] !== m)) return null;
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength), n = d.getUint32(4, true), pasos: Paso[] = [];
  let o = 8;
  for (let k = 0; k < n; k++) {
    if (o >= b.length) return null;
    const op = b[o++];
    if (op === OP.romper) {
      if (o + 4 > b.length) return null;
      pasos.push({ op: 'romper', forma: formaDeCodigo(d.getUint32(o, true)) }); o += 4;
    } else if (op === OP.unir) {
      if (o + 16 > b.length) return null;
      pasos.push({ op: 'unir', insumo: d.getUint32(o, true), forma: d.getUint32(o + 4, true), masa: d.getFloat64(o + 8, true) });
      o += 16;
    } else if (op === OP.calentar || op === OP.mojar) {
      if (o + 17 > b.length) return null;
      const banderas = b[o++]!, hasta: { T?: number; ticks?: number } = {};
      if (banderas & 1) hasta.T = d.getFloat64(o, true);
      if (banderas & 2) hasta.ticks = d.getFloat64(o + 8, true);
      pasos.push({ op: op === OP.calentar ? 'calentar' : 'mojar', hasta }); o += 16;
    } else return null;
  }
  return o === b.length ? pasos : null;
}

/** Id de la receta en el registro del motor (insertar es idempotente: los mismos bytes dan el mismo id). */
export const registrarReceta = (registro: Registro, pasos: readonly Paso[]): number => registro.insertar(codificarReceta(pasos));
export function leerReceta(registro: Registro, id: number): Paso[] | null {
  const b = registro.leer(id);
  return b ? decodificarReceta(b) : null;
}

// ── Vector funcional: propiedades del lote × rasgos de su forma ──────────────────────────────────────────

const PROPIEDADES = ['dureza', 'tenacidad', 'sellado', 'aislamiento'] as const;
const RASGOS = ['material', 'largo', 'ancho', 'grueso', 'hueco', 'filo'] as const;
/** Claves del vector con que se mide la novedad (`novedadFuncional`): cada propiedad de la vista del lote por cada
 * rasgo de su forma, más la propiedad sola («material»), que es lo que cuenta en un lote sin forma (cal, carbón). */
export const CLAVES_FUNCIONALES: readonly string[] = PROPIEDADES.flatMap(p => RASGOS.map(r => `${p}·${r}`));

/** Rasgos de una forma en [0, 1]: las longitudes por su campo de `codigoForma` (escala logarítmica desde 1 mm). */
function rasgosForma(codigo: number): number[] {
  if (codigo === 0) return [1, 0, 0, 0, 0, 0];
  const campo = (i: number) => Math.floor(codigo / 64 ** i) % 64 / 63;
  return [1, campo(0), campo(1), campo(2), campo(3), campo(4)];
}

/** Vector (propiedades × forma) de un lote, en el orden de CLAVES_FUNCIONALES. */
export function vectorFuncional(v: VistaLote): number[] {
  const rasgos = rasgosForma(v.forma), out: number[] = [];
  for (const p of PROPIEDADES) for (const r of rasgos) out.push(v.masa > 0 ? v[p] * r : 0);
  return out;
}

export const perfilDeVector = (vector: readonly number[]): Record<string, number> =>
  Object.fromEntries(CLAVES_FUNCIONALES.map((k, i) => [k, vector[i] ?? 0]));

// ── Utilidades de lote ───────────────────────────────────────────────────────────────────────────────────

const pasos = new WeakMap<object, CtxPaso>();
/** El contexto de `pasoLote`, `fluir` y `romper` desde el de la ley: arena, química y azar del hilo.
 * La anotación no sortea: registra la primera reacción aplicada y luego se quita. */
export function ctxPaso(c: CtxLeyMateria): CtxPaso {
  let p = pasos.get(c);
  if (!p) {
    p = { arena: c.materia, quimica: c.quimica, azar: () => c.azar() };
    if (!reaccionObservadaDe(c.materia)) {
      p.anotar = (reaccion, veces, lote) => {
        anotarReaccionAplicada(c.materia, reaccion, veces, lote, c.tick);
        p!.anotar = undefined;
      };
    }
    pasos.set(c, p);
  }
  return p;
}

/** Sustancias de un lote por id (lo que ocurre no depende de en qué ranura está cada una). */
export function especiesDe(c: CtxLeyMateria, l: LoteRef): Uint32Array {
  let ids = new Uint32Array(16), n = c.materia.especies(l, ids);
  if (n > ids.length) n = c.materia.especies(l, ids = new Uint32Array(n));
  return ids.subarray(0, n).sort();
}

const masaCuantos = (c: CtxLeyMateria, id: SustanciaId, cuantos: number) => cuantos * c.quimica.sustancia(id).masa / MG_POR_KG;
const esGas = (c: CtxLeyMateria, id: SustanciaId, T: number) => c.quimica.sustancia(id).prop.tEbullicion <= T;

/** L que ocupa lo condensado de un lote (sus gases se van al aire). */
export function volumenLote(c: CtxLeyMateria, l: LoteRef): number {
  const T = c.materia.vista(l).T;
  let v = 0;
  for (const id of especiesDe(c, l)) {
    const s = c.quimica.sustancia(id);
    if (s.prop.tEbullicion <= T || !(s.prop.densidad > 0)) continue;
    v += c.materia.cuantos(l, id) * s.masa / MG_POR_KG / s.prop.densidad;
  }
  return v;
}

/** L que ocupa una forma: largo·ancho·grueso, menos su hueco. */
export const volumenForma = (f: Forma): number => f.largo * f.ancho * f.grueso * L_POR_M3 * (1 - f.hueco);

/**
 * Mueve de `de` a `a` la fracción `f` de cada sustancia (redondeo entero insesgado con el azar del hilo) y la parte del
 * calor de los átomos que se van, como `desprender`, y devuelve los kg movidos.
 */
export function moverFraccion(c: CtxLeyMateria, de: LoteRef, a: LoteRef, f: number): number {
  if (!(f > 0)) return 0;
  const ids = especiesDe(c, de);
  let atomos = 0n, movidosAt = 0n, kg = 0;
  const calor = c.materia.calor(de);
  for (const id of ids) {
    const s = c.quimica.sustancia(id), n = c.materia.cuantos(de, id), at = BigInt(s.atomos.reduce((x, y) => x + y, 0));
    atomos += BigInt(n) * at;
    const x = n * Math.min(1, f), k = Math.floor(x) + (c.azar() < x - Math.floor(x) ? 1 : 0);
    if (k === 0) continue;
    const m = c.materia.mover({ de, a, esp: id, cuantos: k });
    movidosAt += BigInt(m) * at;
    kg += masaCuantos(c, id, m);
  }
  if (atomos > 0n && movidosAt > 0n) c.materia.moverCalor(de, a, Number(BigInt(calor) * movidosAt / atomos));
  return kg;
}

/** Los gases del lote (lo que hierve a su T) salen al aire de su página, con su calor. */
export function ventilar(c: CtxLeyMateria, l: LoteRef, aire: LoteRef): void {
  if (aire < 0) return;
  const T = c.materia.vista(l).T;
  for (const id of especiesDe(c, l)) if (esGas(c, id, T)) {
    const n = c.materia.cuantos(l, id);
    if (n > 0) c.materia.moverParte(l, aire, { parte: Parte.Exacta, esp: id, cuantos: n, kappa: null });
  }
}

/** Celda de (x, y) si es de este dueño; −1 si no es residente o es de otro. */
export function celdaPropia(c: CtxLey, x: number, y: number): number {
  const celda = c.terreno.celda(Math.round(x), Math.round(y));
  return celda >= 0 && c.terreno.duenoChunk[c.terreno.chunkDe(celda)] === c.hilo ? celda : -1;
}

const lotesCelda: LotesCelda = { suelo: -1, agua: -1, vida: -1, aire: -1 };
let buferObjetos = new Float64Array(16);
/** Lotes con rol Objeto de una celda propia (montones, objetos dejados, fuegos). */
export function objetosDeCelda(c: CtxLeyMateria, celda: number): LoteRef[] {
  let n = c.materia.lotes(celda, Rol.Objeto, buferObjetos);
  if (n > buferObjetos.length) n = c.materia.lotes(celda, Rol.Objeto, buferObjetos = new Float64Array(n * 2));
  return Array.from(buferObjetos.subarray(0, n));
}

/** Echa `l` (vacío o no) al montón de la celda con su misma sustancia principal y sin forma; si no hay, `l` es el montón. */
function amontonar(c: CtxLeyMateria, celda: number, l: LoteRef, excluir: LoteRef): void {
  const v = c.materia.vista(l);
  if (v.masa <= 0 && c.materia.calor(l) === 0) { c.materia.liberar(l); return; }
  const fuego = fuegoEn(c, celda);
  for (const otro of objetosDeCelda(c, celda)) {
    if (otro === l || otro === excluir || otro === fuego || !c.materia.propio(otro)) continue;
    const w = c.materia.vista(otro);
    if (w.forma !== 0 || w.principal !== v.principal) continue;
    c.materia.moverParte(l, otro, { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null });
    if (c.materia.vista(l).masa <= 0 && c.materia.calor(l) === 0) c.materia.liberar(l);
    return;
  }
}

/** Golpe (`DATO_GOLPEAR`) con `trabajo` J dado con un útil de vista `u` (o la mano: tejido sin forma). */
function golpe(u: VistaLote, trabajo: number): Float64Array {
  const g = new Float64Array(5), f = formaDeCodigo(u.forma);
  g[DATO_GOLPEAR.trabajo] = trabajo;
  g[DATO_GOLPEAR.filo] = f.filo;
  g[DATO_GOLPEAR.tenacidad] = u.tenacidad;
  g[DATO_GOLPEAR.esbeltez] = f.largo > 0 ? Math.max(0, 1 - f.grueso / f.largo) : 0;
  g[DATO_GOLPEAR.dureza] = u.dureza;
  return g;
}

// ── La ley ───────────────────────────────────────────────────────────────────────────────────────────────

export const leyTecnica: Ley = {
  id: 't1', interruptor: 'tecnica', sustituye: ['memoriaTecnica'],
  iniciar: c => iniciarTecnica(c as CtxLeyMateria),
  // F5 y no F4: el gancho F4 corre antes de que las personas actúen (`pasoPersonas`), y el avance pasivo marcaba el
  // tick como trabajado y les quitaba su propio avance (prender el fuego, dejar un paso imposible).
  F5: c => avanzarTecnicaDelMundo(c as CtxLeyMateria),
  F6: c => mantenerTecnica(c as CtxLeyMateria),
  aplicar: { Ensenar: (c, i) => aplicarEnsenar(c as CtxLeyMateria, i) },
  proyectar: {
    mundo: (c, vista) => proyectarLotes(c as CtxLeyMateria, vista),
    persona: (c, p, vista) => {
      const t = p.technology?.tecnica;
      if (!t) return;
      vista.tecnicaVista = tecnicaVisible(t, id => leerReceta(c.globales.registro, id));
    },
  },
  comprobar: c => comprobarTecnica(c as CtxLeyMateria),
};

/** Qué pasó al avanzar un proceso un tick: sigue en su paso, pasó al siguiente, terminó, o espera algo del mundo (un
 * insumo que no está, un fuego, agua) sin gastar nada. */
export type AvanceProceso = 'sigue' | 'paso' | 'hecho' | 'espera';

/** Empieza un proceso sobre un lote propio que está en la celda (x, y) o a cuestas de quien lo hace. */
export function iniciarProceso(c: CtxLeyMateria, lote: LoteRef, pasos: readonly Paso[], x: number, y: number): ProcesoMaterial {
  if (!c.materia.propio(lote)) throw new Error('iniciarProceso: el lote no es de este dueño.');
  // Copia propia: unir lleva en su paso la masa que le falta, y la receta del registro no se toca.
  const copia = pasos.map((p): Paso => p.op === 'romper' ? { op: 'romper', forma: { ...p.forma } }
    : p.op === 'unir' ? { ...p } : { op: p.op, hasta: { ...p.hasta } });
  return { lote, pasos: copia, i: 0, desde: c.tick, x, y };
}

/** Avanza un tick el paso en curso. `quien` es el cuerpo que trabaja (paga con `pagar` el trabajo de romper y de
 * unir; null si el paso solo espera al mundo: calentar junto a un fuego, mojar). Si se interrumpe, el lote intermedio se
 * queda donde está: el proceso es dato, no un cerrojo. */
export function avanzarProceso(c: CtxLeyMateria, p: ProcesoMaterial, quien: Cuerpo | null): AvanceProceso {
  return avanzarProcesoCon(c, p, quien, null, []);
}

/**
 * `avanzarProceso` con lo que lleva quien trabaja: `util` es el lote con que golpea al romper (null = la mano, su
 * tejido) y `carga` los lotes a cuestas de donde puede unir. Lo usan la técnica de las personas y act.
 */
export function avanzarProcesoCon(c: CtxLeyMateria, p: ProcesoMaterial, quien: Cuerpo | null, util: LoteRef | null,
  carga: readonly LoteRef[]): AvanceProceso {
  if (p.i >= p.pasos.length) return 'hecho';
  if (!c.materia.vivo(p.lote) || !c.materia.propio(p.lote)) return 'espera';
  const celda = celdaPropia(c, p.x, p.y);
  if (celda < 0) return 'espera';
  const paso = p.pasos[p.i]!;
  const listo = paso.op === 'romper' ? romperPaso(c, p, paso.forma, celda, quien, util)
    : paso.op === 'unir' ? unirPaso(c, p, paso, celda, quien, carga)
    : esperarPaso(c, p, paso.op, paso.hasta, celda, quien);
  if (listo === 'espera') { p.desde++; return 'espera'; }
  if (listo === 'sigue') return 'sigue';
  p.i++; p.desde = c.tick;
  return p.i >= p.pasos.length ? 'hecho' : 'paso';
}

type Resultado = 'sigue' | 'listo' | 'espera';

/** Romper con patrón: quita del lote lo que sobra para caber en la forma, pagando el golpe; lo quitado queda en la celda. */
function romperPaso(c: CtxLeyMateria, p: ProcesoMaterial, forma: Forma, celda: number, quien: Cuerpo | null,
  util: LoteRef | null): Resultado {
  const l = p.lote, V = volumenLote(c, l), Vf = volumenForma(forma);
  const sobra = V > 0 ? 1 - Vf / V : 0;
  let cohesion = 0, cuantos = 0;
  for (const id of especiesDe(c, l)) {
    const n = c.materia.cuantos(l, id);
    cohesion += FRACTURA * n * c.quimica.sustancia(id).prop.dMedia;
    cuantos += n;
  }
  if (!(sobra > 0) || sobra * cuantos < 1) { c.materia.formar(l, codigoForma(forma)); return 'listo'; }
  if (!quien) return 'espera';
  const usaUtil = util !== null && util >= 0 && util !== l && c.materia.propio(util);
  const vistaUtil = c.materia.vista(usaUtil ? util : quien.tejido);
  // J que llegan al blanco por J de trabajo, con el útil que hay: la ley de romper.
  const porJulio = reparto(golpe(vistaUtil, 1), c.materia.vista(l)).blanco;
  if (!(porJulio > 0)) return 'espera';
  const falta = sobra * cohesion / porJulio;
  const pagado = pagar(c, quien, Math.min(falta, POTENCIA_TRABAJO * SEGUNDOS_TICK));
  if (!(pagado > 0)) return 'espera';
  const lascas = c.materia.nuevo(Rol.Objeto, celda, 0);
  const hecho = romper(c.materia, c.quimica, l, lascas, golpe(vistaUtil, pagado), () => c.azar());
  if (usaUtil && hecho.desgaste > 0) desprender(c.materia, c.quimica, util, lascas, hecho.desgaste, () => c.azar());
  amontonar(c, celda, lascas, l);
  const V2 = volumenLote(c, l);
  if (V2 <= Vf || (1 - Vf / V2) * cuantos < 1) { c.materia.formar(l, codigoForma(forma)); return 'listo'; }
  return 'sigue';
}

/** Unir: añade al lote `masa` kg de un lote cuya sustancia principal es `insumo` (y su forma, si no es 0), a cuestas
 * o en la celda (un montón propio o el suelo). El paso lleva lo que falta; sin insumo, espera. */
function unirPaso(c: CtxLeyMateria, p: ProcesoMaterial, paso: Extract<Paso, { op: 'unir' }>, celda: number,
  quien: Cuerpo | null, carga: readonly LoteRef[]): Resultado {
  if (!(paso.masa > 0)) return 'listo';
  if (!quien) return 'espera';
  const fuente = fuenteUnir(c, p.lote, paso.insumo, paso.forma, celda, carga);
  if (fuente < 0) return 'espera';
  const disponible = c.materia.vista(fuente).masa;
  const quiere = Math.min(paso.masa, disponible);
  const pagado = pagar(c, quien, Math.min(quiere * TRABAJO_UNIR, POTENCIA_TRABAJO * SEGUNDOS_TICK));
  if (!(pagado > 0)) return 'espera';
  const kg = moverFraccion(c, fuente, p.lote, Math.min(quiere, pagado / TRABAJO_UNIR) / disponible);
  (paso as { masa: number }).masa = Math.max(0, paso.masa - kg);
  // Menos de un cuanto de lo que se une no se puede mover: el paso está hecho.
  return paso.masa <= masaCuantos(c, paso.insumo, 1) ? 'listo' : 'sigue';
}

function fuenteUnir(c: CtxLeyMateria, lote: LoteRef, insumo: SustanciaId, forma: number, celda: number,
  carga: readonly LoteRef[]): LoteRef {
  const vale = (l: LoteRef) => {
    if (l < 0 || l === lote || !c.materia.vivo(l) || !c.materia.propio(l)) return false;
    const v = c.materia.vista(l);
    return v.masa > 0 && v.principal === insumo && (forma === 0 || v.forma === forma);
  };
  for (const l of carga) if (vale(l)) return l;
  const fuego = fuegoEn(c, celda);
  for (const l of objetosDeCelda(c, celda)) if (l !== fuego && vale(l)) return l;
  if (forma === 0) {
    lotesDeCelda(c, celda, lotesCelda);
    if (vale(lotesCelda.suelo)) return lotesCelda.suelo;
  }
  return -1;
}

/** Calentar junto a un fuego o mojar en agua hasta `hasta.T` (calentar: subir a T; mojar: bajar a T) o `hasta.ticks`
 * ticks, lo primero que llegue. El lote reacciona a su T (`pasoLote`, sin catálisis) y sus gases salen al aire. */
function esperarPaso(c: CtxLeyMateria, p: ProcesoMaterial, op: 'calentar' | 'mojar', hasta: { T?: number; ticks?: number },
  celda: number, quien: Cuerpo | null): Resultado {
  const l = p.lote;
  const fin = () => {
    const T = c.materia.vista(l).T;
    if (hasta.T !== undefined && (op === 'calentar' ? T >= hasta.T : T <= hasta.T)) return true;
    if (hasta.ticks !== undefined && c.tick - p.desde >= hasta.ticks) return true;
    return hasta.T === undefined && hasta.ticks === undefined;
  };
  if (fin()) return 'listo';
  lotesDeCelda(c, celda, lotesCelda);
  const cp = ctxPaso(c);
  if (op === 'calentar') {
    const fuego = fuegoEn(c, celda);
    if (fuego < 0 || fuego === l) return quien && prender(c, celda, l, quien) ? 'sigue' : 'espera';
    fluirCalor(cp, fuego, l, G_FUEGO, 1);
  } else {
    const agua = lotesCelda.agua;
    if (agua < 0) return 'espera';
    empapar(c, agua, l);
    fluirCalor(cp, agua, l, G_AGUA, 1);
  }
  pasoLote(cp, l, 1, kappaDeRol(Rol.Objeto));
  ventilar(c, l, lotesCelda.aire);
  return fin() ? 'listo' : 'sigue';
}

/** El lote sumergido toma agua hacia lo que su porosidad (1 − sellado) le deja llenar, con constante TAU_MOJAR. */
function empapar(c: CtxLeyMateria, agua: LoteRef, l: LoteRef): void {
  const h2o = c.materia.vista(agua).principal;
  if (!h2o) return;
  const s = c.quimica.sustancia(h2o);
  const hueco = (1 - c.materia.vista(l).sellado) * volumenLote(c, l) * s.prop.densidad * MG_POR_KG / s.masa;
  const falta = hueco - c.materia.cuantos(l, h2o);
  if (!(falta >= 1)) return;
  const x = falta * -Math.expm1(-1 / TAU_MOJAR), k = Math.min(c.materia.cuantos(agua, h2o), Math.floor(x) + (c.azar() < x % 1 ? 1 : 0));
  if (k > 0) c.materia.moverParte(agua, l, { parte: Parte.Exacta, esp: h2o, cuantos: k, kappa: null });
}

/** Sin fuego en la celda, quien trabaja prende el montón de más energía (no el lote que calienta) con J_ENCENDER J
 * que paga su cuerpo: el calor pasa de su reserva al combustible y w decide si arde. */
function prender(c: CtxLeyMateria, celda: number, lote: LoteRef, quien: Cuerpo): boolean {
  let mejor = -1, energia = 0;
  for (const l of objetosDeCelda(c, celda)) {
    if (l === lote || !c.materia.propio(l)) continue;
    const v = c.materia.vista(l);
    if (v.energia > energia && (v.fase === 0 || v.fase === 3)) { mejor = l; energia = v.energia; }
  }
  if (mejor < 0) return false;
  const pagado = pagar(c, quien, J_ENCENDER);
  if (!(pagado > 0)) return false;
  const j = c.materia.moverCalor(quien.reserva, mejor, Math.floor(Math.min(pagado, c.materia.calor(quien.reserva))));
  return encender(c, celda, mejor, j) || j > 0;
}

// ── Enseñar, proyectar y comprobar ───────────────────────────────────────────────────────────────────────

function aplicarEnsenar(c: CtxLeyMateria, i: Intento): Aplicado {
  if (!i.bytes) return 'rechazo';
  const persona = c.personas.get(slotDe(i.a));
  if (!persona || c.frente.gen[slotDe(i.a)] !== genDe(i.a)) return 'rechazo';
  const ensenanza = decodificarEnsenanza(i.bytes);
  if (!ensenanza) return 'rechazo';
  return aprenderReceta(c, persona, ensenanza, i.de) ? 'hecho' : 'rechazo';
}

/** Rol Objeto de las celdas propias salvo los fuegos (de w): montones, objetos dejados, hornos y metal al rojo. */
function proyectarLotes(c: CtxLeyMateria, vista: WorldView): void {
  const lotes: LoteVisible[] = vista.lotes ??= [];
  const sustancias: SustanciaVista[] = vista.sustancias ??= [];
  const vistas = new Set(sustancias.map(s => s.id));
  for (const t of c.mundo.tiles as Tile[]) {
    const celda = celdaPropia(c, t.x, t.y);
    if (celda < 0) continue;
    const fuego = fuegoEn(c, celda);
    for (const l of objetosDeCelda(c, celda)) {
      if (l === fuego) continue;
      const v = c.materia.vista(l);
      if (!(v.masa > 0)) continue;
      lotes.push({ x: t.x, y: t.y, rol: 'objeto', forma: v.forma, principal: v.principal, masa: v.masa, T: v.T });
      if (v.principal && !vistas.has(v.principal)) {
        vistas.add(v.principal);
        const s = c.quimica.sustancia(v.principal);
        sustancias.push({ id: s.id, clase: s.clase, atomos: Array.from(s.atomos), enlaces: Array.from(s.enlaces), masa: s.masa, prop: s.prop });
      }
    }
  }
}

function comprobarTecnica(c: CtxLeyMateria): Violacion[] {
  const out: Violacion[] = [];
  for (const persona of c.mundo.people as Person[]) {
    const t = persona.technology.tecnica;
    if (!t) continue;
    const p = t.proceso?.proceso;
    if (p && (p.i < 0 || p.i > p.pasos.length || !Number.isSafeInteger(p.i)))
      out.push({ id: 't1-proceso', gravedad: 'dura', tick: c.tick, detalle: `Proceso de ${persona.id} con paso ${p.i} de ${p.pasos.length}.` });
    if (t.recetas.some(r => r.vector.length !== CLAVES_FUNCIONALES.length || !(r.usada <= c.tick)))
      out.push({ id: 't1-memoria', gravedad: 'dura', tick: c.tick, detalle: `Receta mal recordada por ${persona.id}.` });
    if (new Set(t.recetas.map(r => r.id)).size !== t.recetas.length)
      out.push({ id: 't1-memoria', gravedad: 'dura', tick: c.tick, detalle: `Receta repetida en la memoria de ${persona.id}.` });
  }
  return out;
}
