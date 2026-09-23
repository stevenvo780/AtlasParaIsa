/** Piezas de dibujo compartidas por las vistas del cuaderno (tarjetas, curvas y barras). Puras: reciben
 * datos del estado y devuelven HTML escapado. Las curvas usan los pasos de las muestras del servidor. */
import { esc, number } from './ui-catalog.js';

export function statCard(label: string, value: string, note: string, accent = ''): string { return `<article class="stat-card ${accent}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`; }

/** Charts use the server's sample ticks, not evenly spaced invented timestamps. */
export function sparkline(points: { tick: number; value: number }[], title: string, unit: string, fixedRange?: [number, number]): string {
  const safe = points.filter(p => Number.isFinite(p.tick) && Number.isFinite(p.value)).slice(-96);
  if (!safe.length) return `<figure class="history-chart"><figcaption>${esc(title)}</figcaption><p class="stats-empty">Todavía no hay muestras de esta serie.</p></figure>`;
  const width = 280, height = 92, padding = 8;
  const start = safe[0]!.tick, end = safe.at(-1)!.tick;
  const minimum = fixedRange?.[0] ?? 0, maximum = fixedRange?.[1] ?? Math.max(1, ...safe.map(p => p.value)) * 1.1;
  const span = Math.max(0.0001, maximum - minimum);
  const mapped = safe.map(p => ({ x: safe.length === 1 ? width / 2 : padding + (p.tick - start) / Math.max(1, end - start) * (width - padding * 2), y: height - padding - Math.max(0, Math.min(1, (p.value - minimum) / span)) * (height - padding * 2) }));
  const coordinates = mapped.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const latest = safe.at(-1)!; const label = `${title}. ${safe.length} ${safe.length === 1 ? 'muestra' : 'muestras'}, pasos ${start} a ${end}. Último valor ${number(latest.value, 2)} ${unit}.`;
  return `<figure class="history-chart"><figcaption><span>${esc(title)}</span><strong>${esc(number(latest.value, 1))}<small>${esc(unit)}</small></strong></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><path class="chart-grid" d="M8 8H272M8 46H272M8 84H272"/><polyline class="chart-line" points="${coordinates}" fill="none"/><circle class="chart-point" cx="${mapped.at(-1)!.x.toFixed(2)}" cy="${mapped.at(-1)!.y.toFixed(2)}" r="3"/></svg><div class="chart-axis"><span>Paso ${start}</span><span>${safe.length} ${safe.length === 1 ? 'muestra' : 'muestras'}</span><span>${end}</span></div></figure>`;
}

export function distribution(data: Record<string, number> | undefined, labels: Record<string, string>, unit: string): string {
  const rows = Object.entries(data ?? {}).filter(([, value]) => Number.isFinite(value) && value >= 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<p class="stats-empty">Aún no hay datos registrados.</p>';
  const maximum = Math.max(1, ...rows.map(([, value]) => value));
  return `<div class="distribution">${rows.map(([key, value]) => `<div class="distribution-row"><div><span>${esc(labels[key] ?? key)}</span><strong>${esc(number(value, 1))}<small>${esc(unit)}</small></strong></div><span class="distribution-track" aria-hidden="true"><i style="width:${(value / maximum * 100).toFixed(2)}%"></i></span></div>`).join('')}</div>`;
}
