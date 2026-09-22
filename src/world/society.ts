import type { ChronicleEvent, CommunityView, PersonView } from '../shared/types.js';
import type { Person, World } from './index.js';
import { localRandom } from './genetics.js';
import { paramsOf } from './params.js';
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
/** Instruction helps a material task the learner is actually undertaking. A skill
 * received from a lesson is not evidence that its holder has practised it. */
function practicedSkillToTeach(world: World, teacher: Person, learner: Person): string | undefined {
  if (!world.learningEnabled || distance(learner, learner.target) > 7) return;
  const skill = learner.action;
  if (!['gather', 'farm', 'hunt', 'forage'].includes(skill) || (teacher.activity[skill] ?? 0) <= 0 ||
    (teacher.skills[skill] ?? 0) <= (learner.skills[skill] ?? 0) + 0.08) return;
  const tile = tileAt(world, learner.target);
  if (!tile) return;
  const useful = skill === 'gather' ? ((tile.wood ?? 0) >= 1 && learner.materials.wood < 12) || ((tile.stone ?? 0) >= 1 && learner.materials.stone < 8)
    : skill === 'farm' ? learner.materials.wood >= 1 && tile.terrain !== 'shelter' && tile.moisture > 0.2 && tile.vegetation < 0.9 && (tile.cultivation ?? 0) < 1
    : skill === 'hunt' ? (tile.fauna ?? 0) >= 1
    : tile.food > 0 && learner.inventory < 0.25;
  return useful ? skill : undefined;
}

/** This is a local prospect, not a withdrawal: supplies still require collection
 * or exchange and fabrication still pays the physical execution's full costs. */
function localRecipeInputs(world: World, teacher: Person, learner: Person): (program: TechnologyProgram, prospectiveProductId?: string) => boolean {
  const raw = { wood: (learner.materials.wood + teacher.materials.wood) * MASS_UNIT,
    stone: (learner.materials.stone + teacher.materials.stone) * MASS_UNIT, water: 0 };
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy > 49) continue;
    const tile = tileAt(world, { x: learner.x + dx, y: learner.y + dy });
    if (tile && tile.terrain !== 'water') { raw.wood += (tile.wood ?? 0) * MASS_UNIT; raw.stone += (tile.stone ?? 0) * MASS_UNIT; raw.water += (tile.drinkingWater ?? 0) * 50_000; }
  }
  const items = [...learner.technology.items, ...teacher.technology.items], powers = toolCapacities({ ...learner, technology: { ...learner.technology, items } });
  return (program, prospectiveProductId) => {
    const required = { wood: 0, stone: 0, water: 0 }, residue = { wood: 0, stone: 0, water: 0 }, products = new Map<string, number>();
    for (const input of program.inputs) {
      if (input.source === 'product') products.set(input.recipeId!, (products.get(input.recipeId!) ?? 0) + input.mass);
      else (input.source === 'raw' ? required : residue)[input.material!] += input.mass;
    }
    const fuel = program.steps.reduce((n, step) => n + (step.op === 'heat' ? step.intensity * 50 : 0), 0);
    required.wood += Math.max(0, fuel - Math.max(0, learner.technology.residue.wood - residue.wood));
    return (['wood', 'stone', 'water'] as const).every(material => required[material] <= raw[material] && residue[material] <= learner.technology.residue[material]) &&
      [...products].every(([id, needed]) => id === prospectiveProductId || items.filter(item => item.recipeId === id).reduce((total, item) => total + item.mass, 0) >= needed) &&
      program.steps.every(step => !step.requiredCatalyst || powers[step.requiredCatalyst] >= 0.1);
  };
}
function practicedRecipeToTeach(world: World, teacher: Person, learner: Person): string | undefined {
  if (!world.learningEnabled) return;
  const candidates = teacher.technology.knownRecipes.flatMap(id => {
    if (learner.technology.knownRecipes.includes(id) || (teacher.technology.competence[id]?.successes ?? 0) <= 0) return [];
    const recipe = resolveTechnologyRecipe(world, id); return recipe ? [recipe] : [];
  });
  if (!candidates.length) return;
  const inputsAvailable = localRecipeInputs(world, teacher, learner);
  const remembered = learner.technology.knownRecipes.flatMap(id => { const recipe = resolveTechnologyRecipe(world, id); return recipe ? [recipe] : []; });
  const known = remembered.filter(recipe => inputsAvailable(recipe.program));
  // Possessing a tool does not teach its replacement. Compare reproducible
  // instructions, not the world catalogue or the teacher's lifetime popularity.
  const powers = Object.fromEntries(CAPABILITIES.map(capability => [capability, Math.max(0, ...known.map(recipe => recipe.capacities[capability]))])) as Record<Capability, number>;
  // An intermediate can unblock instructions already remembered before a craft
  // action is possible. Assess only those instructions (or the learner's own active
  // program), with the other substrates still required locally; the world catalogue
  // supplies no new desires and no product is credited until fabrication pays for it.
  const prospectivePrograms = [...remembered.map(recipe => recipe.program), ...requestedPrograms(world, learner)];
  const viable = candidates.filter(recipe => inputsAvailable(recipe.program)).map(recipe => ({ recipe,
    gain: Math.max(...CAPABILITIES.map(capability => recipe.capacities[capability] - powers[capability]))
      + (prospectivePrograms.some(program => program.inputs.some(input => input.source === 'product' && input.recipeId === recipe.id)
        && inputsAvailable(program, recipe.id)) ? 1 : 0),
  })).filter(candidate => candidate.gain > 0.12);
  // Ley candidata `social.ensenanzaRareza`: ordenar sólo por `gain` reenseña siempre la
  // misma receta y la transmisión se apaga cuando todos la saben. La rareza medida —la
  // fracción de vivos que NO la recuerdan— entra en la clave de orden; con el default 0
  // la clave vuelve a ser `gain` y el orden es exactamente el histórico. El filtro
  // `gain > 0.12` y los dos desempates (beneficio del maestro, id) no se tocan.
  const rareza = paramsOf(world).social.ensenanzaRareza;
  const holders = rareza > 0 ? recipeHolders(world, viable) : undefined;
  const alive = Math.max(1, world.people.length);
  return viable.map(candidate => ({ ...candidate,
    key: candidate.gain + (holders ? rareza * (1 - (holders.get(candidate.recipe.id) ?? 0) / alive) : 0) }))
    .sort((a, b) => b.key - a.key || (teacher.technology.competence[b.recipe.id]?.benefit ?? 0) - (teacher.technology.competence[a.recipe.id]?.benefit ?? 0) || a.recipe.id.localeCompare(b.recipe.id))[0]?.recipe.id;
}
/** Vivos que ya recuerdan cada receta candidata, en UNA pasada por la población: contar
 * por receta recorrería `O(personas × recetas)` una vez por candidata. */
function recipeHolders(world: World, candidates: readonly { recipe: { id: string } }[]): Map<string, number> {
  const counts = new Map(candidates.map(candidate => [candidate.recipe.id, 0]));
  for (const person of world.people) for (const id of person.technology.knownRecipes) {
    const held = counts.get(id);
    if (held !== undefined) counts.set(id, held + 1);
  }
  return counts;
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
    else if (practicedSkillToTeach(world, person, other)) opportunities.push({ person: other, kind: 'teach', score });
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
    if (practicedRecipeToTeach(world, person, other) !== opportunity.recipeId || !shareTechnology(world, person, other, emit, opportunity.recipeId)) return false;
    helperPaid = true; count(world, 'teaching');
    const recipe = resolveTechnologyRecipe(world, opportunity.recipeId)!;
    detail = `Mostró las operaciones practicadas ${recipe.program.steps.map(s => s.op).join(' → ')}; ${other.name} aprendió la receta por esta interacción cercana.`;
  } else {
    const skill = practicedSkillToTeach(world, person, other);
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

const COMMUNITY_SYLLABLES = ['Sauce','Brisa','Lumbre','Junco','Piedra','Semilla','Rocío','Sendero'];
const COMMUNITY_COLORS = ['#dfba67','#76b8be','#c498b8','#a3bb6c'];
/** Vecino de confianza: el mismo predicado con el que `updateCommunities` une y funda (≤ 6 celdas,
 * confianza propia ≥ 0,25, prácticas a menos de 0,3). */
const trustedNeighbor = (person: Person, other: Person): boolean => other !== person && distance(person, other) <= 6
  && (person.bonds[other.id] ?? 0) >= 0.25 && culturalDistance(person.culture, other.culture) < 0.3;
/** Comunidad a la que pertenecen más vecinos de confianza; empate por id. */
function trustedMajority(nearby: readonly Person[]): { id: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const p of nearby) if (p.communityId) counts.set(p.communityId, (counts.get(p.communityId) ?? 0) + 1);
  let best: { id: string; count: number } | undefined;
  for (const [id, n] of counts) if (!best || n > best.count || (n === best.count && id < best.id)) best = { id, count: n };
  return best;
}

/**
 * Ley candidata `social.radioConvivencia` (hipótesis COM, 2026-09-22): la pertenencia es con quién
 * convivo y en quién confío, no una etiqueta de nacimiento. Dos reglas locales, sin umbrales nuevos
 * salvo el radio:
 * 1. Fisión: quien vive a más de `radius` celdas del centro de su comunidad y tiene al menos dos vecinos
 *    de confianza de su misma comunidad funda con ellos una propia (mismos requisitos que una fundación:
 *    tres personas, un lugar a ≤ 7 celdas y el tope `social.maxComunidades`), siempre que el grupo de
 *    origen conserve a alguien. Una fisión por comunidad y revisión.
 * 2. Mayoría: quien tiene al menos dos vecinos de confianza de otra comunidad, y más que de la suya,
 *    pasa a esa comunidad (se revisa en orden de `world.people`, así que un par aislado no se intercambia).
 * Nada se crea ni se paga: sólo cambia a qué grupo cuenta cada uno. Cada cambio deja un evento con causa.
 */
function reviseByCohabitation(world: World, emit: Emit, radius: number): void {
  const cap = paramsOf(world).social.maxComunidades;
  for (const group of [...world.communities]) {
    const members = world.people.filter(p => p.communityId === group.id);
    if (members.length < 4 || world.communities.length >= cap) continue;
    const center = { x: members.reduce((sum, p) => sum + p.x, 0) / members.length, y: members.reduce((sum, p) => sum + p.y, 0) / members.length };
    for (const person of members) {
      const away = distance(person, center);
      if (away <= radius) continue;
      const core = members.filter(p => trustedNeighbor(person, p));
      if (core.length < 2 || core.length + 1 >= members.length || !world.places.some(place => distance(person, place) <= 7)) continue;
      const founders = [person, ...core], id = `community-${++world.communityCounter}`;
      const random = localRandom(world.seed, id), name = `Círculo de ${COMMUNITY_SYLLABLES[Math.floor(random() * COMMUNITY_SYLLABLES.length)]}`;
      const ids = founders.map(p => p.id);
      world.communities.push({ id, name, x: person.x, y: person.y, members: ids, color: COMMUNITY_COLORS[world.communityCounter % 4]!, culture: { ...person.culture }, formedAt: world.tick, cooperation: 0, disputes: 0 });
      for (const p of founders) p.communityId = id;
      // Arreglo propio para el evento: la fisión no reproduce el alias de la fundación (nota de abajo).
      emit({ kind: 'community', actors: [...ids], x: person.x, y: person.y, source: 'simulation', text: `${name} se separó de ${group.name} entre ${founders.map(p => p.name).join(', ')}.`, cause: `Viven a ${away.toFixed(1)} celdas del centro de ${group.name} (más de ${radius}) y confían entre sí; la pertenencia sigue a la convivencia, no a la etiqueta de origen. Mismos requisitos que una fundación: tres personas, un lugar cercano y el tope de comunidades.` });
      break;
    }
  }
  for (const person of world.people) {
    if (!person.communityId) continue;
    const nearby = world.people.filter(p => trustedNeighbor(person, p));
    const own = nearby.filter(p => p.communityId === person.communityId).length;
    const best = trustedMajority(nearby.filter(p => p.communityId !== person.communityId));
    if (!best || best.count < 2 || best.count <= own) continue;
    const from = world.communities.find(c => c.id === person.communityId), to = world.communities.find(c => c.id === best.id);
    if (!to) continue;
    person.communityId = to.id;
    emit({ kind: 'community', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} dejó ${from?.name ?? 'su comunidad'} y se unió a ${to.name}.`, cause: `${best.count} de sus vecinos de confianza son de ${to.name} y ${own} de la suya; la pertenencia sigue a la convivencia y la confianza.` });
  }
}

/** Local trust and cultural similarity form groups; group identity alone never causes a dispute. */
export function updateCommunities(world: World, emit: Emit): void {
  if (!world.cooperationEnabled || world.tick % 120 !== 0) return;
  // Membership can change when lived practices and trust cease to fit a group.
  // Nearby compatible contacts are required; geographical isolation alone is insufficient.
  // Leyes candidatas `social.confianzaSalida` y `social.distanciaAlternativa`: cada
  // cooperación suma +0,12 de confianza, así que la media satura y la salida queda
  // cerrada; y las alternativas vienen de grupos que divergen, así que exigirles menos
  // de 0,2 de distancia cultural las descarta siempre. Los defaults son esos dos números.
  const { confianzaSalida, distanciaAlternativa, radioConvivencia } = paramsOf(world).social;
  for (const person of world.people) {
    const group = world.communities.find(c => c.id === person.communityId);
    if (!group || culturalDistance(person.culture, group.culture) < 0.3) continue;
    const peers = world.people.filter(p => p !== person && p.communityId === group.id);
    const trust = peers.length ? peers.reduce((sum, p) => sum + (person.bonds[p.id] ?? 0.2), 0) / peers.length : 0.2;
    const alternatives = world.people.filter(p => p !== person && p.communityId !== group.id && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.3 && culturalDistance(person.culture, p.culture) < distanciaAlternativa);
    if (trust >= confianzaSalida || alternatives.length < 2) continue;
    person.communityId = null;
    emit({ kind: 'community', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} dejó ${group.name} y buscó otra comunidad cercana.`, cause: 'Prácticas distintas, confianza interna baja y al menos dos contactos cercanos compatibles; la pertenencia es revisable.' });
  }
  if (radioConvivencia > 0) reviseByCohabitation(world, emit, radioConvivencia);
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
    // Con `social.radioConvivencia` > 0 quien no tiene comunidad (una cría, un recién llegado) se une a la
    // de la mayoría de sus vecinos de confianza; con 0, a la del primero que encuentra, como siempre.
    const joined = radioConvivencia > 0 ? trustedMajority(nearby)?.id : nearby.find(p => p.communityId)?.communityId;
    if (joined) { person.communityId = joined; world.communities.find(c => c.id === joined)?.members.push(person.id); continue; }
    const free = nearby.filter(p => !p.communityId);
    // Tope de FUNDACIÓN = `social.maxComunidades` (regla de conducta; default 8 = la de siempre).
    // La admisión `limites.comunidades` es otra cosa: lanza al validar, nunca decide aquí.
    if (free.length < 2 || world.communities.length >= paramsOf(world).social.maxComunidades || !world.places.some(place => distance(person, place) <= 7)) continue;
    const members = [person, ...free], id = `community-${++world.communityCounter}`;
    const random = localRandom(world.seed, id), name = `Círculo de ${COMMUNITY_SYLLABLES[Math.floor(random() * COMMUNITY_SYLLABLES.length)]}`;
    const group: CommunityView = { id, name, x: person.x, y: person.y, members: members.map(p => p.id), color: COMMUNITY_COLORS[world.communityCounter % 4]!, culture: { ...person.culture }, formedAt: world.tick, cooperation: 0, disputes: 0 };
    for (const p of members) p.communityId = id;
    world.communities.push(group);
    // NOTA (2026-09-22): este evento COMPARTE el arreglo con `group.members`. Un nacimiento
    // del MISMO paso lo extiende retroactivamente, y esa lista extendida es la que hoy
    // guardan las instantáneas de producción. Copiarlo aquí cambiaría historias ya escritas
    // (medido: el digesto de las semillas 51926 y 42 se mueve), así que no se toca en esta
    // tarea; `reproduce` evita el alias sólo en el camino que lo rompería (index.ts).
    emit({ kind: 'community', actors: group.members, x: person.x, y: person.y, source: 'simulation', text: `${name} tomó forma entre ${members.map(p => p.name).join(', ')}.`, cause: 'Confianza ganada en interacciones cercanas, prácticas compatibles y un lugar compartido; no se asignó una facción al nacer.' });
  }
  world.communities = world.communities.filter(group => group.members.length > 0);
}
export function resourceDispute(world: World, person: Person, emit: Emit): boolean {
  // Leyes candidatas `social.disputaNecesidad`, `social.disputaEscasez` y
  // `social.disputaRadio`: las tres condiciones tienen que darse A LA VEZ (necesidad
  // urgente, fuente casi agotada y otra persona con el mismo destino al lado), y con los
  // números de hoy no coinciden nunca — cero disputas y cero turnos en toda la medición.
  // `disputaEscasez` multiplica los tres umbrales de stock (comida, agua, fauna) a la vez;
  // `disputaDestino` es cuánto tienen que coincidir los dos destinos y `disputaEspera` los
  // ticks de calma que guarda cada lado tras disputar.
  const { disputaNecesidad, disputaEscasez, disputaRadio, disputaDestino, disputaEspera } = paramsOf(world).social;
  if (!world.cooperationEnabled || !person.communityId || world.tick - person.lastDispute < disputaEspera || Math.max(person.hunger, person.thirst) < disputaNecesidad) return false;
  const source = tileAt(world, person.target);
  const stock = person.action === 'drink' ? waterAvailable(world,person.target) : person.action === 'hunt' ? source?.fauna ?? 0 : source?.food ?? 0;
  if (!source || !['eat','drink','hunt'].includes(person.action) || stock <= 0 || stock > disputaEscasez * (person.action === 'drink' ? 0.12 : person.action === 'hunt' ? 1 : 0.06)) return false;
  const other = world.people.find(p => p !== person && p.communityId && p.action === person.action && distance(person, p) <= disputaRadio && distance(person.target, p.target) < disputaDestino && Math.max(p.hunger, p.thirst) > disputaNecesidad && world.tick - p.lastDispute >= disputaEspera);
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
