import type { TechnologyKnowledge } from '../../src/shared/technology.js';
import { initialTechnologyKnowledge } from '../../src/world/technology.js';

/** Clon estructural para el instrumento: conserva el cuerpo de la plantilla, pero no
 * duplica pertenencias, proyectos ni práctica tecnológica adquiridos entre ventanas.
 * Cada sintético recibe su propio estado inicial por la misma vía que createWorld. */
export function clonarPlantillaSintetica<T extends { technology: TechnologyKnowledge }>(plantilla: T): T {
  const persona = structuredClone(plantilla);
  persona.technology = initialTechnologyKnowledge();
  return persona;
}
