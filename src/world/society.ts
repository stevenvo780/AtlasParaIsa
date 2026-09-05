import type { ChronicleEvent, CommunityView, PersonView } from '../shared/types.js';
import type { Person, World } from './index.js';
import { localRandom } from './genetics.js';
import { count } from './statistics.js';
import { tileAt } from './spatial.js';
import { constructionCost, waterAvailable } from './inventions.js';
import { CAPABILITIES, MASS_UNIT, materialCapacities, shareTechnology, toolCapacities, transferTechnologyItem } from './technology.js';
import type { Capability, MaterialBatch, TechnologyProgram } from '../shared/technology.js';
import { resolveTechnologyRecipe } from './technology-catalogue.js';

type Emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => ChronicleEvent;
export type Culture = NonNullable<PersonView['culture']>;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export function initialCulture(seed: number, id: string): Culture {
  const random = localRandom(seed, `culture:${id}`);
  return { sharing: 0.15 + random() * 0.7, stewardship: 0.15 + random() * 0.7, openness: 0.15 + random() * 0.7 };
}
export function culturalDistance(a: Culture, b: Culture): number { return (Math.abs(a.sharing - b.sharing) + Math.abs(a.stewardship - b.stewardship) + Math.abs(a.openness - b.openness)) / 3; }
export function bond(world: World, a: Person, b: Person, amount: number): void {
  a.bonds[b.id] = clamp((a.bonds[b.id] ?? 0.2) + amount); b.bonds[a.id] = clamp((b.bonds[a.id] ?? 0.2) + amount);
  if (!world.cooperationEnabled || amount <= 0) return;
  const similarity = 1 - culturalDistance(a.culture, b.culture);
  for (const key of ['sharing','stewardship','openness'] as const) {
    const delta = (b.culture[key] - a.culture[key]) * 0.015 * similarity;
    a.culture[key] = clamp(a.culture[key] + delta); b.culture[key] = clamp(b.culture[key] - delta);
  }
}
export interface Opportunity {
  person: Person; kind: 'supply' | 'assist' | 'teach' | 'trade' | 'tools'; score: number;
  recipeId?: string; supplyMaterial?: 'wood' | 'stone';
  exchange?: { itemId: string; material: 'wood' | 'stone'; amount: number };
}
function practicedRecipeToTeach(world: World, teacher: Person, learner: Person): string | undefined {
  if (!world.learningEnabled) return;
  return teacher.technology.knownRecipes.flatMap(id => {
    if (learner.technology.knownRecipes.includes(id) || (teacher.technology.competence[id]?.successes ?? 0) <= 0) return [];
    const recipe = resolveTechnologyRecipe(world, id); return recipe ? [recipe] : [];
  })
    .sort((a, b) => (teacher.technology.competence[b.id]?.benefit ?? 0) - (teacher.technology.competence[a.id]?.benefit ?? 0) || a.id.localeCompare(b.id))[0]?.id;
}
/** A request comes from the recipient's active program, or a recipe they actually know
 * while attempting fabrication. The world's catalogue is never a source of desires. */
function requestedPrograms(world: World, person: Person): TechnologyProgram[] {
  if (!['research', 'craft'].includes(person.action)) return [];
  if (person.technology.project) return [person.technology.project.program];
  if (person.action !== 'craft') return [];
  return person.technology.knownRecipes.flatMap(id => { const recipe = resolveTechnologyRecipe(world, id); return recipe ? [recipe.program] : []; });
}
function processMaterialNeed(world: World, person: Person): { wood: number; stone: number } {
  const deficit = { wood: 0, stone: 0 };
  for (const program of requestedPrograms(world, person)) {
    const required = { wood: 0, stone: 0 };
    for (const input of program.inputs) if (input.source === 'raw' && (input.material === 'wood' || input.material === 'stone')) required[input.material] += input.mass / MASS_UNIT;
    const fuel = program.steps.reduce((n, s) => n + (s.op === 'heat' ? s.intensity * 50 : 0), 0);
    const scrapUsed = program.inputs.filter(i => i.source === 'residue' && i.material === 'wood').reduce((n, i) => n + i.mass, 0);
    required.wood += Math.max(0, fuel - Math.max(0, person.technology.residue.wood - scrapUsed)) / MASS_UNIT;
    for (const material of ['wood', 'stone'] as const) deficit[material] = Math.max(deficit[material], required[material] - person.materials[material]);
  }
  return deficit;
}
function itemNeed(world: World, person: Person, item: MaterialBatch, excludingItem = false): number {
  const inventory = excludingItem ? person.technology.items.filter(i => i.id !== item.id) : person.technology.items;
  const powers = excludingItem ? toolCapacities({ ...person, technology: { ...person.technology, items: inventory } }) : toolCapacities(person);
  const capacities = materialCapacities(item); let need = 0;
  for (const program of requestedPrograms(world, person)) {
    const requiredMass = program.inputs.filter(i => i.source === 'product' && i.recipeId === item.recipeId).reduce((n, i) => n + i.mass, 0);
    const availableMass = inventory.filter(i => i.recipeId === item.recipeId).reduce((n, i) => n + i.mass, 0);
    if (requiredMass > availableMass) need = Math.max(need, 0.5 + Math.min(0.3, item.mass / Math.max(1, requiredMass) * 0.3));
    for (const step of program.steps) if (step.requiredCatalyst && powers[step.requiredCatalyst] < 0.1 && capacities[step.requiredCatalyst] >= 0.1) need = Math.max(need, 0.75);
  }
  if (distance(person, person.target) <= 7) {
    const tile = tileAt(world, person.target); let useful: Capability | undefined;
    if (person.action === 'gather') {
      const material = person.materials.wood < 6 ? 'wood' : 'stone';
      if ((tile?.[material] ?? 0) > 1 && person.materials[material] < (material === 'wood' ? 11 : 7)) useful = material === 'wood' ? 'cutting' : 'abrasion';
    } else if (person.action === 'farm' && tile && tile.terrain !== 'shelter' && tile.moisture > 0.2 && (tile.cultivation ?? 0) < 1 && person.materials.wood >= 1) useful = 'cultivation';
    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);
  }
  return need;
}
function productExchange(world: World, seller: Person, buyer: Person): Opportunity['exchange'] | undefined {
  if (buyer.technology.items.length >= world.technology.budgets.maxItems) return;
  const item = seller.technology.items.filter(i => itemNeed(world, buyer, i) > 0 && itemNeed(world, seller, i, true) === 0)
    .sort((a, b) => itemNeed(world, buyer, b) - itemNeed(world, buyer, a) || a.id.localeCompare(b.id))[0];
  if (!item) return;
  const material = (['wood', 'stone'] as const).filter(m => buyer.materials[m] >= 1 && seller.materials[m] <= (m === 'wood' ? 11 : 7))
    .filter(m => processMaterialNeed(world, { ...buyer, materials: { ...buyer.materials, [m]: buyer.materials[m] - 1 } })[m] <= processMaterialNeed(world, buyer)[m] && !(buyer.action === 'farm' && m === 'wood' && buyer.materials.wood < 2))
    .sort((a, b) => seller.materials[a] - seller.materials[b] || a.localeCompare(b))[0];
  if (!material) return;
  return { itemId: item.id, material, amount: 1 };
}
/** A home is an observed useful place, not a birth faction or a movement boundary. */
export function settlementOpportunity(world: World, person: Person): { target: {x:number;y:number}; score: number; reason: string } | undefined {
  if (!world.cooperationEnabled) return;
  const viable = (place: {x:number;y:number}) => {
    let food = 0, water = 0;
    for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) {
      if (dx*dx+dy*dy>16) continue;
      const tile = tileAt(world,{x:place.x+dx,y:place.y+dy});
      if (tile && tile.terrain !== 'water') { food += tile.food; water += tile.drinkingWater ?? 0; }
    }
    const facilities = world.structures.filter(s=>distance(s,place)<=4 && s.condition>0.1);
    food += facilities.reduce((sum,s)=>sum+s.food,0); water += facilities.reduce((sum,s)=>sum+s.water,0);
    const peers = world.people.filter(p=>p!==person && distance(p,place)<=6);
    const trust = peers.reduce((sum,p)=>sum+(person.bonds[p.id]??0.15),0)/Math.max(1,peers.length);
    const provision = Math.min(clamp(food/0.8),clamp(water/0.12));
    return provision * (0.45 + (facilities.length ? 0.25 : 0) + trust*0.3);
  };
  if (person.home && distance(person,person.home)<=7) {
    person.home.quality = viable(person.home); person.home.observedAt = world.tick;
    if (person.home.quality < 0.12) delete person.home;
  }
  const nearby = world.places.filter(p=>distance(person,p)<=6).map(p=>({place:p,quality:viable(p)}))
    .sort((a,b)=>b.quality-a.quality || distance(person,a.place)-distance(person,b.place));
  const best = nearby[0];
  if (best && best.quality>0.4 && (!person.home || best.quality>person.home.quality+0.12)) person.home={x:best.place.x,y:best.place.y,quality:best.quality,observedAt:world.tick};
  const home=person.home;
  if (!home) return;
  // Old observations decay. An explorer cannot read distant regenerated resources.
  const confidence=Math.max(0,1-(world.tick-home.observedAt)/2400), quality=home.quality*confidence;
  if (quality<0.2 || Math.max(person.hunger,person.thirst)>0.82 || person.socialLoad>0.75) return;
  const away=distance(person,home);
  if (away<2) return;
  return {target:{x:home.x,y:home.y},score:quality*(0.55+person.sociability*0.25+(1-person.curiosity)*0.2)+Math.min(0.18,away*0.012),reason:'Vuelve a un lugar conocido con agua, alimento, techo o cooperación; compara esos beneficios con sus necesidades actuales.'};
}
export function cooperationOpportunity(world: World, person: Person): Opportunity | undefined {
  if (!world.cooperationEnabled) return;
  const opportunities: Opportunity[] = [];
  for (const other of world.people) {
    if (other === person || distance(person, other) > 7 || world.tick - person.lastSocial < 30) continue;
    const same = person.communityId && person.communityId === other.communityId;
    const trust = person.bonds[other.id] ?? 0.2;
    const openness = other.communityId !== person.communityId && !same ? person.culture.openness : 1;
    const score = 0.22 + person.genome.cooperation * 0.35 + trust * 0.16 + openness * 0.07;
    const cost = constructionCost(world,other);
    const processNeed = processMaterialNeed(world, other);
    const supplyMaterial = (['wood', 'stone'] as const).find(m => processNeed[m] > 0 && person.materials[m] >= 1 && other.materials[m] <= (m === 'wood' ? 11 : 7));
    const recipeId = practicedRecipeToTeach(world, person, other), exchange = productExchange(world, person, other);
    if (exchange) opportunities.push({ person: other, kind: 'tools', exchange, score: score + 0.24 });
    if (supplyMaterial) opportunities.push({ person: other, kind: 'supply', supplyMaterial, score: score + 0.22 });
    if (recipeId) opportunities.push({ person: other, kind: 'teach', recipeId, score: score + 0.06 });
    if (other.action === 'build' && ((other.materials.wood < cost.wood && person.materials.wood > 0) || (other.materials.stone < cost.stone && person.materials.stone > 0))) opportunities.push({ person: other, kind: 'supply', score: score + 0.22 });
    else if ((other.action === 'build' || other.action === 'hunt') && other.work > 0 && other.work < (other.action === 'build' ? cost.work : Math.ceil(45*(1-(other.skills.hunt??0)*0.25))) - 1) opportunities.push({ person: other, kind: 'assist', score: score + 0.16 });
    else if (person.materials.wood >= 2 && person.materials.stone < 2 && other.materials.stone >= 2 && other.materials.wood < 6) opportunities.push({ person: other, kind: 'trade', score: score + 0.08 });
    else if (world.learningEnabled && Object.entries(person.skills).some(([skill, level]) => level > (other.skills[skill] ?? 0) + 0.08)) opportunities.push({ person: other, kind: 'teach', score });
  }
  return opportunities.sort((a, b) => b.score - a.score || distance(person, a.person) - distance(person, b.person) || a.person.id.localeCompare(b.person.id))[0];
}
export function cooperate(world: World, person: Person, emit: Emit): boolean {
  const opportunity = cooperationOpportunity(world, person);
  if (!opportunity || distance(person, opportunity.person) > 1.5) return false;
  const other = opportunity.person; let detail = '', helperPaid = false;
  if (opportunity.kind === 'supply') {
    const material = opportunity.supplyMaterial ?? (other.materials.wood < constructionCost(world,other).wood && person.materials.wood > 0 ? 'wood' : 'stone');
    if (person.materials[material] < 1 || other.materials[material] > (material === 'wood' ? 11 : 7) || (opportunity.supplyMaterial && processMaterialNeed(world, other)[material] <= 0)) return false;
    person.materials[material]--; other.materials[material]++;
    detail = `Aportó una unidad de ${material === 'wood' ? 'madera' : 'piedra'} al trabajo de ${other.name}.`;
  } else if (opportunity.kind === 'assist') {
    const before = other.work;
    const ceiling = (other.action === 'build' ? constructionCost(world,other).work : Math.ceil(45*(1-(other.skills.hunt??0)*0.25))) - 1;
    if (before >= ceiling) return false;
    other.work = Math.min(ceiling, other.work + 12); count(world, 'constructionHelp');
    detail = `Aportó ${other.work - before} unidades de trabajo a ${other.action === 'build' ? 'la obra' : 'la caza'} de ${other.name}.`;
  } else if (opportunity.kind === 'trade') {
    person.materials.wood--; other.materials.wood++; other.materials.stone--; person.materials.stone++; count(world, 'trade');
    detail = `Intercambiaron una madera por una piedra; ambos resolvieron una carencia.`;
  } else if (opportunity.kind === 'tools') {
    const exchange = opportunity.exchange;
    if (!exchange || other.materials[exchange.material] < exchange.amount || person.materials[exchange.material] + exchange.amount > (exchange.material === 'wood' ? 12 : 8) || productExchange(world, person, other)?.itemId !== exchange.itemId) return false;
    const item = person.technology.items.find(i => i.id === exchange.itemId);
    if (!item || itemNeed(world, other, item) <= 0 || itemNeed(world, person, item, true) > 0 || !transferTechnologyItem(world, person, other, item.id)) return false;
    other.materials[exchange.material] -= exchange.amount; person.materials[exchange.material] += exchange.amount; count(world, 'trade');
    const capacities = materialCapacities(item), strongest = [...CAPABILITIES].sort((a, b) => capacities[b] - capacities[a])[0]!;
    const words: Record<Capability, string> = { cutting: 'corte', storage: 'contención', insulation: 'aislamiento', cultivation: 'palanca para cultivo', binding: 'unión', abrasion: 'abrasión' };
    detail = `Entregó el objeto ${item.id}, con ${item.mass} unidades de masa y capacidad de ${words[strongest]}, a cambio de una unidad de ${exchange.material === 'wood' ? 'madera' : 'piedra'}; resuelve una carencia observable sin duplicar el lote.`;
  } else if (opportunity.recipeId) {
    if (!practicedRecipeToTeach(world, person, other) || (person.technology.competence[opportunity.recipeId]?.successes ?? 0) <= 0 || !shareTechnology(world, person, other, emit, opportunity.recipeId)) return false;
    helperPaid = true; count(world, 'teaching');
    const recipe = resolveTechnologyRecipe(world, opportunity.recipeId)!;
    detail = `Mostró las operaciones practicadas ${recipe.program.steps.map(s => s.op).join(' → ')}; ${other.name} aprendió la receta por esta interacción cercana.`;
  } else {
    const skill = Object.keys(person.skills).filter(key => person.skills[key]! > (other.skills[key] ?? 0) + 0.08).sort((a, b) => person.skills[b]! - person.skills[a]!)[0];
    if (!skill) return false;
    other.skills[skill] = clamp((other.skills[skill] ?? 0) + Math.min(0.012, (person.skills[skill]! - (other.skills[skill] ?? 0)) * other.genome.learningRate)); count(world, 'teaching');
    detail = `Mostró una técnica practicada de ${skill}; ${other.name} aprendió mediante observación.`;
  }
  person.lastSocial = world.tick;
  if (!helperPaid) { person.energy = clamp(person.energy - 0.005); person.fatigue = clamp(person.fatigue + 0.004); }
  bond(world, person, other, 0.12); count(world, 'cooperation');
  const group = world.communities.find(c => c.id === person.communityId); if (group) group.cooperation++;
  const event = emit({ kind: 'cooperation', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} cooperó con ${other.name}. ${detail}`, cause: `Estrategia ${opportunity.kind}; recursos o trabajo transferidos realmente; confianza reforzada y prácticas locales aproximadas.` });
  for (const p of [person, other]) { p.experiences.push({ tick: world.tick, text: detail, causeId: event.id, placeId: '' }); p.experiences = p.experiences.slice(-8); p.recentMemory = detail; }
  return true;
}

/** Local trust and cultural similarity form groups; group identity alone never causes a dispute. */
export function updateCommunities(world: World, emit: Emit): void {
  if (!world.cooperationEnabled || world.tick % 120 !== 0) return;
  // Membership can change when lived practices and trust cease to fit a group.
  // Nearby compatible contacts are required; geographical isolation alone is insufficient.
  for (const person of world.people) {
    const group = world.communities.find(c => c.id === person.communityId);
    if (!group || culturalDistance(person.culture, group.culture) < 0.3) continue;
    const peers = world.people.filter(p => p !== person && p.communityId === group.id);
    const trust = peers.length ? peers.reduce((sum, p) => sum + (person.bonds[p.id] ?? 0.2), 0) / peers.length : 0.2;
    const alternatives = world.people.filter(p => p !== person && p.communityId !== group.id && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.3 && culturalDistance(person.culture, p.culture) < 0.2);
    if (trust >= 0.35 || alternatives.length < 2) continue;
    person.communityId = null;
    emit({ kind: 'community', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} dejó ${group.name} y buscó otra comunidad cercana.`, cause: 'Prácticas distintas, confianza interna baja y al menos dos contactos cercanos compatibles; la pertenencia es revisable.' });
  }
  for (const group of world.communities) {
    const members = world.people.filter(p => p.communityId === group.id);
    group.members = members.map(p => p.id);
    if (members.length) {
      for (const key of ['sharing','stewardship','openness'] as const) group.culture[key] = members.reduce((sum, p) => sum + p.culture[key], 0) / members.length;
      group.x = Math.round(members.reduce((sum, p) => sum + p.x, 0) / members.length); group.y = Math.round(members.reduce((sum, p) => sum + p.y, 0) / members.length);
    }
  }
  for (const person of world.people) {
    if (person.communityId) continue;
    const nearby = world.people.filter(p => p !== person && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.25 && culturalDistance(person.culture, p.culture) < 0.3);
    const known = nearby.find(p => p.communityId);
    if (known) { person.communityId = known.communityId; world.communities.find(c => c.id === known.communityId)?.members.push(person.id); continue; }
    const free = nearby.filter(p => !p.communityId);
    if (free.length < 2 || world.communities.length >= 8 || !world.places.some(place => distance(person, place) <= 7)) continue;
    const members = [person, ...free], id = `community-${++world.communityCounter}`;
    const syllables = ['Sauce','Brisa','Lumbre','Junco','Piedra','Semilla','Rocío','Sendero'];
    const random = localRandom(world.seed, id), name = `Círculo de ${syllables[Math.floor(random() * syllables.length)]}`;
    const group: CommunityView = { id, name, x: person.x, y: person.y, members: members.map(p => p.id), color: ['#dfba67','#76b8be','#c498b8','#a3bb6c'][world.communityCounter % 4]!, culture: { ...person.culture }, formedAt: world.tick, cooperation: 0, disputes: 0 };
    for (const p of members) p.communityId = id;
    world.communities.push(group);
    emit({ kind: 'community', actors: group.members, x: person.x, y: person.y, source: 'simulation', text: `${name} tomó forma entre ${members.map(p => p.name).join(', ')}.`, cause: 'Confianza ganada en interacciones cercanas, prácticas compatibles y un lugar compartido; no se asignó una facción al nacer.' });
  }
  world.communities = world.communities.filter(group => group.members.length > 0);
}
export function resourceDispute(world: World, person: Person, emit: Emit): boolean {
  if (!world.cooperationEnabled || !person.communityId || world.tick - person.lastDispute < 180 || Math.max(person.hunger, person.thirst) < 0.65) return false;
  const source = tileAt(world, person.target);
  const stock = person.action === 'drink' ? waterAvailable(world,person.target) : person.action === 'hunt' ? source?.fauna ?? 0 : source?.food ?? 0;
  if (!source || !['eat','drink','hunt'].includes(person.action) || stock <= 0 || stock > (person.action === 'drink' ? 0.12 : person.action === 'hunt' ? 1 : 0.06)) return false;
  const other = world.people.find(p => p !== person && p.communityId && p.action === person.action && distance(person, p) <= 2 && distance(person.target, p.target) < 0.5 && Math.max(p.hunger, p.thirst) > 0.65 && world.tick - p.lastDispute >= 180);
  if (!other) return false;
  const trust = person.bonds[other.id] ?? 0.2;
  if (trust >= 0.55 || (person.culture.openness + other.culture.openness) / 2 >= 0.65) {
    bond(world, person, other, 0.04); person.lastDispute = other.lastDispute = world.tick;
    person.action = 'retreat'; person.target = { x: person.x, y: person.y }; person.decisionAt = world.tick + 12;
    person.reason = 'Acordó un turno ante la escasez: deja acceder primero a su vecino.';
    count(world, 'cooperation');
    emit({ kind: 'cooperation', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} y ${other.name} acordaron turnarse ante una fuente escasa.`, cause: 'Confianza o apertura aprendida permiten coordinar el acceso; el primero espera doce pasos y el recurso no aumenta.' });
    return true;
  }
  if (person.communityId === other.communityId && trust >= 0.25) return false;
  person.lastDispute = world.tick; other.lastDispute = world.tick;
  person.socialLoad = clamp(person.socialLoad + 0.12); other.socialLoad = clamp(other.socialLoad + 0.12);
  person.fatigue = clamp(person.fatigue + 0.015); other.fatigue = clamp(other.fatigue + 0.015);
  bond(world, person, other, -0.08); count(world, 'conflicts');
  for (const p of [person, other]) { const group = world.communities.find(c => c.id === p.communityId); if (group) group.disputes++; }
  // Yield one contested attempt, producing an observable cost without forced violence or theft.
  person.action = 'retreat'; person.target = { x: person.x, y: person.y }; person.decisionAt = world.tick + 30;
  person.reason = 'Una fuente escasa quedó disputada; cede el intento y busca otra posibilidad.';
  emit({ kind: 'conflict', actors: [person.id, other.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} y ${other.name} disputaron una fuente escasa.`, cause: 'Necesidades urgentes, mismo destino, confianza baja y prácticas de apertura reducida. Fatiga y tensión aumentan; uno cede el intento. La diferencia de grupo por sí sola no dispara conflicto.' });
  return true;
}
