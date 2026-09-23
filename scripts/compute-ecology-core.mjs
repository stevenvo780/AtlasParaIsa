// Isolated benchmark port, checked against the live EcosystemKernel; never imported by the app.
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
export const ECOLOGY_CONTRACT = Object.freeze({
  version: 3,
  fields: ['growth', 'fertility', 'life', 'moisture', 'drinkingWater', 'cultivation', 'traffic', 'vegetation', 'wood', 'feature', 'aquatic', 'ocean', 'mountain', 'wetland', 'woodPresent', 'x', 'y'],
  options: { decaimientoFertilidad: 0, seed: 0, cuencas: 1 },
  terms: {
    life: 'old 8-neighbor life >= 0.45; fertile at 3 neighbors or alive with 2; light/moisture/fertility growth minus drought and traffic',
    fertility: 'clamp(fertility + life*0.0012 - traffic*0.0007 - cultivation*0.0002 - decaimientoFertilidad*fertility)',
    growth: 'light*moisture*fertility*(0.25+life*0.75)*(1-growth)*(1-traffic*0.9)*0.005; losses 0.0002, traffic*0.002, drought 0.001',
    vegetation: 'land only: clamp(vegetation + produced*0.25 - traffic*0.001)',
    traffic: 'clamp(traffic - 0.0005); cultivation: clamp(cultivation - 0.00002)',
    moisture: 'aquatic only: clamp(moisture + (ocean ? 0.003 : 0) + (rain ? 0.008 : 0))',
    water: 'rain and spring recharge require reservoir AND (aquatic OR ruidoCuenca(seed,x,y)<cuencas); ocean forced to zero',
    basin: '32-bit imul hash; salt1400; scale24; floor negative coordinates; quintic fade and bilinear lerp in original order',
    wood: '100-tick regrowth debits updated growth; uses old fertility/moisture/growth; stump transitions preserved',
    cadence: 'no updates except tick%10==0; read old neighbor life; Float64 with FMA disabled',
    tick: 'stepWorld runs ecology() first (moisture, vegetation, food; not ported here, T120) and then this kernel; tests/compute-ecology.test.ts compares that whole composition',
  },
});
export const FIELDS = ECOLOGY_CONTRACT.fields.length;
export const MAX_CELLS = 4_000_000;
export const FEATURES = [undefined, 'none', 'tree', 'pine', 'palm', 'cactus', 'reeds', 'stump', 'spring', 'pool', 'berries', 'flowers', 'rock', 'clay'];
export const clamp = n => Math.max(0, Math.min(1, n));

/**
 * ECOLOGY_KERNEL_SPEC — versión 1.0 de las fórmulas del kernel vivo
 * (`src/world/ecosystem-kernel.ts`). Sustituye al candado de bytes SHA256
 * que bloqueaba el banco desde 2024-09-06: la lista cerrada de campos del
 * tile y de constantes/coeficientes en fórmulas, junto con un hash canónico
 * del cuerpo de `step()` con comentarios y espacios colapsados, acepta
 * refactorizaciones de formato y rechaza cambios de reglas.
 *
 * `terms` declara cada aparición textual de un coeficiente de regla en el
 * cuerpo de `step()`. Una entrada por ocurrencia (los valores que aparecen
 * dos veces —`0.45`, `0.6`, `0.4`, `0.15`, `0.35`, `0.0002`, `0.001`,
 * `0.002`, `0.008`, `0.25`, `2`— reciben varias entradas con sufijo
 * contextual). Bumpear `version` y `canonicalStepBodyHash` cuando cambia
 * una regla intencionalmente.
 */
export const ECOLOGY_KERNEL_SPEC = Object.freeze({
  version: '1.0',
  fieldsRead: Object.freeze([
    'vegetation', 'moisture', 'terrain', 'biome', 'feature', 'growth',
    'fertility', 'life', 'drinkingWater', 'cultivation', 'traffic', 'wood',
    'x', 'y',
  ]),
  fieldsWritten: Object.freeze([
    'life', 'fertility', 'growth', 'vegetation', 'traffic',
    'cultivation', 'drinkingWater', 'moisture', 'wood', 'feature',
  ]),
  terms: Object.freeze({
    // Umbrales y factores del parche life
    lifeNeighborThreshold: 0.45,
    lifeFertileThreshold: 0.45,
    fertileNeighborCount: 2,
    lifePatternFactor: 0.2,
    lifeDroughtThreshold: 0.15,
    growthDroughtThreshold: 0.15,
    lifeDroughtPenalty: 0.015,
    lifeTrafficPenalty: 0.004,

    // cellularEnergy = light * moisture * (base + fertility * factor)
    cellularEnergyBase: 0.6,
    cellularEnergyFertilityFactor: 0.4,

    // fertility = clamp(fertility + life * production − traffic * trafficDecay
    //                − cultivation * cultivationDecay − decay * fertility)
    fertilityProduction: 0.0012,
    fertilityTrafficDecay: 0.0007,
    fertilityCultivationDecay: 0.0002,

    // growth = clamp(growth + produced − baselineDecay − traffic * trafficDecay
    //                − droughtDecay)
    growthLifeBase: 0.25,
    growthLifeFactor: 0.75,
    growthScale: 0.005,
    growthBaselineDecay: 0.0002,
    growthTrafficDecay: 0.002,
    growthDroughtDecay: 0.001,
    growthTrafficFactor: 0.9,

    // vegetation = clamp(vegetation + produced * productionFactor − traffic * trafficDecay)
    vegetationProductionFactor: 0.25,
    vegetationTrafficDecay: 0.001,

    // traffic y cultivation
    trafficDecay: 0.0005,
    cultivationDecay: 0.00002,

    // drinkingWater: rain = 0.008 * (0.4 + fertility * 0.6), spring = 0.002
    rainRecharge: 0.008,
    rainFertilityBase: 0.4,
    rainFertilityFactor: 0.6,
    springRecharge: 0.002,
    waterDecayDay: 0.00015,
    waterDecayNight: 0.00003,

    // moisture = clamp(moisture + (ocean ? oceanMoisture : 0) + (rain ? rainRecharge : 0))
    oceanMoisture: 0.003,
    rainMoistureRecharge: 0.008,

    // Luz: day=1, night=0, dawn=0.4
    dawnLight: 0.4,

    // Regrowth de madera (tick % 100)
    woodGrowthThreshold: 0.65,
    woodFertilityThreshold: 0.4,
    woodMoistureThreshold: 0.35,
    woodTrafficThreshold: 0.35,
    woodRegrowthRate: 0.025,
    woodRegrowthCost: 0.05,
    woodCapacityDefault: 12,
    woodCapacityPalm: 6,
    woodCapacityReeds: 2,
  }),
  // SHA256 del cuerpo de step() con comentarios /* */, // y secuencias de
  // espacios colapsadas. Hay que bumpear la versión (y este hash) junto con
  // cualquier cambio intencional de reglas.
  canonicalStepBodyHash: '88aa7c842b2d9756df8c72d4c0f9a3abd08d213922531450c112f4b20e7b494a',
});

// Conteos/índices que aparecen en el cuerpo de step() y NO son reglas
// versionadas. Mantener este set sincronizado con el kernel.
const STRUCTURAL_NUMERIC_LITERALS = new Set([0, 1, 3, 8, 10, 100]);

function extractStepBody(source) {
  const stepStart = source.indexOf('step(tiles: Tile[]');
  if (stepStart < 0) throw new Error('step() not found in kernel source');
  let bodyStart = source.indexOf('{', stepStart);
  if (bodyStart < 0) throw new Error('step() body start not found');
  let depth = 1;
  let i = bodyStart + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('step() body braces unbalanced');
  return source.slice(bodyStart, i - 1);
}

function stripComments(body) {
  // /* ... */ primero (puede cruzar líneas).
  let s = body.replace(/\/\*[\s\S]*?\*\//g, '');
  // // después, pero solo si no estamos dentro de un literal de cadena.
  s = s.split('\n').map(line => {
    const idx = line.indexOf('//');
    if (idx < 0) return line;
    const before = line.slice(0, idx);
    const sq = (before.match(/(?<!\\)'/g) || []).length;
    const dq = (before.match(/(?<!\\)"/g) || []).length;
    if (sq % 2 === 1 || dq % 2 === 1) return line;
    return before;
  }).join('\n');
  return s;
}

function normalizeStepBody(source) {
  return stripComments(extractStepBody(source)).replace(/\s+/g, ' ').trim();
}

function extractNumericLiterals(source) {
  const stripped = stripComments(extractStepBody(source));
  const matches = stripped.match(/-?\d+\.?\d*(?:e[+-]?\d+)?/gi) || [];
  return matches.map(Number);
}

function extractTileFieldAccesses(source) {
  const stripped = stripComments(extractStepBody(source));
  const matches = stripped.match(/\btile\.([a-zA-Z_]\w*)/g) || [];
  return new Set(matches.map(m => m.slice(5)));
}

function multiset(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

function hashNormalizedStepBody(source) {
  return createHash('sha256').update(normalizeStepBody(source)).digest('hex');
}

/**
 * Valida que el código fuente del kernel vivo cumple ECOLOGY_KERNEL_SPEC.
 * Devuelve `{valid:true, version}` o `{valid:false, version, reason}` con la
 * primera discrepancia encontrada (tér mino faltante/extra, campo fuera de
 * lista, o cuerpo de step() con hash distinto).
 */
export function validateKernelSpecification(kernelSource) {
  if (typeof kernelSource !== 'string') throw new Error('kernelSource must be a string');
  let srcLiterals;
  try {
    srcLiterals = extractNumericLiterals(kernelSource).filter(n => !STRUCTURAL_NUMERIC_LITERALS.has(n));
  } catch (error) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Could not locate EcosystemKernel.step() body: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let srcFields;
  try {
    srcFields = extractTileFieldAccesses(kernelSource);
  } catch (error) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Could not extract tile fields: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let actualHash;
  try {
    actualHash = hashNormalizedStepBody(kernelSource);
  } catch (error) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Could not hash step() body: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const specTerms = Object.values(ECOLOGY_KERNEL_SPEC.terms);
  const specMultiset = multiset(specTerms);
  const srcMultiset = multiset(srcLiterals);

  const missingTerms = [];
  for (const [val, count] of specMultiset) {
    if ((srcMultiset.get(val) || 0) < count) missingTerms.push(val);
  }
  if (missingTerms.length > 0) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Kernel is missing spec term(s): ${missingTerms.join(', ')}. Bump ECOLOGY_KERNEL_SPEC.version if this is intentional.`,
    };
  }
  const extraTerms = [];
  for (const [val, count] of srcMultiset) {
    if ((specMultiset.get(val) || 0) < count) extraTerms.push(val);
  }
  if (extraTerms.length > 0) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Kernel introduces new term(s) not in ECOLOGY_KERNEL_SPEC.terms: ${extraTerms.join(', ')}. Add them to the spec or revert.`,
    };
  }

  const specFields = new Set([...ECOLOGY_KERNEL_SPEC.fieldsRead, ...ECOLOGY_KERNEL_SPEC.fieldsWritten]);
  const missingFields = [...specFields].filter(f => !srcFields.has(f));
  if (missingFields.length > 0) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Kernel no longer references spec field(s): ${missingFields.join(', ')}. Bump ECOLOGY_KERNEL_SPEC.version if this is intentional.`,
    };
  }
  const extraFields = [...srcFields].filter(f => !specFields.has(f));
  if (extraFields.length > 0) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Kernel accesses new tile field(s) not in ECOLOGY_KERNEL_SPEC: ${extraFields.join(', ')}. Add them to fieldsRead/fieldsWritten or revert.`,
    };
  }

  if (actualHash !== ECOLOGY_KERNEL_SPEC.canonicalStepBodyHash) {
    return {
      valid: false,
      version: ECOLOGY_KERNEL_SPEC.version,
      reason: `Kernel step() body structure changed (hash mismatch). expected=${ECOLOGY_KERNEL_SPEC.canonicalStepBodyHash.slice(0, 12)}…, got=${actualHash.slice(0, 12)}…. Bump ECOLOGY_KERNEL_SPEC.version and canonicalStepBodyHash if this is intentional.`,
      expectedHash: ECOLOGY_KERNEL_SPEC.canonicalStepBodyHash,
      actualHash,
    };
  }

  return { valid: true, version: ECOLOGY_KERNEL_SPEC.version };
}

export function topology(tiles) {
  const positions = new Map();
  for (let i = 0; i < tiles.length; i++) {
    const key = `${tiles[i].x},${tiles[i].y}`;
    if (positions.has(key)) throw new Error('Duplicate coordinates');
    positions.set(key, i);
  }
  const neighbors = new Int32Array(tiles.length * 8).fill(-1);
  for (let i = 0; i < tiles.length; i++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx || dy) neighbors[i * 8 + k++] = positions.get(`${tiles[i].x + dx},${tiles[i].y + dy}`) ?? -1;
    }
  }
  return neighbors;
}

export function pack(tiles, into = new Float64Array(tiles.length * FIELDS)) {
  const n = tiles.length;
  if (into.length !== n * FIELDS) throw new Error('Invalid packed size');
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    into[i] = t.growth ?? t.vegetation; into[n+i] = t.fertility ?? 0;
    into[2*n+i] = t.life ?? 0; into[3*n+i] = t.moisture;
    into[4*n+i] = t.drinkingWater ?? 0; into[5*n+i] = t.cultivation ?? 0;
    into[6*n+i] = t.traffic ?? 0; into[7*n+i] = t.vegetation;
    into[8*n+i] = t.wood ?? 0; into[9*n+i] = FEATURES.indexOf(t.feature);
    if (into[9*n+i] < 0) throw new Error('Unknown feature');
    into[10*n+i] = +(t.terrain === 'water'); into[11*n+i] = +(t.biome === 'ocean');
    into[12*n+i] = +(t.biome === 'mountain'); into[13*n+i] = +(t.biome === 'wetland');
    into[14*n+i] = +(t.wood !== undefined);
    into[15*n+i] = t.x; into[16*n+i] = t.y;
  }
  return into;
}

export function unpack(data, tiles, tick) {
  if (tick % 10) return tiles;
  const n = tiles.length;
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    t.growth=data[i]; t.fertility=data[n+i]; t.life=data[2*n+i]; t.moisture=data[3*n+i];
    t.drinkingWater=data[4*n+i]; t.cultivation=data[5*n+i]; t.traffic=data[6*n+i];
    t.vegetation=data[7*n+i];
    if (data[14*n+i]) t.wood=data[8*n+i];
    const feature=FEATURES[data[9*n+i]];
    if (feature !== undefined) t.feature=feature;
  }
  return tiles;
}

function basinUnit(seed, x, y) {
  let value = seed ^ 1400 ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
export function basinNoise(seed, x, y) {
  const px = x / 24, py = y / 24, ix = Math.floor(px), iy = Math.floor(py);
  const tx = fade(px - ix), ty = fade(py - iy);
  return lerp(lerp(basinUnit(seed, ix, iy), basinUnit(seed, ix + 1, iy), tx), lerp(basinUnit(seed, ix, iy + 1), basinUnit(seed, ix + 1, iy + 1), tx), ty);
}

export function stepArrays(input, output, neighbors, n, tick, rain, light, begin = 0, end = n, options = {}) {
  const { decaimientoFertilidad = 0, seed = 0, cuencas = 1 } = options;
  for (let f=0; f<FIELDS; f++) output.set(input.subarray(f*n+begin,f*n+end),f*n+begin);
  if (tick % 10) return;
  for (let i=begin; i<end; i++) {
    const growth=input[i], fertility=input[n+i], life=input[2*n+i], moisture=input[3*n+i];
    const water=input[4*n+i], cultivation=input[5*n+i], traffic=input[6*n+i];
    const vegetation=input[7*n+i], wood=input[8*n+i], feature=input[9*n+i];
    const aquatic=input[10*n+i], ocean=input[11*n+i], mountain=input[12*n+i], wetland=input[13*n+i];
    let living=0;
    for(let k=0;k<8;k++) { const q=neighbors[i*8+k]; if(q>=0 && input[2*n+q]>=0.45) living++; }
    const fertilePattern=living===3 || (life>=0.45 && living===2);
    const cellularEnergy=light*moisture*(0.6+fertility*0.4);
    output[2*n+i]=clamp(life+((fertilePattern?1:0)-life)*0.2*cellularEnergy-(moisture<0.15?0.015:0)-traffic*0.004);
    output[n+i]=clamp(fertility+life*0.0012-traffic*0.0007-cultivation*0.0002-decaimientoFertilidad*fertility);
    const produced=light*moisture*fertility*(0.25+life*0.75)*(1-growth)*(1-traffic*0.9)*0.005;
    output[i]=clamp(growth+produced-0.0002-traffic*0.002-(moisture<0.15?0.001:0));
    if(!aquatic) output[7*n+i]=clamp(vegetation+produced*0.25-traffic*0.001);
    output[6*n+i]=clamp(traffic-0.0005); output[5*n+i]=clamp(cultivation-0.00002);
    const reservoir=(feature===9 || feature===8 || wetland || aquatic) && (aquatic || basinNoise(seed,input[15*n+i],input[16*n+i])<cuencas);
    output[4*n+i]=ocean?0:clamp(water+(reservoir&&rain?0.008*(0.4+fertility*0.6):0)+(reservoir&&feature===8?0.002:0)-(light?0.00015:0.00003));
    if(aquatic) output[3*n+i]=clamp(moisture+(ocean?0.003:0)+(rain?0.008:0));
    if(tick%100===0 && feature>=2 && feature<=7 && growth>0.65 && fertility>0.4 && moisture>0.35 && traffic<0.35 && light>0) {
      const capacity=feature===6||feature===5?2:feature===4?6:12;
      const regrowth=Math.min(capacity-wood,0.025*light*moisture*fertility);
      if(regrowth>0) {
        output[8*n+i]=wood+regrowth; output[14*n+i]=1;
        output[i]=clamp(output[i]-regrowth*0.05);
        if(feature===7 && output[8*n+i]>=1) output[9*n+i]=mountain?3:2;
      }
    }
  }
}

export function compare(expected, actual) {
  if(expected.length!==actual.length) throw new Error('Mismatched output length');
  let different=0, maximumAbsoluteError=0;
  for(let i=0;i<expected.length;i++) {
    if(!Number.isFinite(actual[i])) throw new Error(`Nonfinite output at ${i}`);
    if(!Object.is(expected[i],actual[i])) different++;
    maximumAbsoluteError=Math.max(maximumAbsoluteError,Math.abs(expected[i]-actual[i]));
  }
  return {different,maximumAbsoluteError};
}

/** The benchmark refuses timings if these versioned physical cases differ from the live engine. */
export function validateLiveKernel(referenceStep) {
  const coordinates = [-49, -24, -1, 0, 23, 24, 49];
  const fixture = coordinates.flatMap((y, j) => coordinates.map((x, i) => ({
    x, y, terrain: i % 4 === 0 ? 'water' : 'meadow', biome: j % 3 === 0 ? 'ocean' : j % 3 === 1 ? 'wetland' : 'mountain',
    feature: FEATURES[2 + (i + j) % 12], wood: 0.999, growth: 0.9, fertility: 0.9,
    life: i % 2 === 0 ? 0.45 : 0.44999999999999996, moisture: 0.9, vegetation: 0.7, food: 0.5, drinkingWater: 0.2,
  })));
  const neighbors = topology(fixture);
  let comparisons = 0;
  for (const seed of [42, 51926, -1, 4294967295]) for (const cuencas of [0, 0.4, 1]) for (const decaimientoFertilidad of [0, 0.001]) {
    const options = { seed, cuencas, decaimientoFertilidad };
    let cells = fixture.map(tile => ({ ...tile }));
    for (let j = 0; j < 8; j++) {
      const tick = j === 0 ? 1 : j * 100, rain = j % 2 === 0, light = [1, 0, 0.4][j % 3];
      const expected = cells.map(tile => ({ ...tile })), input = pack(cells), actual = new Float64Array(input.length);
      referenceStep(expected, tick, rain, light, options);
      stepArrays(input, actual, neighbors, cells.length, tick, rain, light, 0, cells.length, options);
      const fidelity = compare(pack(expected), actual);
      if (fidelity.different) throw new Error(`Live ecology contract v${ECOLOGY_CONTRACT.version} differs: ${JSON.stringify({ options, tick, ...fidelity })}`);
      const unpacked = unpack(actual, cells.map(tile => ({ ...tile })), tick);
      if (!isDeepStrictEqual(unpacked, expected)) throw new Error(`Live ecology contract v${ECOLOGY_CONTRACT.version} tile fields differ: ${JSON.stringify({ options, tick })}`);
      comparisons++;
      cells = expected;
    }
  }
  return { version: ECOLOGY_CONTRACT.version, comparisons, differentValues: 0 };
}
