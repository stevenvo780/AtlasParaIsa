/**
 * Interruptores de la V23: el único sitio donde se declara qué ley o pieza nueva está encendida en un mundo.
 * Viajan como el grupo `v23` de `WorldParams` (`params.ts` solo lo enchufa), así que los instrumentos del laboratorio
 * los encienden con su `--params` de siempre (`{"v23": {"materia": true}}`) y un mundo guardado recuerda los suyos.
 *
 * Reglas (valen para todos los carriles de la oleada):
 *  - Apagado es el valor por defecto y, apagado, el mundo es el de antes paso a paso.
 *  - Ningún carril añade claves aquí ni en `params.ts`: si le falta una, la pide por escrito al integrador.
 *  - Un interruptor solo puede encenderse si lo están los que exige (`REQUIERE`): quien escribe una ley puede dar por
 *    encendidas sus exigencias y no escribe ramas para lo contrario. `parseParams` rechaza las combinaciones imposibles.
 *  - Las constantes físicas de cada ley no van aquí: cada carril las declara con nombre y unidad en su fichero y el
 *    integrador las reúne en `shared/naturaleza.ts`.
 */
export interface InterruptoresV23 {
  // ── Leyes que valen también sobre el mundo escalar de hoy ──
  /** n: cohesión que emerge (memoria del agua, hogar, buscar compañía). */
  cohesion: boolean;
  /** n: natalidad pagada, sin cupo ni ventana. Con `cuerpos` paga en átomos; sin él, sobre los escalares de hoy. */
  natalidad: boolean;
  /** s: comunidades como componentes de una red de vínculos que decaen; cada cual escribe su lado. */
  comunidades: boolean;
  // ── Materia: cada uno exige el anterior ──
  /** w: las teselas son lotes; las vistas escriben los escalares de `Tile`; comer, beber y recolectar con cuerpos aún
   * escalares van a un sumidero declarado. */
  materia: boolean;
  /** b: cuerpos de átomos para las personas (tejido, reserva, digestivo, embrión); morir deja un cadáver. */
  cuerpos: boolean;
  /** f: la fauna con el mismo cuerpo, sin especies en las reglas; miedo, habituación, caza por romper y extracción. */
  fauna: boolean;
  /** t1: procesos técnicos sobre lotes, olvido de recetas y carga por masa. */
  tecnica: boolean;
  /** t2: piezas de obra como lotes; las estructuras se degradan por química y desgaste. */
  obra: boolean;
  // ── Motor: cada uno exige el anterior ──
  /** act + m5: disciplina de dueño. A los demás se les lee por el frente y se les escribe por intento. */
  intentos: boolean;
  /** m4a: `params.motor.hilos` dueños por chunk, cada uno con su parte del mundo. */
  duenos: boolean;
  /** m7: reparto de chunks por tiempo de pared medido. */
  rebalanceo: boolean;
  /** g: `pasoLote` en la tarjeta, con caída a CPU en el mismo tick. */
  materiaGpu: boolean;
  // ── Servidor ──
  /** m6 + srv: fotograma binario escrito por los dueños; sin proyección ni clon por tick. */
  fotograma: boolean;
  /** ps: guardado completo sin reejecución, con la materia en la misma operación. */
  guardadoCompleto: boolean;
  /** w: ticks entre dos pasos materiales de una misma página (las páginas se escalonan: 1/K de ellas en cada tick). Es
   * la resolución temporal del integrador, no una ley: 1 = cada tick. Solo actúa con `materia`. */
  cadenciaMateria: number;
}

export type Interruptor = { [K in keyof InterruptoresV23]: InterruptoresV23[K] extends boolean ? K : never }[keyof InterruptoresV23];

export const INTERRUPTORES_APAGADOS: Readonly<InterruptoresV23> = Object.freeze({
  cohesion: false, natalidad: false, comunidades: false,
  materia: false, cuerpos: false, fauna: false, tecnica: false, obra: false,
  intentos: false, duenos: false, rebalanceo: false, materiaGpu: false,
  fotograma: false, guardadoCompleto: false,
  cadenciaMateria: 60,
});

export const INTERRUPTORES: readonly Interruptor[] = (Object.keys(INTERRUPTORES_APAGADOS) as (keyof InterruptoresV23)[])
  .filter((k): k is Interruptor => typeof INTERRUPTORES_APAGADOS[k] === 'boolean');

/** Qué debe estar encendido para poder encender cada uno. El orden de `ORDEN_ENCENDIDO` las respeta. */
export const REQUIERE: Readonly<Record<Interruptor, readonly Interruptor[]>> = Object.freeze({
  cohesion: [], natalidad: [], comunidades: [],
  materia: [], cuerpos: ['materia', 'natalidad'], fauna: ['cuerpos'], tecnica: ['cuerpos'], obra: ['tecnica'],
  intentos: ['cohesion', 'natalidad', 'comunidades', 'fauna', 'obra'],
  duenos: ['intentos'], rebalanceo: ['duenos'], materiaGpu: ['materia'],
  fotograma: [], guardadoCompleto: [],
});

/** Orden en que la puesta a punto enciende las leyes, de una en una y acumulando. */
export const ORDEN_ENCENDIDO: readonly Interruptor[] = [
  'guardadoCompleto', 'fotograma', 'cohesion', 'natalidad', 'comunidades',
  'materia', 'cuerpos', 'fauna', 'tecnica', 'obra', 'intentos', 'duenos', 'rebalanceo', 'materiaGpu',
];

/** Lanza si hay algún interruptor encendido sin sus exigencias. */
export function exigirCoherentes(v: Readonly<InterruptoresV23>): void {
  for (const k of INTERRUPTORES) {
    if (!v[k]) continue;
    const falta = REQUIERE[k].find(r => !v[r]);
    if (falta) throw new Error(`Interruptores incoherentes: v23.${k} exige v23.${falta}.`);
  }
}

export const todosApagados = (v: Readonly<InterruptoresV23>): boolean =>
  INTERRUPTORES.every(k => !v[k]) && v.cadenciaMateria === INTERRUPTORES_APAGADOS.cadenciaMateria;

/** Los encendidos hasta `hasta` incluido, siguiendo `ORDEN_ENCENDIDO`: el mundo de cada escalón de la puesta a punto. */
export function escalon(hasta: Interruptor): InterruptoresV23 {
  const v: InterruptoresV23 = { ...INTERRUPTORES_APAGADOS };
  for (const k of ORDEN_ENCENDIDO) { v[k] = true; if (k === hasta) break; }
  return v;
}
