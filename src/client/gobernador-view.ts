/**
 * M2: el gobernador (governor.ts) frena el CRECIMIENTO cuando el servidor va lento. Este módulo puro
 * traduce `performance.gobernador` a un estado legible, con la misma semántica que `decidirConTecho` y
 * `decideReproduction`, sin inventar nada que no venga en el estado:
 * · techo: p95 > presupuesto fija el techo en la población de ese momento; solo nace alguien mientras la
 *   población esté por debajo del techo (reponer, no crecer). Bajo el 70 % del presupuesto se retira;
 *   en la banda muerta [70 %, 100 %] se conserva; nunca baja.
 * · apagar: por encima del presupuesto no nace nadie; bajo el 70 % vuelve a permitirse.
 * · manual: una orden humana manda sobre el gobernador.
 */
import type { FaseNombre, RuntimeStats, WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';

export type Gobernador = NonNullable<RuntimeStats['gobernador']>;
export type EstadoCrecimiento = 'libre' | 'reponiendo' | 'en-techo' | 'apagado' | 'manual';

export interface Crecimiento {
  estado: EstadoCrecimiento;
  /** Frase corta para el chip del HUD; null cuando el crecimiento está libre. */
  chip: string | null;
  /** Título legible del estado («Crecimiento en pausa», «Crecimiento libre»…). */
  titulo: string;
  /** La causa y lo que implica, sin repetir el título. */
  explicacion: string;
  /** `${titulo}: ${explicacion}` para lectores de pantalla y el título del chip. */
  detalle: string;
  /** Umbral por debajo del cual el freno se retira (70 % del presupuesto). */
  retiroMs: number;
}
const estado = (estado: EstadoCrecimiento, chip: string | null, titulo: string, explicacion: string, retiroMs: number): Crecimiento =>
  ({ estado, chip, titulo, explicacion, detalle: `${titulo}: ${explicacion.charAt(0).toLocaleLowerCase('es')}${explicacion.slice(1)}`, retiroMs });

const ms = (value: number): string => `${number(value, 1)} ms`;

/** Estado del crecimiento de la población según el gobernador. `null` si el servidor no lo informó. */
export function estadoCrecimiento(g: Gobernador | undefined, poblacion: number | undefined): Crecimiento | null {
  if (!g || !Number.isFinite(g.presupuestoMs) || !Number.isFinite(g.p95StepMs)) return null;
  const retiroMs = g.presupuestoMs * 0.7;
  const lento = g.p95StepMs > g.presupuestoMs;
  const causa = lento
    ? `el servidor va lento (paso p95 ${ms(g.p95StepMs)} > ${ms(g.presupuestoMs)} de presupuesto)`
    : `el paso sigue cerca del límite (p95 ${ms(g.p95StepMs)}; el freno se retira por debajo de ${ms(retiroMs)})`;
  if (g.manual !== null && g.manual !== undefined) {
    return g.manual
      ? estado('manual', 'Nacimientos por orden manual', 'Nacimientos por orden manual', 'Una orden humana permite los nacimientos; el gobernador mide el paso pero no decide.', retiroMs)
      : estado('manual', 'Nacimientos detenidos a mano', 'Nacimientos detenidos a mano', 'Una orden humana detuvo los nacimientos; el gobernador mide el paso pero no decide.', retiroMs);
  }
  if (g.politica === 'apagar') {
    return g.activo
      ? estado('libre', null, 'Crecimiento libre', `El paso p95 (${ms(g.p95StepMs)}) cabe en el presupuesto de ${ms(g.presupuestoMs)}.`, retiroMs)
      : estado('apagado', 'Nacimientos en pausa', 'Nacimientos en pausa', `${mayuscula(causa)}. Vuelven cuando el paso p95 baje de ${ms(retiroMs)}.`, retiroMs);
  }
  // Política techo (la de hoy) o un servidor que no la nombra y publica techo.
  const techo = g.techo ?? null;
  if (techo === null) {
    return estado('libre', null, 'Crecimiento libre', `Sin techo de población: el paso p95 (${ms(g.p95StepMs)}) cabe en el presupuesto de ${ms(g.presupuestoMs)}.`, retiroMs);
  }
  if (poblacion !== undefined && Number.isFinite(poblacion) && poblacion < techo) {
    return estado('reponiendo', `Reponiendo ${number(poblacion)} de ${number(techo)}`, `Reponiendo: ${number(poblacion)} de ${number(techo)} vidas`,
      `El techo se fijó porque el servidor fue lento; solo nace alguien para reponer a quien murió, sin crecer por encima de ${number(techo)}. Se retira cuando el paso p95 baje de ${ms(retiroMs)}.`, retiroMs);
  }
  return estado('en-techo', 'Crecimiento en pausa', 'Crecimiento en pausa',
    `${mayuscula(causa)}, y el mundo se queda en ${number(techo)} vidas. Solo nacerá alguien si muere otra persona. El techo se retira cuando el paso p95 baje de ${ms(retiroMs)}.`, retiroMs);
}

const mayuscula = (texto: string): string => texto.charAt(0).toLocaleUpperCase('es') + texto.slice(1);

/**
 * «Último frenazo», compuesto desde sus campos (coma decimal, día del mundo). `texto` es HISTÓRICO: la
 * población de `techoObservado` es la del último paso que entró en rojo, y el techo se fijó la primera
 * vez sin techo y nunca baja (governor.ts), así que pueden diferir. `titular` dice lo vigente con la
 * cifra del mismo campo que el chip (`gobernador.techo`), nunca con la del registro.
 */
export function ultimoFrenazo(g: Gobernador | undefined, ticksPorDia = 2400): { texto: string; vigente: boolean; titular: string } | null {
  const f = g?.techoObservado;
  if (!g || !f) return null;
  const techo = g.politica === 'apagar' ? null : g.techo ?? null;
  const vigente = g.manual === null && (g.politica === 'apagar' ? !g.activo : techo !== null);
  const dia = Math.floor(f.tick / ticksPorDia) + 1;
  const titular = !vigente ? `Día ${number(dia)}`
    : techo !== null ? `Techo vigente: ${number(techo)} ${techo === 1 ? 'vida' : 'vidas'}` : 'Nacimientos en pausa';
  const habitantes = `${number(f.poblacion)} ${f.poblacion === 1 ? 'habitante' : 'habitantes'}`;
  const medida = `paso p95 ${ms(f.p95)} > ${ms(g.presupuestoMs)} con ${habitantes} y ${number(f.teselasActivas)} casillas activas`;
  return { vigente, titular, texto: `Día ${number(dia)} (paso ${number(f.tick)}): ${medida}.` };
}

export type EstadoGobernador = 'verde' | 'amarillo' | 'rojo' | 'manual';

/** Entrada laxa del panel: acepta los campos nuevos (T165) y los de siempre, todos opcionales. */
export interface GobernadorPanelInput {
  estado?: EstadoGobernador; politica?: string; presupuestoMs?: number;
  p95Ms?: number; p95StepMs?: number; maxMs?: number; faseMax?: string; senal?: string;
  teselasActivas?: number; teselasPorHabitante?: number;
  techoPoblacion?: number | null; techo?: number | null;
  reproductionEnabled?: boolean; activo?: boolean; manual?: boolean | null;
  techoObservado?: { p95: number; maxMs?: number; poblacion: number; teselasActivas: number; teselasPorHabitante: number; senal: string; tick: number; motivo?: string } | null;
}

export interface PanelGobernador {
  estado: EstadoGobernador;
  /** «Crecimiento libre» frente a «Crecimiento en pausa» según `estadoCrecimiento`; null sin señal fiable. */
  crecimiento: EstadoCrecimiento | null;
  titulo: string;
  lineas: string[];
  texto: string;
  html: string;
  manual: boolean;
  senal: string | null;
  teselasPorHabitante: number | null;
  techoPoblacion: number | null;
  techoObservado: GobernadorPanelInput['techoObservado'];
  p95Ms: number | null;
  presupuestoMs: number | null;
  maxMs: number | null;
  faseMax: string | null;
}

const finito = (v: number | undefined | null): v is number => v !== undefined && v !== null && Number.isFinite(v);

/**
 * T165: panel del gobernador, puro y sin DOM. Acepta el gobernador suelto, el `RuntimeStats`
 * (`performance`) o el `WorldView` (`state`) entero. Muestra causas: estado, señal y margen,
 * pico de ventana, teselas por habitante y el techo observado, que se conserva aunque el
 * estado actual vuelva a verde. Si hay orden manual, lo dice explícitamente.
 */
export function formatearPanelGobernador(
  entrada: GobernadorPanelInput | RuntimeStats | Pick<WorldView, 'performance' | 'stats'> | null | undefined,
  poblacion?: number,
  teselasActivasRespaldo?: number,
): PanelGobernador | null {
  if (!entrada) return null;
  let g: GobernadorPanelInput | undefined;
  let runtime: RuntimeStats | undefined;
  let poblacionVista = poblacion;
  if ('performance' in entrada) {
    runtime = entrada.performance;
    g = runtime?.gobernador as GobernadorPanelInput | undefined;
    poblacionVista ??= entrada.stats?.population;
  } else if ('gobernador' in entrada) {
    runtime = entrada as RuntimeStats;
    g = runtime.gobernador as GobernadorPanelInput | undefined;
  } else g = entrada as GobernadorPanelInput;
  if (!g) return null;
  const presupuestoMs = finito(g.presupuestoMs) ? g.presupuestoMs : null;
  const p95Ms = finito(g.p95Ms) ? g.p95Ms : finito(g.p95StepMs) ? g.p95StepMs : finito(runtime?.p95StepMs) ? runtime!.p95StepMs : null;
  const maxMs = finito(g.maxMs) ? g.maxMs : null;
  const faseMax = g.faseMax ?? null;
  const techoObservado = g.techoObservado ?? null;
  const techoPoblacion = g.techoPoblacion !== undefined ? g.techoPoblacion : g.techo !== undefined ? g.techo : null;
  const teselasActivas = finito(g.teselasActivas) ? g.teselasActivas : finito(runtime?.activeTiles) ? runtime!.activeTiles : finito(teselasActivasRespaldo) ? teselasActivasRespaldo : null;
  const teselasPorHabitante = finito(g.teselasPorHabitante) ? g.teselasPorHabitante
    : teselasActivas !== null && poblacionVista !== undefined && poblacionVista > 0 ? teselasActivas / poblacionVista : null;
  const manual = g.estado === 'manual' || (g.manual !== null && g.manual !== undefined);
  const reproduccion = g.reproductionEnabled ?? g.activo;
  let estadoPanel: EstadoGobernador;
  if (manual) estadoPanel = 'manual';
  else if (g.estado) estadoPanel = g.estado;
  else if (p95Ms !== null && presupuestoMs !== null && presupuestoMs > 0) estadoPanel = p95Ms > presupuestoMs ? 'rojo' : p95Ms >= presupuestoMs * 0.7 ? 'amarillo' : 'verde';
  else if (techoPoblacion !== null) estadoPanel = 'amarillo';
  else estadoPanel = 'verde';
  const senal = g.senal ?? techoObservado?.senal ?? (p95Ms !== null && presupuestoMs !== null && p95Ms > presupuestoMs ? 'p95' : null);
  // V18: «Crecimiento libre» frente a «Crecimiento en pausa» con la misma regla que el chip del HUD.
  // Solo con la señal completa del cable (presupuesto, p95, activo y manual): una entrada laxa sin
  // `activo` no basta para afirmar si el hardware está frenando los nacimientos.
  const crecimientoPanel = presupuestoMs !== null && p95Ms !== null && g.activo !== undefined && g.manual !== undefined
    ? estadoCrecimiento({ activo: g.activo, presupuestoMs, p95StepMs: p95Ms, manual: g.manual,
        ...(g.politica === 'apagar' || g.politica === 'techo' ? { politica: g.politica } : {}), techo: techoPoblacion ?? null }, poblacionVista)
    : null;
  const lineas: string[] = [`Estado del gobernador: ${estadoPanel}`];
  if (crecimientoPanel) lineas.push(`Crecimiento: ${crecimientoPanel.titulo} — ${crecimientoPanel.explicacion}`);
  if (manual) lineas.push(`Gobernador en modo manual: los nacimientos ${reproduccion === false ? 'están detenidos' : reproduccion === true ? 'están permitidos' : 'quedan fijados'} por orden manual${g.reproductionEnabled !== undefined ? ' (reproductionEnabled fijado manualmente)' : ''}; el gobernador mide el paso pero no decide.`);
  if (g.politica) lineas.push(`Política del gobernador: ${g.politica}.`);
  if (p95Ms !== null && presupuestoMs !== null) {
    const margen = presupuestoMs - p95Ms;
    lineas.push(`Señal disparadora: ${senal ?? 'p95'}; paso p95 ${ms(p95Ms)} frente a ${ms(presupuestoMs)} de presupuesto (margen ${ms(margen)}).`);
  } else if (senal) lineas.push(`Señal disparadora: ${senal}.`);
  if (maxMs !== null) lineas.push(`Pico máximo de la ventana: ${ms(maxMs)}${faseMax ? ` en la fase ${faseMax}` : ''}.`);
  else if (faseMax) lineas.push(`Fase del pico máximo: ${faseMax}.`);
  if (teselasPorHabitante !== null) lineas.push(`Teselas activas por habitante: ${number(teselasPorHabitante, 2)}${teselasActivas !== null && poblacionVista !== undefined && poblacionVista > 0 ? ` (${number(teselasActivas)} teselas activas / ${number(poblacionVista)} habitantes)` : ''}.`);
  else if (poblacionVista === 0) lineas.push('Teselas activas por habitante: sin habitantes.');
  if (techoPoblacion !== null && techoPoblacion !== undefined) lineas.push(`Techo de población: ${number(techoPoblacion)} habitantes.`);
  if (techoObservado) {
    const obs = techoObservado.motivo
      ? `Techo observado: ${techoObservado.motivo}`
      : `Techo observado: frenado por ${techoObservado.senal} = ${ms(techoObservado.p95)} con ${number(techoObservado.poblacion)} habitantes y ${number(techoObservado.teselasActivas)} teselas activas (paso ${number(techoObservado.tick)}).`;
    lineas.push(obs.endsWith('.') ? obs : `${obs}.`);
    if (finito(techoObservado.teselasPorHabitante)) lineas.push(`En el último frenazo: ${number(techoObservado.teselasPorHabitante, 2)} teselas activas por habitante.`);
    if (finito(techoObservado.maxMs)) lineas.push(`Pico del último frenazo: ${ms(techoObservado.maxMs!)}.`);
  }
  const titulo = `Gobernador: ${estadoPanel}`;
  const items = lineas.map(linea => `<li>${esc(linea)}</li>`).join('');
  const html = `<section class="stats-section" data-panel-gobernador data-estado="${esc(estadoPanel)}"${manual ? ' data-manual="true"' : ''}><div class="stats-section-heading"><h3>Panel del gobernador</h3><span>${esc(titulo)}</span></div><ul class="governor-panel">${items}</ul></section>`;
  return { estado: estadoPanel, crecimiento: crecimientoPanel?.estado ?? null, titulo, lineas, texto: lineas.join(' '), html, manual, senal, teselasPorHabitante, techoPoblacion, techoObservado, p95Ms, presupuestoMs, maxMs, faseMax };
}

/** HTML del panel del gobernador; cadena vacía si el servidor no informó el gobernador. */
export function renderPanelGobernador(
  entrada: Parameters<typeof formatearPanelGobernador>[0],
  poblacion?: number,
  teselasActivasRespaldo?: number,
): string {
  return formatearPanelGobernador(entrada, poblacion, teselasActivasRespaldo)?.html ?? '';
}

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
