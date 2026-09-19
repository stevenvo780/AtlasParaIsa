import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../world/params.js';

/**
 * La configuración explícita del despliegue: el escalón MÁS ALTO de la precedencia de
 * params (`DEFAULT_PARAMS` → params de la instantánea → esto). Vive aquí, y no dentro de
 * `main.ts`, para que las pruebas ejerciten la receta REAL de producción en vez de una
 * copia parecida: la ronda de corrección R2 encontró el fallo justo en esa diferencia.
 *
 * En producción el mundo se persiste cada 20 pasos (2 s) y siempre que llega un gesto; un
 * corte arriesga esos 2 s de simulación, nunca un gesto confirmado. `CARTA_PARAMS` ajusta
 * cualquier parámetro (y abre la ventana de poda) sin tocar código.
 */
export const PRODUCTION_PARAMS = 'persistencia.cadaTicks=20,persistencia.ventanaEventosTicks=24000';

/**
 * Los overrides del despliegue aplicados ENCIMA de `base`, clave a clave. Para un mundo
 * nuevo `base` son los defaults; para un mundo cargado son los params de su instantánea,
 * que solo ceden en las claves que el operador nombra de verdad. Antes de R2 esto era
 * `setParams(world, parseParams(cadena))`, que reemplazaba el objeto entero: un mundo
 * generado con `agua.cuencas=1` se recargaba, se medía y se volvía a guardar con 0,4 sin
 * decir nada, simulando un régimen distinto del que lo generó.
 */
export function deploymentParams(base: WorldParams = DEFAULT_PARAMS, carta = process.env.CARTA_PARAMS): WorldParams {
  return parseParams(`${PRODUCTION_PARAMS}${carta ? `,${carta}` : ''}`, base);
}
