/**
 * M4: por qué nace (o no nace) nadie. Módulo puro: lee `performance.natalidad` (resumen del servidor
 * cada 50 pasos, con las funciones de la ley), `stats.census` y `stats.history`, y dibuja
 * una escalera causal. En la ficha, `fertil` y `busca` llegan con la ficha a demanda. Nada se supone:
 * si un dato no llegó, se dice.
 */
import type { PersonDetail, PersonView, WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';
import { sparkline } from './charts.js';
import { censoDe } from './censo-view.js';
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

type Ley = NonNullable<NonNullable<WorldView['performance']>['natalidad']>['ley'];

/** El cupo de `reproduce()` (world/index.ts) y el tope de población, con los números del mundo mostrado.
 * Con un servidor que no los informa no se afirma una ley que quizá no rija. */
export function cupoDeNacimientos(ley: Ley): string {
  const partes: string[] = [];
  if (ley.cupo !== undefined && ley.ventana !== undefined) {
    const pasos = `${number(ley.ventana)} ${ley.ventana === 1 ? 'paso' : 'pasos'}`;
    if (ley.cupo === 0) partes.push('Este mundo tiene el cupo de nacimientos en 0: nadie puede nacer.');
    // Con la comprobación continua la ventana es móvil y cuenta los vecinos nacidos en ella que siguen vivos.
    else if (ley.continua) {
      partes.push(`Hay un cupo: nace alguien solo si en los últimos ${pasos} nacieron menos de ${number(ley.cupo)} vecinos`
        + ' que siguen con vida; se comprueba en cada paso.');
    }
    else partes.push(`Hay un cupo: una vez cada ${pasos} pueden nacer hasta ${number(ley.cupo)} ${ley.cupo === 1 ? 'vida' : 'vidas'}.`);
  }
  if (ley.maxima !== undefined) partes.push(`Este mundo tiene un tope de ${number(ley.maxima)} vidas: con esa población no nace nadie.`);
  return partes.length ? ` ${partes.join(' ')}` : '';
}

/** Mundo › Vida › Nacimientos: la escalera causal, la curva y la ley en claro. */
export function seccionNacimientos(view: WorldView): string {
  const natalidad = view.performance?.natalidad, censo = censoDe(view);
  const pasos: string[] = [];
  const adultos = censo ? number(censo.lifeStage.adult) : '—';
  pasos.push(`<li data-natality-step="edad"><strong>En edad de criar: ${adultos}</strong><span>Vecinos entre la madurez y la vejez, en todo el mundo.</span></li>`);
  if (natalidad) {
    pasos.push(`<li data-natality-step="fertiles"><strong>Fértiles ahora: ${number(natalidad.fertiles)}</strong><span>Con el cuerpo listo (salud, hambre, sed, energía y descanso) y fuera del descanso tras su última cría.</span></li>`);
    pasos.push(`<li data-natality-step="intencion"><strong>Buscando a su pareja: ${number(natalidad.cortejando)} · preparando reservas: ${number(natalidad.preparando)} · reuniéndose para criar: ${number(natalidad.reuniendose)}</strong><span>Lo que hacen ahora por una posible crianza, leído de su intención.</span></li>`);
  } else pasos.push('<li data-natality-step="sin-dato"><span>El servidor todavía no envió el resumen de fertilidad.</span></li>');
  const serie = nacimientosPorIntervalo(view.stats?.history ?? []);
  const enVentana = serie.reduce((sum, point) => sum + point.value, 0);
  const ley = natalidad?.ley;
  const leyTexto = ley ? 'Para que nazca alguien hacen falta dos vecinos fértiles con un vínculo de confianza mutuo, que no sean'
    + ` parientes cercanos, a ${number(ley.radioPareja)} casillas o menos uno del otro y a ${number(ley.radioLugar)} o menos de un lugar,`
    + ` cada uno con al menos ${number(ley.reserva, 2)} de reserva de alimento${ley.exigeComunidad ? ' y con comunidad' : ''}.`
    + ' Tras criar, cada progenitor descansa un tiempo antes de poder volver a hacerlo.'
    + `${ley.radioCortejo > 0 ? ` Quien es fértil puede ir a buscar a su pareja hasta ${number(ley.radioCortejo)} casillas.` : ''}`
    + `${cupoDeNacimientos(ley)} Hambre, sed y descanso urgentes siguen pasando primero.`
    + (esMundoV23(view) ? ` ${leyPagadaTexto(ley, view)}` : '')
    : 'La ley de natalidad de este mundo no llegó con este estado.';
  return `<section class="stats-section" data-natality><div class="stats-section-heading"><h3>Nacimientos</h3><span>${natalidad ? `medido en el paso ${esc(number(natalidad.tick))}` : 'sin resumen'}</span></div><ol class="natality-ladder">${pasos.join('')}</ol>${sparkline(serie, `Nacimientos por intervalo · ${number(enVentana)} en la ventana`, 'nacimientos')}<details class="person-detail" data-detail="natality-law"><summary>La ley en claro</summary><p>${leyTexto}</p></details></section>${seccionReservaV23(view)}`;
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
    : f.bloqueo === 'pausa-manual' ? 'No: los nacimientos están en pausa por orden manual.' : 'Sin dato.';
  const busca = detail.busca ? `<p class="drawer-note" data-seeking>${detail.busca.motivo === 'cortejo' ? 'Busca a su pareja' : detail.busca.motivo === 'reunion' ? 'Va a reunirse para criar con' : 'Prepara reservas para criar con'}: ${personLink(view, detail.busca.id)}</p>` : '';
  return `<div class="skill-row" data-person-fertility="${f.ahora ? 'si' : esc(f.bloqueo ?? '')}"><span>Puede criar ahora</span><strong>${f.ahora ? 'Sí' : 'No'}</strong></div><p class="drawer-note">${esc(texto)}</p>${busca}`;
}

/* ------------------------------------------------------------------ */
/* V23 — natalidad pagada con reserva, sin cupo ni ventana              */
/* ------------------------------------------------------------------ */

/** El mundo mostrado trae cuerpos de átomos o el libro de la materia: solo entonces se afirma la natalidad pagada. */
export function esMundoV23(view: Pick<WorldView, 'people' | 'materia'>): boolean {
  return view.materia !== undefined || view.people.some(p => p.cuerpoVisto !== undefined);
}

export interface CuerposDeCriar {
  /** Personas de la vista con cuerpo de átomos (el resto no cuenta: sin dato no es cero). */
  conCuerpo: number;
  gestando: number;
  crias: number;
  /** Reserva media de los adultos con cuerpo, en [0, 1]; null si no hay ninguno. */
  reservaAdultos: number | null;
  /** Adultos con reserva por debajo de la mitad de lo que su cuerpo pide. */
  adultosConPocaReserva: number;
  adultos: number;
}

/** Lo que dicen los cuerpos de esta vista sobre quién puede pagar una gestación. */
export function cuerposDeCriar(people: readonly Pick<PersonView, 'cuerpoVisto' | 'crianza' | 'lifeStage'>[]): CuerposDeCriar {
  let conCuerpo = 0, gestando = 0, crias = 0, adultos = 0, pocaReserva = 0, suma = 0;
  for (const p of people) {
    const c = p.cuerpoVisto;
    if (!c) continue;
    conCuerpo++;
    if (c.embrion) gestando++;
    if (p.crianza) crias++;
    if (p.lifeStage === 'adult' && Number.isFinite(c.reserva)) { adultos++; suma += c.reserva; if (c.reserva < .5) pocaReserva++; }
  }
  return { conCuerpo, gestando, crias, reservaAdultos: adultos ? suma / adultos : null, adultosConPocaReserva: pocaReserva, adultos };
}

/** La ley de natalidad de un mundo V23, en claro: sin cupo ni ventana ni tope; la reserva decide. Sin esos datos de la ley
 * del servidor no se afirma nada de cupos: solo se dice que este mundo no los informa. */
export function leyPagadaTexto(ley: Ley | undefined, view: Pick<WorldView, 'people' | 'materia'>): string {
  if (!esMundoV23(view)) return '';
  const sinCupo = !ley || (ley.cupo === undefined && ley.ventana === undefined);
  const sinTope = !ley || ley.maxima === undefined;
  const partes = [sinCupo ? 'Este mundo no tiene cupo de nacimientos ni ventana entre comprobaciones' : '', sinTope ? 'ni un tope de vidas' : ''].filter(Boolean);
  const cabeza = partes.length ? `${partes.join(' ')}. ` : '';
  return `${cabeza}La fertilidad sale de la reserva: quien tiene energía almacenada para pagar la gestación puede concebir, la gestación gasta esa reserva y, si falta durante un día seguido, se aborta y la masa vuelve a quien gestaba. Con menos gente sobra alimento, las reservas suben y la fertilidad vuelve; con más, compiten y baja.`;
}

/** Mundo › Vida › Nacimientos: cuántos cuerpos de esta vista gestan, cuántas crías dependen de cuidadores y qué reserva tienen los adultos. */
export function seccionReservaV23(view: WorldView): string {
  if (!esMundoV23(view)) return '';
  const c = cuerposDeCriar(view.people);
  if (!c.conCuerpo) return '<section class="stats-section" data-natality-reserva="sin-dato"><div class="stats-section-heading"><h3>Reserva y gestación</h3><span>sin dato</span></div><p class="stats-note">Esta vista no trae cuerpos de átomos: no se puede decir quién puede pagar una gestación.</p></section>';
  const reserva = c.reservaAdultos === null ? '<em class="sin-dato">sin dato</em>' : `${number(c.reservaAdultos * 100)} %`;
  return `<section class="stats-section" data-natality-reserva="ok"><div class="stats-section-heading"><h3>Reserva y gestación</h3><span>${esc(number(c.conCuerpo))} cuerpos en esta vista</span></div><div class="stats-facts"><span data-reserva-adultos>Reserva media de los adultos<strong>${reserva}</strong></span><span data-reserva-pocos>Adultos con menos de la mitad<strong>${esc(number(c.adultosConPocaReserva))} de ${esc(number(c.adultos))}</strong></span><span data-gestando>Gestando ahora<strong>${esc(number(c.gestando))}</strong></span><span data-crias>Crías con cuidadores<strong>${esc(number(c.crias))}</strong></span></div><p class="stats-note">Solo cuenta a las personas de la cámara con dato de cuerpo; el resto del mundo no se supone.</p></section>`;
}
