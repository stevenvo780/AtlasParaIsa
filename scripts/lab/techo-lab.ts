/**
 * Techo DETERMINISTA de laboratorio (`scripts/lab/replica.ts --techo-lab N`, noche 2026-09-22).
 *
 * Por qué: el servidor, con la política `gobernador.politica = 'techo'` (src/server/governor.ts), fija un
 * techo de población cuando el p95 del paso supera `gobernador.presupuestoMs` y desde ahí los nacimientos
 * solo reponen muertes. Ese disparo depende del reloj de pared (carga de la torre, otras réplicas): no es
 * reproducible. Para corridas de 60 días comparables entre semillas y repetibles bit a bit, el
 * laboratorio usa la MISMA rama de la política con el techo ya fijado en N.
 *
 * Qué NO es: no es una ley del mundo (no toca src/world ni los params; solo `world.reproductionEnabled`,
 * que ya gobierna el servidor) ni un tope del servidor: el servidor sigue gobernado por hardware
 * (ruling R17, FR-013). Ver scripts/lab/README.md §«Techo de laboratorio».
 */
import { decidirConTecho } from '../../src/server/governor.js';

/** El mundo nace con 16 personas (14 vecinos fundadores + S e I): un techo menor no deja reponer ni a los fundadores. */
export const TECHO_LAB_MINIMO = 16;

/**
 * Decisión del techo de laboratorio para el paso siguiente: la rama de `decidirConTecho` (la MISMA función
 * que usa el servidor) en rojo permanente con el techo ya fijado en `techo`, i.e. `poblacion < techo`.
 * `poblacion` debe contarse como el servidor: `world.people.length` (todas las personas vivas, S e I
 * incluidas; `governReproduction` en src/server/app.ts pasa `draft.people.length`).
 */
export function decidirTechoLab(poblacion: number, techo: number, presupuestoMs: number): boolean {
  return decidirConTecho(Number.POSITIVE_INFINITY, presupuestoMs, poblacion, { techo }).reproduccion;
}

/**
 * Cota de población que garantiza el techo de laboratorio. Solo `reproduce()` (src/world/index.ts) añade
 * personas a `world.people`, y solo con `reproductionEnabled`; en un paso nacen como mucho
 * `poblacion.nacimientosPorComprobacion` (su cupo menos los nacidos en la ventana de
 * `intervaloComprobacionTicks`). Así, si antes del paso hay P ≥ N personas, tras él hay ≤ P (ningún
 * nacimiento); si P ≤ N − 1, hay ≤ N − 1 + nacidos del paso ≤ N − 1 + nacimientosPorComprobacion.
 * Por inducción, tras cualquier paso:
 *
 *   población ≤ max(poblaciónInicial, N − 1 + nacimientosPorComprobacion).
 *
 * Es decir: se pasa de N como mucho en los nacidos de UN paso menos uno (los que ya estaban decididos
 * cuando aún había sitio), nunca más.
 */
export function techoLabCota(techo: number, poblacionInicial: number, nacimientosPorComprobacion: number): number {
  return Math.max(poblacionInicial, techo - 1 + nacimientosPorComprobacion);
}
