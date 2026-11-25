/** V23 view adapter. The existing Spanish projection remains the allow-list owner. */
import type { PersonView, Viewport, WorldView } from '../shared/types.js';
import type { Person, World, WorldContext } from './index.js';
import { projectWorld as projectBase } from './proyeccion.js';
export { personDetail, VIEW_EVENTS, VIEW_MEMORIES } from './proyeccion.js';

/** Inventories are bounded by the chemistry/technology contracts. No intermediate
 * arrays/objects, and no allocation or mutation at all when no material is carried. */
export function projectCraft(person: Person, view: PersonView): void {
  let tint: string | undefined, focus: string | undefined, best = -1;
  if (person.compounds) for (const lot of person.compounds) {
    if (!(lot.mass > 0)) continue;
    const p = lot.properties, cutting = p.hardness * p.toughness;
    const score = Math.max(cutting, p.insulation, p.seal, p.fuelPower);
    if (score > best) { best = score; tint = p.colorHex; focus = score === cutting ? 'cutting' : score === p.insulation ? 'insulation' : score === p.seal ? 'containment' : 'fuel'; }
  }
  for (const item of person.technology.items) {
    if (!item.materialTint || !(item.mass > 0)) continue;
    const p = item.properties, cutting = p.hardness * p.toughness * p.edge;
    const score = Math.max(cutting, p.insulation, p.containment);
    if (score > best) { best = score; tint = item.materialTint; focus = score === cutting ? 'cutting' : score === p.insulation ? 'insulation' : 'containment'; }
  }
  if (tint !== undefined) { view.craftTint = tint; view.craftFocus = focus; }
}

export function projectWorld(world: World, viewport?: Viewport, context?: WorldContext): WorldView {
  return projectBase(world, viewport, context, projectCraft);
}
