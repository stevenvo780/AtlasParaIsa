import { createWorld, stepWorld, cloneWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { parseParams, setParams, paramsOf } from '../src/world/params.js';

const days = Number(process.env.DIAS ?? 10);
let world = createWorld(51926);
setParams(world, parseParams(process.env.PARAMS ?? 'poblacion.maxima=1000000'));
console.log('maxima =', paramsOf(world).poblacion.maxima, '| poblacion inicial =', world.people.length);
const line: string[] = [];
for (let day = 1; day <= days; day++) {
  const t0 = performance.now();
  for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
    const draft = cloneWorld(world);
    stepWorld(draft, []);
    world = draft;
  }
  const ms = performance.now() - t0;
  const food = world.people.reduce((s: number, p) => s + p.inventory, 0) / Math.max(1, world.people.length);
  line.push(String(world.people.length));
  console.log(`dia ${day}: poblacion=${world.people.length} nacimientos=${world.totals.births ?? 0} muertes=${world.demographyDynamics.deaths} reservaPerCapita=${food.toFixed(3)} msPorTick=${(ms / TICKS_PER_DAY).toFixed(2)}`);
}
console.log('curva:', line.join(' '));
