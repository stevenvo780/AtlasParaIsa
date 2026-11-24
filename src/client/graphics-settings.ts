/**
 * Una carta para Isa — ajustes de gráficos, cámara y sonido (V24).
 *
 * Sustituye al interruptor rígido «Modo ligero» por tres perfiles (`ultra`, `equilibrado`, `ligero`) y
 * controles sueltos. Módulo puro: sin estado global ni DOM; el HTML se devuelve como cadena con todo
 * valor escapado y los datos guardados se sanean siempre (un `localStorage` manipulado no rompe nada).
 */
import { esc } from './ui-catalog.js';

export type GraphicsPreset = 'ultra' | 'equilibrado' | 'ligero';

export interface GraphicsSettings {
  preset: GraphicsPreset;
  /** Zoom mínimo de cámara, 4..16: cuanto menor, más lejos se puede alejar. */
  minZoom: number;
  maxDpr: 1 | 1.5 | 2;
  shadows: boolean;
  atmosphere: boolean;
  vegetationSway: boolean;
  waterRipples: boolean;
  cutaways: boolean;
  chemicalGlint: boolean;
  /** Volumen maestro del paisaje sonoro ambiental, 0..1. */
  soundVolume: number;
}

export const GRAPHICS_STORAGE_KEY = 'carta.graphics';
export const GRAPHICS_PRESETS: readonly GraphicsPreset[] = ['ultra', 'equilibrado', 'ligero'];
export const MIN_ZOOM_RANGE = { min: 4, max: 16, step: 1 } as const;
export const DPR_OPTIONS: readonly (1 | 1.5 | 2)[] = [1, 1.5, 2];

export const PRESET_SETTINGS: Record<GraphicsPreset, GraphicsSettings> = {
  ultra: { preset: 'ultra', minZoom: 4, maxDpr: 2, shadows: true, atmosphere: true, vegetationSway: true, waterRipples: true, cutaways: true, chemicalGlint: true, soundVolume: 0.6 },
  equilibrado: { preset: 'equilibrado', minZoom: 8, maxDpr: 1.5, shadows: true, atmosphere: true, vegetationSway: true, waterRipples: false, cutaways: true, chemicalGlint: false, soundVolume: 0.5 },
  ligero: { preset: 'ligero', minZoom: 12, maxDpr: 1, shadows: false, atmosphere: false, vegetationSway: false, waterRipples: false, cutaways: false, chemicalGlint: false, soundVolume: 0.3 },
};

const FLAGS = ['shadows', 'atmosphere', 'vegetationSway', 'waterRipples', 'cutaways', 'chemicalGlint'] as const;
type FlagKey = typeof FLAGS[number];

const isPreset = (value: unknown): value is GraphicsPreset => typeof value === 'string' && (GRAPHICS_PRESETS as readonly string[]).includes(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const copy = (settings: GraphicsSettings): GraphicsSettings => ({ ...settings });

/** Acepta cualquier valor y devuelve ajustes válidos: lo que falte o venga mal cae al perfil `equilibrado`. */
export function sanitizeGraphicsSettings(raw: unknown): GraphicsSettings {
  const source = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const preset = isPreset(source.preset) ? source.preset : 'equilibrado';
  const base = PRESET_SETTINGS[preset];
  const out = copy(base);
  if (typeof source.minZoom === 'number' && Number.isFinite(source.minZoom)) out.minZoom = Math.round(clamp(source.minZoom, MIN_ZOOM_RANGE.min, MIN_ZOOM_RANGE.max));
  if (typeof source.maxDpr === 'number' && Number.isFinite(source.maxDpr)) out.maxDpr = DPR_OPTIONS.reduce((best, option) => Math.abs(option - (source.maxDpr as number)) < Math.abs(best - (source.maxDpr as number)) ? option : best, DPR_OPTIONS[0]!);
  for (const key of FLAGS) if (typeof source[key] === 'boolean') out[key] = source[key] as boolean;
  if (typeof source.soundVolume === 'number' && Number.isFinite(source.soundVolume)) out.soundVolume = Math.round(clamp(source.soundVolume, 0, 1) * 100) / 100;
  return out;
}

/** Aplica un perfil completo: sustituye todos los controles salvo el volumen, que es preferencia del oyente. */
export function applyPreset(preset: GraphicsPreset, current: GraphicsSettings): GraphicsSettings {
  const next = copy(PRESET_SETTINGS[isPreset(preset) ? preset : 'equilibrado']);
  next.soundVolume = sanitizeGraphicsSettings(current).soundVolume;
  return next;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

/** Lee los ajustes guardados; sin almacenamiento o con datos corruptos devuelve el perfil `equilibrado`. */
export function loadGraphicsSettings(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): GraphicsSettings {
  try {
    const raw = storage?.getItem(GRAPHICS_STORAGE_KEY);
    return sanitizeGraphicsSettings(raw ? JSON.parse(raw) : null);
  } catch { return copy(PRESET_SETTINGS.equilibrado); }
}

/** Guarda los ajustes saneados. Devuelve `false` (sin lanzar) si el almacenamiento no está disponible. */
export function saveGraphicsSettings(storage: Pick<Storage, 'setItem'> | undefined, settings: GraphicsSettings): boolean {
  try { storage?.setItem(GRAPHICS_STORAGE_KEY, JSON.stringify(sanitizeGraphicsSettings(settings))); return storage !== undefined; } catch { return false; }
}

const PRESET_LABELS: Record<GraphicsPreset, { label: string; hint: string }> = {
  ultra: { label: 'Ultra', hint: 'Todo el detalle y la máxima resolución.' },
  equilibrado: { label: 'Equilibrado', hint: 'Buen aspecto sin exigir demasiado.' },
  ligero: { label: 'Ligero', hint: 'Para móviles y equipos lentos.' },
};

const EFFECTS: readonly { key: FlagKey; label: string; hint: string }[] = [
  { key: 'shadows', label: 'Sombras', hint: 'Sombras de árboles, edificios y habitantes.' },
  { key: 'atmosphere', label: 'Atmósfera', hint: 'Luz del día, bruma y color del cielo.' },
  { key: 'vegetationSway', label: 'Vegetación al viento', hint: 'Hierba y copas se mecen.' },
  { key: 'waterRipples', label: 'Ondas en el agua', hint: 'Ondulación de ríos y lagos.' },
  { key: 'cutaways', label: 'Cortes de edificios', hint: 'Interiores visibles al acercarte.' },
  { key: 'chemicalGlint', label: 'Brillo químico', hint: 'Destellos de reacciones y materiales.' },
];

/** Etiqueta de zoom para el deslizador: más lejos cuanto menor es el número. */
export function minZoomLabel(minZoom: number): string {
  const value = Math.round(clamp(Number.isFinite(minZoom) ? minZoom : 8, MIN_ZOOM_RANGE.min, MIN_ZOOM_RANGE.max));
  return value <= 6 ? 'Muy lejos' : value <= 10 ? 'Lejos' : value <= 13 ? 'Medio' : 'Cerca';
}

/** HTML del panel de ajustes. Todo texto dinámico pasa por `esc`; los valores numéricos se sanean antes. */
export function renderGraphicsSettingsHtml(settings: GraphicsSettings): string {
  const s = sanitizeGraphicsSettings(settings);
  const pills = GRAPHICS_PRESETS.map(id => {
    const { label, hint } = PRESET_LABELS[id];
    return `<button type="button" class="preset-pill" data-preset="${esc(id)}" aria-pressed="${s.preset === id}" title="${esc(hint)}">${esc(label)}</button>`;
  }).join('');
  const dprOptions = DPR_OPTIONS.map((option, index) => `<option value="${index}"${option === s.maxDpr ? ' selected' : ''}>${esc(option === 1 ? '1× (estándar)' : option === 1.5 ? '1,5× (nítido)' : '2× (máxima)')}</option>`).join('');
  const effects = EFFECTS.map(({ key, label, hint }) =>
    `<label class="settings-check"><input type="checkbox" data-setting="${esc(key)}"${s[key] ? ' checked' : ''}><span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span></label>`).join('');
  return `<section class="graphics-settings" aria-label="Gráficos, cámara y sonido">`
    + `<div class="settings-group"><h3>Perfil gráfico</h3><div class="preset-pills" role="group" aria-label="Perfil gráfico">${pills}</div></div>`
    + `<div class="settings-group"><h3>Cámara y resolución</h3>`
    + `<label class="settings-range" for="setting-min-zoom"><span>Alejamiento máx. de cámara</span><output id="setting-min-zoom-out" for="setting-min-zoom">${esc(minZoomLabel(s.minZoom))}</output></label>`
    + `<input id="setting-min-zoom" type="range" data-setting="minZoom" min="${MIN_ZOOM_RANGE.min}" max="${MIN_ZOOM_RANGE.max}" step="${MIN_ZOOM_RANGE.step}" value="${s.minZoom}"><p class="settings-hint">Menos es más lejos: ves más mundo a la vez.</p>`
    + `<label class="settings-range" for="setting-max-dpr"><span>Resolución (DPR)</span></label>`
    + `<select id="setting-max-dpr" data-setting="maxDpr">${dprOptions}</select></div>`
    + `<div class="settings-group"><h3>Efectos visuales</h3>${effects}</div>`
    + `<div class="settings-group"><h3>Sonido</h3>`
    + `<label class="settings-range" for="setting-sound-volume"><span>Volumen ambiental</span><output id="setting-sound-volume-out" for="setting-sound-volume">${esc(Math.round(s.soundVolume * 100))} %</output></label>`
    + `<input id="setting-sound-volume" type="range" data-setting="soundVolume" min="0" max="1" step="0.05" value="${s.soundVolume}"></div>`
    + `</section>`;
}
