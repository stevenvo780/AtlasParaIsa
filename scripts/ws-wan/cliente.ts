/** Cliente sin navegador que hace lo mismo que `src/client/connection.ts` (misma máquina de
 * estados, mismos temporizadores) contra un servidor, normalmente a través de un `Enlace`:
 *
 *   connect(): estado 'connecting' (1.º intento) u 'offline' (reintentos) → GET /api/world
 *     (con el viewport si ya lo hay; aborta a los 10 s) → abre /ws → vigila silencio 8 s.
 *   onopen: 'live', reintentos a 0, reenvía `suscripcion` y `viewport`.
 *   onmessage: rearma el silencio de 8 s; parsea JSON (como el navegador).
 *   silencio 8 s: cierra y reprograma. onclose: reprograma (1 s, 2 s, 4 s … 30 s).
 *   Viewport: como `Landscape.reportViewport`, se conoce tras el PRIMER mundo recibido y se
 *     envía 150 ms después (debounce de `setViewport`), o en `onopen` si ya se conocía.
 *
 * Registra cada transición y cada mensaje; `resumen()` devuelve las cifras del escenario. */
import { request } from 'node:http';
import { WebSocket } from 'ws';

export type Estado = 'connecting' | 'live' | 'offline';
export interface Viewport { x: number; y: number; width: number; height: number }
export interface ClienteOpciones {
  puerto: number; host: string; origin: string; cookie: string;
  /** Viewport que la pantalla pediría (null: nunca envía viewport, p. ej. el banco T136 sin cámara). */
  viewport: Viewport | null;
  /** Modo observador (`connection.suscribir(5000)`), 0 = completo. */
  suscribirMs: number;
  etiqueta: string;
}
export interface Mensaje { t: number; tipo: string; bytes: number; secuencia?: number; socket: number }
export interface Transicion { t: number; estado: Estado; motivo: string }

export class Cliente {
  private socket: WebSocket | null = null;
  private socketId = 0;
  private retries = 0;
  private stopped = false;
  private viewport: Viewport | null = null;
  private silenceTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private viewportTimer: NodeJS.Timeout | undefined;
  estado: Estado = 'connecting';
  readonly transiciones: Transicion[] = [];
  readonly mensajes: Mensaje[] = [];
  readonly eventos: { t: number; ev: string; detalle?: unknown }[] = [];
  readonly getWorld: { t: number; ms: number; bytes: number; ok: boolean; motivo?: string; viewport: boolean }[] = [];
  readonly puertosLocales = new Set<number>();
  private inicio = 0;
  constructor(private readonly o: ClienteOpciones) {}

  start(): void { this.inicio = Date.now(); void this.connect(); }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.silenceTimer); clearTimeout(this.retryTimer); clearTimeout(this.viewportTimer);
    this.socket?.terminate(); this.socket = null;
  }

  private setEstado(estado: Estado, motivo: string): void {
    this.estado = estado; this.transiciones.push({ t: Date.now(), estado, motivo });
  }
  /** Lo que haría `Landscape`: tras el primer mundo, `fitWorld` centra la cámara en S (o en el
   * centro de la ventana recibida si S no está en ella), `reportViewport` informa el recuadro
   * (ancho×alto de la pantalla) y `setViewport` lo envía 150 ms después. */
  private primerMundo(world?: { originX?: number; originY?: number; width: number; height: number; people?: { role: string; x: number; y: number }[] }): void {
    if (this.viewport || !this.o.viewport || !world) return;
    const s = world.people?.find(p => p.role === 'S');
    const cx = s ? s.x + 0.5 : (world.originX ?? 0) + world.width / 2, cy = s ? s.y + 0.5 : (world.originY ?? 0) + world.height / 2;
    const { width, height } = this.o.viewport;
    this.viewport = { x: Math.floor(cx - width / 2), y: Math.floor(cy - height / 2), width, height };
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => this.transmit({ type: 'viewport', viewport: this.viewport }), 150);
  }
  private transmit(message: unknown): boolean {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private getWorldHttp(): Promise<boolean> {
    const query = this.viewport ? `?${new URLSearchParams(Object.entries(this.viewport).map(([k, v]) => [k, String(v)]))}` : '';
    const t0 = Date.now();
    return new Promise((yes, no) => {
      let bytes = 0;
      const req = request({ host: '127.0.0.1', port: this.o.puerto, path: `/api/world${query}`, method: 'GET', agent: false,
        headers: { Host: this.o.host, Cookie: this.o.cookie, Accept: 'application/json' } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { bytes += c.length; chunks.push(c); });
        res.on('end', () => {
          clearTimeout(timer);
          const ok = res.statusCode === 200;
          this.getWorld.push({ t: t0, ms: Date.now() - t0, bytes, ok, motivo: ok ? undefined : `http ${res.statusCode}`, viewport: !!this.viewport });
          if (!ok) return no(new Error(`http ${res.statusCode}`));
          let world;
          try { world = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return no(new Error('json')); }
          this.primerMundo(world);
          yes(!this.stopped);
        });
        res.on('error', no);
      });
      // AbortSignal.timeout(10_000) del cliente real: cuenta hasta el último byte del cuerpo.
      const timer = setTimeout(() => {
        this.getWorld.push({ t: t0, ms: Date.now() - t0, bytes, ok: false, motivo: 'timeout 10 s', viewport: !!this.viewport });
        req.destroy(new Error('timeout'));
      }, 10_000);
      req.on('error', error => { clearTimeout(timer); no(error); });
      req.end();
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setEstado(this.retries ? 'offline' : 'connecting', this.retries ? 'reintento' : 'inicio');
    try {
      if (!await this.getWorldHttp()) return;
      const id = ++this.socketId;
      const socket = new WebSocket(`ws://127.0.0.1:${this.o.puerto}/ws`, {
        headers: { Host: this.o.host, Origin: this.o.origin, Cookie: this.o.cookie },
        perMessageDeflate: true, // un navegador SIEMPRE ofrece permessage-deflate; decide el servidor
      });
      this.socket = socket;
      this.watchSilence();
      socket.on('upgrade', () => { const p = (socket as unknown as { _socket?: { localPort?: number } })._socket?.localPort; if (p) this.puertosLocales.add(p); });
      socket.on('open', () => {
        if (this.stopped || this.socket !== socket) { socket.close(); return; }
        this.retries = 0;
        this.setEstado('live', `ws abierto #${id}${socket.extensions ? ` (${socket.extensions})` : ''}`);
        this.watchSilence();
        if (this.o.suscribirMs) this.transmit({ type: 'suscripcion', intervaloMs: this.o.suscribirMs });
        if (this.viewport) this.transmit({ type: 'viewport', viewport: this.viewport });
      });
      socket.on('message', (data: Buffer, binary: boolean) => {
        if (this.stopped || this.socket !== socket) return;
        this.watchSilence();
        const text = binary ? '' : data.toString('utf8');
        try {
          const message = JSON.parse(text) as { type: string; world?: { sequence: number; originX?: number; originY?: number; width: number; height: number; people?: { role: string; x: number; y: number }[] } };
          this.mensajes.push({ t: Date.now(), tipo: message.type, bytes: Buffer.byteLength(text), secuencia: message.world?.sequence, socket: id });
          if (message.type === 'state') this.primerMundo(message.world);
        } catch { this.eventos.push({ t: Date.now(), ev: 'json-ilegible' }); }
      });
      socket.on('error', error => { this.eventos.push({ t: Date.now(), ev: 'ws-error', detalle: String(error.message) }); socket.close(); });
      socket.on('close', (code, reason) => {
        this.eventos.push({ t: Date.now(), ev: 'ws-close', detalle: { id, code, reason: reason.toString() } });
        if (this.stopped || this.socket !== socket) return;
        clearTimeout(this.silenceTimer);
        this.socket = null;
        if (code === 1008 || code === 4001 || code === 4401) { this.eventos.push({ t: Date.now(), ev: 'expira' }); this.stop(); return; }
        this.scheduleReconnect(`close ${code}`);
      });
    } catch (error) {
      this.eventos.push({ t: Date.now(), ev: 'connect-fallo', detalle: String((error as Error).message) });
      if (!this.stopped) this.scheduleReconnect(`connect: ${(error as Error).message}`);
    }
  }
  private scheduleReconnect(motivo: string): void {
    clearTimeout(this.retryTimer);
    this.setEstado('offline', motivo);
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5));
    this.eventos.push({ t: Date.now(), ev: 'reconexion-programada', detalle: { delay, motivo } });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
  private watchSilence(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.stopped) return;
      this.eventos.push({ t: Date.now(), ev: 'silencio-8s' });
      const previous = this.socket; this.socket = null; previous?.close();
      this.scheduleReconnect('silencio 8 s');
    }, 8000);
  }

  resumen(fin = Date.now()) {
    const dur = fin - this.inicio;
    // Tiempo por estado (lo que ve la pantalla: 'live' oculta el aviso; 'offline' = «Sin conexión»).
    const tiempo: Record<Estado, number> = { connecting: 0, live: 0, offline: 0 };
    for (let i = 0; i < this.transiciones.length; i++) {
      const a = this.transiciones[i]!, b = this.transiciones[i + 1];
      tiempo[a.estado] += (b?.t ?? fin) - a.t;
    }
    const states = this.mensajes.filter(m => m.tipo === 'state');
    const gaps: number[] = [];
    for (let i = 1; i < states.length; i++) if (states[i]!.socket === states[i - 1]!.socket) gaps.push(states[i]!.t - states[i - 1]!.t);
    gaps.sort((a, b) => a - b);
    const q = (arr: number[], p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]! : null;
    const bytes = states.map(m => m.bytes).sort((a, b) => a - b);
    const primerLive = this.transiciones.find(x => x.estado === 'live');
    return {
      etiqueta: this.o.etiqueta, duracionS: dur / 1000,
      pctLive: 100 * tiempo.live / dur, pctOffline: 100 * tiempo.offline / dur, pctConnecting: 100 * tiempo.connecting / dur,
      primerLiveS: primerLive ? (primerLive.t - this.inicio) / 1000 : null,
      primerStateS: states[0] ? (states[0].t - this.inicio) / 1000 : null,
      sockets: this.socketId,
      reconexiones: this.eventos.filter(e => e.ev === 'reconexion-programada').length,
      silencios8s: this.eventos.filter(e => e.ev === 'silencio-8s').length,
      cierres: this.eventos.filter(e => e.ev === 'ws-close').map(e => (e.detalle as { code: number }).code),
      getWorld: this.getWorld.map(g => ({ ms: g.ms, kib: Math.round(g.bytes / 1024), ok: g.ok, motivo: g.motivo, viewport: g.viewport })),
      states: states.length, statesPorS: states.length / (dur / 1000),
      stateKiB: { p50: (q(bytes, 0.5) ?? 0) / 1024, max: (bytes.at(-1) ?? 0) / 1024 },
      bajadaMbps: states.reduce((s, m) => s + m.bytes, 0) * 8 / (dur / 1000) / 1e6,
      gapMs: { p50: q(gaps, 0.5), p95: q(gaps, 0.95), max: gaps.at(-1) ?? null },
    };
  }
}
