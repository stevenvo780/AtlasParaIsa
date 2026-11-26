import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../world/params.js';
import { hostFullHardwareParams, hostOpenWorldParams, hostParams } from './hardware-limits.js';

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
 * Por defecto se guarda cada 100 pasos (ruling R19) y siempre que llega un gesto. `CARTA_PARAMS`
 * permite ajustar los parámetros admitidos, incluida la cadencia de guardado y la ventana de poda.
 */
export const PRODUCTION_PARAMS = 'persistencia.cadaTicks=100,persistencia.ventanaEventosTicks=24000';

/**
 * Los overrides del despliegue aplicados ENCIMA de `base`, clave a clave. Para un mundo
 * nuevo `base` son los defaults (`DEFAULT_PARAMS`, reglas 10); para un mundo cargado son los
 * params de su instantánea (completados con `HISTORICAL_PARAMS`),
 * que solo ceden en las claves que el operador nombra de verdad. Reemplazar el objeto entero
 * por los overrides haría que un mundo generado con `agua.cuencas=1` se recargara, se midiera y
 * se volviera a guardar con 0,4 sin decir nada, simulando un régimen distinto del que lo generó.
 */
export function deploymentParams(base: WorldParams = DEFAULT_PARAMS, carta = process.env.CARTA_PARAMS): WorldParams {
  return parseParams(`${PRODUCTION_PARAMS}${carta ? `,${carta}` : ''}`, base);
}

export function paramsNuevosDeDespliegue(): WorldParams {
  const carta = process.env.CARTA_PARAMS;
  const arranque = deploymentParams(DEFAULT_PARAMS, carta);
  const v23 = arranque.v23.duenos || arranque.v23.fotograma;
  const sinDespachoHeredado = v23 ? { nvrtcAvailable: () => false, cpuThreads: () => 1 } : undefined;
  const leyes = parseParams({ v23: arranque.v23 }, DEFAULT_PARAMS);
  const base = process.env.CARTA_OPEN_WORLD === '1' ? hostOpenWorldParams(leyes, sinDespachoHeredado)
    : process.env.CARTA_FULL_HARDWARE === '1' && !v23 ? hostFullHardwareParams(leyes) : hostParams(leyes);
  return deploymentParams(base, carta);
}
