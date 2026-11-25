/** INTERFAZ PUENTE de las comunidades como red de vínculos (carril s). s rellena los ganchos: con `v23.comunidades`
 * sustituye a `convivir` y a `updateCommunities` (los pasos heredados 'convivir' y 'comunidades'). */
import type { Ley } from './motor/acceso.js';

export const leyComunidades: Ley = { id: 's', interruptor: 'comunidades', sustituye: ['convivir', 'comunidades'] };
