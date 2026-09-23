/** El cliente REAL (`src/client/connection.ts`, sin tocar) con el navegador mínimo de
 * `navegador-node.ts`, expuesto con la MISMA forma que `Cliente` (el emulador del diagnóstico) para
 * que `banco.ts` mida antes y después con la misma tabla.
 *
 * Como `Landscape`: tras el primer mundo informa una cámara del tamaño de la pantalla centrada en S
 * (`setViewport`, que la manda con su debounce de 150 ms); `suscribirMs` = modo observador.
 *
 * Lo que `Connection` no cuenta (no se toca el cliente para medirlo) se deduce de lo que ve la página:
 *   - reconexiones = GET /api/world − 1 (cada `connect()` empieza por él);
 *   - «silencio 8 s» = paso a 'offline' sin un cierre del socket ni un GET fallido justo antes.
 * Un proceso = una página (los globales del navegador son del proceso). */
import { Connection, type ConnectionStatus } from '../../src/client/connection.js';
import type { ServerMessage, WorldView } from '../../src/shared/types.js';
import { instalarNavegador, type EventoPagina } from './navegador-node.js';
import type { ClienteOpciones, Estado, Mensaje, Transicion, Viewport } from './cliente.js';

export class ClienteReal {
  readonly transiciones: Transicion[] = [];
  readonly mensajes: Mensaje[] = [];
  readonly eventos: { t: number; ev: string; detalle?: unknown }[] = [];
  readonly getWorld: { t: number; ms: number; bytes: number; ok: boolean; motivo?: string; viewport: boolean }[] = [];
  readonly urls: string[] = [];
  private conexion: Connection | null = null;
  private navegador: { restaurar: () => void } | null = null;
  private viewport: Viewport | null = null;
  private inicio = 0;
  private detenido = false;
  private readonly pagina: EventoPagina[] = [];
  private trozos = new Map<number, { total: number; partes: string[]; bytes: number }>();
  constructor(private readonly o: ClienteOpciones) {}

  start(): void {
    this.inicio = Date.now();
    this.navegador = instalarNavegador({ host: this.o.host, origin: this.o.origin, cookie: this.o.cookie, puerto: this.o.puerto, registro: e => this.registrar(e) });
    this.conexion = new Connection({
      world: world => this.mundo(world),
      status: status => this.estado(status),
      result: () => {}, error: message => this.eventos.push({ t: Date.now(), ev: 'error', detalle: message }),
      expired: () => this.eventos.push({ t: Date.now(), ev: 'expira' }), pending: () => {},
    });
    if (this.o.suscribirMs) this.conexion.suscribir(this.o.suscribirMs);
    this.conexion.start();
  }
  stop(): void {
    if (this.detenido) return;
    this.detenido = true;
    this.conexion?.stop(); this.navegador?.restaurar();
  }

  private estado(status: ConnectionStatus): void {
    if (this.detenido) return;
    const previo = this.transiciones.at(-1)?.estado;
    if (status === previo) return; // `Connection` repite 'offline' al reintentar; la pantalla no cambia
    const t = Date.now();
    let motivo = status === 'live' ? `ws abierto #${this.urls.length}` : status === 'connecting' ? 'inicio' : 'silencio';
    if (status === 'offline') {
      const antes = this.pagina.filter(e => e.t >= t - 100 && (e.ev === 'ws-cierra' || e.ev === 'http-fallo')).at(-1);
      if (antes?.ev === 'ws-cierra') motivo = `close ${antes.code}`;
      else if (antes?.ev === 'http-fallo') motivo = `connect: ${antes.motivo}`;
      else this.eventos.push({ t, ev: 'silencio-8s' });
      this.eventos.push({ t, ev: 'reconexion-programada', detalle: { motivo } });
    }
    this.transiciones.push({ t, estado: status as Estado, motivo });
  }

  private mundo(world: WorldView): void {
    // Lo que haría `Landscape.reportViewport` tras `fitWorld` (igual que el emulador).
    if (this.viewport || !this.o.viewport) return;
    const s = world.people?.find(p => p.role === 'S');
    const cx = s ? s.x + 0.5 : (world.originX ?? 0) + world.width / 2, cy = s ? s.y + 0.5 : (world.originY ?? 0) + world.height / 2;
    this.viewport = { x: Math.floor(cx - this.o.viewport.width / 2), y: Math.floor(cy - this.o.viewport.height / 2), width: this.o.viewport.width, height: this.o.viewport.height };
    this.conexion?.setViewport(this.viewport);
  }

  private registrar(e: EventoPagina): void {
    this.pagina.push(e);
    if (e.ev === 'http' || e.ev === 'http-fallo') {
      if (!e.ruta.startsWith('/api/world')) return;
      const ok = e.ev === 'http' && e.status === 200;
      this.getWorld.push({ t: e.t - e.ms, ms: e.ms, bytes: e.ev === 'http' ? e.bytesCable : 0, ok, motivo: ok ? undefined : e.ev === 'http' ? `http ${e.status}` : e.motivo === 'abortada' ? 'timeout 10 s' : e.motivo, viewport: e.ruta.includes('?') });
      return;
    }
    if (e.ev === 'ws-crea') { this.urls.push(e.url); return; }
    if (e.ev === 'ws-cierra') { this.eventos.push({ t: e.t, ev: 'ws-close', detalle: { id: e.socket, code: e.code } }); this.trozos.delete(e.socket); return; }
    if (e.ev !== 'marco') return;
    // Reconstruye los mensajes como `connection.ts`: un `trozos` y sus partes son UN mensaje.
    const enCurso = this.trozos.get(e.socket);
    if (enCurso) {
      enCurso.partes.push(e.texto); enCurso.bytes += e.bytes;
      if (enCurso.partes.length < enCurso.total) return;
      this.trozos.delete(e.socket);
      this.anotar(e.t, enCurso.partes.join(''), enCurso.bytes, e.socket);
      return;
    }
    let tipo = '';
    try { tipo = (JSON.parse(e.texto) as ServerMessage).type; } catch { this.eventos.push({ t: e.t, ev: 'json-ilegible' }); return; }
    if (tipo === 'trozos') { const m = JSON.parse(e.texto) as { partes: number }; this.trozos.set(e.socket, { total: m.partes, partes: [], bytes: 0 }); return; }
    this.anotar(e.t, e.texto, e.bytes, e.socket);
  }
  private anotar(t: number, texto: string, bytes: number, socket: number): void {
    const message = JSON.parse(texto) as ServerMessage;
    this.mensajes.push({ t, tipo: message.type, bytes, secuencia: message.type === 'state' ? message.world.sequence : undefined, socket });
  }

  resumen(fin = Date.now()) {
    const dur = fin - this.inicio;
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
    // Hueco máximo entre marcos cualesquiera de un mismo socket: lo que mide el silencio de 8 s.
    const marcos = this.pagina.filter((e): e is Extract<EventoPagina, { ev: 'marco' }> => e.ev === 'marco');
    let huecoMarcoMax = 0;
    for (let i = 1; i < marcos.length; i++) if (marcos[i]!.socket === marcos[i - 1]!.socket) huecoMarcoMax = Math.max(huecoMarcoMax, marcos[i]!.t - marcos[i - 1]!.t);
    return {
      etiqueta: this.o.etiqueta, duracionS: dur / 1000,
      pctLive: 100 * tiempo.live / dur, pctOffline: 100 * tiempo.offline / dur, pctConnecting: 100 * tiempo.connecting / dur,
      primerLiveS: primerLive ? (primerLive.t - this.inicio) / 1000 : null,
      primerStateS: states[0] ? (states[0].t - this.inicio) / 1000 : null,
      sockets: this.urls.length, urls: [...new Set(this.urls)].slice(0, 4),
      reconexiones: Math.max(0, this.getWorld.length - 1),
      silencios8s: this.eventos.filter(e => e.ev === 'silencio-8s').length,
      cierres: this.eventos.filter(e => e.ev === 'ws-close' && e.t < fin).map(e => (e.detalle as { code: number }).code),
      getWorld: this.getWorld.map(g => ({ ms: g.ms, kib: Math.round(g.bytes / 1024), ok: g.ok, motivo: g.motivo, viewport: g.viewport })),
      states: states.length, statesPorS: states.length / (dur / 1000),
      stateKiB: { p50: (q(bytes, 0.5) ?? 0) / 1024, max: (bytes.at(-1) ?? 0) / 1024 },
      bajadaMbps: states.reduce((s, m) => s + m.bytes, 0) * 8 / (dur / 1000) / 1e6,
      gapMs: { p50: q(gaps, 0.5), p95: q(gaps, 0.95), max: gaps.at(-1) ?? null },
      huecoMarcoMaxMs: huecoMarcoMax,
      trozos: this.mensajes.length ? marcos.length - this.mensajes.length : 0,
    };
  }
}
