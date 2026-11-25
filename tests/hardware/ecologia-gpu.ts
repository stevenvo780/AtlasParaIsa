import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Tile } from '../../src/shared/types.js';

/**
 * Comparación estadística entre la ecología de la CPU y la de la GPU. Desde V23 la GPU compila con FMA y no repite a la
 * CPU bit a bit (AJUSTES-ORQUESTADOR §1): casi todas las celdas coinciden hasta el redondeo acumulado, y las pocas que se
 * apartan (un umbral cruzado por un ULP, o la conducta que diverge después) son una fracción mínima.
 */
export const TOLERANCIA_ECOLOGIA = 1e-9;
export const FRACCION_MAXIMA = 0.01;

export interface DiferenciaCampo { campo: string; maxima: number; fueraDeTolerancia: number }

/** Por campo, la mayor diferencia absoluta y la fracción de las `n` celdas que difieren más que la tolerancia (los
 * valores que no son números, como el terreno de una tesela, cuentan si no son iguales). */
export function diferencias(campos: readonly string[], n: number,
  leer: (lado: 0 | 1, campo: string, i: number) => number | string | undefined): DiferenciaCampo[] {
  return campos.map(campo => {
    let maxima = 0, fuera = 0;
    for (let i = 0; i < n; i++) {
      const a = leer(0, campo, i), b = leer(1, campo, i);
      if (typeof a === 'number' && typeof b === 'number') {
        const d = Math.abs(a - b);
        if (!(d <= TOLERANCIA_ECOLOGIA)) fuera++;
        maxima = Math.max(maxima, Number.isNaN(d) ? Infinity : d);
      } else if (a !== b) { fuera++; maxima = Infinity; }
    }
    return { campo, maxima, fueraDeTolerancia: fuera / Math.max(1, n) };
  });
}

export function asegurarParecidas(t: TestContext, medidas: readonly DiferenciaCampo[]): void {
  t.diagnostic(JSON.stringify(medidas));
  for (const m of medidas) assert.ok(m.fueraDeTolerancia <= FRACCION_MAXIMA, `${m.campo}: ${m.fueraDeTolerancia} de las celdas difieren`);
}

const CAMPOS_TESELA = ['moisture', 'vegetation', 'food', 'wood', 'growth', 'fertility', 'cultivation', 'traffic', 'drinkingWater',
  'terrain', 'biome', 'feature', 'life'] as const;

/** Las teselas de dos mundos de la misma semilla, uno con la ecología en CPU y otro en GPU: celda a celda y en media. */
export function asegurarTeselasParecidas(t: TestContext, cpu: readonly Tile[], gpu: readonly Tile[]): void {
  assert.equal(gpu.length, cpu.length, 'mismas teselas');
  const lados = [cpu, gpu];
  asegurarParecidas(t, diferencias(CAMPOS_TESELA, cpu.length, (lado, campo, i) => lados[lado]![i]![campo as keyof Tile] as number | string | undefined));
  const media = (ts: readonly Tile[], campo: 'moisture' | 'vegetation' | 'food') => ts.reduce((s, tesela) => s + tesela[campo], 0) / ts.length;
  for (const campo of ['moisture', 'vegetation', 'food'] as const)
    assert.ok(Math.abs(media(cpu, campo) - media(gpu, campo)) <= 1e-4, `${campo}: medias distintas`);
}
