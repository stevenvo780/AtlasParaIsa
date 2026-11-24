import type { FaseNombre, RuntimeStats } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';

const ms = (value: number): string => `${number(value, 1)} ms`;

export interface FaseMedida { clave: FaseNombre; etiqueta: string; ms: number; parte: number | null }

/** Orden de ejecución de `FaseNombre` con su nombre en claro. */
const FASES_EN_CLARO: ReadonlyArray<[FaseNombre, string]> = [
  ['maintainRegions', 'Regiones'], ['ecologia', 'Ecología'], ['kernel', 'Núcleo'], ['fauna', 'Fauna'],
  ['personas', 'Personas'], ['encuentros', 'Encuentros'], ['demografia', 'Demografía'], ['comunidades', 'Comunidades'],
  ['reproduccion', 'Reproducción'], ['checkpoint', 'Punto de control'], ['muestreo', 'Muestreo'],
  ['save', 'Guardado'], ['broadcast', 'Envío'],
];
/** Las cuatro fases que el panel técnico garantiza siempre legibles, aunque no sean las más caras. */
const FASES_PRINCIPALES: ReadonlyArray<FaseNombre> = ['ecologia', 'fauna', 'personas', 'save'];

/** Desglose medido del paso (`performance.fases`): fases válidas de la más cara a la más barata y su
 * parte sobre la suma de las fases medidas. `null` si el servidor no envió ninguna fase utilizable;
 * una fase ausente o no finita se omite, nunca se dibuja como cero inventado. */
export function fasesMedidas(runtime: RuntimeStats | null | undefined): { totalMs: number; fases: FaseMedida[] } | null {
  const bruto = (runtime as RuntimeStats | undefined)?.fases as Partial<Record<FaseNombre, unknown>> | undefined;
  if (!bruto || typeof bruto !== 'object') return null;
  const entradas: { clave: FaseNombre; etiqueta: string; ms: number }[] = [];
  for (const [clave, etiqueta] of FASES_EN_CLARO) {
    const valor = bruto[clave];
    if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) entradas.push({ clave, etiqueta, ms: valor });
  }
  if (!entradas.length) return null;
  const totalMs = entradas.reduce((suma, f) => suma + f.ms, 0);
  const fases = entradas
    .map(f => ({ ...f, parte: totalMs > 0 ? f.ms / totalMs : null }))
    .sort((a, b) => b.ms - a.ms);
  return { totalMs, fases };
}

const parteTexto = (parte: number | null): string => parte === null ? '' : ` · ${number(parte * 100)} % de las fases`;

/** Mundo › Rendimiento › «Fases del paso»: ecología, fauna, personas y guardado siempre a la vista,
 * la fase más cara nombrada y la fracción serial recibida, sin suponer nada que no viniera medido. */
export function seccionFases(runtime: RuntimeStats | null | undefined): string {
  const medida = fasesMedidas(runtime);
  if (!medida) return '<section class="stats-section" data-fases><div class="stats-section-heading"><h3>Fases del paso</h3><span>Mediciones reales</span></div><p class="stats-empty">El servidor no envió el desglose por fases con este estado.</p></section>';
  const porClave = new Map(medida.fases.map(f => [f.clave, f]));
  const filas = FASES_PRINCIPALES.flatMap(clave => {
    const f = porClave.get(clave);
    return f ? [`<span data-fase="${esc(clave)}">${esc(f.etiqueta)}<strong>${esc(ms(f.ms))}${esc(parteTexto(f.parte))}</strong></span>`] : [];
  }).join('');
  const masCara = medida.fases[0]!;
  const principalesMs = FASES_PRINCIPALES.reduce((suma, clave) => suma + (porClave.get(clave)?.ms ?? 0), 0);
  const restoMs = Math.max(0, medida.totalMs - principalesMs);
  const serial = runtime && Number.isFinite(runtime.fraccionSerial)
    ? ` Fracción serial de las fases: ${number(runtime.fraccionSerial * 100)} % (con muchos hilos, esa parte no se reparte).` : '';
  return `<section class="stats-section" data-fases><div class="stats-section-heading"><h3>Fases del paso</h3><span>${esc(ms(medida.totalMs))} en fases medidas</span></div><div class="stats-facts">${filas}</div><p class="stats-note">La fase más cara de este paso fue ${esc(masCara.etiqueta)} (${esc(ms(masCara.ms))}). El resto de fases medidas suma ${esc(ms(restoMs))}.${esc(serial)}</p></section>`;
}

/** Ritmo real del mundo frente al pedido. `objetivo` ausente: no se afirma que vaya lento. */
export function ritmo(tickHz: number | undefined, objetivo: number | undefined, ticksPorDia = 2400): { pasosPorSegundo: string; diaDura: string; lento: boolean } | null {
  if (tickHz === undefined || !Number.isFinite(tickHz) || tickHz <= 0) return null;
  const segundos = ticksPorDia / tickHz;
  const diaDura = segundos < 90 ? `${number(segundos)} s` : segundos < 5400 ? `${number(segundos / 60)} min` : `${number(segundos / 3600, 1)} h`;
  const lento = objetivo !== undefined && Number.isFinite(objetivo) && objetivo > 0 && tickHz < objetivo * 0.9;
  return { pasosPorSegundo: `${number(tickHz, 1)} pasos/s`, diaDura, lento };
}
