import { desequilibrio, repartir, type MedidaReparto } from './rebalanceo.js';

export interface CalibracionLocalidad {
  /** La cesión se paga una vez. Se amortiza sobre los pasos de esta ventana. */
  pasos: number;
  serieMs: number;
  haloMsPorExtremo: number;
  otroDominioMsPorExtremo: number;
  cesionMsPorExtremo: number;
}

export interface OpcionesLocalidad {
  /** Dominio de caché de cada dueño según la asignación que va a medir el laboratorio. */
  dominioPorHilo?: readonly number[];
  calibracion?: CalibracionLocalidad;
  presupuestoPasoMs?: number;
  pasoObservadoMs?: number;
}

type NombrePlan = 'vigente' | 'morton' | 'mortonTranspuesto';
interface PlanLocalidad {
  nombre: NombrePlan;
  dueños: Int16Array;
  cargaMsPorHilo: number[];
  cargaCriticaMs: number;
  desequilibrio: number;
  paresDeHalo: number;
  paresEntreDominios: number | null;
  chunksCedidos: number;
  haloMsPorHilo: number[] | null;
  cesionAmortizadaMsPorHilo: number[] | null;
  pasoEstimadoMs: number | null;
  holguraEstimadaMs: number | null;
}

const vecinosAdelante = [[1, 0], [0, 1], [1, 1], [-1, 1]] as const;
const clave = (x: number, y: number): string => `${x},${y}`;
const noNegativo = (n: number): boolean => Number.isFinite(n) && n >= 0;

/** Banco de planificación. Cada vecino de borde o esquina cuenta como un par potencial de halo.
 * Los coeficientes medidos se cargan a ambos extremos. La ruta crítica estimada es el mayor
 * coste de dueño más la parte serie. El resultado es una hipótesis para medir, no una lectura del motor. */
export function compararLocalidad(m: MedidaReparto, hilos: number, opciones: OpcionesLocalidad = {}) {
  const n = m.chunks.length;
  if (!Number.isInteger(hilos) || hilos < 1 || hilos > 0x8000) throw new RangeError('Número de dueños fuera de rango');
  if ([m.px, m.py, m.costeMs, m.dueno].some(columna => columna.length !== n)) throw new RangeError('Columnas de chunks desalineadas');
  const { dominioPorHilo, calibracion, presupuestoPasoMs, pasoObservadoMs } = opciones;
  if (dominioPorHilo && (dominioPorHilo.length !== hilos || !dominioPorHilo.every(d => Number.isSafeInteger(d) && d >= 0)))
    throw new RangeError('Un dominio válido por dueño');
  if (calibracion) {
    const { pasos, serieMs, haloMsPorExtremo, otroDominioMsPorExtremo, cesionMsPorExtremo } = calibracion;
    if (!Number.isSafeInteger(pasos) || pasos < 1 || ![serieMs, haloMsPorExtremo, otroDominioMsPorExtremo, cesionMsPorExtremo].every(noNegativo))
      throw new RangeError('Calibración de costes inválida');
    if (otroDominioMsPorExtremo > 0 && !dominioPorHilo) throw new RangeError('La penalización entre dominios exige su asignación');
  }
  if ([presupuestoPasoMs, pasoObservadoMs].some(ms => ms !== undefined && !noNegativo(ms))) throw new RangeError('Tiempo de paso inválido');

  const paginas = new Map<string, number>();
  let medidaTotal = 0, medidas = 0;
  for (let i = 0; i < n; i++) {
    const ubicacion = clave(m.px[i]!, m.py[i]!);
    if (paginas.has(ubicacion)) throw new RangeError(`Página repetida: ${ubicacion}`);
    paginas.set(ubicacion, i);
    const coste = m.costeMs[i]!;
    if (coste > 0 && Number.isFinite(coste)) { medidaTotal += coste; medidas++; }
  }
  const costeSuplente = medidas > 0 ? medidaTotal / medidas : 1;
  const costes = m.costeMs.map(coste => coste > 0 && Number.isFinite(coste) ? coste : costeSuplente);
  const pares: [number, number][] = [];
  for (let i = 0; i < n; i++) for (const [dx, dy] of vecinosAdelante) {
    const j = paginas.get(clave(m.px[i]! + dx, m.py[i]! + dy));
    if (j !== undefined) pares.push([i, j]);
  }

  function evaluar(nombre: NombrePlan, dueños: Int16Array): PlanLocalidad {
    const carga = new Float64Array(hilos), halo = new Uint32Array(hilos), remoto = new Uint32Array(hilos), cesiones = new Uint32Array(hilos);
    let paresDeHalo = 0, paresEntreDominios = 0, chunksCedidos = 0, cargaTotal = 0;
    for (let i = 0; i < n; i++) {
      const a = dueños[i]!, anterior = m.dueno[i]!;
      carga[a]! += costes[i]!;
      cargaTotal += costes[i]!;
      if (a === anterior || anterior < 0) continue;
      chunksCedidos++;
      cesiones[a]!++;
      if (anterior < hilos) cesiones[anterior]!++;
    }
    for (const [i, j] of pares) {
      const a = dueños[i]!, b = dueños[j]!;
      if (a === b) continue;
      paresDeHalo++;
      halo[a]!++; halo[b]!++;
      if (dominioPorHilo && dominioPorHilo[a] !== dominioPorHilo[b]) {
        paresEntreDominios++;
        remoto[a]!++; remoto[b]!++;
      }
    }
    let cargaCriticaMs = 0, criticaConCostesMs = 0;
    const haloMsPorHilo = calibracion ? new Array<number>(hilos) : null;
    const cesionAmortizadaMsPorHilo = calibracion ? new Array<number>(hilos) : null;
    for (let h = 0; h < hilos; h++) {
      cargaCriticaMs = Math.max(cargaCriticaMs, carga[h]!);
      if (calibracion && haloMsPorHilo && cesionAmortizadaMsPorHilo) {
        haloMsPorHilo[h] = halo[h]! * calibracion.haloMsPorExtremo + remoto[h]! * calibracion.otroDominioMsPorExtremo;
        cesionAmortizadaMsPorHilo[h] = cesiones[h]! * calibracion.cesionMsPorExtremo / calibracion.pasos;
        criticaConCostesMs = Math.max(criticaConCostesMs, carga[h]! + haloMsPorHilo[h]! + cesionAmortizadaMsPorHilo[h]!);
      }
    }
    const pasoEstimadoMs = calibracion ? criticaConCostesMs + calibracion.serieMs : null;
    return { nombre, dueños, cargaMsPorHilo: Array.from(carga), cargaCriticaMs,
      desequilibrio: cargaTotal ? cargaCriticaMs / (cargaTotal / hilos) : 1,
      paresDeHalo, paresEntreDominios: dominioPorHilo ? paresEntreDominios : null, chunksCedidos, haloMsPorHilo, cesionAmortizadaMsPorHilo, pasoEstimadoMs,
      holguraEstimadaMs: presupuestoPasoMs !== undefined && pasoEstimadoMs !== null ? presupuestoPasoMs - pasoEstimadoMs : null };
  }

  const planes: PlanLocalidad[] = [];
  if (m.dueno.every(d => d >= 0 && d < hilos)) planes.push(evaluar('vigente', m.dueno.slice()));
  planes.push(evaluar('morton', repartir(m, hilos)));
  planes.push(evaluar('mortonTranspuesto', repartir({ ...m, px: m.py, py: m.px }, hilos, false)));
  const comparar = (a: PlanLocalidad, b: PlanLocalidad) => (a.pasoEstimadoMs ?? a.cargaCriticaMs) - (b.pasoEstimadoMs ?? b.cargaCriticaMs)
    || (a.paresEntreDominios ?? 0) - (b.paresEntreDominios ?? 0) || a.paresDeHalo - b.paresDeHalo || a.chunksCedidos - b.chunksCedidos;
  const preferido = planes.reduce((a, b) => comparar(a, b) <= 0 ? a : b).nombre;
  return { planes, preferido, chunksMedidos: medidas, desequilibrioObservado: m.hiloMs.some(ms => ms > 0 && Number.isFinite(ms)) ? desequilibrio(m) : null,
    presupuestoPasoMs: presupuestoPasoMs ?? null, pasoObservadoMs: pasoObservadoMs ?? null,
    holguraObservadaMs: presupuestoPasoMs !== undefined && pasoObservadoMs !== undefined ? presupuestoPasoMs - pasoObservadoMs : null };
}
