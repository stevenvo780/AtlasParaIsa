/** Scheduling data stays outside World, WorldParams and encoded snapshots. Rates are cells/ms. */
export interface GPUThroughput { device: number; throughput: number }
export interface GPUPage { x: number; y: number }
export interface GPUAssignment<T extends GPUPage> extends GPUThroughput {
  pages: T[]; pageBegin: number; pageEnd: number;
}
export const DEFAULT_GPU_THROUGHPUT: readonly GPUThroughput[] = Object.freeze([
  Object.freeze({ device: 0, throughput: 2_500_000 }), Object.freeze({ device: 1, throughput: 680_000 }),
]);

/** Signed int32 page coordinates biased to unsigned, then interleaved without 32-bit truncation. */
export function mortonCode(x: number, y: number): bigint {
  for (const coordinate of [x, y]) if (!Number.isInteger(coordinate) || coordinate < -0x80000000 || coordinate > 0x7fffffff)
    throw new RangeError('Coordenada de página fuera de int32.');
  const a = BigInt(x + 0x80000000), b = BigInt(y + 0x80000000);
  let code = 0n;
  for (let bit = 0n; bit < 32n; bit++) code |= ((a >> bit) & 1n) << (2n * bit) | ((b >> bit) & 1n) << (2n * bit + 1n);
  return code;
}

/** Largest remainders round quotas to whole pages. Ties follow the explicit device order. */
export function repartirPaginas<T extends GPUPage>(pages: readonly T[], rates: readonly GPUThroughput[] = DEFAULT_GPU_THROUGHPUT): GPUAssignment<T>[] {
  if (!rates.length || rates.some(rate => !Number.isSafeInteger(rate.device) || rate.device < 0
    || !Number.isFinite(rate.throughput) || rate.throughput < 0)
    || new Set(rates.map(rate => rate.device)).size !== rates.length)
    throw new RangeError('Dispositivos o tasas de GPU inválidos.');
  const maximum = Math.max(...rates.map(rate => rate.throughput));
  if (maximum === 0) throw new RangeError('Se requiere throughput positivo.');
  const ordered = pages.map(page => ({ page, code: mortonCode(page.x, page.y) }))
    .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].code === ordered[i - 1].code)
    throw new Error('Página duplicada.');
  const weights = rates.map(rate => rate.throughput / maximum), total = weights.reduce((sum, weight) => sum + weight, 0);
  const quotas = weights.map(weight => weight / total * pages.length), counts = quotas.map(Math.floor);
  const remainders = quotas.map((quota, index) => ({ index, remainder: quota - counts[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const missing = pages.length - counts.reduce((sum, count) => sum + count, 0);
  for (let i = 0; i < missing; i++) counts[remainders[i].index]++;
  let cursor = 0;
  return rates.map((rate, i) => {
    const pageBegin = cursor; cursor += counts[i];
    return { ...rate, pageBegin, pageEnd: cursor, pages: ordered.slice(pageBegin, cursor).map(entry => entry.page) };
  });
}
