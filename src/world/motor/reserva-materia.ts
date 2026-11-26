import { LOTES_POR_BLOQUE } from '../materia/arena.js';
import { PageArena } from '../soa/arena.js';

export const RESERVA_LOTES_HISTORICA = 2 ** 23;
/** Reserva virtual comprobada con SAB crecibles de Node en x64. Los punteros siguen cabiendo en u32. */
export const RESERVA_LOTES_MAXIMA = 2 ** 26;
export const DESBORDES_POR_LOTE = 4;

export interface ArenasMateria {
  lotes: PageArena;
  desborde: PageArena;
  contenido?: PageArena;
}

export function validarReservaLotesMateria(lotes: number): void {
  if (!Number.isSafeInteger(lotes) || lotes < RESERVA_LOTES_HISTORICA || lotes > RESERVA_LOTES_MAXIMA
    || lotes % LOTES_POR_BLOQUE !== 0) throw new RangeError('Reserva virtual de lotes de materia inválida.');
}

/** Crea los SAB sin comprometer su capacidad máxima. F0 crece las columnas cuando hacen falta. */
export function crearArenasMateria(lotes = RESERVA_LOTES_HISTORICA, separarComposicion = false): ArenasMateria {
  validarReservaLotesMateria(lotes);
  return { lotes: new PageArena(lotes), desborde: new PageArena(DESBORDES_POR_LOTE * lotes),
    ...(separarComposicion && { contenido: new PageArena(lotes) }) };
}
