/**
 * Registro de las leyes de la V23, en el orden en que el motor llama a sus ganchos dentro de cada fase. No es de
 * ningún carril: lo leen los que conducen el tick (m4a), aplican intentos (m5), proyectan (m6) y miden (lab). Los
 * ficheros de las leyes NO importan este módulo (evita ciclos): importan los tipos de `motor/acceso.ts`.
 *
 * Por qué este orden: el cuerpo (b) metaboliza antes de que nadie actúe; la fauna (f) y la cohesión (n) deciden antes
 * que las personas (act); lo que cruza organismos (m5) va tras actuar; técnica (t1) y obra (t2) después; las muertes y
 * los vínculos quedan resueltos antes de que la natalidad (n) conciba o haga nacer, y las comunidades (s) cierran.
 */
import type { InterruptoresV23 } from '../../shared/interruptores.js';
import { leyActuar } from '../actuar/ley-actuar.js';
import { leyCohesion } from '../cohesion.js';
import { leyComunidades } from '../comunidades.js';
import { leyFauna } from '../ley-fauna.js';
import { leyCuerpos } from '../materia/cuerpo.js';
import { leyMundo } from '../materia/ley-mundo.js';
import { leyObra } from '../materia/piezas.js';
import { leyTecnica } from '../materia/proceso.js';
import { leyNatalidad } from '../natalidad.js';
import type { Ley, PasoHeredado } from './acceso.js';
import { leyInteracciones } from '../actuar/interacciones.js';

export const LEYES: readonly Ley[] = [
  leyMundo, leyCuerpos, leyFauna, leyCohesion, leyActuar, leyInteracciones, leyTecnica, leyObra, leyNatalidad, leyComunidades,
];

/** Las leyes encendidas en un mundo, en orden. */
export const leyesActivas = (v: Readonly<InterruptoresV23>): Ley[] => LEYES.filter(l => v[l.interruptor]);

/** ¿Hay alguna ley encendida que reemplace este paso heredado? (el tick heredado lo salta). */
export const sustituido = (v: Readonly<InterruptoresV23>, paso: PasoHeredado): boolean =>
  LEYES.some(l => v[l.interruptor] && l.sustituye?.includes(paso) === true);
