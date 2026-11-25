import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { EscritorCinta } from '../src/server/cinta/escritor.js';
import { LectorCinta } from '../src/server/cinta/lector.js';
import { CINTA, type ChunkResp } from '../src/shared/cinta.js';
import type { WorldView } from '../src/shared/types.js';

test('I1/I9: la proyección es pública y la serie duradera conserva el balance demográfico fuera de L0', t => {
  const raiz = '/tmp/atlas-v23-o-cinta';
  mkdirSync(raiz, { recursive: true });
  const directorio = mkdtempSync(join(raiz, 'serie-'));
  t.after(() => rmSync(directorio, { recursive: true, force: true }));
  const escritor = new EscritorCinta({ directorio });
  try {
    escritor.abrir({ epoca: 0, tMundo: 0, instanciaId: 'serie', motivo: 'reinicio' });
    for (const [i, nacimientos, muertes] of [[0, 0, 0], [1, 2, 0], [2, 4, 3]]) {
      const tick = i * CINTA.seriePaso, poblacion = 7 + nacimientos - muertes;
      const vista: WorldView & { seed: number } = { tick, seed: 42, sequence: i, day: 1, phase: 'day', weather: 'clear',
        version: 10, width: 1, height: 1, people: [], places: [], events: [], memories: [], tiles: [] };
      escritor.registrarSerie(0, { t: tick, poblacion, nacimientos, muertes, hz: 6, fauna: 0, estructuras: 0, sustancias: 0 });
      if (i !== 1) escritor.registrar({ seq: i, epoca: 0, t: tick, vista, tilesCambiadas: i ? [] : 'todas', hitos: [],
        catalogo: [], hz: 6, serie: { poblacion, nacimientos, muertes, hz: 6, fauna: 0, estructuras: 0, sustancias: 0 } });
    }
  } finally { escritor.close(); }

  const lector = new LectorCinta(directorio);
  t.after(() => lector.close());
  const { serie, lagunas } = lector.meta();
  assert.deepEqual(serie.map(s => s.t), [0, CINTA.seriePaso, 2 * CINTA.seriePaso]);
  assert.deepEqual(lagunas, [{ t0: 0, t1: 2 * CINTA.seriePaso }]);
  for (const [i, s] of serie.slice(1).entries()) {
    const prev = serie[i]!;
    assert.equal(s.poblacion - prev.poblacion, s.nacimientos - prev.nacimientos - (s.muertes - prev.muertes));
  }
  const { baseFrame } = JSON.parse(lector.chunk({ t: CINTA.seriePaso, n: 1, nivel: 0 })) as ChunkResp;
  assert.equal(baseFrame?.tick, 0);
  assert.ok(baseFrame && !('seed' in baseFrame));
});
