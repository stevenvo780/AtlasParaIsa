import { PROTOCOL_VERSION, type Gesture, type GestureResult, type ServerMessage, type WorldView } from '../shared/types.js';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';
interface Callbacks {
  world: (world: WorldView) => void;
  result: (result: GestureResult) => void;
  status: (status: ConnectionStatus) => void;
  expired: () => void;
  error: (message: string) => void;
  pending: (pending: boolean) => void;
}

/** The server owns the world. This class retries an input with its original ID. */
export class Connection {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private stopped = false;
  private sequence = -1;
  private operationalState = '';
  private pending: Gesture | null = null;
  private readonly requesting = new Set<string>();
  private status: ConnectionStatus = 'connecting';
  private browserOffline = false;
  private readonly onOffline = (): void => {
    if (this.stopped) return;
    this.browserOffline = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.silenceTimer);
    clearTimeout(this.acknowledgementTimer);
    this.updateStatus('offline');
    const previous = this.socket; this.socket = null; previous?.close();
  };
  private readonly onOnline = (): void => {
    if (this.stopped) return;
    this.browserOffline = false;
    clearTimeout(this.retryTimer);
    this.retries = 0;
    void this.connect();
  };
  constructor(private callbacks: Callbacks) {}

  start(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('online', this.onOnline);
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.acknowledgementTimer);
    clearTimeout(this.silenceTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('online', this.onOnline);
    }
    this.socket?.close();
    this.socket = null;
    this.pending = null;
  }

  send(gesture: Gesture): boolean {
    if (this.stopped || this.status !== 'live' || this.pending) return false;
    this.pending = gesture;
    this.callbacks.pending(true);
    this.deliver();
    return true;
  }

  private updateStatus(status: ConnectionStatus): void {
    this.status = status;
    this.callbacks.status(status);
  }

  private accept(world: WorldView, reconnectSnapshot = false): void {
    const operationalState = `${!!world.paused}:${world.pauseReason ?? ''}`;
    if (this.stopped) return;
    if (world.version !== PROTOCOL_VERSION) {
      this.callbacks.error('Esta versión del mundo necesita que actualices la página.');
      this.stop();
      this.updateStatus('offline');
      return;
    }
    if (!reconnectSnapshot && (world.sequence < this.sequence || (world.sequence === this.sequence && operationalState === this.operationalState))) return;
    this.sequence = world.sequence;
    this.operationalState = operationalState;
    this.callbacks.world(world);
  }

  private result(result: GestureResult): void {
    if (this.stopped || result.id !== this.pending?.id) return;
    clearTimeout(this.acknowledgementTimer);
    this.pending = null;
    this.callbacks.pending(false);
    this.callbacks.result(result);
  }

  private expire(): void {
    if (this.stopped) return;
    this.stop();
    this.callbacks.expired();
  }

  private async getWorld(): Promise<boolean> {
    const response = await fetch('/api/world', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (response.status === 401 || response.status === 403) { this.expire(); return false; }
    if (!response.ok) throw new Error('El mundo no está disponible todavía.');
    this.accept(await response.json() as WorldView, true);
    return !this.stopped;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.browserOffline) return;
    this.updateStatus(this.retries ? 'offline' : 'connecting');
    try {
      if (!await this.getWorld() || this.browserOffline) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      this.socket = socket;
      this.watchSilence();
      socket.onopen = () => {
        if (this.stopped || this.socket !== socket) { socket.close(); return; }
        this.retries = 0;
        this.updateStatus('live');
        this.watchSilence();
        if (this.pending) this.deliver();
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        if (this.stopped || this.socket !== socket) return;
        this.watchSilence();
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          if (message.type === 'state') this.accept(message.world);
          else if (message.type === 'result') this.result(message.result);
          else if (message.type === 'error') this.callbacks.error(message.message);
        } catch { this.callbacks.error('No pudimos leer una actualización. Esperamos la siguiente.'); }
      };
      socket.onerror = () => socket.close();
      socket.onclose = (event) => {
        if (this.stopped || this.socket !== socket) return;
        clearTimeout(this.silenceTimer);
        this.socket = null;
        if (event.code === 1008 || event.code === 4001 || event.code === 4401) { this.expire(); return; }
        this.scheduleReconnect();
      };
    } catch {
      if (!this.stopped) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.acknowledgementTimer);
    this.updateStatus('offline');
    if (this.browserOffline || this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5));
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private watchSilence(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.stopped || this.browserOffline) return;
      const previous = this.socket; this.socket = null; previous?.close();
      this.scheduleReconnect();
    }, 8000);
  }

  private deliver(): void {
    if (!this.pending || this.stopped) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'gesture', gesture: this.pending }));
      clearTimeout(this.acknowledgementTimer);
      this.acknowledgementTimer = setTimeout(() => void this.deliverHttp(), 6000);
    } else void this.deliverHttp();
  }

  private async deliverHttp(): Promise<void> {
    if (!this.pending || this.stopped || this.requesting.has(this.pending.id)) return;
    const gesture = this.pending;
    this.requesting.add(gesture.id);
    try {
      const response = await fetch('/api/gesture', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gesture),
        signal: AbortSignal.timeout(10_000),
      });
      if (this.stopped || this.pending?.id !== gesture.id) return;
      if (response.status === 401 || response.status === 403) { this.expire(); return; }
      const body = await response.json() as GestureResult & { error?: string };
      if (this.stopped || this.pending?.id !== gesture.id) return;
      if (typeof body.accepted === 'boolean' && body.id === gesture.id) this.result(body);
      else {
        // A malformed request is not a persisted gesture; never claim that it was applied.
        if (response.status >= 400 && response.status < 500) {
          this.pending = null;
          this.callbacks.pending(false);
          this.callbacks.error(body.error ?? 'El servidor no pudo aceptar este gesto.');
        } else throw new Error('El gesto sigue sin confirmación.');
      }
    } catch {
      if (this.stopped || this.pending?.id !== gesture.id) return;
      this.callbacks.error('Aún no tenemos confirmación. Al reconectar consultaremos el mismo gesto, sin duplicarlo.');
      if (this.socket) this.socket.close();
      else this.scheduleReconnect();
    } finally { this.requesting.delete(gesture.id); }
  }
}
