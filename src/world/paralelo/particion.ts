/** Rango de escritura exclusivo; el halo se lee directamente de los SAB del despacho. */
export interface StaticRegion {
  id: number | string;
  begin: number;
  end: number;
}

/** Firma de los consumidores de la piscina anterior, hasta que se integren M2 y M3. */
export type StaticRegionOrder = 'natural' | 'inverso' | 'adversarial';

/** Reparte tramos de la entrada. La comprobación de solapes no ordena el trabajo. */
export function partitionRegions(
  regions: readonly StaticRegion[], workers: number, _orden?: StaticRegionOrder,
): StaticRegion[][] {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new RangeError('workers debe ser un entero positivo.');
  const ids = new Set<number | string>();
  for (const region of regions) {
    if ((typeof region.id !== 'string' && typeof region.id !== 'number')
      || (typeof region.id === 'number' && !Number.isSafeInteger(region.id))) {
      throw new TypeError('Cada región requiere un id string o entero seguro.');
    }
    if (ids.has(region.id)) throw new Error(`Id de región repetido: ${region.id}`);
    ids.add(region.id);
    if (!Number.isSafeInteger(region.begin) || !Number.isSafeInteger(region.end)
      || region.begin < 0 || region.end < region.begin) {
      throw new RangeError(`Rango inválido en la región ${region.id}.`);
    }
  }
  const nonempty = regions.filter(region => region.begin !== region.end)
    .sort((left, right) => left.begin - right.begin || left.end - right.end);
  for (let index = 1; index < nonempty.length; index++) {
    const previous = nonempty[index - 1]!, current = nonempty[index]!;
    if (current.begin < previous.end) {
      throw new RangeError(`Rangos solapados entre las regiones ${previous.id} y ${current.id}.`);
    }
  }
  return Array.from({ length: workers }, (_, workerIndex) => regions.slice(
    Math.floor(regions.length * workerIndex / workers),
    Math.floor(regions.length * (workerIndex + 1) / workers),
  ));
}
