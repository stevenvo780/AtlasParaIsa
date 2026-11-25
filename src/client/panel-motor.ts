/**
 * Panel «Motor» y luz del motor en el indicador de salud (V23, carril V1).
 *
 * La fuente es `TelemetriaMotor` (world/motor/contratos.ts), que el servidor sirve en `RUTA_MOTOR`. Mientras esa ruta no
 * exista, el panel dibuja lo que ya llega: el ritmo y las fases del paso (`WorldView.performance`) y las tarjetas y
 * recargas de `/health`. Lo que ninguna de las dos fuentes trae se dice «sin dato»; nunca se dibuja como cero.
 */
import type { TelemetriaMotor } from '../world/motor/contratos.js';
import type { RuntimeStats } from '../shared/types.js';
import type { SaludVisible } from './salud-view.js';
import { fasesMedidas } from './rendimiento-view.js';
import { esc, number } from './ui-catalog.js';

export const RUTA_MOTOR = '/api/motor';
const TICKS_POR_DIA = 2400;

/** `TelemetriaMotor` tal como cruza en JSON: la ocupación por hilo llega como lista. */
export type TelemetriaRecibida = Omit<TelemetriaMotor, 'ocupacion'> & { ocupacion: number[] };

const finito = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const noNegativo = (v: unknown): v is number => finito(v) && v >= 0;
const listaDe = <T>(v: unknown, es: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(es);
const estadoTarjeta = (v: unknown): v is 'ok' | 'cpu' | 'sin' => v === 'ok' || v === 'cpu' || v === 'sin';
const FASES_MOTOR = [['F0', 'Coordinación'], ['eco', 'Ecología'], ['percibir', 'Percibir'], ['actuar', 'Actuar'], ['aplicar', 'Aplicar']] as const;

/** Acepta solo una telemetría completa y coherente (una tarjeta por posición en las tres listas). */
export function leerTelemetria(data: unknown): TelemetriaRecibida | null {
  if (typeof data !== 'object' || data === null) return null;
  const t = data as Record<string, unknown>;
  const fases = t.faseMs as Record<string, unknown> | undefined;
  const escalares = ['tick', 'hz', 'diasPorMinuto', 'hilos', 'desequilibrio', 'esperaBarreraMs', 'intentos', 'rechazados', 'migraciones', 'fotogramasSaltados'];
  if (!escalares.every(k => noNegativo(t[k]))) return null;
  if (typeof fases !== 'object' || fases === null || !FASES_MOTOR.every(([k]) => noNegativo(fases[k]))) return null;
  if (!listaDe(t.ocupacion, noNegativo) || !listaDe(t.gpuMs, noNegativo) || !listaDe(t.gpuBytes, noNegativo) || !listaDe(t.gpuEstado, estadoTarjeta)) return null;
  if (t.gpuMs.length !== t.gpuEstado.length || t.gpuBytes.length !== t.gpuEstado.length) return null;
  return data as TelemetriaRecibida;
}

export interface FaseMotor { clave: string; etiqueta: string; ms: number }
export interface TarjetaMotor { dispositivo: number; estado: 'ok' | 'cpu' | 'sin'; ms: number | null; mib: number | null }

/** Lo que dibuja el panel, con `null` para «sin dato». */
export interface VistaMotor {
  fuente: 'motor' | 'paso' | 'nada';
  tick: number | null; hz: number | null; hzObjetivo: number | null; diasPorMinuto: number | null;
  /** Pasos entre lo que se mira en la cinta y el presente del mundo; null fuera de la cinta. */
  retraso: number | null;
  hilos: number | null; ocupacion: number[] | null; ocupacionMedia: number | null; desequilibrio: number | null; esperaBarreraMs: number | null;
  fases: FaseMotor[];
  tarjetas: TarjetaMotor[];
  intentos: number | null; rechazados: number | null; migraciones: number | null; saltados: number | null;
  recargas: number | null; servidor: SaludVisible['estado'] | null;
}

export function vistaMotor(t: TelemetriaRecibida | null, salud: SaludVisible | null, paso: RuntimeStats | undefined, retraso: number | null = null): VistaMotor {
  const servidor = salud?.estado ?? null, recargas = salud?.recargas ?? null;
  if (t) {
    const media = t.ocupacion.length ? t.ocupacion.reduce((a, b) => a + b, 0) / t.ocupacion.length : null;
    return {
      fuente: 'motor', tick: t.tick, hz: t.hz, hzObjetivo: finito(paso?.tickHzObjetivo) ? paso.tickHzObjetivo : null, diasPorMinuto: t.diasPorMinuto, retraso,
      hilos: t.hilos, ocupacion: t.ocupacion, ocupacionMedia: media, desequilibrio: t.desequilibrio, esperaBarreraMs: t.esperaBarreraMs,
      fases: FASES_MOTOR.map(([clave, etiqueta]) => ({ clave, etiqueta, ms: t.faseMs[clave] })),
      // `gpuEstado` sigue el orden de `MotorConfig.gpu`; /health nombra cada tarjeta por su índice CUDA en ese mismo orden.
      tarjetas: t.gpuEstado.map((estado, i) => ({ dispositivo: salud?.gpu.length === t.gpuEstado.length ? salud.gpu[i]!.dispositivo : i, estado, ms: t.gpuMs[i]!, mib: t.gpuBytes[i]! / 1048576 })),
      intentos: t.intentos, rechazados: t.rechazados, migraciones: t.migraciones, saltados: t.fotogramasSaltados, recargas, servidor,
    };
  }
  if (!paso && !salud) return { fuente: 'nada', tick: null, hz: null, hzObjetivo: null, diasPorMinuto: null, retraso, hilos: null, ocupacion: null, ocupacionMedia: null, desequilibrio: null, esperaBarreraMs: null, fases: [], tarjetas: [], intentos: null, rechazados: null, migraciones: null, saltados: null, recargas, servidor };
  const hz = finito(paso?.tickHz) ? paso.tickHz : salud ? salud.ticksPorSegundo : null;
  return {
    fuente: 'paso', tick: salud?.tick ?? null, hz, hzObjetivo: finito(paso?.tickHzObjetivo) ? paso.tickHzObjetivo : null,
    diasPorMinuto: hz === null ? null : hz * 60 / TICKS_POR_DIA, retraso,
    hilos: null, ocupacion: null, ocupacionMedia: finito(paso?.ocupacionWorkers) ? paso.ocupacionWorkers : null, desequilibrio: null,
    esperaBarreraMs: finito(paso?.tiempoBarreraMs) ? paso.tiempoBarreraMs : null,
    fases: fasesMedidas(paso)?.fases.map(f => ({ clave: f.clave, etiqueta: f.etiqueta, ms: f.ms })) ?? [],
    tarjetas: (salud?.gpu ?? []).map(g => ({ dispositivo: g.dispositivo, estado: g.estado, ms: null, mib: null })),
    intentos: null, rechazados: null, migraciones: null, saltados: null, recargas, servidor,
  };
}

export type EstadoSalud = 'sano' | 'atencion' | 'grave' | 'sin-dato';
export interface LuzSalud { estado: EstadoSalud; valor: string; motivo: string }

/** Luz del motor: grave si el servidor se paró o no avanza; atención si se degradó, una tarjeta cayó a CPU, saltó
 * fotogramas desde la lectura anterior o va por debajo del ritmo pedido. */
export function luzMotor(v: VistaMotor, saltadosAntes: number | null = null): LuzSalud {
  if (v.fuente === 'nada' || v.hz === null) return { estado: 'sin-dato', valor: 'sin dato', motivo: 'Sin medidas del motor todavía.' };
  const valor = `${number(v.hz, v.hz < 10 ? 1 : 0)} Hz`;
  if (v.servidor === 'parado' || v.hz === 0) return { estado: 'grave', valor, motivo: v.servidor === 'parado' ? 'El servidor está parado.' : 'El mundo no avanza.' };
  const avisos: string[] = [];
  if (v.servidor === 'degradado') avisos.push('el servidor está degradado');
  const enCpu = v.tarjetas.filter(t => t.estado === 'cpu').length;
  if (enCpu) avisos.push(`${number(enCpu)} ${enCpu === 1 ? 'tarjeta cayó' : 'tarjetas cayeron'} a CPU`);
  if (v.saltados !== null && saltadosAntes !== null && v.saltados > saltadosAntes) avisos.push(`saltó ${number(v.saltados - saltadosAntes)} fotogramas desde la última lectura`);
  if (v.hzObjetivo !== null && v.hz < v.hzObjetivo * .9) avisos.push(`va a ${valor} de ${number(v.hzObjetivo, 1)} Hz pedidos`);
  const dias = v.diasPorMinuto === null ? '' : ` Un minuto real son ${number(v.diasPorMinuto, 2)} días del mundo.`;
  return avisos.length ? { estado: 'atencion', valor, motivo: `Atención: ${avisos.join('; ')}.${dias}` } : { estado: 'sano', valor, motivo: `Motor sano.${dias}` };
}

const sinDato = '<em class="sin-dato">sin dato</em>';
const cifra = (v: number | null, digits = 0, unidad = ''): string => v === null ? sinDato : esc(`${number(v, digits)}${unidad}`);
/** 8 escalones: la barra de cada hilo es una pila de píxeles, y una lectura que apenas cambia no rehace el HTML. */
const escalon = (o: number): number => Math.round(Math.max(0, Math.min(1, o)) * 8);
const COLORES_FASE = ['#486750', '#b07a3c', '#5f8fa3', '#a5584a', '#8c8a4a', '#6f5f8f', '#4f7f6a', '#c29a4b', '#7c6a58', '#3f6f8a', '#9a6b7c', '#6c7d45', '#8a5a3c'];

function cabecera(v: VistaMotor): string {
  const fuente = v.fuente === 'motor' ? 'Telemetría del motor' : v.fuente === 'paso' ? 'Medidas del paso y del servidor' : 'Sin medidas';
  return `<div class="stats-section-heading"><h3>Motor</h3><span>${esc(fuente)}${v.tick === null ? '' : ` · paso ${esc(number(v.tick))}`}</span></div>`;
}

function ritmo(v: VistaMotor): string {
  const retraso = v.retraso === null ? '<span>Lo que miras<strong>en vivo</strong></span>'
    : `<span data-motor-retraso>Lo que miras<strong>${v.retraso <= 0 ? 'en el presente' : esc(`${number(v.retraso / TICKS_POR_DIA, 2)} días atrás`)}</strong></span>`;
  return `<div class="motor-ritmo telemetry-facts"><span data-motor-hz>Pasos por segundo<strong>${cifra(v.hz, 1)}</strong></span><span data-motor-dias>Días del mundo por minuto<strong>${cifra(v.diasPorMinuto, 2)}</strong></span>${retraso}</div>`;
}

function hilos(v: VistaMotor): string {
  if (!v.ocupacion?.length) {
    return `<div class="motor-bloque" data-motor-hilos="media"><h4 class="detail-subtitle">Hilos</h4><p class="stats-note">${v.ocupacionMedia === null ? `Ocupación por hilo ${sinDato}: el servidor aún no publica la telemetría del motor.` : `Ocupación media de los hilos de trabajo: <strong>${esc(number(v.ocupacionMedia * 100))} %</strong>. El reparto por hilo llega con la telemetría del motor.`}${v.esperaBarreraMs === null ? '' : ` Espera de barrera: ${esc(number(v.esperaBarreraMs, 2))} ms.`}</p></div>`;
  }
  const ocupacion = v.ocupacion, media = v.ocupacionMedia ?? 0;
  const min = ocupacion.reduce((a, b) => Math.min(a, b), Infinity), max = ocupacion.reduce((a, b) => Math.max(a, b), -Infinity);
  const barras = ocupacion.map((o, i) => `<span class="motor-hilo" style="--o:${escalon(o)}" title="Hilo ${i} · ${esc(number(o * 100))} %"></span>`).join('');
  return `<div class="motor-bloque" data-motor-hilos="${ocupacion.length}"><h4 class="detail-subtitle">${esc(number(v.hilos ?? ocupacion.length))} hilos</h4><div class="motor-hilos" role="img" aria-label="${esc(`Ocupación de ${ocupacion.length} hilos: media ${number(media * 100)} %, de ${number(min * 100)} a ${number(max * 100)} %`)}">${barras}</div><p class="stats-note">Media ${esc(number(media * 100))} % · de ${esc(number(min * 100))} a ${esc(number(max * 100))} % · desequilibrio ${cifra(v.desequilibrio, 2)} · espera de barrera ${cifra(v.esperaBarreraMs, 2, ' ms')}.</p></div>`;
}

function fases(v: VistaMotor): string {
  const total = v.fases.reduce((a, f) => a + f.ms, 0);
  if (!v.fases.length) return `<div class="motor-bloque" data-motor-fases="0"><h4 class="detail-subtitle">Coste por fase</h4><p class="stats-note">Desglose por fase ${sinDato}.</p></div>`;
  const parte = (ms: number): number => total > 0 ? ms / total : 0;
  const barra = v.fases.map((f, i) => `<span style="flex:${parte(f.ms).toFixed(4)} 1 0;background:${COLORES_FASE[i % COLORES_FASE.length]}" title="${esc(`${f.etiqueta} · ${number(f.ms, 2)} ms`)}"></span>`).join('');
  const filas = v.fases.map((f, i) => `<li data-fase="${esc(f.clave)}"><i style="background:${COLORES_FASE[i % COLORES_FASE.length]}" aria-hidden="true"></i>${esc(f.etiqueta)}<strong>${esc(number(f.ms, 2))} ms</strong><small>${esc(number(parte(f.ms) * 100))} %</small></li>`).join('');
  return `<div class="motor-bloque" data-motor-fases="${v.fases.length}"><h4 class="detail-subtitle">Coste por fase · ${esc(number(total, 2))} ms</h4><div class="motor-fases-barra" role="img" aria-label="${esc(v.fases.map(f => `${f.etiqueta} ${number(parte(f.ms) * 100)} %`).join(' · '))}">${barra}</div><ul class="motor-fases">${filas}</ul></div>`;
}

const estadosTarjeta: Record<TarjetaMotor['estado'], string> = { ok: 'Activa', cpu: 'Caída a CPU', sin: 'No disponible' };
function tarjetas(v: VistaMotor): string {
  if (!v.tarjetas.length) return `<div class="motor-bloque" data-motor-tarjetas="0"><h4 class="detail-subtitle">Tarjetas</h4><p class="stats-note">${v.fuente === 'nada' ? `Tarjetas ${sinDato}.` : 'Sin tarjetas gráficas: todo el cómputo va en CPU.'}</p></div>`;
  const filas = v.tarjetas.map(t => `<article class="motor-tarjeta" data-estado="${t.estado}"><strong>GPU ${esc(number(t.dispositivo))}</strong><span class="detail-badge">${esc(estadosTarjeta[t.estado])}</span><small>${t.ms === null ? `tiempo ${sinDato}` : esc(`${number(t.ms, 2)} ms por paso`)} · ${t.mib === null ? `memoria ${sinDato}` : esc(`${number(t.mib, 1)} MiB`)}</small></article>`).join('');
  return `<div class="motor-bloque" data-motor-tarjetas="${v.tarjetas.length}"><h4 class="detail-subtitle">Tarjetas</h4><div class="motor-tarjetas">${filas}</div></div>`;
}

function trafico(v: VistaMotor): string {
  const rechazo = v.intentos && v.rechazados !== null ? ` <small>(${esc(number(v.rechazados / v.intentos * 100, 1))} %)</small>` : '';
  const enCpu = v.tarjetas.filter(t => t.estado === 'cpu').length;
  return `<div class="motor-bloque" data-motor-trafico><h4 class="detail-subtitle">Colas y fallos recuperados</h4><div class="telemetry-facts">`
    + `<span data-motor-colas>Colas del buzón (M, A, B, F0)<strong>${sinDato}</strong></span>`
    + `<span>Intentos entre dueños<strong>${cifra(v.intentos)}</strong></span><span>Rechazados<strong>${cifra(v.rechazados)}${rechazo}</strong></span>`
    + `<span>Migraciones<strong>${cifra(v.migraciones)}</strong></span><span data-motor-saltados>Fotogramas saltados<strong>${cifra(v.saltados)}</strong></span>`
    + `<span data-motor-recargas>Recargas tras un fallo del paso<strong>${cifra(v.recargas)}</strong></span><span>Tarjetas en respaldo de CPU<strong>${v.tarjetas.length ? esc(number(enCpu)) : sinDato}</strong></span>`
    + '</div><p class="stats-note">Un fallo de tarjeta se recalcula en CPU en el mismo paso; un fallo del paso recarga el último guardado y el mundo sigue.</p></div>';
}

export function renderPanelMotor(v: VistaMotor, luz: LuzSalud): string {
  return `<section class="stats-section motor-panel" data-panel-motor data-fuente="${v.fuente}" data-estado="${luz.estado}">${cabecera(v)}<p class="motor-luz" data-estado="${luz.estado}">${esc(luz.motivo)}</p>${ritmo(v)}${hilos(v)}${fases(v)}${tarjetas(v)}${trafico(v)}</section>`;
}

/** Firma de lo que se ve, redondeado como se dibuja: el ruido de una lectura a otra no rehace el panel. */
export function firmaMotor(v: VistaMotor, luz: LuzSalud): string {
  const como = (x: number | null, escala: number): number | null => x === null ? null : Math.round(x * escala);
  return JSON.stringify([v.fuente, v.tick, como(v.hz, 10), como(v.diasPorMinuto, 100), v.retraso, v.hilos, v.ocupacion?.map(escalon), como(v.ocupacionMedia, 100), como(v.desequilibrio, 100), como(v.esperaBarreraMs, 100),
    v.fases.map(f => [f.clave, Math.round(f.ms * 100)]), v.tarjetas.map(t => [t.dispositivo, t.estado, como(t.ms, 100), como(t.mib, 10)]), v.intentos, v.rechazados, v.migraciones, v.saltados, v.recargas, v.servidor, luz.estado, luz.motivo]);
}

/** Lectura de `RUTA_MOTOR`: 404 significa que este servidor aún no la sirve (no es un fallo que reintentar). */
export async function pedirTelemetria(session: AbortSignal): Promise<TelemetriaRecibida | 'sin-ruta'> {
  const response = await fetch(RUTA_MOTOR, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([session, AbortSignal.timeout(8000)]) });
  if (response.status === 404) return 'sin-ruta';
  if (!response.ok) throw new Error('Telemetría del motor no disponible.');
  const t = leerTelemetria(await response.json());
  if (!t) throw new Error('Telemetría del motor con forma inesperada.');
  return t;
}
