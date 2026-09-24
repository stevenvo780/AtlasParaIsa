import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, TICKS_PER_DAY } from '../src/world/index.js';

async function observar(base: string, gemelo?: string): Promise<Record<string, any>> {
  const script = pathToFileURL(join(process.cwd(), 'scripts/ops/observar-publico.mts')).href;
  const cargar = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ observarPublico: (options: { base: string; gemelo?: string }) => Record<string, any> }>;
  return (await cargar(script)).observarPublico({ base, gemelo });
}

test('observa la instantánea sin alterar SQLite y detecta diferencias contra el gemelo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'observar-publico-'));
  const base = join(dir, 'world.sqlite'), gemelo = join(dir, 'gemelo');
  mkdirSync(gemelo);
  let store: Store | undefined;
  try {
    const world = createWorld(71209);
    store = new Store(base);
    store.save(world);
    for (let i = 0; i < 4; i++) stepWorld(world);
    store.save(world);

    // El mundo de prueba ha avanzado cuatro pasos. Se lo ubica dentro del día 3
    // para verificar que coteja el último día completo (dia-002) y lo declara.
    world.tick = TICKS_PER_DAY * 2 + 4;
    for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    store.save(world);
    store.close(); store = undefined;

    const esperado = await observar(base);
    assert.equal(esperado.tick, world.tick);
    assert.equal(esperado.poblacion, world.people.length);
    assert.equal(esperado.poblacionMortal, world.people.filter(person => person.role === 'neighbor').length);
    assert.equal(esperado.nacimientos, world.totals.births ?? 0);

    const statAntes = statSync(base);
    const segundo = await observar(base);
    const statDespues = statSync(base);
    assert.deepEqual({ size: statDespues.size, mtimeMs: statDespues.mtimeMs }, { size: statAntes.size, mtimeMs: statAntes.mtimeMs });
    assert.equal(segundo.tick, esperado.tick);

    const gemeloDiario = {
      tick: TICKS_PER_DAY * 2,
      poblacion: esperado.poblacion,
      nacimientos: esperado.nacimientos,
      muertesPorCausa: { senescence: esperado.muertesPorCausa.senescence, exposure: esperado.muertesPorCausa.exposure,
        dehydration: esperado.muertesPorCausa.dehydration, starvation: esperado.muertesPorCausa.starvation },
      conflictosAcumulados: esperado.conflictosAcumulados + 1,
      cooperacionAcumuladaPorTipo: {
        teaching: esperado.cooperacionAcumuladaPorTipo.teaching,
        trade: esperado.cooperacionAcumuladaPorTipo.trade,
        constructionHelp: esperado.cooperacionAcumuladaPorTipo.constructionHelp,
        foodShared: esperado.cooperacionAcumuladaPorTipo.foodShared,
      },
    };
    writeFileSync(join(gemelo, 'dia-002.json'), JSON.stringify(gemeloDiario));
    const conGemelo = await observar(base, gemelo);
    assert.equal(conGemelo.comparacionGemelo?.estado, 'diferencias');
    assert.equal(conGemelo.comparacionGemelo?.diaGemelo, 2);
    assert.match(conGemelo.comparacionGemelo?.nota ?? '', /día simulado .* incompleto/);
    assert.deepEqual(conGemelo.comparacionGemelo?.diferencias.map((d: string) => d.split(':')[0]), ['conflictosAcumulados']);
    assert.deepEqual(JSON.parse(readFileSync(join(gemelo, 'dia-002.json'), 'utf8')), gemeloDiario);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
