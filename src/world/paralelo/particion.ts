/** Rango de escritura exclusivo; el halo se lee directamente de los SAB del despacho. */
export interface StaticRegion {
  id: number | string;
  begin: number;
  end: number;
}

/** Orden físico del despacho; nunca forma parte de una ley ni del RNG del mundo. */
export type StaticRegionOrder = 'natural' | 'inverso' | 'adversarial';

export function compareRegionIds(left: StaticRegion, right: StaticRegion): number {
  if (typeof left.id === 'number' && typeof right.id === 'number') return left.id - right.id;
  if (typeof left.id !== typeof right.id) return typeof left.id === 'number' ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Colas contiguas del orden por id: independientes del orden de llegada, sin stealing. */
export function partitionRegions(
  regions: readonly StaticRegion[], workers: number, orden: StaticRegionOrder = 'natural',
): StaticRegion[][] {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new RangeError('workers debe ser un entero positivo.');
  if (orden !== 'natural' && orden !== 'inverso' && orden !== 'adversarial') {
    throw new TypeError('orden debe ser natural, inverso o adversarial.');
  }
  const ids = new Set<number | string>();
  const ordered = regions.map(region => {
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
    return { id: region.id, begin: region.begin, end: region.end };
  }).sort(compareRegionIds);
  const nonempty = ordered.filter(region => region.begin !== region.end)
    .sort((left, right) => left.begin - right.begin || left.end - right.end);
  for (let index = 1; index < nonempty.length; index++) {
    const previous = nonempty[index - 1]!, current = nonempty[index]!;
    if (current.begin < previous.end) {
      throw new RangeError(`Rangos solapados entre las regiones ${previous.id} y ${current.id}.`);
    }
  }
  return Array.from({ length: workers }, (_, workerIndex) => {
    const queue = ordered.slice(
      Math.floor(ordered.length * workerIndex / workers),
      Math.floor(ordered.length * (workerIndex + 1) / workers),
    );
    // La pertenencia de cada cola permanece estática: sólo se invierte su recorrido.
    return orden === 'natural' ? queue : queue.reverse();
  });
}
