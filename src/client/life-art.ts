import type { AnimalView, StructureView } from '../shared/life.js';

export const speciesNames: Record<AnimalView['species'], string> = { hare: 'Liebre', deer: 'Venado', boar: 'Jabalí', fish: 'Pez', wolf: 'Lobo', fox: 'Zorro' };
export const speciesPlural: Record<AnimalView['species'], string> = { hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces', wolf: 'Lobos', fox: 'Zorros' };
export const animalActions: Record<AnimalView['action'], string> = { roam: 'Recorriendo', graze: 'Alimentándose', drink: 'Bebiendo', rest: 'Descansando', hunt: 'Cazando', flee: 'Huyendo' };
export const componentNames = { frame: 'Armazón', roof: 'Cubierta', cistern: 'Cisterna', granary: 'Granero', garden: 'Huerta', hearth: 'Hogar' };
export const componentPurpose = { frame: 'sostiene la construcción', roof: 'protege al descansar', cistern: 'recoge agua de lluvia', granary: 'guarda alimento', garden: 'cultiva usando agua', hearth: 'ayuda al descanso con combustible' };
export const animalColors: Record<AnimalView['species'], string> = { hare: '#c8b29a', deer: '#b78450', boar: '#705c49', fish: '#9bd5ce', wolf: '#858c91', fox: '#d08746' };

/** A reusable 32px sprite. Only a server position locates the body in the world. */
export function paintAnimal(g: CanvasRenderingContext2D, species: AnimalView['species'], action: AnimalView['action'], pose: number): void {
  const block = (x: number, y: number, w: number, h: number, color: string) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
  const coat = animalColors[species], sleep = action === 'rest';
  block(10, 25, 13, 2, '#14221a30');
  if (species === 'fish') { block(11, 19, 10, 4, coat); block(8, 18 + pose, 3, 5, '#65a99f'); block(21, 20, 1, 1, '#264e53'); block(14, 17, 3, 2, '#65a99f'); return; }
  if (species === 'hare') { block(12, 20, 8, 5, coat); block(18, 18, 5, 5, '#deccb3'); block(19, sleep ? 17 : 12 - pose, 2, sleep ? 3 : 7, coat); block(22, sleep ? 18 : 13, 1, sleep ? 2 : 6, coat); block(11, 21, 2, 2, '#f1ead9'); block(21, 19, 1, 1, '#3e392f'); return; }
  const deer = species === 'deer', boar = species === 'boar', headY = action === 'graze' || action === 'drink' ? 20 : 16;
  block(10, 19, 12, sleep ? 6 : 5, coat); block(20, headY, 5, 5, coat); block(24, headY + 3, 3, 2, boar ? '#aa9077' : coat); block(23, headY + 1, 1, 1, '#2e342f');
  if (!sleep) { block(11 + pose, 24, 2, deer ? 4 : 3, '#534b40'); block(20 - pose, 24, 2, deer ? 4 : 3, '#534b40'); }
  if (deer) { block(21, headY - 5, 1, 5, '#6d5741'); block(24, headY - 5, 1, 5, '#6d5741'); block(20, headY - 4, 6, 1, '#6d5741'); }
  else if (boar) { block(25, headY + 4, 2, 1, '#f1ead9'); block(9, 18, 2, 3, '#574737'); }
  else { block(20, headY - 3, 2, 3, coat); block(23, headY - 2, 2, 2, coat); block(6, 20 - pose, 5, 3, coat); block(5, 19 - pose, 3, 2, species === 'fox' ? '#f0e1c5' : '#69737b'); block(24, headY + 4, 2, 1, '#f0e1c5'); }
}

/** Composition, repeated parts, damage and stock are visible; no arbitrary hut variant. */
export function paintStructure(g: CanvasRenderingContext2D, s: StructureView): void {
  const block = (x: number, y: number, w: number, h: number, color: string) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
  const count = (part: StructureView['components'][number]) => s.components.filter(c => c === part).length;
  block(2, 28, 28, 3, '#14221a30');
  if (count('frame')) { block(6, 15, 2, 14, '#87664a'); block(23, 15, 2, 14, '#87664a'); block(6, 15, 19, 2, '#c3a077'); block(8, 26, 15, 3, '#b59773'); }
  if (count('frame') > 1) { block(10, 16, 2, 12, '#a8845f'); block(19, 16, 2, 12, '#a8845f'); }
  if (count('roof')) { for (let row = 0; row < 7; row++) block(15 - row * 2, 8 + row, 3 + row * 4, 1, row % 2 ? '#bd945a' : '#d4b579'); for (let n = 1; n < count('roof'); n++) block(4, 14 + n * 2, 25, 1, '#825e3f'); }
  if (count('garden')) { block(2, 25, 9, 4, '#796246'); for (let n = 0; n < Math.min(5, count('garden') + 2); n++) block(3 + n * 2, 24 - n % 2, 1, 3, '#83ac5d'); }
  if (count('cistern')) { block(23, 21, 7, 8, '#b5b5a2'); block(24, 28 - Math.min(5, Math.ceil(s.water * 8)), 5, Math.min(5, Math.ceil(s.water * 8)), '#71b8c1'); for (let n = 1; n < count('cistern'); n++) block(29 - n, 20, 1, 8, '#dde0c8'); }
  if (count('granary')) { block(2, 18, 7, 7, '#ba8d4f'); block(2, 19, 7, 1, '#6e593d'); block(3, 21, Math.min(5, Math.ceil(s.food * 7)), 2, '#e4c77b'); for (let n = 1; n < count('granary'); n++) block(3, 17 - n, 6, 1, '#d3ad63'); }
  if (count('hearth')) { block(15, 25, 6, 3, '#9b988b'); block(16, 23, 3, 3, '#5a5044'); }
  if (s.condition < .65) { block(9, 15, 2, 3, '#493f35'); block(21, 16, 1, 4, '#493f35'); }
  if (s.condition < .3) { g.clearRect(17, 9, 4, 4); block(21, 27, 6, 2, '#765d45'); }
}
