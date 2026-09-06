import type { AnimalView, StructureView } from '../shared/life.js';
import type { Tile } from '../shared/types.js';

export interface TreeForm {
  kind: 'tree' | 'pine' | 'palm'; height: number; width: number; foliage: number; variant: number;
}

/** A cell is a resource patch, not a census of trees. One glyph retains every woody patch. */
export function treeForm(tile: Tile): TreeForm | null {
  if (tile.terrain === 'water' || tile.terrain === 'shelter' || !(tile.wood !== undefined && tile.wood > .05)) return null;
  if (tile.feature && tile.feature !== 'tree' && tile.feature !== 'pine' && tile.feature !== 'palm') return null;
  const bounded = (n: number) => Math.max(0, Math.min(1, n));
  const stock = Math.sqrt(bounded(tile.wood / 12));
  const growth = bounded(tile.growth ?? tile.vegetation), vegetation = bounded(tile.vegetation);
  const kind = tile.feature === 'pine' || tile.feature === 'palm' ? tile.feature : 'tree';
  const variant = (Math.abs(tile.variety ?? 0) + (tile.biome === 'wetland' ? 2 : tile.biome === 'grassland' ? 1 : 0)) % 4;
  return {
    kind,
    // Root spacing comes from real stock distribution, not omitted trees.
    // Mature forms retain roughly 2–3 standing human heights (14 art pixels).
    height: Math.min(44, 12 + Math.round(stock * (15 + growth * 14 + (kind === 'pine' ? 3 : variant)) / 2) * 2),
    width: 6 + Math.round(stock * (5 + vegetation * 7) / 3) * 3,
    foliage: Math.round(growth * vegetation * 3),
    variant,
  };
}

/** 32×48 art, rooted at (16,44); a mature tree is roughly three standing human bodies tall. */
export function paintTree(g: CanvasRenderingContext2D, form: TreeForm, pose = 1): void {
  const block = (x: number, y: number, w: number, h: number, color: string) => { g.fillStyle = color; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    g.fillStyle = color; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
  };
  const base = 44, top = base - form.height, sway = pose - 1;
  const trunk = form.height >= 30 ? 3 : 2, center = 16 + sway;
  const half = form.width / 2, crown = Math.round(form.height * [ .60, .55, .67, .58 ][form.variant]!);
  const palettes = [['#294a39','#48734b','#81a965'],['#344f38','#648153','#a3b776'],['#2c4944','#4f7661','#92ae78'],['#3e4c32','#778552','#afba76']];
  const [dark, mid, light] = palettes[form.variant]!;
  oval(16, 45, Math.min(8, half), 1.5, '#14221a24');
  block(16 - Math.floor(trunk / 2), top + crown * .5, trunk, form.height - crown * .5, '#69533e');
  block(16, top + crown * .5, 1, form.height - crown * .5, '#aa875f');
  block(13, 43, 4, 1, '#69533e'); block(17, 42, 3, 2, '#69533e');
  if (form.foliage === 0) {
    // Remaining wood with no live canopy is a standing, depleted crown, not a lush prop.
    for (const side of [-1, 1]) { block(16 + side * 3, top + 6, 1, crown, '#69533e'); block(16 + Math.min(0, side * 4), top + crown, 5, 1, '#69533e'); }
    return;
  }
  if (form.kind === 'pine') {
    for (let tier = 0; tier < 3; tier++) {
      const y = top + tier * crown * .22, depth = Math.round(crown * .62), radius = half * (.55 + tier * .23);
      for (let row = 0; row < depth; row++) {
        const w = Math.max(1, Math.round(radius * row / depth));
        block(center - w, y + row, w * 2 + 1, 1, dark!);
        block(center - w, y + row, w + 1, 1, tier === 0 ? light! : mid!);
      }
    }
  } else if (form.kind === 'palm') {
    for (const side of [-1, 1]) for (let row = 0; row < half; row++) {
      block(center + side * row, top + 3 + Math.floor(row * row / 18), 3, 2, row % 3 ? mid! : light!);
      block(center + side * row, top + 7 + Math.floor(row * row / 24), 2, 2, dark!);
    }
    block(center - 1, top, 2, 7, light!);
    for (let y = top + 12; y < base - 2; y += 4) block(15, y, 3, 1, '#795d42');
  } else {
    const cy = top + crown * .53, spread = .7 + form.foliage * .1;
    const broad = form.variant === 0 ? 1.2 : form.variant === 3 ? .85 : 1;
    const split = form.variant === 2;
    // Forks and unequal crown lobes vary by seeded habitat form, without adding another resource.
    for (const side of [-1, 1]) {
      const length = 3 + form.variant % 2;
      for (let i = 0; i < length; i++) block(16 + side * i, top + crown + length - i * 2, 2, 3, '#795f43');
    }
    oval(center, cy + crown * .23, half * spread * broad, crown * .38, dark!);
    oval(center - half * .34, cy + (split ? -crown * .12 : crown * .04), half * .7 * spread, crown * .41, mid!);
    oval(center + half * .4, cy + (split ? crown * .19 : -crown * .04), half * .62 * spread, crown * .35, mid!);
    oval(center - half * .3, cy - crown * .28, half * .51 * spread, crown * .24, light!);
    if (split || form.variant === 1) oval(center + half * .43, cy - crown * .04, half * .4 * spread, crown * .19, light!);
    for (let i = 0; i < 3; i++) block(center - half * .5 + i * 3, cy - crown * .19 + (form.variant + i) % 3, 2, 1, light!);
  }
}

export const speciesNames: Record<AnimalView['species'], string> = { hare: 'Liebre', deer: 'Venado', boar: 'Jabalí', fish: 'Pez', wolf: 'Lobo', fox: 'Zorro' };
export const speciesPlural: Record<AnimalView['species'], string> = { hare: 'Liebres', deer: 'Venados', boar: 'Jabalíes', fish: 'Peces', wolf: 'Lobos', fox: 'Zorros' };
export const animalActions: Record<AnimalView['action'], string> = { roam: 'Recorriendo', graze: 'Alimentándose', drink: 'Bebiendo', rest: 'Descansando', hunt: 'Cazando', flee: 'Huyendo' };
export const componentNames = { frame: 'Armazón', roof: 'Cubierta', cistern: 'Cisterna', granary: 'Granero', garden: 'Huerta', hearth: 'Hogar' };
export const componentPurpose = { frame: 'sostiene la construcción', roof: 'protege al descansar', cistern: 'recoge agua de lluvia', granary: 'guarda alimento', garden: 'cultiva usando agua', hearth: 'ayuda al descanso con combustible' };
export const animalColors: Record<AnimalView['species'], string> = { hare: '#c8b29a', deer: '#b78450', boar: '#705c49', fish: '#9bd5ce', wolf: '#858c91', fox: '#d08746' };

/** A reusable 32px sprite. Only a server position locates the body in the world. */
export function paintAnimal(g: CanvasRenderingContext2D, species: AnimalView['species'], action: AnimalView['action'], pose: number): void {
  const block = (x: number, y: number, w: number, h: number, color: string) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
  const coat = animalColors[species], sleep = action === 'rest', feeding = action === 'graze' || action === 'drink';
  const stride = feeding || sleep ? 0 : [0, 1, 0, -1][pose % 4]!;
  const dip = feeding ? pose % 2 : 0;
  block(10, 27, 14, 2, '#14221a30');
  if (species === 'fish') {
    block(10, 20, 12, 3, '#4d9b9f'); block(12, 19, 9, 4, coat); block(14, 19, 6, 1, '#d1e6d8');
    block(7, 19 + stride, 3, 5, '#6bb2ab'); block(10, 20, 2, 3, '#77bfb7');
    block(21, 20, 1, 1, '#264e53'); block(15, 17, 3, 2, '#65a99f'); block(15, 23, 3, 1, '#4a8c94'); return;
  }
  if (species === 'hare') {
    const headY = sleep ? 22 : feeding ? 22 + dip : 18;
    block(12, 20, 8, 6, '#9d876f'); block(13, 19, 6, 5, coat); block(18, headY, 5, 4, '#deccb3');
    block(19, headY - (sleep ? 2 : 6), 2, sleep ? 3 : 7, coat); block(22, headY - 5, 1, sleep ? 2 : 6, '#ae9279');
    block(11, 22, 2, 2, '#f1ead9'); block(21, headY + 1, 1, 1, '#3e392f');
    if (!sleep) { block(13 - stride, 25, 4, 2, '#deccb3'); block(20 + stride, 25, 2, 2, '#c8b29a'); } return;
  }
  const deer = species === 'deer', boar = species === 'boar', fox = species === 'fox';
  const headY = sleep ? 22 : feeding ? 22 + dip : deer ? 13 : boar ? 20 : 17;
  const backY = sleep ? 23 : deer ? 18 : boar ? 19 : 20;
  block(10, backY, 13, sleep ? 4 : 6, coat); block(11, backY, 9, 2, boar ? '#8c7760' : deer ? '#c99a62' : fox ? '#e2a262' : '#a0a7a5');
  block(12, backY + 4, 9, 2, deer || fox ? '#d9c6a6' : boar ? '#554939' : '#bcc1b8');
  if (deer && !sleep && !feeding) block(20, 15, 3, 7, coat);
  block(21, headY, 5, 4, coat); block(25, headY + 2, boar ? 3 : 2, 2, boar ? '#aa9077' : coat);
  block(24, headY + 1, 1, 1, '#29322d'); block(26, headY + 2, 1, 1, '#3c3a33');
  if (!sleep) {
    block(11 + stride, backY + 5, deer ? 1 : 2, deer ? 6 : 3, '#61503d');
    block(20 - stride, backY + 5, deer ? 1 : 2, deer ? 6 : 3, '#61503d');
    block(13 - stride, backY + 6, 1, deer ? 5 : 2, '#89755c'); block(22 + stride, backY + 6, 1, deer ? 5 : 2, '#89755c');
  }
  if (deer) {
    block(22, headY - 6, 1, 6, '#715e44'); block(25, headY - 5, 1, 5, '#715e44');
    block(20, headY - 5, 3, 1, '#715e44'); block(25, headY - 4, 3, 1, '#715e44'); block(20, headY - 2, 3, 1, '#d4af78');
    block(9, backY + 1, 2, 3, '#ead6b6'); block(15, backY + 2, 1, 1, '#e4c394');
  } else if (boar) {
    block(26, headY + 3, 1, 2, '#f1ead9'); block(10, backY - 2, 9, 2, '#574737'); block(21, headY - 2, 2, 2, '#9a8264'); block(8, backY + 2, 2, 1, coat);
  } else {
    block(21, headY - 3, 2, 3, coat); block(24, headY - 2, 2, 2, coat); block(22, headY - 2, 1, 1, '#574e47');
    block(6, backY + 1 - stride, 5, fox ? 4 : 3, coat); block(3, backY - stride, 4, fox ? 3 : 2, fox ? '#f0e1c5' : '#69737b');
    block(24, headY + 3, 2, 1, '#f0e1c5');
  }
}

export interface StructureSurface {
  materials?: { wood: number; stone: number };
  ground?: Pick<Tile, 'growth' | 'vegetation' | 'cultivation' | 'moisture'>;
}

/** Parts change layout and capacity; material tones describe the blueprint cost, never an invented alloy. */
export function paintStructure(g: CanvasRenderingContext2D, s: StructureView, surface: StructureSurface = {}): void {
  const block = (x: number, y: number, w: number, h: number, color: string) => { g.fillStyle = color; g.fillRect(Math.round(x), Math.round(y), Math.max(0, Math.round(w)), Math.max(0, Math.round(h))); };
  const count = (part: StructureView['components'][number]) => s.components.filter(c => c === part).length;
  const frames = count('frame'), roofs = count('roof'), cisterns = count('cistern'), stores = count('granary'), gardens = count('garden');
  const condition = Math.max(0, Math.min(1, s.condition)), degraded = condition < .65, broken = condition < .3;
  const wood = surface.materials?.wood ?? 0, stone = surface.materials?.stone ?? 0;
  const masonry = wood + stone > 0 ? Math.round(stone / (wood + stone) * 4) : 1;
  const left = frames > 1 ? 3 : cisterns ? 3 : 6, width = frames > 1 ? 26 : cisterns ? 19 : 21;
  const floor = stores ? 25 : 28, eave = stores ? 12 : gardens ? 14 : 13;
  const timber = degraded ? '#88785f' : '#bc9767', beam = '#6b513c', light = '#e0bf87';
  block(2, 29, 28, 2, '#17292030');
  if (frames) {
    // Raised granaries, open garden shelters and framed rooms occupy different silhouettes.
    block(left, floor, width, Math.max(1, masonry), '#a49a80');
    block(left, floor + 1, width, 1, '#686d62');
    if (stores) for (let x = left + 2; x < left + width; x += 7) { block(x, floor, 2, 4, beam); block(x - 1, 28, 4, 1, '#ada68c'); }
    if (!gardens) {
      block(left + 2, eave, width - 4, floor - eave, timber);
      for (let y = eave + 2; y < floor; y += 3) block(left + 2, y, width - 4, 1, '#97774f');
      block(left + width - 6, floor - 8, 4, 8, '#4e4637');
      block(left + width - 6, floor - 8, 1, 8, '#deb778');
      if (stores) for (let x = left + 4; x < left + width - 7; x += 4) block(x, eave + 3, 2, 2, '#4e4637');
    }
    for (let bay = 0; bay <= Math.max(1, frames); bay++) {
      const x = left + Math.round(bay / Math.max(1, frames) * (width - 2));
      block(x, eave - 1, 2, floor - eave + 2, beam); block(x, eave, 1, floor - eave, light);
    }
    block(left, eave, width, 2, beam);
  }
  if (roofs) {
    const spans = Math.max(1, roofs);
    for (let bay = 0; bay < spans; bay++) {
      const l = left - 1 + Math.floor(bay * (width + 2) / spans), w = Math.ceil((width + 2) / spans), ridge = eave - (gardens ? 5 : 8);
      for (let row = 0; row < eave - ridge; row++) {
        const inset = cisterns ? Math.max(0, Math.round((eave - ridge - row - 1) * .55)) : Math.round((eave - ridge - row - 1) * w / (2 * (eave - ridge)));
        block(l + inset, ridge + row, w - inset * (cisterns ? 1 : 2), 1, row % 3 === 0 ? '#e0bc79' : degraded ? '#9c8862' : '#b78a50');
      }
      block(l, eave - 1, w, 2, '#76583d'); block(l + 1, ridge, Math.max(2, w * .28), 1, '#efd39a');
      if (broken) { g.clearRect(l + w * .48, ridge + 3, 3, 3); block(l + 3, floor - 1, 6, 2, '#786448'); }
    }
  }
  for (let i = 0; i < cisterns; i++) {
    const x = 24 - i * 7, y = 21 - i * 2;
    block(x, y, 7, 8, '#79857c'); block(x + 1, y + 1, 5, 6, '#384e4b');
    const fill = Math.max(0, Math.min(5, Math.ceil(s.water / Math.max(1, cisterns) / .6 * 5)));
    if (fill) { block(x + 1, y + 7 - fill, 5, fill, '#529fa4'); block(x + 1, y + 7 - fill, 5, 1, '#bae2d3'); }
    block(x, y, 7, 1, '#d5d0b3'); block(x, y + 7, 7, 1, '#afb39c');
    if (roofs) { block(x + 3, eave, 1, y - eave, '#b4bb9d'); block(left + width - 4, eave + 1, Math.max(1, x + 4 - left - width + 4), 1, '#73877f'); }
  }
  for (let i = 0; i < stores; i++) {
    const x = left + 2 + i * 7;
    block(x, floor - 6, 6, 5, '#8d673e'); block(x, floor - 6, 6, 1, '#dfba73');
    const fill = Math.max(0, Math.min(4, Math.ceil(s.food / Math.max(1, stores) / .7 * 4)));
    if (fill) { block(x + 1, floor - 1 - fill, 4, fill, '#e9c677'); block(x + 2, floor - fill, 1, Math.max(1, fill - 1), '#b98c48'); }
  }
  for (let i = 0; i < gardens; i++) {
    const x = 2 + i * 11, y = 24;
    block(x, y, 10, 5, '#745a3f'); block(x, y + 4, 10, 1, '#c69f6d');
    for (let row = 0; row < 2; row++) block(x + 1, y + row * 2, 8, 1, '#493f31');
    // A garden component is prepared infrastructure; crops require received living ground.
    const ground = surface.ground;
    if (ground && (ground.cultivation ?? 0) > .08 && ground.vegetation > .1 && (ground.growth ?? ground.vegetation) > .15) {
      for (let n = 0; n < 3; n++) block(x + 2 + n * 3, y - 1, 1, 3, ground.moisture > .3 ? '#97b86f' : '#baaa69');
    }
  }
  if (count('hearth')) {
    block(left + 3, 7, 4, 13, '#a2a08d'); block(left + 2, 6, 6, 2, '#d4cbb0');
    block(left + 3, 13, 3, 1, '#777d72'); block(left + 4, 9, 3, 1, '#777d72');
    block(left + 2, 24, 6, 4, '#6b6d60'); block(left + 3, 25, 4, 3, '#343a31');
    // No flame or smoke: StructureView carries no current fuel-burning receipt.
  }
  if (degraded) { block(left + 3, eave + 3, 1, 4, '#554735'); block(left + 4, eave + 6, 2, 1, '#554735'); }
  if (broken) { block(left + 2, 28, 5, 1, '#6d624d'); block(left + 9, 29, 3, 1, '#9c8866'); }
}
