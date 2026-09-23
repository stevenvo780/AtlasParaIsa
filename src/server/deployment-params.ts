import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../world/params.js';

/**
 * La configuración explícita del despliegue: el escalón MÁS ALTO de la precedencia de
 * params (`DEFAULT_PARAMS` → params de la instantánea → esto). Reglas 10, etapa 1: un mundo
 * NUEVO parte de `DEFAULT_PARAMS` (paquete de natalidad adoptado); un mundo CARGADO parte de
 * los params de su instantánea, cuyas claves ausentes ya completó `readSnapshotParams` con
 * `HISTORICAL_PARAMS`, así que el despliegue nunca le inyecta una ley nueva que no nombre
 * `CARTA_PARAMS`. Vive aquí, y no dentro de
 * `main.ts`, para que las pruebas ejerciten la receta REAL de producción en vez de una
 * copia parecida: la ronda de corrección R2 encontró el fallo justo en esa diferencia.
 *
 * En producción el mundo se persiste cada 100 pasos (10 s, ruling R19) y siempre que llega un
 * gesto; un corte arriesga esos 10 s de simulación, nunca un gesto confirmado. `CARTA_PARAMS` ajusta
 * cualquier parámetro (y abre la ventana de poda) sin tocar código.
 */
// Ruling R19 (2026-09-19 16:30): cadencia 100 pasos (10 s). Con 20, a 40 habitantes el guardado
// (350–500 ms) entraba 6 veces en la ventana de 120 pasos del gobernador y fijaba su p95, así que
// los nacimientos quedaban pausados para siempre; con 100 entra una vez y el p95 mide el paso.
// Coste si está mal: hasta 10 s de mundo perdidos en un corte (antes 2 s).
export const PRODUCTION_PARAMS = 'persistencia.cadaTicks=100,persistencia.ventanaEventosTicks=24000';

/**
 * Los overrides del despliegue aplicados ENCIMA de `base`, clave a clave. Para un mundo
 * nuevo `base` son los defaults (`DEFAULT_PARAMS`, reglas 10); para un mundo cargado son los
 * params de su instantánea (completados con `HISTORICAL_PARAMS`),
 * que solo ceden en las claves que el operador nombra de verdad. Antes de R2 esto era
 * `setParams(world, parseParams(cadena))`, que reemplazaba el objeto entero: un mundo
 * generado con `agua.cuencas=1` se recargaba, se medía y se volvía a guardar con 0,4 sin
 * decir nada, simulando un régimen distinto del que lo generó.
 */
export function deploymentParams(base: WorldParams = DEFAULT_PARAMS, carta = process.env.CARTA_PARAMS): WorldParams {
  return parseParams(`${PRODUCTION_PARAMS}${carta ? `,${carta}` : ''}`, base);
}
