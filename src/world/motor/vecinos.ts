/**
 * INTERFAZ PUENTE: vecinos por el frente público (carril m5). El esqueleto lo fijó la preparación de la oleada: m5
 * rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las consumen s, n, f y act).
 *
 * Es la única forma de recorrer a «los demás»: lee `c.frente` (el estado de todos tras el tick anterior), así que da lo
 * mismo con un dueño que con muchos y nunca toca objetos de otro heap. El índice espacial del frente se arma una vez
 * por tick y por hilo, la primera vez que se pide.
 */
import { Clase, REF_NULA, refDe, type CtxLectura, type FrentePublico, type Ref, type Slot } from './contratos.js';

const LADO_PAGINA_CELDAS = 16;
const LADO_SUBCELDA = 4;
const SUBCELDAS_POR_LADO = LADO_PAGINA_CELDAS / LADO_SUBCELDA;
const ANCHO_CLAVE = 2 ** 26;
const clave = (x: number, y: number): number => x * ANCHO_CLAVE + y;
const SIN_SLOTS: readonly Slot[] = [];

interface Pagina {
  x: number;
  y: number;
  slots: Slot[];
  personasPorSubcelda?: (Slot[] | undefined)[];
}

interface Indice {
  tick: number;
  alta: number;
  porClave: Map<number, Pagina>;
  ocupadas: Pagina[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const indices = new WeakMap<FrentePublico, Indice>();

function indiceDe(frente: FrentePublico): Indice {
  const previo = indices.get(frente);
  if (previo?.tick === frente.tick && previo.alta === frente.alta) return previo;
  const indice: Indice = {
    tick: frente.tick, alta: frente.alta, porClave: new Map(), ocupadas: [],
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
  };
  for (let s = 0; s < frente.alta; s++) {
    if (frente.vivo[s] !== 1) continue;
    const x = Math.floor(frente.x[s] / LADO_PAGINA_CELDAS);
    const y = Math.floor(frente.y[s] / LADO_PAGINA_CELDAS);
    const k = clave(x, y);
    let pagina = indice.porClave.get(k);
    if (!pagina) {
      pagina = { x, y, slots: [] };
      indice.porClave.set(k, pagina);
      indice.ocupadas.push(pagina);
      indice.minX = Math.min(indice.minX, x);
      indice.maxX = Math.max(indice.maxX, x);
      indice.minY = Math.min(indice.minY, y);
      indice.maxY = Math.max(indice.maxY, y);
    }
    pagina.slots.push(s);
  }
  indices.set(frente, indice);
  return indice;
}

function agruparPersonas(frente: FrentePublico, pagina: Pagina): (Slot[] | undefined)[] {
  const grupos = new Array<Slot[] | undefined>(SUBCELDAS_POR_LADO ** 2);
  const origenX = pagina.x * SUBCELDAS_POR_LADO, origenY = pagina.y * SUBCELDAS_POR_LADO;
  for (const slot of pagina.slots) {
    if (frente.clase[slot] !== Clase.Persona) continue;
    const sx = Math.floor(frente.x[slot] / LADO_SUBCELDA) - origenX;
    const sy = Math.floor(frente.y[slot] / LADO_SUBCELDA) - origenY;
    const index = sy * SUBCELDAS_POR_LADO + sx;
    (grupos[index] ??= []).push(slot);
  }
  return grupos;
}

/** Para un disco de radio ≤2, cada página aporta como máximo dos subceldas por eje.
 * La mezcla mantiene el orden ascendente de ranura que tenía la página completa. */
function visitarPersonasCercanas(frente: FrentePublico, pagina: Pagina, x: number, y: number, radio: number,
  visitar: (slot: Slot, d2: number) => boolean | void): boolean {
  const grupos = pagina.personasPorSubcelda ??= agruparPersonas(frente, pagina);
  const origenX = pagina.x * SUBCELDAS_POR_LADO, origenY = pagina.y * SUBCELDAS_POR_LADO;
  const x0 = Math.max(0, Math.floor((x - radio) / LADO_SUBCELDA) - origenX);
  const y0 = Math.max(0, Math.floor((y - radio) / LADO_SUBCELDA) - origenY);
  const x1 = Math.min(SUBCELDAS_POR_LADO - 1, Math.floor((x + radio) / LADO_SUBCELDA) - origenX);
  const y1 = Math.min(SUBCELDAS_POR_LADO - 1, Math.floor((y + radio) / LADO_SUBCELDA) - origenY);
  const fila0 = y0 * SUBCELDAS_POR_LADO, fila1 = y1 * SUBCELDAS_POR_LADO;
  const a = grupos[fila0 + x0] ?? SIN_SLOTS;
  const b = x1 === x0 ? SIN_SLOTS : grupos[fila0 + x1] ?? SIN_SLOTS;
  const c = y1 === y0 ? SIN_SLOTS : grupos[fila1 + x0] ?? SIN_SLOTS;
  const d = x1 === x0 || y1 === y0 ? SIN_SLOTS : grupos[fila1 + x1] ?? SIN_SLOTS;
  let ia = 0, ib = 0, ic = 0, id = 0;
  let sa = a[ia] ?? Infinity, sb = b[ib] ?? Infinity, sc = c[ic] ?? Infinity, sd = d[id] ?? Infinity;
  const r2 = radio * radio;
  for (;;) {
    const slot = Math.min(sa, sb, sc, sd);
    if (slot === Infinity) return true;
    const dx = frente.x[slot] - x, dy = frente.y[slot] - y, d2 = dx * dx + dy * dy;
    if (d2 <= r2 && visitar(slot, d2) === false) return false;
    if (slot === sa) sa = a[++ia] ?? Infinity;
    else if (slot === sb) sb = b[++ib] ?? Infinity;
    else if (slot === sc) sc = c[++ic] ?? Infinity;
    else sd = d[++id] ?? Infinity;
  }
}

function consultar(frente: FrentePublico, x: number, y: number, radio: number, clase: 0 | Clase,
  visitar?: (slot: Slot, d2: number) => boolean | void, salvo: Slot = REF_NULA,
  filtro?: (slot: Slot) => boolean, azar?: () => number): number {
  const vacio = azar ? REF_NULA : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(radio >= 0)) return vacio;
  const indice = indiceDe(frente);
  const x0 = Math.max(indice.minX, Math.floor((x - radio) / LADO_PAGINA_CELDAS));
  const x1 = Math.min(indice.maxX, Math.floor((x + radio) / LADO_PAGINA_CELDAS));
  const y0 = Math.max(indice.minY, Math.floor((y - radio) / LADO_PAGINA_CELDAS));
  const y1 = Math.min(indice.maxY, Math.floor((y + radio) / LADO_PAGINA_CELDAS));
  if (x0 > x1 || y0 > y1) return vacio;
  const ancho = x1 - x0 + 1, area = ancho * (y1 - y0 + 1);
  const porClave = area <= indice.ocupadas.length;
  const n = porClave ? area : indice.ocupadas.length;
  const r2 = radio * radio;
  const subceldas = visitar !== undefined && clase === Clase.Persona && radio <= LADO_SUBCELDA / 2;
  let total = 0, mejor = REF_NULA, distancia = r2, empates = 0;
  for (let p = 0; p < n; p++) {
    const pagina = porClave
      ? indice.porClave.get(clave(x0 + p % ancho, y0 + Math.floor(p / ancho)))
      : indice.ocupadas[p];
    if (!pagina || pagina.x < x0 || pagina.x > x1 || pagina.y < y0 || pagina.y > y1) continue;
    if (subceldas) {
      if (!visitarPersonasCercanas(frente, pagina, x, y, radio, visitar)) return 0;
      continue;
    }
    for (let j = 0; j < pagina.slots.length; j++) {
      const s = pagina.slots[j];
      if (s === salvo || (clase !== 0 && frente.clase[s] !== clase)) continue;
      const dx = frente.x[s] - x, dy = frente.y[s] - y, d2 = dx * dx + dy * dy;
      if (d2 > distancia || (filtro && !filtro(s))) continue;
      if (visitar) {
        if (visitar(s, d2) === false) return 0;
      } else if (!azar) {
        total++;
      } else if (mejor === REF_NULA || d2 < distancia) {
        mejor = s;
        distancia = d2;
        empates = 1;
      } else if (azar() * ++empates < 1) {
        mejor = s;
      }
    }
  }
  if (!azar) return total;
  return mejor === REF_NULA ? REF_NULA : refDe(mejor, frente.gen[mejor]);
}

/** Llama a `f` con cada organismo vivo del frente a distancia euclídea ≤ `radio` de (x, y), sin orden. `clase` 0 =
 * cualquiera. `d2` es la distancia al cuadrado. Si `f` devuelve `false`, corta. No excluye a nadie: quien busca vecinos
 * de sí mismo descarta su propio slot. */
export function cercanos(c: CtxLectura, x: number, y: number, radio: number, clase: 0 | Clase,
  f: (slot: Slot, d2: number) => boolean | void): void {
  consultar(c.frente, x, y, radio, clase, f);
}

/** El organismo vivo más cercano a (x, y) dentro de `radio` que cumple `filtro` (y no es `salvo`), o REF_NULA. Los
 * empates se rompen con el azar de quien llama, nunca por slot ni por id. */
export function masCercano(c: CtxLectura, x: number, y: number, radio: number, clase: 0 | Clase, salvo: Slot,
  filtro: (slot: Slot) => boolean, azar: () => number): Ref {
  return consultar(c.frente, x, y, radio, clase, undefined, salvo, filtro, azar);
}

/** Cuántos organismos vivos de `clase` hay a ≤ `radio` de (x, y) (densidad local: compañía, hacinamiento). */
export function cuantosCerca(c: CtxLectura, x: number, y: number, radio: number, clase: 0 | Clase): number {
  return consultar(c.frente, x, y, radio, clase);
}
