/**
 * INTERFAZ PUENTE: vecinos por el frente público (carril m5). El esqueleto lo fijó la preparación de la oleada: m5
 * rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las consumen s, n, f y act).
 *
 * Es la única forma de recorrer a «los demás»: lee `c.frente` (el estado de todos tras el tick anterior), así que da lo
 * mismo con un dueño que con muchos y nunca toca objetos de otro heap. El índice espacial del frente se arma una vez
 * por tick y por hilo, la primera vez que se pide.
 */
import { sinImplementar } from './acceso.js';
import type { Clase, CtxLectura, Ref, Slot } from './contratos.js';

/** Llama a `f` con cada organismo vivo del frente a distancia euclídea ≤ `radio` de (x, y), sin orden. `clase` 0 =
 * cualquiera. `d2` es la distancia al cuadrado. Si `f` devuelve `false`, corta. No excluye a nadie: quien busca vecinos
 * de sí mismo descarta su propio slot. */
export function cercanos(c: CtxLectura, x: number, y: number, radio: number, clase: 0 | Clase,
  f: (slot: Slot, d2: number) => boolean | void): void { return sinImplementar('m5: cercanos'); }

/** El organismo vivo más cercano a (x, y) dentro de `radio` que cumple `filtro` (y no es `salvo`), o REF_NULA. Los
 * empates se rompen con el azar de quien llama, nunca por slot ni por id. */
export function masCercano(c: CtxLectura, x: number, y: number, radio: number, clase: 0 | Clase, salvo: Slot,
  filtro: (slot: Slot) => boolean, azar: () => number): Ref { return sinImplementar('m5: masCercano'); }

/** Cuántos organismos vivos de `clase` hay a ≤ `radio` de (x, y) (densidad local: compañía, hacinamiento). */
export function cuantosCerca(c: CtxLectura, x: number, y: number, radio: number, clase: 0 | Clase): number { return sinImplementar('m5: cuantosCerca'); }
