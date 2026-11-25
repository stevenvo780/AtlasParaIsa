/** Coordenadas int32 sesgadas a uint32 e intercaladas sin truncar el código de 64 bits. */
export function mortonCode(x: number, y: number): bigint {
  for (const coordinate of [x, y]) {
    if (!Number.isInteger(coordinate) || coordinate < -0x80000000 || coordinate > 0x7fffffff) {
      throw new RangeError('Coordenada de página fuera de int32.');
    }
  }
  const a = BigInt(x + 0x80000000), b = BigInt(y + 0x80000000);
  let code = 0n;
  for (let bit = 0n; bit < 32n; bit++) code |= ((a >> bit) & 1n) << (2n * bit) | ((b >> bit) & 1n) << (2n * bit + 1n);
  return code;
}
