/**
 * Laboratorio — digesto de control de una réplica (reglas 10, etapa 1, 2026-09-22).
 *
 * Mismo régimen que las réplicas de `tests/leyes-candidatas.test.ts`, `tests/agua-memoria.test.ts`,
 * `tests/ley-aptitud.test.ts` y `tests/comunidades-vivas.test.ts`: Store temporal, `store.save` ANTES
 * del primer paso (liga el catálogo de tecnología de producción) y ningún guardado más.
 *
 *   npx tsx scripts/lab/digesto-control.ts --seed 51926 --pasos 1200 [--params "a.b=1,c.d=2"] [--sin agua.memoria,conducta.aptitud]
 *
 * Los `--params` se aplican sobre la BASE HISTÓRICA: `HISTORICAL_PARAMS` cuando el árbol la exporta
 * (reglas 10 en adelante) y, si no, `DEFAULT_PARAMS`, que en todo árbol anterior ES la base histórica.
 * Así el mismo script mide lo mismo en una exportación limpia de un commit viejo (`git archive`) y en
 * el árbol actual. Imprime JSON con `completo` (`digestoCanonico`), `fisico` (el digesto con las claves
 * de `--sin` quitadas de los params, la forma de params de antes de declararlas) y `nacimientos`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { createWorld, stepWorld } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import * as parametros from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const seed = Number(arg('--seed') ?? 51926), pasos = Number(arg('--pasos') ?? 1200), params = arg('--params');
const sin = (arg('--sin') ?? '').split(',').filter(Boolean);
if (!Number.isInteger(seed) || seed < 0 || !Number.isInteger(pasos) || pasos < 0) throw new Error('Uso: --seed N --pasos P [--params ...] [--sin a.b,c.d]');
const base = (parametros as { HISTORICAL_PARAMS?: parametros.WorldParams }).HISTORICAL_PARAMS ?? parametros.DEFAULT_PARAMS;

const directory = mkdtempSync(join(tmpdir(), 'atlas-digesto-control-'));
const store = new Store(join(directory, 'world.sqlite'));
try {
  const world = createWorld(seed, parametros.parseParams(params, base));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  const vigentes = parametros.paramsOf(world);
  const forma = structuredClone(vigentes) as unknown as Record<string, Record<string, unknown>>;
  for (const clave of sin) {
    const [seccion, hoja] = clave.split('.') as [string, string];
    if (!forma[seccion] || !Object.hasOwn(forma[seccion]!, hoja)) throw new Error(`--sin: la clave ${clave} no existe en este árbol`);
    delete forma[seccion]![hoja];
  }
  parametros.setParams(world, forma as unknown as parametros.WorldParams);
  const fisico = digestoCanonico(world);
  parametros.setParams(world, vigentes);
  console.log(JSON.stringify({ seed, pasos, params: params ?? null, sin, base: base === parametros.DEFAULT_PARAMS ? 'DEFAULT_PARAMS' : 'HISTORICAL_PARAMS',
    completo: digestoCanonico(world), fisico, nacimientos: world.birthCounter, poblacion: world.people.length }));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
