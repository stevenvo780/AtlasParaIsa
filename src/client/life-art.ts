import type { AnimalView } from '../shared/life.js';
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

export interface AnimalVisualTraits {
  /** 0 = bold/dark coat, 1 = base coat, 2 = high-camouflage dappled/striped coat */
  camouflage?: 0 | 1 | 2;
  size?: 0 | 1 | 2;
  coat?: 0 | 1 | 2;
  defense?: 0 | 1 | 2;
  tame?: 0 | 1 | 2;
  /** 0 = standard, 1 = high speed or perception (taller ears, longer antlers/fins) */
  agile?: 0 | 1;
  /** 0 = standard, 1 = high carnivory/defense (prominent fangs/tusks & dorsal crest) */
  fierce?: 0 | 1;
  /** 0 = juvenile, 1 = adult, 2 = evolved veteran (generation >= 3) */
  maturity?: 0 | 1 | 2;
}

/** A reusable 32px sprite with 2-pass #231710 outline and evolved genetic/maturity traits. */
export function paintAnimal(
  g: CanvasRenderingContext2D,
  species: AnimalView['species'],
  action: AnimalView['action'],
  pose: number,
  traits: AnimalVisualTraits = {},
): void {
  const rawBlock = (x: number, y: number, w: number, h: number, color: string) => {
    if (w > 0 && h > 0) {
      g.fillStyle = color;
      g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }
  };
  const cam = traits.camouflage ?? 1;
  const agile = traits.agile ?? 0;
  const fierce = traits.fierce ?? 0;
  const maturity = traits.maturity ?? 1;
  const juvenile = maturity === 0;
  const veteran = maturity === 2;
  const outlineHex = '#231710';
  const bulk = (traits.size ?? 1) - 1, wool = traits.coat === 2, defense = traits.defense === 2, tame = traits.tame ?? 0;

  const rects: { x: number; y: number; w: number; h: number; color: string; outline: boolean }[] = [];
  const block = (x: number, y: number, w: number, h: number, color: string, outline = true) => {
    if (w > 0 && h > 0) {
      rects.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), color, outline });
    }
  };
  const flush = () => {
    // Wool and neck marks are part of the same two-pass silhouette, never blurry overlays.
    if (species !== 'fish') {
      const y = action === 'rest' ? 22 : species === 'hare' ? 19 : species === 'deer' ? 18 : species === 'boar' ? 19 : 20;
      if (wool) {
        block(11, y - 1, 3, 2, '#ece5d5'); block(16, y - 2, 3, 3, '#e2dccb');
        block(12, y + 4, 2, 2, '#ece5d5');
      }
      if (defense && species !== 'deer' && species !== 'boar') {
        block(20, y - 3, 2, 7, '#5a4c3c'); block(19, y - 2, 1, 4, '#aa9981');
      }
      if (tame > 0) block(20, y + 1, 2, 2, '#d9ad78', false);
      if (tame === 2) {
        block(22, y + 1, 1, 3, '#f4d49a', false); block(23, y + 3, 2, 1, '#bb704e', false);
      }
    }
    // Size changes the entire body silhouette, including leaner legs and broader heads.
    if (bulk) for (const r of rects) {
      const scaleX = bulk > 0 ? 1.1 : .9, scaleY = bulk > 0 ? 1.08 : .9;
      const right = Math.round(17 + (r.x + r.w - 17) * scaleX);
      const bottom = Math.round(26 + (r.y + r.h - 26) * scaleY);
      r.x = Math.round(17 + (r.x - 17) * scaleX); r.y = Math.round(26 + (r.y - 26) * scaleY);
      r.w = Math.max(1, right - r.x); r.h = Math.max(1, bottom - r.y);
    }
    for (const r of rects) {
      if (r.outline) rawBlock(r.x - 1, r.y - 1, r.w + 2, r.h + 2, outlineHex);
    }
    for (const r of rects) {
      rawBlock(r.x, r.y, r.w, r.h, r.color);
    }
  };

  const baseCoat = animalColors[species];
  const coat = wool ? '#d8d4c6' : cam === 0
    ? (species === 'deer' ? '#9e6234' : species === 'boar' ? '#4d3f34' : species === 'wolf' ? '#626b73' : species === 'fox' ? '#c26026' : species === 'hare' ? '#ab9076' : '#3a8c94')
    : cam === 2
      ? (species === 'deer' ? '#c2925a' : species === 'boar' ? '#7d6752' : species === 'wolf' ? '#969e9c' : species === 'fox' ? '#d99652' : species === 'hare' ? '#d4c0a6' : '#7ec7bf')
      : baseCoat;
  const sleep = action === 'rest', feeding = action === 'graze' || action === 'drink';
  const stride = feeding || sleep ? 0 : [0, 1, 0, -1][pose % 4]!;
  const dip = feeding ? pose % 2 : 0;

  // Soft ground shadow (outside 2-pass outline)
  rawBlock(juvenile ? 11 : 9, 27, juvenile ? 11 : 15, 2, '#14221a38');

  if (species === 'fish') {
    block(10, 20, juvenile ? 10 : 12, 3, '#3b848a');
    block(12, 19, juvenile ? 7 : 9, 4, coat);
    block(14, 19, juvenile ? 4 : 6, 1, '#e0f5ec', false);
    block(7, 19 + stride, 3, agile || veteran ? 6 : 5, '#5da8a1');
    block(10, 20, 2, 3, '#77bfb7', false);
    if (cam === 2) {
      block(14, 20, 1, 2, '#285e63', false);
      block(17, 20, 1, 2, '#285e63', false);
    }
    block(20, 20, 1, 1, '#182e30', false);
    block(15, agile || veteran ? 16 : 17, 3, agile || veteran ? 3 : 2, '#5ca399');
    block(15, 23, 3, 1, '#3b7a82');
    flush();
    return;
  }

  if (species === 'hare') {
    const headY = sleep ? 22 : feeding ? 22 + dip : 18;
    const earH = sleep ? 3 : (agile ? 8 : juvenile ? 5 : 7);
    block(12, 20, juvenile ? 7 : 8, juvenile ? 5 : 6, '#8f7860');
    block(13, 19, juvenile ? 5 : 6, 5, coat);
    if (cam === 2) {
      block(14, 20, 2, 1, '#f2e8d5', false);
      block(16, 22, 2, 1, '#705c48', false);
    }
    block(18, headY, 5, 4, '#ead8bf');
    block(19, headY - (sleep ? 2 : earH - 1), 2, earH, coat);
    block(22, headY - (sleep ? 1 : earH - 2), 1, Math.max(2, earH - 1), '#b89b80');
    if (agile && !sleep) {
      block(19, headY - earH + 1, 2, 1, '#2b211a', false);
    }
    block(10, 22, 2, 2, '#fff8eb');
    block(21, headY + 1, 1, 1, '#1c1510', false);
    if (!sleep) {
      block(13 - stride, 25, 4, 2, '#ead8bf');
      block(20 + stride, 25, 2, 2, coat);
    }
    flush();
    return;
  }

  const deer = species === 'deer', boar = species === 'boar', fox = species === 'fox';
  const headY = sleep ? 22 : feeding ? 22 + dip : deer ? (juvenile ? 15 : 13) : boar ? 20 : 17;
  const backY = sleep ? 23 : deer ? (juvenile ? 19 : 18) : boar ? 19 : 20;
  const bodyW = juvenile ? 11 : 13;
  const bodyH = sleep ? 4 : juvenile ? 5 : 6;

  // Legs (drawn before torso so outline wraps cleanly)
  if (!sleep) {
    const legH = deer ? (agile ? 7 : 6) : (agile ? 4 : 3);
    block(11 + stride, backY + bodyH - 1, deer ? 1 : 2, legH, '#4f3f2f');
    block(20 - stride, backY + bodyH - 1, deer ? 1 : 2, legH, '#4f3f2f');
    block(13 - stride, backY + bodyH, 1, Math.max(2, legH - 1), '#7a6750');
    block(21 + stride, backY + bodyH, 1, Math.max(2, legH - 1), '#7a6750');
  }

  // Main body & dorsal/belly shading
  block(10, backY, bodyW, bodyH, coat);
  block(11, backY, bodyW - 4, 2, boar ? '#967f66' : deer ? '#d9aa72' : fox ? '#f0ad68' : '#b4bcba', false);
  block(12, backY + bodyH - 2, bodyW - 4, 2, deer || fox ? '#eee0c4' : boar ? '#4a3e30' : '#d2d6ce', false);

  // Evolved camouflage coat patterns (fawn spots, boar brindle stripes, wolf/fox mottling)
  if (cam === 2) {
    if (deer) {
      block(12, backY + 2, 1, 1, '#fff3db', false);
      block(15, backY + 1, 2, 1, '#fff3db', false);
      block(18, backY + 2, 1, 1, '#fff3db', false);
    } else if (boar) {
      block(12, backY + 1, 6, 1, '#3b2f24', false);
      block(13, backY + 3, 5, 1, '#b89f82', false);
    } else {
      block(13, backY + 2, 2, 1, '#eef2ef', false);
      block(17, backY + 1, 2, 1, '#545c61', false);
    }
  }

  if (deer && !sleep && !feeding) block(20, headY + 2, 3, backY - headY + 1, coat);
  block(21, headY, 5, 4, coat);
  block(25, headY + 2, boar ? 3 : 2, 2, boar ? '#b89c80' : coat);
  block(24, headY + 1, 1, 1, '#1a1612', false);
  if (agile) block(23, headY + 1, 1, 1, '#f5ebd6', false);
  block(26, headY + 2, 1, 1, '#26201a', false);

  if (deer) {
    if (!juvenile) {
      // Antlers scale with maturity (veteran G3+) and agile (perception/speed)
      const antlerH = defense ? 9 : veteran || agile ? 7 : 5;
      const antlerColor = veteran ? '#c9a96e' : '#7d674a';
      block(22, headY - antlerH, 1, antlerH, antlerColor);
      block(25, headY - antlerH + 1, 1, antlerH - 1, antlerColor);
      block(20, headY - antlerH + 1, 3, 1, antlerColor);
      block(25, headY - antlerH + 2, 3, 1, antlerColor);
      if (veteran || agile || defense) {
        block(19, headY - antlerH, 1, 2, '#f5e4be');
        block(27, headY - antlerH + 1, 1, 2, '#f5e4be');
      }
    }
    block(20, headY - 2, 3, 1, '#e0bc84');
    block(8, backY + 1, 2, 3, '#f5e4c6');
  } else if (boar) {
    // Tusks & dorsal bristle crest scale with fierce (carnivory) and veteran maturity
    const tuskH = defense ? 4 : fierce || veteran ? 3 : juvenile ? 1 : 2;
    block(26, headY + 4 - tuskH, 1, tuskH, '#fff8e6');
    if (fierce || veteran || defense) block(28, headY + 3 - tuskH, 1, tuskH, '#fff8e6');
    if (defense) block(27, headY - 1, 2, 1, '#fff8e6');
    block(10, backY - (fierce || veteran ? 2 : 1), 9, fierce || veteran ? 2 : 1, '#3b2e22');
    block(21, headY - 2, 2, 2, '#a3896a');
    block(8, backY + 2, 2, 1, coat);
  } else {
    // Wolf & Fox: ears, bushy tail, and predator fangs when fierce
    const earH = agile ? 4 : 3;
    block(21, headY - earH, 2, earH, coat);
    block(24, headY - earH + 1, 2, earH - 1, coat);
    block(22, headY - 2, 1, 1, '#453c36', false);
    block(6, backY + 1 - stride, 5, fox ? 4 : 3, coat);
    block(3, backY - stride, 4, fox ? 3 : 2, fox ? '#fff3db' : '#5d6770');
    block(24, headY + 3, 2, 1, '#f5ead2', false);
    if (fierce || veteran) {
      block(26, headY + 4, 1, 2, '#fffaf0');
    }
  }
  flush();
}

// Preserve the public V18 entry point while sharing material rendering with modular halls.
export { paintStructure, type StructureSurface } from './structure-art.js';
