// Isolated benchmark port of EcosystemKernel at 95ff0d2; never imported by the app.
export const FIELDS = 15;
export const FEATURES = [undefined, 'none', 'tree', 'pine', 'palm', 'cactus', 'reeds', 'stump', 'spring', 'pool', 'berries', 'flowers', 'rock', 'clay'];
export const clamp = n => Math.max(0, Math.min(1, n));

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

export function stepArrays(input, output, neighbors, n, tick, rain, light, begin = 0, end = n) {
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
    output[n+i]=clamp(fertility+life*0.0012-traffic*0.0007-cultivation*0.0002);
    const produced=light*moisture*fertility*(0.25+life*0.75)*(1-growth)*(1-traffic*0.9)*0.005;
    output[i]=clamp(growth+produced-0.0002-traffic*0.002-(moisture<0.15?0.001:0));
    if(!aquatic) output[7*n+i]=clamp(vegetation+produced*0.25-traffic*0.001);
    output[6*n+i]=clamp(traffic-0.0005); output[5*n+i]=clamp(cultivation-0.00002);
    const reservoir=feature===9 || feature===8 || wetland || aquatic;
    output[4*n+i]=ocean?0:clamp(water+(reservoir&&rain?0.008*(0.4+fertility*0.6):0)+(feature===8?0.002:0)-(light?0.00015:0.00003));
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
