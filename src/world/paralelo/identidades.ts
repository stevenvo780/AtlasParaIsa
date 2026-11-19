/**
 * T146: prefix-sum de los nueve contadores de identidad en el coordinador.
 *
 * Los workers nunca incrementan un contador compartido: emiten candidatos con una
 * clave de orden total `(tick, fase, regionMorton, actorSlot, secuenciaLocal)` y el
 * coordinador —un solo hilo, tras la barrera— ordena de forma estable, calcula el
 * prefix-sum por contador desde el valor ya confirmado y asigna los seriales.
 * Sin `Atomics` para ids y sin hashes `seed:tick:pos`: los ids legibles de hoy
 * (`descendant-N`, `process-N`, …) se conservan porque viven en la crónica, en
 * `legacy` y en los snapshots.
 *
 * Este módulo es puro: no lee ni escribe ningún `World`. T145/Gate E.1 lo cablea
 * en `index.ts`/`society.ts`; con `motor.hilos=1` el orden de llegada coincide con
 * el orden total, así que la secuencia asignada es exactamente la de hoy.
 */

export const CONTADORES_IDENTIDAD = [
  'birth', 'community', 'event', 'discovered', 'execution', 'item', 'recipe', 'blueprint', 'structure',
] as const;
export type ContadorIdentidad = (typeof CONTADORES_IDENTIDAD)[number];

/** Los nueve contadores confirmados, con los nombres que usan hoy `World`/`TechnologyState`. */
export interface ContadoresIdentidad {
  birthCounter: number;
  communityCounter: number;
  eventCounter: number;
  discoveredChunks: number;
  executionCounter: number;
  itemCounter: number;
  recipeCounter: number;
  blueprintCounter: number;
  structureCounter: number;
}

export interface ClaveOrdenIdentidad {
  tick: number;
  fase: number;
  regionMorton: number;
  actorSlot: number;
  secuenciaLocal: number;
}

export interface CandidatoIdentidad {
  contador: ContadorIdentidad;
  clave: ClaveOrdenIdentidad;
  /** Solo `discovered`: clave del chunk candidato a descubrimiento. */
  chunkKey?: string;
  /** Correlación opaca del emisor; el coordinador la devuelve intacta y nunca ordena por ella. */
  referencia?: string;
}

export interface AsignacionIdentidad {
  /** Posición del candidato en el arreglo de llegada; permite reasociar sin depender de ese orden. */
  indice: number;
  candidato: CandidatoIdentidad;
  contador: ContadorIdentidad;
  /** Serial asignado; `null` en un descubrimiento duplicado o ya conocido. */
  serial: number | null;
  /** Id legible (`descendant-N`, `eN`, …); `null` en `discovered` y en duplicados. */
  id: string | null;
  /** Solo `discovered`: `true` si este candidato es la transición `false→true` que cuenta. */
  descubrimientoNuevo: boolean;
}

const CAMPO_POR_CONTADOR: Readonly<Record<ContadorIdentidad, keyof ContadoresIdentidad>> = {
  birth: 'birthCounter', community: 'communityCounter', event: 'eventCounter',
  discovered: 'discoveredChunks', execution: 'executionCounter', item: 'itemCounter',
  recipe: 'recipeCounter', blueprint: 'blueprintCounter', structure: 'structureCounter',
};

const PREFIJO_POR_CONTADOR: Readonly<Record<ContadorIdentidad, string | null>> = {
  birth: 'descendant-', community: 'community-', event: 'e', discovered: null,
  execution: 'process-', item: 'product-', recipe: 'recipe-', blueprint: 'blueprint-', structure: 'structure-',
};

function enteroSeguro(valor: unknown, campo: string): asserts valor is number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`Clave de identidad inválida: ${campo} debe ser un entero seguro ≥ 0.`);
  }
}

function validarClave(clave: ClaveOrdenIdentidad): void {
  if (!clave || typeof clave !== 'object') throw new TypeError('Candidato de identidad sin clave de orden.');
  enteroSeguro(clave.tick, 'tick'); enteroSeguro(clave.fase, 'fase');
  enteroSeguro(clave.regionMorton, 'regionMorton'); enteroSeguro(clave.actorSlot, 'actorSlot');
  enteroSeguro(clave.secuenciaLocal, 'secuenciaLocal');
}

function validarConfirmados(confirmados: ContadoresIdentidad): void {
  if (!confirmados || typeof confirmados !== 'object') throw new TypeError('Contadores confirmados ausentes.');
  for (const contador of CONTADORES_IDENTIDAD) enteroSeguro(confirmados[CAMPO_POR_CONTADOR[contador]], CAMPO_POR_CONTADOR[contador]);
}

/** Orden total por contenido; nunca por llegada. Empate exacto dentro de un contador es ambiguo. */
export function compararClaveIdentidad(a: ClaveOrdenIdentidad, b: ClaveOrdenIdentidad): number {
  return a.tick - b.tick || a.fase - b.fase || a.regionMorton - b.regionMorton
    || a.actorSlot - b.actorSlot || a.secuenciaLocal - b.secuenciaLocal;
}

function mismaClave(a: ClaveOrdenIdentidad, b: ClaveOrdenIdentidad): boolean {
  return compararClaveIdentidad(a, b) === 0;
}

export function formatearIdIdentidad(contador: ContadorIdentidad, serial: number): string | null {
  enteroSeguro(serial, 'serial');
  if (serial < 1) throw new RangeError('Clave de identidad inválida: serial debe ser ≥ 1.');
  const prefijo = PREFIJO_POR_CONTADOR[contador];
  return prefijo === null ? null : `${prefijo}${serial}`;
}

/** Serial de un id legible de este contador; `null` si el id no pertenece a él. */
export function serialDeIdIdentidad(contador: ContadorIdentidad, id: string): number | null {
  const prefijo = PREFIJO_POR_CONTADOR[contador];
  if (prefijo === null || typeof id !== 'string' || !id.startsWith(prefijo)) return null;
  const resto = id.slice(prefijo.length);
  if (!/^[1-9]\d*$/.test(resto)) return null;
  const serial = Number(resto);
  return Number.isSafeInteger(serial) ? serial : null;
}

/**
 * Stable sort + prefix-sum por contador. Para cada contador: se agrupan los
 * candidatos por `regionMorton` en orden creciente, se cuentan por región y el
 * prefix-sum de esos conteos da el desplazamiento de cada región sobre el
 * contador confirmado; dentro de la región manda `(actorSlot, secuenciaLocal)`.
 * El resultado no depende del orden de llegada: dos llegadas con la misma clave
 * exacta en el mismo contador lanzan, porque ningún desempate por llegada es válido.
 */
export function asignarIdentidades(
  candidatos: readonly CandidatoIdentidad[],
  confirmados: ContadoresIdentidad,
  opciones: { descubiertosPrevios?: ReadonlySet<string> } = {},
): { asignaciones: AsignacionIdentidad[]; contadores: ContadoresIdentidad } {
  validarConfirmados(confirmados);
  const contadores: ContadoresIdentidad = { ...confirmados };
  const asignaciones: AsignacionIdentidad[] = [];
  for (const contador of CONTADORES_IDENTIDAD) {
    const grupo = candidatos
      .map((candidato, indice) => ({ candidato, indice }))
      .filter(({ candidato }) => candidato?.contador === contador);
    if (!grupo.length) continue;
    if (grupo.length !== candidatos.filter(c => c?.contador === contador).length) throw new TypeError('Candidato de identidad mal formado.');
    for (const { candidato } of grupo) {
      if (!candidato || typeof candidato !== 'object') throw new TypeError('Candidato de identidad mal formado.');
      validarClave(candidato.clave);
      if (contador === 'discovered' && (typeof candidato.chunkKey !== 'string' || candidato.chunkKey.length === 0)) {
        throw new TypeError('Un candidato discovered requiere chunkKey.');
      }
      if (contador !== 'discovered' && candidato.chunkKey !== undefined) {
        throw new TypeError('chunkKey solo pertenece a un candidato discovered.');
      }
    }
    // Orden estable: el índice de llegada solo estabiliza el algoritmo; el empate exacto se rechaza abajo.
    const ordenados = [...grupo].sort((a, b) => compararClaveIdentidad(a.candidato.clave, b.candidato.clave) || a.indice - b.indice);
    for (let i = 1; i < ordenados.length; i++) {
      if (mismaClave(ordenados[i - 1]!.candidato.clave, ordenados[i]!.candidato.clave)) {
        throw new Error(`Clave de identidad repetida en ${contador}: dos candidatos comparten (tick, fase, regionMorton, actorSlot, secuenciaLocal).`);
      }
    }
    const campo = CAMPO_POR_CONTADOR[contador];
    const base = confirmados[campo];
    if (contador === 'discovered') {
      const vistos = new Set(opciones.descubiertosPrevios ?? []);
      let nuevosAntes = 0;
      for (const { candidato, indice } of ordenados) {
        const nuevo = !vistos.has(candidato.chunkKey!);
        if (nuevo) vistos.add(candidato.chunkKey!);
        asignaciones.push({
          indice, candidato, contador,
          serial: nuevo ? base + nuevosAntes + 1 : null,
          id: null, descubrimientoNuevo: nuevo,
        });
        if (nuevo) nuevosAntes++;
      }
      contadores[campo] = base + nuevosAntes;
      continue;
    }
    // Prefix-sum por región: conteo por regionMorton, suma prefija y desplazamiento intra-región.
    let desplazamientoRegion = 0;
    let inicio = 0;
    while (inicio < ordenados.length) {
      let fin = inicio + 1;
      while (fin < ordenados.length && ordenados[fin]!.candidato.clave.regionMorton === ordenados[inicio]!.candidato.clave.regionMorton) fin++;
      for (let i = inicio; i < fin; i++) {
        const { candidato, indice } = ordenados[i]!;
        const serial = base + desplazamientoRegion + (i - inicio) + 1;
        if (!Number.isSafeInteger(serial)) throw new RangeError(`Desbordamiento de identidad en ${contador}.`);
        asignaciones.push({ indice, candidato, contador, serial, id: formatearIdIdentidad(contador, serial), descubrimientoNuevo: false });
      }
      desplazamientoRegion += fin - inicio;
      inicio = fin;
    }
    contadores[campo] = base + ordenados.length;
    if (!Number.isSafeInteger(contadores[campo])) throw new RangeError(`Desbordamiento de identidad en ${contador}.`);
  }
  const conocidos = new Set(candidatos.map(c => c?.contador));
  for (const contador of conocidos) if (!CONTADORES_IDENTIDAD.includes(contador as ContadorIdentidad)) throw new TypeError(`Contador de identidad desconocido: ${String(contador)}.`);
  return { asignaciones, contadores };
}

export interface CandidatoTransaccionEjecucion {
  clave: ClaveOrdenIdentidad;
  /** Ejecuciones de la transacción, incluida la de cierre; su bloque debe quedar contiguo. */
  cantidadEjecuciones: number;
  referencia?: string;
}

export interface AsignacionTransaccionEjecucion {
  indice: number;
  candidato: CandidatoTransaccionEjecucion;
  inicioSerial: number;
  finSerial: number;
  ids: string[];
}

/**
 * Prefix-sum cuya unidad es la TRANSACCIÓN de tecnología, no la ejecución suelta:
 * cada transacción recibe un bloque contiguo `[inicioSerial, finSerial]` y el
 * prefix-sum corre sobre `cantidadEjecuciones`, de modo que
 * `nestedExecutionIds`/`catalysts[].executionId` se renumeran dentro del bloque
 * sin romper `serial === previousSerial + 1` (ver helpers en `technology.ts`).
 */
export function asignarTransaccionesEjecucion(
  transacciones: readonly CandidatoTransaccionEjecucion[],
  executionCounterConfirmado: number,
): { asignaciones: AsignacionTransaccionEjecucion[]; executionCounter: number } {
  enteroSeguro(executionCounterConfirmado, 'executionCounter');
  const ordenadas = transacciones.map((candidato, indice) => ({ candidato, indice }));
  for (const { candidato } of ordenadas) {
    if (!candidato || typeof candidato !== 'object') throw new TypeError('Candidata de transacción mal formada.');
    validarClave(candidato.clave);
    enteroSeguro(candidato.cantidadEjecuciones, 'cantidadEjecuciones');
    if (candidato.cantidadEjecuciones < 1) throw new RangeError('Una transacción de tecnología incluye al menos su ejecución de cierre.');
  }
  ordenadas.sort((a, b) => compararClaveIdentidad(a.candidato.clave, b.candidato.clave) || a.indice - b.indice);
  for (let i = 1; i < ordenadas.length; i++) {
    if (mismaClave(ordenadas[i - 1]!.candidato.clave, ordenadas[i]!.candidato.clave)) {
      throw new Error('Clave de identidad repetida en execution: dos transacciones comparten (tick, fase, regionMorton, actorSlot, secuenciaLocal).');
    }
  }
  let prefijo = 0;
  const asignaciones = ordenadas.map(({ candidato, indice }) => {
    const inicioSerial = executionCounterConfirmado + prefijo + 1;
    const finSerial = inicioSerial + candidato.cantidadEjecuciones - 1;
    if (!Number.isSafeInteger(finSerial)) throw new RangeError('Desbordamiento de identidad en execution.');
    prefijo += candidato.cantidadEjecuciones;
    return { indice, candidato, inicioSerial, finSerial, ids: Array.from({ length: candidato.cantidadEjecuciones }, (_, n) => `process-${inicioSerial + n}`) };
  });
  return { asignaciones, executionCounter: executionCounterConfirmado + prefijo };
}
