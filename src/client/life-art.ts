import type { AnimalView } from '../shared/life.js';
import type { Tile } from '../shared/types.js';
import type { CuerpoVisible } from '../shared/vistas-v23.js';
import { DEMOGRAPHY_TICKS_PER_DAY } from '../shared/demography.js';

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
  /** V23: pelaje del linaje fundador (`pelajeDeLinaje`); manda sobre el color del cuerpo salvo la lana. */
  pelaje?: string;
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
  const coat = wool ? '#d8d4c6' : traits.pelaje ? traits.pelaje : cam === 0
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

/* ------------------------------------------------------------------ */
/* V23: cuerpos de átomos, crianza y fauna sin especie                 */
/* ------------------------------------------------------------------ */

/** Masa (sobre la adulta) que representa el sprite juvenil tal como se pinta: un juvenil de esa masa no se reescala. */
export const MASA_SPRITE_JUVENIL = 0.35;
/** Escala mínima y máxima del sprite por masa: fuera de ellas el pixel-art de 32 px deja de leerse. */
export const ESCALA_CUERPO_MIN = 0.625; // 10/16: múltiplo del paso
export const ESCALA_CUERPO_MAX = 1.625; // 26/16
/** Pasos de la escala (1/16: 2 px enteros en un sprite de 32), para que la caché vea pocas tallas. */
export const PASOS_ESCALA = 16;
/** Masa adulta (kg) hasta la que un animal se dibuja con cuerpo pequeño (liebre, zorro). */
export const MASA_CUERPO_PEQUENO_KG = 8;
/** Carnivoría (gen, [0, 1]) desde la que se dibuja cuerpo de cazador y desde la que se dibuja hocico de omnívoro. */
export const CARNIVORIA_CAZADOR = 0.54;
export const CARNIVORIA_OMNIVORO = 0.3;
/** Masa (kg) que representa cada cuerpo dibujado tal como se pinta, para reescalarlo según la masa real. */
export const MASA_NOMINAL_CUERPO_KG: Readonly<Record<AnimalView['species'], number>> = { hare: 3, fox: 6, wolf: 35, deer: 60, boar: 80, fish: 2 };
/** Miedo ([0, 1]) a partir del cual se dibuja la señal de alarma sobre el animal. */
export const MIEDO_VISIBLE = 0.5;
/** Miedo desde el que la señal pasa del ámbar al rojo (pánico). */
export const MIEDO_PANICO = 0.8;
/** Ticks que dura la marca de «ordeñó» o «esquiló» (un día). */
export const MARCA_EXTRACCION_TICKS = DEMOGRAPHY_TICKS_PER_DAY;

const cuantizar = (v: number) => Math.round(v * PASOS_ESCALA) / PASOS_ESCALA;
const acotar = (v: number) => Math.max(ESCALA_CUERPO_MIN, Math.min(ESCALA_CUERPO_MAX, v));

/** Escala del sprite de una persona por su masa: la del sprite de su etapa es 1; un cuerpo flaco o grueso se ve así. */
export function escalaDeCuerpo(cuerpo: CuerpoVisible | undefined, etapa?: 'juvenile' | 'adult' | 'senescent'): number {
  if (!cuerpo || !(cuerpo.masaAdulta > 0) || !(cuerpo.masa > 0)) return 1;
  const referencia = etapa === 'juvenile' ? MASA_SPRITE_JUVENIL : 1;
  return cuantizar(acotar(Math.cbrt(cuerpo.masa / cuerpo.masaAdulta / referencia)));
}

/** Avance de la gestación en [0, 1] (masa del embrión sobre la que tendrá al nacer); `null` sin embarazo. */
export function fraccionGestacion(cuerpo: CuerpoVisible | undefined): number | null {
  const e = cuerpo?.embrion;
  if (!e || !(e.m0 > 0)) return null;
  return Math.max(0, Math.min(1, e.masa / e.m0));
}

/** Vientre de una gestación sobre el sprite de una persona con el pie en (`ax`, `ay`) y escala `escala`. */
export function paintEmbarazo(g: CanvasRenderingContext2D, ax: number, ay: number, fraccion: number, escala = 1): void {
  if (!(fraccion > 0)) return;
  const w = 1 + Math.round(2 * Math.min(1, fraccion)), h = 2 + Math.round(2 * Math.min(1, fraccion));
  const x = Math.round(ax + 3 * escala), y = Math.round(ay - 11 * escala);
  g.fillStyle = '#231710'; g.fillRect(x, y - 1, w + 1, h + 2);
  g.fillStyle = '#efe6d2'; g.fillRect(x, y, w, h);
  g.fillStyle = '#c9b48f'; g.fillRect(x, y + h - 1, w, 1);
}

/** Cuerpo con que se dibuja un animal con `v23`: sale de su masa adulta, su carnivoría y de si está en el agua, nunca de
 * una especie. Sin `v23` se dibuja como hoy (`species`). */
export function planDeFauna(v: AnimalView, enAgua = false): AnimalView['species'] {
  if (!v.v23) return v.species;
  if (enAgua) return 'fish';
  const masa = v.cuerpoVisto ? (v.cuerpoVisto.masaAdulta > 0 ? v.cuerpoVisto.masaAdulta : v.cuerpoVisto.masa) : MASA_NOMINAL_CUERPO_KG[v.species];
  const carnivoria = v.genes?.carnivory ?? 0, pequeno = masa <= MASA_CUERPO_PEQUENO_KG;
  if (carnivoria >= CARNIVORIA_CAZADOR) return pequeno ? 'fox' : 'wolf';
  if (pequeno) return 'hare';
  return carnivoria >= CARNIVORIA_OMNIVORO ? 'boar' : 'deer';
}

/** Escala del sprite de un animal por su masa sobre la del cuerpo con que se dibuja. 1 sin cuerpo de átomos. */
export function escalaDeFauna(v: AnimalView, plan: AnimalView['species']): number {
  const masa = v.cuerpoVisto?.masa;
  if (!(masa !== undefined && masa > 0)) return 1;
  return cuantizar(acotar(Math.cbrt(masa / MASA_NOMINAL_CUERPO_KG[plan])));
}

const PELAJES = ['#b78450', '#8f6a4a', '#c8b29a', '#705c49', '#a09a8e', '#c98d4e', '#5f5248', '#d2bf96'] as const;

/** Pelaje de un linaje fundador: un tono de una paleta terrosa fija, el mismo para toda su descendencia. */
export function pelajeDeLinaje(linaje: number): string {
  let h = Math.imul((linaje | 0) ^ 0x9e3779b9, 2654435761) >>> 0;
  h ^= h >>> 15;
  return PELAJES[h % PELAJES.length]!;
}

/** Madurez visible del animal (para el sprite juvenil): por masa sobre masa adulta si hay cuerpo; si no, como hoy. */
export function madurezDeFauna(v: AnimalView): 0 | 1 | 2 | undefined {
  const c = v.cuerpoVisto;
  if (!c || !(c.masaAdulta > 0)) return undefined;
  return c.masa / c.masaAdulta < .5 ? 0 : (v.generation ?? 0) >= 3 ? 2 : 1;
}

/** Nombre sin especie para la etiqueta del mapa: «Animal de 34 kg». */
export function nombreDeFauna(v: AnimalView): string {
  const masa = v.cuerpoVisto?.masa;
  if (!v.v23 || masa === undefined || !Number.isFinite(masa)) return speciesNames[v.species];
  const kg = masa >= 10 ? Math.round(masa).toLocaleString('es-CO') : masa.toLocaleString('es-CO', { maximumFractionDigits: 1 });
  return `Animal de ${kg} kg`;
}

/** Extracción no letal reciente («ordeñó» o «esquiló») que el mapa marca sobre el animal; `null` si no hay o ya pasó un día. */
export function extraccionVisible(v: AnimalView, tick: number): 'reserva' | 'fibra' | null {
  const e = v.v23?.extraido;
  if (!e) return null;
  const edad = tick - e.tick;
  return edad >= 0 && edad < MARCA_EXTRACCION_TICKS ? e.que : null;
}

/** Marca de extracción junto al lomo (arte en píxeles): gota de leche o mechón de fibra. */
export function paintMarcaExtraccion(g: CanvasRenderingContext2D, x: number, y: number, que: 'reserva' | 'fibra'): void {
  const p = (dx: number, dy: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(Math.round(x + dx), Math.round(y + dy), w, h); };
  if (que === 'reserva') {
    p(0, -1, 3, 5, '#231710'); p(1, -2, 1, 1, '#231710');
    p(1, -1, 1, 1, '#f7f3ea'); p(1, 0, 1, 3, '#f7f3ea'); p(1, 2, 1, 1, '#d9d2c4');
  } else {
    p(-1, -1, 5, 4, '#231710');
    p(0, 0, 3, 2, '#ece5d5'); p(1, -1, 1, 1, '#ece5d5'); p(2, 1, 1, 1, '#cfc6b2');
  }
}

/** Señal de alarma sobre un animal asustado: «!» en píxeles, del ámbar al rojo según el miedo. */
export function paintMiedo(g: CanvasRenderingContext2D, x: number, y: number, miedo: number): void {
  if (!(miedo >= MIEDO_VISIBLE)) return;
  const color = miedo >= MIEDO_PANICO ? '#d8432c' : '#e8a93a';
  g.fillStyle = '#231710'; g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 7);
  g.fillStyle = color; g.fillRect(Math.round(x), Math.round(y), 1, 3); g.fillRect(Math.round(x), Math.round(y) + 4, 1, 1);
}
