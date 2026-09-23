import { PROTOCOL_VERSION, type ClientMessage, type Gesture, type GestureResult, type PersonDetail, type ServerMessage, type TechnologyRecipe, type Viewport, type WorldView } from '../shared/types.js';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';
interface Callbacks {
  world: (world: WorldView) => void;
  result: (result: GestureResult) => void;
  status: (status: ConnectionStatus) => void;
  expired: () => void;
  error: (message: string) => void;
  pending: (pending: boolean) => void;
  /** A null definition means the server could not serve it, never that the procedure is empty. */
  recipe?: (id: string, recipe: TechnologyRecipe | null) => void;
  /** T036(h): a null persona means that identity is not in the served world, never that it lived nothing. */
  persona?: (id: string, persona: PersonDetail | null) => void;
}

/** The server owns the world. This class retries an input with its original ID. */
export class Connection {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private viewportTimer: ReturnType<typeof setTimeout> | undefined;
  private viewport: Viewport | null = null;
  private viewportSignature = '';
  private retries = 0;
  private stopped = false;
  private sequence = -1;
  private operationalState = '';
  private pending: Gesture | null = null;
  private readonly requesting = new Set<string>();
  private readonly askedRecipes = new Set<string>();
  private readonly askedPeople = new Set<string>();
  private subscribeMs = 0;
  /** Un `state` que el servidor manda en trozos (`/ws?ack=1`): cuántos marcos faltan y los recibidos. */
  private trozos: { total: number; partes: string[] } | null = null;
  /** La cámara que viajó en la URL del socket actual: al abrir solo se manda si cambió desde entonces. */
  private urlViewport = 'null';
  private status: ConnectionStatus = 'connecting';
  private browserOffline = false;
  private readonly onOffline = (): void => {
    if (this.stopped) return;
    this.browserOffline = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.silenceTimer);
    clearTimeout(this.viewportTimer);
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
    clearTimeout(this.viewportTimer);
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

  /** Camera requests only change the projection; the server owns exploration. */
  setViewport(viewport: Viewport): void {
    if (this.stopped || ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)) return;
    const width = Math.max(1, Math.min(96, Math.ceil(viewport.width)));
    const height = Math.max(1, Math.min(64, Math.ceil(viewport.height)));
    const next = { x: Math.max(-10_000_000, Math.min(10_000_000 - width, Math.floor(viewport.x))), y: Math.max(-10_000_000, Math.min(10_000_000 - height, Math.floor(viewport.y))), width, height };
    if (JSON.stringify(next) === JSON.stringify(this.viewport)) return;
    this.viewport = next;
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => this.sendViewport(), 150);
  }

  /** Modo ligero móvil (T024/T036a): pide al servidor una cadencia mínima para ESTE cliente.
   * Se recuerda y se reenvía en cada reconexión, porque el servidor no la conserva entre sockets. */
  suscribir(intervaloMs: number): void {
    if (!Number.isFinite(intervaloMs) || intervaloMs < 0) return;
    this.subscribeMs = Math.floor(intervaloMs);
    this.transmit({ type: 'suscripcion', intervaloMs: this.subscribeMs });
  }

  /** A procedure's steps are not part of the snapshot; a reader asks for one at a time. */
  requestRecipe(id: string): boolean {
    if (this.stopped || !/^recipe-[1-9]\d{0,9}$/.test(id) || this.askedRecipes.has(id)) return false;
    if (!this.transmit({ type: 'recipe', id })) return false;
    this.askedRecipes.add(id);
    return true;
  }

  /** T036(h): experiences, trust and remembered procedures are not part of the snapshot;
   * the inspector asks for one inhabitant at a time. */
  requestPersona(id: string): boolean {
    if (this.stopped || !/^[A-Za-z0-9_:-]{1,50}$/.test(id) || this.askedPeople.has(id)) return false;
    if (!this.transmit({ type: 'persona', id })) return false;
    this.askedPeople.add(id);
    return true;
  }

  private transmit(message: ClientMessage): boolean {
    if (this.stopped || this.browserOffline || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private sendViewport(): void {
    if (this.viewport) this.transmit({ type: 'viewport', viewport: this.viewport });
  }

  private updateStatus(status: ConnectionStatus): void {
    // A question asked to a socket that died was never answered; leaving it pending would silence the next one.
    if (status !== 'live') { this.askedRecipes.clear(); this.askedPeople.clear(); }
    this.status = status;
    this.callbacks.status(status);
  }

  private accept(world: WorldView, reconnectSnapshot = false): void {
    const operationalState = `${!!world.paused}:${world.pauseReason ?? ''}`;
    const viewportSignature = `${world.originX ?? 0}:${world.originY ?? 0}:${world.width}:${world.height}`;
    if (this.stopped) return;
    if (world.version !== PROTOCOL_VERSION) {
      this.callbacks.error('Esta versión del mundo necesita que actualices la página.');
      this.stop();
      this.updateStatus('offline');
      return;
    }
    if (!reconnectSnapshot && (world.sequence < this.sequence || (world.sequence === this.sequence && operationalState === this.operationalState && viewportSignature === this.viewportSignature))) return;
    this.sequence = world.sequence;
    this.operationalState = operationalState;
    this.viewportSignature = viewportSignature;
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
    const query = this.viewport ? `?${new URLSearchParams(Object.entries(this.viewport).map(([key, value]) => [key, String(value)]))}` : '';
    const response = await fetch(`/api/world${query}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
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
      // `ack=1`: este cliente acusa cada `state` y el servidor nunca le tiene más de uno en vuelo
      // (contrapresión: por un enlace lento recibe menos estados, siempre el más reciente, en vez
      // de acumular retraso hasta que el latido corta). La cámara ya conocida viaja en la URL para
      // que el primer `state` sea el de esta pantalla y no la vista por defecto.
      const query = new URLSearchParams({ ack: '1', ...(this.viewport ? Object.fromEntries(Object.entries(this.viewport).map(([key, value]) => [key, String(value)])) : {}) });
      const socket = new WebSocket(`${protocol}//${location.host}/ws?${query}`);
      this.socket = socket;
      this.trozos = null; this.urlViewport = JSON.stringify(this.viewport);
      this.watchSilence();
      socket.onopen = () => {
        if (this.stopped || this.socket !== socket) { socket.close(); return; }
        this.retries = 0;
        this.updateStatus('live');
        this.watchSilence();
        if (this.subscribeMs) this.transmit({ type: 'suscripcion', intervaloMs: this.subscribeMs });
        // La cámara de la URL ya sirvió el primer `state`; repetirla pediría otro igual.
        if (JSON.stringify(this.viewport) !== this.urlViewport) this.sendViewport();
        if (this.pending) this.deliver();
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        if (this.stopped || this.socket !== socket) return;
        // Cualquier marco rearma el silencio: un trozo de un `state` grande o un latido demuestran
        // que la conexión vive aunque el `state` entero tarde más de 8 s por un enlace lento.
        this.watchSilence();
        let data = event.data;
        if (this.trozos) {
          this.trozos.partes.push(data);
          if (this.trozos.partes.length < this.trozos.total) return;
          data = this.trozos.partes.join(''); this.trozos = null;
        }
        try {
          const message = JSON.parse(data) as ServerMessage;
          if (message.type === 'trozos') {
            if (Number.isInteger(message.partes) && message.partes > 0 && message.partes <= 4096) this.trozos = { total: message.partes, partes: [] };
            return;
          }
          if (message.type === 'state') {
            // El acuse sale antes de dibujar: mide el enlace, no el render, y libera el siguiente.
            this.transmit({ type: 'ack', sequence: message.world.sequence });
            this.accept(message.world);
          }
          else if (message.type === 'result') this.result(message.result);
          else if (message.type === 'recipe') { this.askedRecipes.delete(message.id); this.callbacks.recipe?.(message.id, message.recipe); }
          else if (message.type === 'persona') { this.askedPeople.delete(message.id); this.callbacks.persona?.(message.id, message.persona); }
          else if (message.type === 'error') this.callbacks.error(message.message);
        } catch { this.callbacks.error('No pudimos leer una actualización. Esperamos la siguiente.'); }
      };
      socket.onerror = () => socket.close();
      socket.onclose = (event) => {
        if (this.stopped || this.socket !== socket) return;
        clearTimeout(this.silenceTimer);
        this.socket = null; this.trozos = null;
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
    if (this.transmit({ type: 'gesture', gesture: this.pending })) {
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
