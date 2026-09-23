/** Proxy TCP que emula un enlace WAN: ancho de banda limitado (cuello de botella FIFO con cola
 * acotada, como el router de casa o el VPS) + retardo de propagación en cada sentido.
 *
 * Todas las conexiones de un mismo `Enlace` comparten el cuello de botella (como las pestañas y
 * peticiones de un mismo navegador por la misma línea). Cuando la cola del cuello supera
 * `colaBytes`, se deja de LEER del servidor: la contrapresión llega al búfer del kernel del
 * servidor y luego al `bufferedAmount` de `ws`, exactamente como por el VPS.
 *
 * Tiempos: un trozo que entra en t espera su turno en el cuello (FIFO), tarda `bytes*8/bps` en
 * «serializarse» y llega al otro extremo `retardoMs` después. */
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface EnlaceOpciones { bajadaBps: number; subidaBps: number; retardoMs: number; colaBytes: number }
interface Trozo { destino: Socket; datos: Buffer; fin?: boolean }

class Sentido {
  private libreEn = 0;          // instante en que el cuello termina de serializar lo encolado
  enCola = 0;                   // bytes aceptados que aún no terminaron de serializarse
  maxCola = 0;
  bytes = 0;
  private pausados = new Set<Socket>();
  /** FIFO estricto: un único temporizador entrega en orden (varios `setTimeout` con retardos
   * fraccionarios pueden dispararse desordenados y romper el flujo TCP emulado). */
  private readonly pendientes: { sale: number; llega: number; n: number; trozo: Trozo; salio: boolean }[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly bps: number, private readonly retardoMs: number, private readonly colaBytes: number) {}
  empujar(origen: Socket, trozo: Trozo): void {
    const ahora = performance.now();
    const n = trozo.datos.length;
    const inicio = Math.max(ahora, this.libreEn);
    const sale = inicio + (n * 8 * 1000) / this.bps;
    this.libreEn = sale;
    this.enCola += n; this.bytes += n; this.maxCola = Math.max(this.maxCola, this.enCola);
    if (this.enCola > this.colaBytes && !this.pausados.has(origen)) { this.pausados.add(origen); origen.pause(); }
    this.pendientes.push({ sale, llega: sale + this.retardoMs, n, trozo, salio: false });
    this.armar();
  }
  private armar(): void {
    if (this.timer || !this.pendientes.length) return;
    const ahora = performance.now();
    const primero = this.pendientes[0]!;
    const siguienteSalida = this.pendientes.find(p => !p.salio)?.sale ?? Infinity;
    const cuando = Math.min(primero.llega, siguienteSalida);
    this.timer = setTimeout(() => { this.timer = null; this.bombear(); }, Math.max(0, cuando - ahora));
  }
  private bombear(): void {
    const ahora = performance.now();
    // 1) Lo que ya terminó de serializarse libera cola (y reanuda a los pausados).
    for (const p of this.pendientes) {
      if (p.salio) continue;
      if (p.sale > ahora) break;
      p.salio = true; this.enCola -= p.n;
    }
    if (this.enCola <= this.colaBytes / 2 && this.pausados.size) { for (const s of this.pausados) s.resume(); this.pausados.clear(); }
    // 2) Lo que ya llegó al otro extremo se entrega EN ORDEN.
    while (this.pendientes.length && this.pendientes[0]!.llega <= ahora && this.pendientes[0]!.salio) {
      const { trozo, n } = this.pendientes.shift()!;
      if (trozo.destino.destroyed) continue;
      if (n) trozo.destino.write(trozo.datos);
      if (trozo.fin) trozo.destino.end();
    }
    this.armar();
  }
}

export class Enlace {
  private server: Server | null = null;
  readonly bajada: Sentido; readonly subida: Sentido;
  /** Puertos locales de las conexiones hacia el servidor: el servidor los ve como `remotePort`. */
  readonly puertosHaciaServidor = new Set<number>();
  conexiones = 0;
  constructor(private readonly destino: { host: string; port: number }, readonly opciones: EnlaceOpciones) {
    this.bajada = new Sentido(opciones.bajadaBps, opciones.retardoMs, opciones.colaBytes);
    this.subida = new Sentido(opciones.subidaBps, opciones.retardoMs, opciones.colaBytes);
  }
  async abrir(): Promise<number> {
    this.server = createServer(cliente => {
      this.conexiones++;
      cliente.setNoDelay(true);
      const servidor = connect({ host: this.destino.host, port: this.destino.port }, () => {
        if (servidor.localPort) this.puertosHaciaServidor.add(servidor.localPort);
      });
      servidor.setNoDelay(true);
      const MAX = 16 * 1024; // trozos pequeños: el ritmo del cuello es más fino
      const trocear = (datos: Buffer, destino: Socket, sentido: Sentido, origen: Socket) => {
        for (let i = 0; i < datos.length; i += MAX) sentido.empujar(origen, { destino, datos: datos.subarray(i, i + MAX) });
      };
      servidor.on('data', d => trocear(d, cliente, this.bajada, servidor));
      cliente.on('data', d => trocear(d, servidor, this.subida, cliente));
      servidor.on('end', () => this.bajada.empujar(servidor, { destino: cliente, datos: Buffer.alloc(0), fin: true }));
      cliente.on('end', () => this.subida.empujar(cliente, { destino: servidor, datos: Buffer.alloc(0), fin: true }));
      const cerrar = () => { cliente.destroy(); servidor.destroy(); };
      servidor.on('error', cerrar); cliente.on('error', cerrar);
      cliente.on('close', () => servidor.destroy());
    });
    await new Promise<void>(yes => this.server!.listen(0, '127.0.0.1', () => yes()));
    return (this.server.address() as { port: number }).port;
  }
  cerrar(): Promise<void> { return new Promise(yes => { if (!this.server) return yes(); this.server.close(() => yes()); }); }
}
