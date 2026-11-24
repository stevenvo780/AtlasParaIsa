/**
 * V23 — 100% Client-Side Procedural Spatial Ambient Soundscape (Web Audio API).
 * Follows the camera viewport & zoom to synthesize live environmental beds
 * (wind/forest, water/shore, rain, day/night chorus, hearth/kiln crackle) and
 * stereo-panned activity/wildlife foley with ZERO server load and ZERO audio asset downloads.
 */
import type { WorldView } from '../shared/types.js';

export interface SoundCamera {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom?: number;
}

export type AcousticEventKind = 'wood_stone' | 'forge' | 'farm_water' | 'wildlife' | 'social_chime';

export interface AcousticEvent {
  kind: AcousticEventKind;
  /** Stereo pan in [-0.85, 0.85] (- = left of camera center, + = right). */
  pan: number;
  /** Normalized proximity/zoom loudness in [0, 1]. */
  gain: number;
  /** Optional normalized pitch/timbre hint in [0, 1] (e.g. high Fe hardness or species pitch). */
  pitchHint: number;
}

export interface AcousticScene {
  wind: number;
  water: number;
  rain: number;
  night: number;
  hearth: number;
  settlement: number;
  zoomFactor: number;
  events: AcousticEvent[];
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

function resolveCamera(world: WorldView, camera?: SoundCamera): { cx: number; cy: number; halfW: number; halfH: number; zoom: number } {
  const validCam = camera && [camera.x, camera.y, camera.width, camera.height].every(Number.isFinite) && camera.width > 0 && camera.height > 0;
  const x = validCam ? camera.x : (Number.isFinite(world.originX) ? world.originX! : 0);
  const y = validCam ? camera.y : (Number.isFinite(world.originY) ? world.originY! : 0);
  const w = validCam ? camera.width : Math.max(1, Number.isFinite(world.width) ? world.width : 32);
  const h = validCam ? camera.height : Math.max(1, Number.isFinite(world.height) ? world.height : 22);
  const zoom = validCam && Number.isFinite(camera.zoom) && camera.zoom! > 0 ? camera.zoom! : 24;
  return { cx: x + w * 0.5, cy: y + h * 0.5, halfW: Math.max(1, w * 0.5), halfH: Math.max(1, h * 0.5), zoom };
}

/** Pure deterministic acoustic analyzer over the visible camera frame (safe in Node & Browser). */
export function analyzeSoundscape(world: WorldView, camera?: SoundCamera): AcousticScene {
  const cam = resolveCamera(world, camera);
  const zoomFactor = clamp01((cam.zoom - 6) / 30); // 0 = far high-altitude, 1 = close ground level
  const altitudeWind = (1 - zoomFactor) * 0.45;

  let tileWeightSum = 0;
  let waterScore = 0;
  let forestWindScore = 0;
  const tiles = world.tiles ?? [];
  const stride = tiles.length > 900 ? Math.ceil(tiles.length / 900) : 1;

  for (let i = 0; i < tiles.length; i += stride) {
    const t = tiles[i]!;
    const dx = (t.x + 0.5 - cam.cx) / cam.halfW;
    const dy = (t.y + 0.5 - cam.cy) / cam.halfH;
    if (Math.abs(dx) > 1.15 || Math.abs(dy) > 1.15) continue;
    const prox = clamp01(1 - Math.hypot(dx, dy) * 0.72);
    const w = 0.25 + prox * 0.75;
    tileWeightSum += w;
    if (t.terrain === 'water') waterScore += w * 1.15;
    else if (t.feature === 'spring' || t.feature === 'pool' || (t.drinkingWater ?? 0) > 0.15) waterScore += w * 0.65;
    if (t.biome === 'forest' || t.biome === 'mountain' || t.biome === 'desert' || (t.wood ?? 0) > 1) {
      forestWindScore += w * (t.biome === 'mountain' ? 1.2 : 0.85);
    }
  }

  const invTiles = tileWeightSum > 0 ? 1 / tileWeightSum : 0;
  const water = clamp01(waterScore * invTiles * 1.65 * (0.45 + 0.55 * zoomFactor));
  const wind = clamp01(0.14 + forestWindScore * invTiles * 0.55 + altitudeWind + (world.weather === 'rain' ? 0.18 : 0));
  const rain = world.weather === 'rain' ? clamp01(0.55 + 0.45 * zoomFactor) : 0;
  const night = world.phase === 'night' ? 1 : world.phase === 'dusk' ? 0.55 : world.phase === 'dawn' ? 0.25 : 0;

  // Hearths, kilns & structures near camera center
  let hearthScore = 0;
  for (const s of world.structures ?? []) {
    const dx = (s.x + 0.5 - cam.cx) / cam.halfW;
    const dy = (s.y + 0.5 - cam.cy) / cam.halfH;
    if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.2) continue;
    const prox = clamp01(1 - Math.hypot(dx, dy) * 0.85);
    const hasHearth = s.components?.includes('hearth') || s.synergy?.heated;
    const kilnBoost = (s.synergy?.kilnTier ?? 0) >= 2 ? 1.6 : (s.synergy?.kilnTier ?? 0) === 1 ? 1.15 : 1;
    if (hasHearth || (s.synergy?.kilnTier ?? 0) > 0) hearthScore += prox * 0.42 * kilnBoost;
  }
  const hearth = clamp01(hearthScore * (0.25 + 0.75 * zoomFactor));

  // Visible people & spatialized activity foley
  const events: AcousticEvent[] = [];
  let visiblePeople = 0;
  const pushEvent = (kind: AcousticEventKind, x: number, y: number, baseGain: number, pitchHint: number) => {
    const dx = (x + 0.5 - cam.cx) / cam.halfW;
    const dy = (y + 0.5 - cam.cy) / cam.halfH;
    if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.2) return;
    const distAtten = clamp01(1 - Math.hypot(dx, dy) * 0.78);
    const gain = clamp01(baseGain * distAtten * (0.28 + 0.72 * zoomFactor));
    if (gain < 0.04) return;
    events.push({ kind, pan: clamp(dx * 0.85, -0.85, 0.85), gain, pitchHint: clamp01(pitchHint) });
  };

  for (const p of world.people ?? []) {
    const dx = (p.x + 0.5 - cam.cx) / cam.halfW;
    const dy = (p.y + 0.5 - cam.cy) / cam.halfH;
    if (Math.abs(dx) > 1.15 || Math.abs(dy) > 1.15) continue;
    visiblePeople++;
    if (p.action === 'gather' || p.action === 'build' || p.action === 'repair') {
      pushEvent('wood_stone', p.x, p.y, p.action === 'build' ? 0.78 : 0.62, p.action === 'repair' ? 0.7 : 0.45);
    } else if (p.action === 'craft' || p.action === 'invent' || p.action === 'research') {
      const hard = p.compounds?.reduce((m, c) => Math.max(m, c.properties.hardness), 0) ?? 0.35;
      pushEvent('forge', p.x, p.y, 0.72, hard);
    } else if (p.action === 'farm' || p.action === 'forage' || p.action === 'drink') {
      pushEvent('farm_water', p.x, p.y, 0.48, p.action === 'drink' ? 0.82 : 0.35);
    }
  }
  const settlement = clamp01((visiblePeople / 14) * (0.3 + 0.7 * zoomFactor));

  // Wildlife cues (wolves at night/dusk, grazing herds & tame animals)
  for (const a of world.animals ?? []) {
    const dx = (a.x + 0.5 - cam.cx) / cam.halfW;
    const dy = (a.y + 0.5 - cam.cy) / cam.halfH;
    if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.2) continue;
    if (a.species === 'wolf' && night >= 0.4) {
      pushEvent('wildlife', a.x, a.y, 0.75, 0.9);
    } else if ((a.habituation ?? 0) >= 0.45 || a.action === 'graze' || a.action === 'flee') {
      pushEvent('wildlife', a.x, a.y, a.action === 'flee' ? 0.55 : 0.36, (a.habituation ?? 0) >= 0.45 ? 0.25 : 0.5);
    }
  }

  // Recent poetic milestones (births, meetings, cooperation, inventions) within camera view
  const recent = (world.events ?? []).slice(-6);
  for (const ev of recent) {
    if (ev.tick < world.tick - 6) continue;
    if (ev.kind === 'birth' || ev.kind === 'invention' || ev.kind === 'cooperation' || ev.kind === 'meeting') {
      const ex = Number.isFinite(ev.x) ? ev.x! : cam.cx;
      const ey = Number.isFinite(ev.y) ? ev.y! : cam.cy;
      pushEvent('social_chime', ex, ey, ev.kind === 'birth' ? 0.85 : 0.58, ev.kind === 'birth' ? 0.8 : 0.5);
    }
  }

  // Keep at most 4 highest-priority diverse events
  events.sort((a, b) => b.gain - a.gain);
  const picked: AcousticEvent[] = [];
  const seenKinds = new Set<AcousticEventKind>();
  for (const ev of events) {
    if (picked.length >= 4) break;
    if (seenKinds.has(ev.kind) && picked.length >= 2) continue;
    seenKinds.add(ev.kind);
    picked.push(ev);
  }

  return { wind, water, rain, night, hearth, settlement, zoomFactor, events: picked };
}

export interface SpatialSoundscapeOptions {
  createContext?: () => AudioContext;
  /** Master volume scalar in [0, 1] (default 0.75, internally capped serene <= 0.18). */
  volume?: number;
}

const PENTATONIC_HZ = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];

function createNoiseBuffer(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  // Deterministic LCG noise so tests and browsers produce smooth zero-DC noise without Math.random quirks
  let s = brown ? 0x12345678 : 0x87654321;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const white = (s / 0x80000000) - 1;
    if (brown) {
      last = (last + 0.03 * white) / 1.03;
      data[i] = clamp(last * 3.2, -1, 1);
    } else {
      last = last * 0.72 + white * 0.28;
      data[i] = clamp(last * 1.4, -1, 1);
    }
  }
  return buffer;
}

/** Real-time procedural Web Audio spatial soundscape engine. */
export class SpatialSoundscape {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private beds: {
    wind: GainNode;
    water: GainNode;
    rain: GainNode;
    hearth: GainNode;
    night: GainNode;
    windFilter: BiquadFilterNode;
  } | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private _active = false;
  private _muted = false;
  private _hidden = false;
  private _volume: number;
  private lastBedAt = -Infinity;
  private lastFoleyAt = -Infinity;
  private foleyCounter = 0;
  private lastScene: AcousticScene | null = null;

  constructor(private readonly options: SpatialSoundscapeOptions = {}) {
    this._volume = clamp01(options.volume ?? 0.75);
  }

  get active(): boolean { return this._active; }
  get muted(): boolean { return this._muted; }
  get volume(): number { return this._volume; }
  get scene(): AcousticScene | null { return this.lastScene; }

  async start(): Promise<boolean> {
    if (this._active && this.ctx) {
      if (!this._muted && !this._hidden) await this.ctx.resume?.();
      return true;
    }
    const factory = this.options.createContext ?? (typeof AudioContext !== 'undefined' ? () => new AudioContext() : undefined);
    if (!factory) return false;
    try {
      const ctx = factory();
      await ctx.resume?.();
      const master = ctx.createGain();
      const targetMaster = this._muted || this._hidden ? 0 : this._volume * 0.18;
      master.gain.setValueAtTime(targetMaster, ctx.currentTime);
      master.connect(ctx.destination);

      const pinkBuf = createNoiseBuffer(ctx, 2.5, false);
      const brownBuf = createNoiseBuffer(ctx, 3.0, true);

      const makeNoiseBed = (buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number): { gain: GainNode; filter: BiquadFilterNode } => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = type;
        filter.frequency.setValueAtTime(freq, ctx.currentTime);
        filter.Q.setValueAtTime(q, ctx.currentTime);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, ctx.currentTime);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        src.start();
        this.sources.push(src);
        return { gain, filter };
      };

      const wind = makeNoiseBed(brownBuf, 'bandpass', 260, 0.9);
      const water = makeNoiseBed(pinkBuf, 'bandpass', 720, 1.3);
      const rain = makeNoiseBed(pinkBuf, 'highpass', 1800, 0.7);
      const hearth = makeNoiseBed(brownBuf, 'lowpass', 190, 1.1);

      // Night gentle harmonic hum (crickets/night air)
      const nightOsc = ctx.createOscillator();
      nightOsc.type = 'sine';
      nightOsc.frequency.setValueAtTime(3400, ctx.currentTime);
      const nightGain = ctx.createGain();
      nightGain.gain.setValueAtTime(0, ctx.currentTime);
      nightOsc.connect(nightGain);
      nightGain.connect(master);
      nightOsc.start();
      this.sources.push(nightOsc);

      this.ctx = ctx;
      this.masterGain = master;
      this.beds = {
        wind: wind.gain,
        water: water.gain,
        rain: rain.gain,
        hearth: hearth.gain,
        night: nightGain,
        windFilter: wind.filter,
      };
      this._active = true;
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  setVolume(volume: number): void {
    this._volume = clamp01(volume);
    this.syncMaster();
  }

  setMuted(muted: boolean): void {
    this._muted = !!muted;
    this.syncMaster();
    if (this.ctx) {
      if (this._muted || this._hidden) void this.ctx.suspend?.();
      else void this.ctx.resume?.();
    }
  }

  setHidden(hidden: boolean): void {
    this._hidden = !!hidden;
    this.syncMaster();
    if (this.ctx) {
      if (this._muted || this._hidden) void this.ctx.suspend?.();
      else void this.ctx.resume?.();
    }
  }

  private syncMaster(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const target = this._muted || this._hidden ? 0 : this._volume * 0.18;
    if (typeof this.masterGain.gain.setTargetAtTime === 'function') {
      this.masterGain.gain.setTargetAtTime(target, now, 0.12);
    } else {
      this.masterGain.gain.setValueAtTime(target, now);
    }
  }

  update(world: WorldView, camera?: SoundCamera, nowMs = performance.now()): void {
    if (!this._active || !this.ctx || !this.beds || this._muted || this._hidden) return;
    if (nowMs - this.lastBedAt < 200) return;
    this.lastBedAt = nowMs;

    const scene = analyzeSoundscape(world, camera);
    this.lastScene = scene;
    const t = this.ctx.currentTime;
    const ramp = (param: AudioParam, value: number, tau = 0.45) => {
      if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, t, tau);
      else param.setValueAtTime(value, t);
    };

    ramp(this.beds.wind.gain, scene.wind * 0.42, 0.55);
    ramp(this.beds.windFilter.frequency, 210 + (1 - scene.zoomFactor) * 240 + scene.wind * 180, 0.6);
    ramp(this.beds.water.gain, scene.water * 0.36, 0.45);
    ramp(this.beds.rain.gain, scene.rain * 0.28, 0.5);
    ramp(this.beds.hearth.gain, scene.hearth * 0.40, 0.4);
    ramp(this.beds.night.gain, scene.night * 0.035 * (0.4 + 0.6 * scene.zoomFactor), 0.7);

    // Rate-limited spatialized foley (at most 1 gentle sound every ~700 ms)
    if (scene.events.length > 0 && nowMs - this.lastFoleyAt >= 700) {
      this.lastFoleyAt = nowMs;
      const ev = scene.events[this.foleyCounter % scene.events.length]!;
      this.foleyCounter++;
      this.triggerFoley(ev);
    }
  }

  private triggerFoley(ev: AcousticEvent): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    let tail: AudioNode = env;
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(clamp(ev.pan, -0.85, 0.85), now);
      env.connect(panner);
      tail = panner;
    }
    tail.connect(this.masterGain);

    let duration = 0.22;
    let peak = ev.gain * 0.22;
    if (ev.kind === 'wood_stone') {
      osc.type = 'triangle';
      const base = 180 + ev.pitchHint * 240;
      osc.frequency.setValueAtTime(base, now);
      osc.frequency.exponentialRampToValueAtTime?.(Math.max(70, base * 0.55), now + 0.09);
      duration = 0.11;
      peak = ev.gain * 0.25;
    } else if (ev.kind === 'forge') {
      osc.type = 'sine';
      const base = 620 + ev.pitchHint * 680;
      osc.frequency.setValueAtTime(base, now);
      duration = 0.34;
      peak = ev.gain * 0.18;
    } else if (ev.kind === 'farm_water') {
      osc.type = 'sine';
      const base = 360 + ev.pitchHint * 420;
      osc.frequency.setValueAtTime(base, now);
      osc.frequency.exponentialRampToValueAtTime?.(base * 1.25, now + 0.12);
      duration = 0.16;
      peak = ev.gain * 0.14;
    } else if (ev.kind === 'wildlife') {
      osc.type = 'sine';
      if (ev.pitchHint >= 0.8) {
        // Distant soft wolf tone
        osc.frequency.setValueAtTime(290, now);
        osc.frequency.linearRampToValueAtTime?.(390, now + 0.35);
        osc.frequency.linearRampToValueAtTime?.(260, now + 0.9);
        duration = 0.95;
        peak = ev.gain * 0.14;
      } else {
        // Calm herd/fauna low murmur
        osc.frequency.setValueAtTime(140 + ev.pitchHint * 120, now);
        duration = 0.28;
        peak = ev.gain * 0.12;
      }
    } else {
      // social_chime: warm pentatonic harmonic
      osc.type = 'sine';
      const note = PENTATONIC_HZ[this.foleyCounter % PENTATONIC_HZ.length]!;
      osc.frequency.setValueAtTime(note * (ev.pitchHint > 0.65 ? 1.5 : 1), now);
      duration = 0.85;
      peak = ev.gain * 0.16;
    }

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime?.(Math.max(0.0005, peak), now + 0.02);
    env.gain.exponentialRampToValueAtTime?.(0.0001, now + duration);
    osc.connect(env);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  stop(): void {
    for (const src of this.sources) {
      try { src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* ignore */ }
    }
    this.sources = [];
    if (this.ctx) {
      try { void this.ctx.close?.(); } catch { /* ignore */ }
    }
    this.ctx = null;
    this.masterGain = null;
    this.beds = null;
    this._active = false;
    this.lastBedAt = -Infinity;
    this.lastFoleyAt = -Infinity;
  }
}
