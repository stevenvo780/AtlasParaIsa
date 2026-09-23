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
import type { RuntimeStats } from '../shared/types.js';
import { number } from './ui-catalog.js';

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

/** «Último frenazo», compuesto desde sus campos (coma decimal, día del mundo) y marcado vigente o retirado. */
export function ultimoFrenazo(g: Gobernador | undefined, ticksPorDia = 2400): { texto: string; vigente: boolean } | null {
  const f = g?.techoObservado;
  if (!g || !f) return null;
  const vigente = g.manual === null && (g.politica === 'apagar' ? !g.activo : (g.techo ?? null) !== null);
  const dia = Math.floor(f.tick / ticksPorDia) + 1;
  return { vigente, texto: `Día ${number(dia)} (paso ${number(f.tick)}): paso p95 ${ms(f.p95)} > ${ms(g.presupuestoMs)} con ${number(f.poblacion)} ${f.poblacion === 1 ? 'habitante' : 'habitantes'} y ${number(f.teselasActivas)} casillas activas.` };
}

/** Ritmo real del mundo frente al pedido. `objetivo` ausente: no se afirma que vaya lento. */
export function ritmo(tickHz: number | undefined, objetivo: number | undefined, ticksPorDia = 2400): { pasosPorSegundo: string; diaDura: string; lento: boolean } | null {
  if (tickHz === undefined || !Number.isFinite(tickHz) || tickHz <= 0) return null;
  const segundos = ticksPorDia / tickHz;
  const diaDura = segundos < 90 ? `${number(segundos)} s` : segundos < 5400 ? `${number(segundos / 60)} min` : `${number(segundos / 3600, 1)} h`;
  const lento = objetivo !== undefined && Number.isFinite(objetivo) && objetivo > 0 && tickHz < objetivo * 0.9;
  return { pasosPorSegundo: `${number(tickHz, 1)} pasos/s`, diaDura, lento };
}
