import type { AnimalView, StructureView } from '../shared/life.js';
import type { Tile } from '../shared/types.js';

export interface TreeForm {
  kind: 'tree' | 'pine' | 'palm'; height: number; width: number; foliage: number; variant: number;
}

/** A cell is a resource patch, not a census of trees. One glyph retains every woody patch. */
export function treeForm(tile: Tile, edgeFraction = 1): TreeForm | null {
  if (tile.terrain === 'water' || tile.terrain === 'shelter' || !(tile.wood !== undefined && tile.wood > .05)) return null;
  if (tile.feature && tile.feature !== 'tree' && tile.feature !== 'pine' && tile.feature !== 'palm') return null;
  const bounded = (n: number) => Math.max(0, Math.min(1, n));
  const stock = Math.sqrt(bounded(tile.wood / 12));
  const growth = bounded(tile.growth ?? tile.vegetation), vegetation = bounded(tile.vegetation);
  const kind = tile.feature === 'pine' || tile.feature === 'palm' ? tile.feature : 'tree';
  const variant = (Math.abs(tile.variety ?? 0) + (tile.biome === 'wetland' ? 2 : tile.biome === 'grassland' ? 1 : 0)) % 4;
  const edge = Math.max(.4, bounded(edgeFraction));
  return {
    kind,
    // Root spacing comes from real stock distribution, not omitted trees.
    // Mature forms retain roughly 2–3 standing human heights (14 art pixels).
    height: Math.round(Math.min(44, 12 + Math.round(stock * (15 + growth * 14 + (kind === 'pine' ? 3 : variant)) / 2) * 2) * edge),
    width: Math.round((6 + Math.round(stock * (5 + vegetation * 7) / 3) * 3) * edge),
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
    // Low received ground cover is not evidence of felling or tree death.
    // Keep standing wood and its height; weathered silver-bark forks avoid clashing with warm timber houses.
    // Note: keep R >= G >= B on all pixels so leafless wood never registers as green foliage.
    const barkDark = '#57524b', barkMid = '#736d64', barkLight = '#918a7e';
    block(16 - Math.floor(trunk / 2), top + crown * .5, trunk, form.height - crown * .5, barkDark);
    block(16, top + crown * .5, 1, form.height - crown * .5, barkLight);
    block(13, 43, 4, 1, barkDark); block(17, 42, 3, 2, barkDark);
    const lean = form.variant % 2 === 0 ? -1 : 1;
    for (let step = 0; step < Math.ceil(crown * .52); step++) {
      const dx = lean * Math.floor((step + form.variant) / 4);
      block(16 + dx, top + crown * .52 - step, step < 4 ? 2 : 1, 2, step % 3 === 0 ? barkLight : barkMid);
    }
    for (const side of [-1, 1]) {
      const length = 3 + (form.variant + (side > 0 ? 1 : 0)) % 4;
      const fork = top + crown * (side === lean ? .52 : .78);
      for (let step = 0; step < length; step++) {
        block(16 + side * (step + 1), fork - step, step < 2 ? 2 : 1, 2, step === length - 1 ? barkLight : barkMid);
      }
    }
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
  generation?: number;
  communityColor?: string;
}

/** Parts change layout and capacity; material tones describe the blueprint cost, never an invented alloy. */
export function paintStructure(g: CanvasRenderingContext2D, s: StructureView, surface: StructureSurface = {}): void {
  const block = (x: number, y: number, w: number, h: number, color: string) => {
    g.fillStyle = color;
    g.fillRect(Math.round(x), Math.round(y), Math.max(0, Math.round(w)), Math.max(0, Math.round(h)));
  };
  const count = (part: StructureView['components'][number]) => s.components.filter(c => c === part).length;
  const frames = count('frame'), roofs = count('roof'), cisterns = count('cistern');
  const stores = count('granary'), gardens = count('garden'), hearths = count('hearth');
  const condition = Math.max(0, Math.min(1, s.condition)), degraded = condition < .65, broken = condition < .3;
  const wood = surface.materials?.wood ?? 0, stone = surface.materials?.stone ?? 0;
  const stoneRatio = wood + stone > 0 ? stone / (wood + stone) : 0.25;
  const masonry = wood + stone > 0 ? Math.round(stoneRatio * 6) : 1;
  const gen = Math.max(0, Math.min(4, surface.generation ?? (frames > 1 || roofs > 1 || cisterns + stores + gardens + hearths >= 2 ? 2 : cisterns + stores + gardens + hearths === 1 ? 1 : 0)));
  const outline = '#2b1d14';
  const communityHex = surface.communityColor && /^#[0-9a-fA-F]{6}$/.test(surface.communityColor) ? surface.communityColor : null;

  // Layout geometry: never erase the main room when a garden or annex is attached.
  const hasRightAnnex = cisterns > 0;
  const hasLeftGarden = gardens > 0;
  const left = frames > 1 ? (hasLeftGarden ? 6 : 3) : hasLeftGarden ? 9 : hasRightAnnex ? 4 : 6;
  const width = frames > 1 ? (hasRightAnnex ? 19 : 24) : hasLeftGarden ? (hasRightAnnex ? 14 : 18) : hasRightAnnex ? 18 : 20;
  const floor = stores ? 25 : 27;
  const wallH = gen === 0 && frames <= 1 && roofs <= 1 && cisterns + stores + gardens + hearths === 0 ? 11 : gen >= 2 || frames > 1 ? 15 : 13;
  const eave = floor - wallH;

  // Ground shadow & stone foundation plinth (high value contrast against #a8825c soil)
  block(2, 29, 28, 2, '#14201948');
  block(left - 1, floor, width + 2, 2, outline);
  block(left, floor, width, 1, '#cfc9ba');

  if (frames) {
    // Raised granary stilts
    if (stores) {
      for (let x = left + 2; x < left + width - 1; x += 6) {
        block(x, floor + 1, 2, 3, outline);
        block(x, floor + 1, 1, 2, '#8c6947');
        block(x - 1, 28, 4, 1, '#cfc9ba');
      }
    }

    // Main wall body: light dressed timber (#e4c797) + real stone masonry courses up to stoneH
    const innerX = left + 1, innerW = Math.max(4, width - 2), innerH = Math.max(4, floor - eave);
    const stoneH = Math.min(innerH, Math.max(1, Math.round(innerH * Math.min(1, stoneRatio * 1.15))));
    const wallTopColor = degraded ? '#a39074' : '#e4c797';
    const plankJoint = degraded ? '#6e5c44' : '#b38b59';

    // Outer dark outline of the building box
    block(left, eave, width, innerH + 1, outline);
    // Upper timber wall
    block(innerX, eave + 1, innerW, innerH - 1, wallTopColor);
    for (let y = eave + 3; y < floor - stoneH; y += 3) {
      block(innerX, y, innerW, 1, plankJoint);
    }

    // Lower (or full) coursed stone masonry wall
    if (stoneH > 0) {
      const sy0 = floor - stoneH;
      block(innerX, sy0, innerW, stoneH, degraded ? '#8f8a7e' : '#cfc9ba');
      for (let y = sy0; y < floor; y += 2) {
        block(innerX, y, innerW, 1, '#5e5a52');
        const shift = ((y - sy0) >> 1) & 1 ? 2 : 0;
        for (let x = innerX + shift; x < innerX + innerW; x += 4) {
          block(x, y + 1, 1, 1, '#5e5a52');
          if (x + 1 < innerX + innerW) block(x + 1, y + 1, 2, 1, (x + y) % 3 === 0 ? '#9c9689' : '#ded8c8');
        }
      }
      // Corner stone quoins when stone ratio is high
      if (masonry >= 3) {
        for (let y = eave + 2; y < floor; y += 3) {
          block(innerX, y, 2, 2, '#ded8c8');
          block(innerX + innerW - 2, y, 2, 2, '#9c9689');
        }
      }
    }

    // Structural frame posts & bays (1 frame vs 2+ frames)
    const bays = Math.max(1, frames);
    for (let bay = 0; bay <= bays; bay++) {
      const x = left + Math.round(bay / bays * (width - 2));
      block(x, eave, 2, innerH + 1, '#4a3321');
      block(x, eave + 1, 1, innerH - 1, '#d4ad73');
    }
    // Reinforced buttresses for 2+ frames
    if (frames > 1) {
      block(left - 1, floor - 5, 2, 6, '#7a756c');
      block(left + width - 1, floor - 5, 2, 6, '#7a756c');
    }

    // Doorway with warm interior depth & optional community lintel
    const doorX = left + Math.max(2, width - 6);
    const doorH = Math.min(7, innerH - 2);
    block(doorX - 1, floor - doorH - 1, 5, doorH + 1, outline);
    block(doorX, floor - doorH, 3, doorH, '#291d15');
    block(doorX, floor - doorH, 1, doorH, '#c99b5b');
    if (communityHex) {
      block(doorX - 1, floor - doorH - 1, 5, 1, communityHex);
    }

    // Windows for multi-bay or higher-generation structures
    if ((gen >= 2 || frames > 1 || stores > 0) && width >= 15) {
      const winCount = frames > 1 ? 2 : 1;
      for (let w = 0; w < winCount; w++) {
        const wx = left + 3 + w * 6;
        if (wx + 3 < doorX) {
          block(wx, eave + 3, 3, 3, outline);
          block(wx + 1, eave + 4, 1, 1, '#f2d08a');
        }
      }
    }
    // Cross-beam at eave
    block(left - 1, eave, width + 2, 2, outline);
    block(left, eave, width, 1, communityHex ?? '#6b4c32');
  }

  // Hearth chimney stack (drawn behind/through roof ridge, no fake smoke or fire from historical `uses`)
  if (hearths) {
    const hx = left + 2;
    block(hx - 1, 3, 6, floor - 3, outline);
    block(hx, 4, 4, floor - 4, '#b8b2a4');
    block(hx, 4, 1, floor - 4, '#ded8c8');
    block(hx - 1, 3, 6, 2, '#ded8c8');
    block(hx, 7, 4, 1, '#6e6a61');
    block(hx, 11, 4, 1, '#6e6a61');
    // Hearth firebox arch at base
    block(hx - 1, floor - 5, 6, 5, '#5e5a52');
    block(hx, floor - 4, 4, 4, '#24221e');
    block(hx + 1, floor - 2, 2, 1, '#7a5238');
  }

  // Roofs: distinct silhouettes by roof count (1 vs 2 stepped gables) and palette by generation/stone
  if (roofs) {
    const spans = Math.max(1, roofs);
    const roofDark = gen >= 3 || masonry >= 4 ? '#6e3222' : gen >= 1 ? '#5c3822' : '#6e5522';
    const roofMid = degraded ? '#7d6e52' : gen >= 3 || masonry >= 4 ? '#9e4933' : gen >= 1 ? '#8c5634' : '#b89240';
    const roofLight = degraded ? '#a69676' : gen >= 3 || masonry >= 4 ? '#d1785e' : gen >= 1 ? '#c78c58' : '#ebd07a';

    for (let bay = 0; bay < spans; bay++) {
      const spanW = Math.ceil((width + 4) / spans);
      const l = left - 2 + Math.floor(bay * (width + 2) / spans);
      // Second roof gable is taller/stepped so "Casa de dos cubiertas" has an unmistakable twin silhouette
      const roofH = (spans > 1 ? (bay === 0 ? 6 : 8) : gen === 0 ? 5 : gen >= 2 ? 8 : 7);
      const ridge = Math.max(2, eave - roofH);
      for (let row = 0; row < eave - ridge; row++) {
        const taper = gen === 0 && spans === 1
          ? Math.round((eave - ridge - row - 1) * .45)
          : Math.round((eave - ridge - row - 1) * spanW / (2 * Math.max(1, eave - ridge)));
        const rx = l + taper;
        const rw = Math.max(2, spanW - taper * (gen === 0 && spans === 1 ? 1 : 2));
        block(rx - 1, ridge + row, rw + 2, 1, outline);
        block(rx, ridge + row, rw, 1, row === 0 ? roofLight : row % 2 === 0 ? roofMid : roofDark);
      }
      block(l - 1, eave - 1, spanW + 2, 2, outline);
      block(l, eave - 1, spanW, 1, roofLight);

      // Community pennant on main roof peak
      if (communityHex && bay === spans - 1) {
        const px0 = l + Math.floor(spanW / 2);
        block(px0, Math.max(0, ridge - 4), 1, 4, outline);
        block(px0 + 1, Math.max(0, ridge - 4), 3, 2, communityHex);
      }
      if (broken) {
        g.clearRect(l + Math.floor(spanW * .45), ridge + 2, 3, 3);
        block(l + 2, floor - 1, 5, 2, '#5c4b36');
      }
    }
  }

  // Granary modules: raised storage chests with visible golden grain level
  for (let i = 0; i < stores; i++) {
    const x = left + 2 + i * 7, y = floor - 7;
    block(x - 1, y - 1, 7, 7, outline);
    block(x, y, 5, 5, '#6e4e2e');
    block(x, y, 5, 1, '#d9b066');
    const fill = Math.max(0, Math.min(4, Math.ceil(s.food / Math.max(1, stores) / .7 * 4)));
    if (fill) {
      block(x + 1, y + 5 - fill, 3, fill, '#f2ca68');
      block(x + 1, y + 5 - fill, 3, 1, '#fff0b8');
    }
  }

  // Cistern modules: stone water tower / well on the right with bright turquoise water gauge
  for (let i = 0; i < cisterns; i++) {
    const x = 23 - i * 6, y = 18 - i * 2;
    block(x - 1, y - 1, 8, 11, outline);
    block(x, y, 6, 9, '#b8b4a6');
    block(x + 1, y + 1, 4, 7, '#22383b');
    const fill = Math.max(0, Math.min(6, Math.ceil(s.water / Math.max(1, cisterns) / .6 * 6)));
    if (fill) {
      block(x + 1, y + 8 - fill, 4, fill, '#3da5ad');
      block(x + 1, y + 8 - fill, 4, 1, '#b8f2e6');
    }
    block(x, y, 6, 1, '#e6e1d0');
    block(x, y + 8, 6, 1, '#8c897d');
    if (roofs) {
      block(left + width - 1, eave + 1, Math.max(1, x - (left + width) + 2), 2, '#5e6e68');
      block(x + 2, eave + 1, 2, Math.max(1, y - eave - 1), '#7d8f88');
    }
  }

  // Garden modules: fenced courtyard beds in front/left (never deleting the house walls!)
  for (let i = 0; i < gardens; i++) {
    const x = 1 + i * 10, y = 21;
    // Fenced enclosure with dark irrigated soil contrast
    block(x, y, 9, 8, outline);
    block(x + 1, y + 1, 7, 6, '#423122');
    // Fence posts & top rail
    block(x, y - 2, 1, 3, '#d4ad73');
    block(x + 4, y - 2, 1, 3, '#d4ad73');
    block(x + 8, y - 2, 1, 3, '#d4ad73');
    block(x, y - 1, 9, 1, '#8c6742');
    // Furrows
    for (let row = 0; row < 3; row++) {
      block(x + 1, y + 1 + row * 2, 7, 1, '#2b1e14');
    }
    // Live crops require received cultivated living ground
    const ground = surface.ground;
    if (ground && (ground.cultivation ?? 0) > .08 && ground.vegetation > .1 && (ground.growth ?? ground.vegetation) > .15) {
      const lush = ground.moisture > .3;
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 2; row++) {
          const cx = x + 2 + col * 2, cy = y + 1 + row * 3;
          block(cx, cy - 1, 2, 2, lush ? '#68a848' : '#9eb054');
          block(cx, cy - 2, 1, 1, lush ? '#a8e070' : '#d4c86a');
        }
      }
    }
  }

  if (degraded) {
    block(left + 3, eave + 3, 1, 4, outline);
    block(left + 4, eave + 6, 2, 1, outline);
  }
  if (broken) {
    block(left + 2, 28, 5, 1, outline);
    block(left + 9, 29, 3, 1, '#7a684b');
  }
}
