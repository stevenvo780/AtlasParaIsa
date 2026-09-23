/**
 * Control de identidad de la retención del archivo de recibos (sprint noche-arch 2026-09-23): `digestoCanonico`
 * en cortes fijos con el régimen de `scripts/lab/rendimiento.ts` (Store temporal guardado antes del primer paso
 * y cada `persistencia.cadaTicks`), con o sin ventana de retención. Corre igual en el árbol base (sin retención:
 * la ventana sólo poda sucesos y terreno) y en la rama (poda además recibos): los digestos deben coincidir.
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/identidad-retencion.ts <semilla> [--params P] \
 *     [--ventana 2400] [--cortes 1200,2400,3600,4800] [--salida j.json]
 *
 * `--params` se aplica sobre `HISTORICAL_PARAMS` (como `digestosControl`); `--ventana` añade
 * `persistencia.ventanaEventosTicks`. Informa también de cuántos recibos quedan y hasta qué serie se podó.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { createWorld, stepWorld } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { HISTORICAL_PARAMS, paramsOf, parseParams } from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp'))
  throw new Error('TMPDIR debe apuntar fuera de /tmp: TMPDIR=/datos/tmp-atlas-lab');
const seed = Number(process.argv[2]), ventana = arg('--ventana'), salida = arg('--salida');
const cortes = (arg('--cortes') ?? '1200,2400,3600,4800').split(',').map(Number);
if (!Number.isSafeInteger(seed))
  throw new Error('Uso: identidad-retencion.ts <semilla> [--params P] [--ventana W] [--cortes a,b] [--salida j]');
const params = [arg('--params'), ventana ? `persistencia.ventanaEventosTicks=${ventana}` : undefined]
  .filter(Boolean).join(',') || undefined;
const dir = mkdtempSync(join(tmpdir(), 'atlas-identidad-retencion-'));
const store = new Store(join(dir, 'world.sqlite'));
try {
  const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
  store.save(world);
  const digestos: Record<string, string> = {}, fin = Math.max(...cortes);
  for (let n = 1; n <= fin; n++) {
    stepWorld(world, [], undefined);
    if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) store.save(world);
    if (cortes.includes(n)) digestos[String(n)] = digestoCanonico(world);
  }
  const fila = (sql: string) => (store.db.prepare(sql).get() ?? {}) as Record<string, number | string | null | undefined>;
  const poda = fila("SELECT value FROM metadata WHERE key='technology-pruned-v1'").value ?? null;
  const resultado = { seed, params: params ?? 'historicos', digestos, tick: world.tick, poblacion: world.people.length,
    executionCounter: world.technology.executionCounter,
    recibosRetenidos: Number(fila('SELECT COUNT(*) AS n FROM technology_executions').n),
    frontera: poda === null ? null : JSON.parse(String(poda)) };
  const texto = JSON.stringify(resultado, null, 1);
  if (salida) writeFileSync(salida, texto + '\n');
  console.log(texto);
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
