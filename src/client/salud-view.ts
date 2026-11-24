import type { Salud } from '../shared/salud.js';
import { esc, number } from './ui-catalog.js';

export type SaludVisible = Pick<Salud, 'estado' | 'tick' | 'ticksPorSegundo' | 'gpu' | 'recargas'>;

const estados: Record<Salud['estado'], string> = { ok: 'En marcha', degradado: 'Degradado', parado: 'Parado' };
const estadosGpu: Record<Salud['gpu'][number]['estado'], string> = { ok: '', cpu: ' → CPU', sin: ' no disponible' };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const noNegativo = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const entero = (value: unknown): value is number => noNegativo(value) && Number.isSafeInteger(value);

function esSaludVisible(value: unknown): value is SaludVisible {
  return record(value) && (value.estado === 'ok' || value.estado === 'degradado' || value.estado === 'parado')
    && entero(value.tick) && noNegativo(value.ticksPorSegundo) && entero(value.recargas)
    && Array.isArray(value.gpu) && value.gpu.every(gpu => record(gpu) && entero(gpu.dispositivo)
      && (gpu.estado === 'ok' || gpu.estado === 'cpu' || gpu.estado === 'sin'));
}

export async function pedirSalud(session: AbortSignal): Promise<SaludVisible> {
  const response = await fetch('/health', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([session, AbortSignal.timeout(8000)]) });
  if (!response.ok && response.status !== 503) throw new Error('Salud no disponible.');
  // /health usa 503 para «parado»; otros 503 (por ejemplo, del proxy) se tratan como falta de datos.
  const data: unknown = await response.json();
  if (!esSaludVisible(data) || (response.status === 503 && data.estado !== 'parado')) throw new Error('Salud con forma inesperada.');
  return data;
}

export function etiquetaSalud(salud: SaludVisible | null): string {
  return `Servidor · ${salud ? estados[salud.estado].toLocaleLowerCase('es') : 'sin datos'}`;
}

export function renderPanelSalud(salud: SaludVisible | null): string {
  if (!salud) return '<section class="stats-section" data-panel-salud data-estado="sin-datos"><div class="stats-section-heading"><h3>Salud del servidor</h3><span>Sin datos</span></div><p class="stats-empty">No hay una medición disponible.</p></section>';
  const gpu = salud.gpu.map(({ dispositivo, estado }) => `GPU ${number(dispositivo)}${estadosGpu[estado]}`);
  if (!salud.gpu.some(({ estado }) => estado === 'ok' || estado === 'cpu')) gpu.push('CPU');
  return `<section class="stats-section" data-panel-salud data-estado="${salud.estado}"><div class="stats-section-heading"><h3>Salud del servidor</h3><span>${estados[salud.estado]}</span></div><div class="stats-facts"><span>Paso<strong>${esc(number(salud.tick))}</strong></span><span>Pasos por segundo<strong>${esc(number(salud.ticksPorSegundo, 2))}</strong></span><span>Cómputo<strong>${esc(gpu.join(' · '))}</strong></span><span>Recargas<strong>${esc(number(salud.recargas))}</strong></span></div></section>`;
}
