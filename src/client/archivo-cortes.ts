import type { WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';

interface Foco { x: number; y: number }
interface LoteCorte { id: string; sustancia: string; masaKg: number }
interface Corte { tick: number; slot: number; pavimento: number; lotes: LoteCorte[]; digest: string }
interface ArchivoCortes { version: 1; foco: Foco; cortes: [Corte, Corte]; fuenteSha256: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{64}$/i.test(value);

function validLote(value: unknown): value is LoteCorte {
  return record(value) && typeof value.id === 'string' && typeof value.sustancia === 'string' && finite(value.masaKg) && value.masaKg >= 0;
}

function validCorte(value: unknown): value is Corte {
  return record(value) && finite(value.tick) && Number.isSafeInteger(value.tick) && value.tick >= 0
    && Number.isSafeInteger(value.slot) && finite(value.pavimento) && value.pavimento >= 0
    && Array.isArray(value.lotes) && value.lotes.every(validLote) && digest(value.digest);
}

function validArchivo(value: unknown): value is ArchivoCortes {
  return record(value) && value.version === 1 && digest(value.fuenteSha256)
    && record(value.foco) && Number.isSafeInteger(value.foco.x) && Number.isSafeInteger(value.foco.y)
    && Array.isArray(value.cortes) && value.cortes.length === 2 && validCorte(value.cortes[0]) && validCorte(value.cortes[1])
    && value.cortes[0].tick < value.cortes[1].tick;
}

function validView(value: unknown, tick: number, foco: Foco): value is WorldView {
  return record(value) && value.tick === tick && Number.isSafeInteger(value.sequence) && finite(value.day)
    && finite(value.width) && value.width > 0 && finite(value.height) && value.height > 0
    && Array.isArray(value.tiles) && value.tiles.some(tile => record(tile) && tile.x === foco.x && tile.y === foco.y)
    && Array.isArray(value.people) && Array.isArray(value.places) && Array.isArray(value.events) && Array.isArray(value.memories);
}

const medida = (value: number): string => value.toLocaleString('es-CO', { maximumSignificantDigits: 9 });

function prueba(corte: Corte): string {
  const { lotes } = corte;
  const masa = lotes.reduce((total, lote) => total + lote.masaKg, 0);
  const cantidad = lotes.length === 1 ? `1 lote · ${lotes[0].sustancia}` : `${number(lotes.length)} lotes`;
  return `Pavimento ${medida(corte.pavimento)} · ${cantidad}${lotes.length ? ` · ${medida(masa)} kg` : ''}`;
}

export function mountArchiveCuts(container: HTMLElement, onCut: (view: WorldView, foco: Foco) => void, onExpired: () => void): { destroy(): void } {
  const session = new AbortController();
  const shell = container.closest<HTMLElement>('.game-shell')!;
  let request: AbortController | undefined;
  let activeTick: number | undefined;
  container.id = 'archive-cuts';
  container.setAttribute('aria-label', 'Cortes del mundo');
  container.innerHTML = `<p class="archive-cuts-heading" data-cut-heading>Cortes del mundo</p>
    <div class="archive-cuts-choices" role="group" aria-label="Saltar entre cortes" data-cut-choices hidden></div>
    <p class="archive-cuts-status" role="status" data-cut-status></p>
    <button type="button" class="dvr-speed" data-cut-retry hidden>Reintentar</button>`;
  const heading = container.querySelector<HTMLElement>('[data-cut-heading]')!;
  const choices = container.querySelector<HTMLElement>('[data-cut-choices]')!;
  const status = container.querySelector<HTMLElement>('[data-cut-status]')!;
  const retry = container.querySelector<HTMLButtonElement>('[data-cut-retry]')!;
  container.hidden = false;
  shell.classList.add('has-archive-cuts');
  const measure = (): void => shell.style.setProperty('--alto-cortes', `${container.offsetHeight}px`);
  measure();
  const resize = new ResizeObserver(measure);
  resize.observe(container);

  async function read(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status === 401 && !signal.aborted) onExpired();
    if (!response.ok) throw new Error('Corte no disponible.');
    return response.json();
  }

  async function show(corte: Corte, foco: Foco): Promise<void> {
    request?.abort();
    if (activeTick === corte.tick) {
      status.textContent = `Mostrando paso ${number(corte.tick)}.`;
      return;
    }
    const controller = new AbortController();
    request = controller;
    status.textContent = `Cargando paso ${number(corte.tick)}…`;
    try {
      const view = await read(`/api/cortes/${corte.tick}`, controller.signal);
      if (controller.signal.aborted) return;
      if (!validView(view, corte.tick, foco)) throw new Error('Corte ilegible.');
      onCut(view, foco);
      activeTick = corte.tick;
      container.dataset.activeTick = String(corte.tick);
      for (const button of choices.querySelectorAll<HTMLButtonElement>('[data-cut-tick]')) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.cutTick) === activeTick));
      }
      status.textContent = `Mostrando paso ${number(corte.tick)}.`;
    } catch {
      if (controller.signal.aborted) return;
      const active = activeTick === undefined ? '' : ` Sigue visible el paso ${number(activeTick)}.`;
      status.textContent = `No se pudo abrir el paso ${number(corte.tick)}.${active} Puedes volver a elegirlo.`;
    } finally {
      if (request === controller) request = undefined;
    }
  }

  async function load(): Promise<void> {
    retry.hidden = true;
    status.textContent = 'Cargando los cortes…';
    try {
      const data = await read('/api/cortes', session.signal);
      if (session.signal.aborted) return;
      if (!validArchivo(data)) throw new Error('Archivo de cortes ilegible.');
      heading.textContent = `Casilla observada (${data.foco.x}, ${data.foco.y}) · el pavimento ${data.cortes[1].pavimento > data.cortes[0].pavimento ? 'aumentó' : data.cortes[1].pavimento < data.cortes[0].pavimento ? 'disminuyó' : 'no cambió'} entre cortes`;
      choices.innerHTML = data.cortes.map((corte, i) => {
        const label = i === 0 ? 'Anterior' : 'Posterior';
        return `<div><button type="button" class="dvr-speed" data-cut-tick="${corte.tick}" aria-pressed="false" aria-describedby="cut-evidence-${corte.tick}">${label} · paso ${number(corte.tick)}</button>
          <p id="cut-evidence-${corte.tick}" data-cut-evidence="${corte.tick}" data-pavimento="${corte.pavimento}" data-lotes="${corte.lotes.length}">${esc(prueba(corte))}</p></div>`;
      }).join('');
      for (const [i, button] of [...choices.querySelectorAll<HTMLButtonElement>('[data-cut-tick]')].entries()) {
        button.addEventListener('click', () => void show(data.cortes[i]!, data.foco), { signal: session.signal });
      }
      choices.hidden = false;
      void show(data.cortes[0], data.foco);
    } catch {
      if (session.signal.aborted) return;
      status.textContent = 'No se pudo abrir el archivo de cortes.';
      retry.hidden = false;
    }
  }

  retry.addEventListener('click', () => void load(), { signal: session.signal });
  void load();
  return { destroy() { session.abort(); request?.abort(); resize.disconnect(); } };
}
