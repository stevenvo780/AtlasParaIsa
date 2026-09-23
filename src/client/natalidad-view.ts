/**
 * M4: por qué nace (o no nace) nadie. Módulo puro: lee `performance.natalidad` (resumen del servidor
 * cada 50 pasos, con las funciones de la ley), `stats.census`, `stats.history` y el gobernador, y dibuja
 * una escalera causal. En la ficha, `fertil` y `busca` llegan con la ficha a demanda. Nada se supone:
 * si un dato no llegó, se dice.
 */
import type { PersonDetail, WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';
import { sparkline } from './charts.js';
import { censoDe } from './censo-view.js';
import { estadoCrecimiento } from './gobernador-view.js';
import { personLink } from './world-evidence.js';

const DIA = 2400;
const dias = (pasos: number): string => `${number(pasos / DIA, 1)} ${Math.abs(pasos / DIA - 1) < 0.05 ? 'día' : 'días'}`;

/** Nacimientos por intervalo entre muestras (el historial trae el acumulado `births`). */
export function nacimientosPorIntervalo(history: { tick: number; births: number }[]): { tick: number; value: number }[] {
  const out: { tick: number; value: number }[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1]!, b = history[i]!;
    if (!Number.isFinite(a.births) || !Number.isFinite(b.births)) continue;
    out.push({ tick: b.tick, value: Math.max(0, b.births - a.births) });
  }
  return out;
}

/** Mundo › Vida › Nacimientos: la escalera causal, la curva y la ley en claro. */
export function seccionNacimientos(view: WorldView): string {
  const natalidad = view.performance?.natalidad, censo = censoDe(view);
  const growth = estadoCrecimiento(view.performance?.gobernador, view.stats?.population);
  const pasos: string[] = [];
  if (growth && growth.estado !== 'libre') {
    const bloqueado = growth.estado === 'en-techo' || growth.estado === 'apagado' || (growth.estado === 'manual' && view.performance?.gobernador?.activo === false);
    pasos.push(`<li data-natality-step="gobernador" class="${bloqueado ? 'is-blocked' : ''}"><strong>${esc(growth.titulo)}</strong><span>${bloqueado
      ? 'Con los nacimientos detenidos nadie corteja ni prepara una crianza: la ley solo lo intenta cuando nacer está permitido.'
      : growth.estado === 'reponiendo' ? 'Pueden nacer vidas para reponer a quien murió, sin superar el techo.' : esc(growth.explicacion)}</span></li>`);
  }
  const adultos = censo ? number(censo.lifeStage.adult) : '—';
  pasos.push(`<li data-natality-step="edad"><strong>En edad de criar: ${adultos}</strong><span>Vecinos entre la madurez y la vejez, en todo el mundo.</span></li>`);
  if (natalidad) {
    pasos.push(`<li data-natality-step="fertiles"><strong>Fértiles ahora: ${number(natalidad.fertiles)}</strong><span>Con el cuerpo listo (salud, hambre, sed, energía y descanso) y fuera del descanso tras su última cría.</span></li>`);
    pasos.push(`<li data-natality-step="intencion"><strong>Buscando a su pareja: ${number(natalidad.cortejando)} · preparando reservas: ${number(natalidad.preparando)} · reuniéndose para criar: ${number(natalidad.reuniendose)}</strong><span>Lo que hacen ahora por una posible crianza, leído de su intención.</span></li>`);
  } else pasos.push('<li data-natality-step="sin-dato"><span>El servidor todavía no envió el resumen de fertilidad.</span></li>');
  const serie = nacimientosPorIntervalo(view.stats?.history ?? []);
  const enVentana = serie.reduce((sum, point) => sum + point.value, 0);
  const ley = natalidad?.ley;
  const leyTexto = ley ? `Para que nazca alguien hacen falta dos vecinos fértiles con un vínculo de confianza mutuo, que no sean parientes cercanos, a ${number(ley.radioPareja)} casillas o menos uno del otro y a ${number(ley.radioLugar)} o menos de un lugar, cada uno con al menos ${number(ley.reserva, 2)} de reserva de alimento${ley.exigeComunidad ? ' y con comunidad' : ''}. Tras criar, cada progenitor descansa un tiempo antes de poder volver a hacerlo.${ley.radioCortejo > 0 ? ` Quien es fértil puede ir a buscar a su pareja hasta ${number(ley.radioCortejo)} casillas.` : ''} Hambre, sed y descanso urgentes siguen pasando primero.` : 'La ley de natalidad de este mundo no llegó con este estado.';
  return `<section class="stats-section" data-natality><div class="stats-section-heading"><h3>Nacimientos</h3><span>${natalidad ? `medido en el paso ${esc(number(natalidad.tick))}` : 'sin resumen'}</span></div><ol class="natality-ladder">${pasos.join('')}</ol>${sparkline(serie, `Nacimientos por intervalo · ${number(enVentana)} en la ventana`, 'nacimientos')}<details class="person-detail" data-detail="natality-law"><summary>La ley en claro</summary><p>${leyTexto}</p></details></section>`;
}

/** Nota bajo «Qué están haciendo»: de los que se acercan, cuántos lo hacen por una crianza. */
export function notaAcercamientos(view: WorldView): string {
  const n = view.performance?.natalidad, total = view.stats?.actions.approach ?? 0;
  if (!n || !total) return '';
  return `<p class="stats-note" data-approach-breakdown>«Acercándose» incluye el cortejo y la crianza: en el paso ${esc(number(n.tick))}, ${number(n.cortejando)} buscaban a su pareja y ${number(n.reuniendose)} se reunían para criar; el resto se acerca por compañía, cuidado o una invitación.</p>`;
}

/** Ficha › Ahora › Salud y ciclo de vida: si puede criar ahora y, si no, por qué.
 * `detail`: null = la ficha a demanda aún no llegó; undefined = no se pidió (no se dibuja nada). */
export function fertilidadFicha(detail: Pick<PersonDetail, 'fertil' | 'busca'> | null | undefined, view: WorldView): string {
  if (detail === undefined) return '';
  if (detail === null) return '<p class="drawer-note" data-loading="fertility">Comprobando si puede criar…</p>';
  const f = detail.fertil;
  if (!f) return '';
  const texto = f.ahora ? 'Sí. Le falta una pareja fértil con vínculo mutuo, cerca y junto a un lugar.'
    : f.bloqueo === 'no-vecino' ? 'No: S e I no crían; su continuidad está protegida.'
    : f.bloqueo === 'joven' ? `No: aún joven${f.faltanPasos ? ` (madura en ${dias(f.faltanPasos)})` : ''}.`
    : f.bloqueo === 'vejez' ? 'No: en la vejez ya no cría.'
    : f.bloqueo === 'enfriamiento' ? `No: descansa tras su última cría${f.faltanPasos ? ` (faltan ${dias(f.faltanPasos)})` : ''}.`
    : f.bloqueo === 'cuerpo' ? `No: su cuerpo no está listo${f.cuerpo?.length ? ` (${f.cuerpo.join(', ')})` : ''}.`
    : f.bloqueo === 'reserva' ? `No: le falta reserva de alimento (${number(f.reserva, 2)} de ${number(f.necesita, 2)}).`
    : f.bloqueo === 'comunidad' ? 'No: este mundo exige comunidad para criar y no tiene.'
    : f.bloqueo === 'techo' ? 'No: el crecimiento está en pausa por el servidor.' : 'Sin dato.';
  const busca = detail.busca ? `<p class="drawer-note" data-seeking>${detail.busca.motivo === 'cortejo' ? 'Busca a su pareja' : detail.busca.motivo === 'reunion' ? 'Va a reunirse para criar con' : 'Prepara reservas para criar con'}: ${personLink(view, detail.busca.id)}</p>` : '';
  return `<div class="skill-row" data-person-fertility="${f.ahora ? 'si' : esc(f.bloqueo ?? '')}"><span>Puede criar ahora</span><strong>${f.ahora ? 'Sí' : 'No'}</strong></div><p class="drawer-note">${esc(texto)}</p>${busca}`;
}
