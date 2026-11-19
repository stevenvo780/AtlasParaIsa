/**
 * T138 — Banco de red a escala con desglose obligatorio por campo.
 *
 * Levanta un servidor real (`createApp` + HTTP/WebSocket en puerto efímero 0)
 * sobre un `CARTA_DATA_DIR` temporal que se limpia al salir, inyecta N
 * habitantes sintéticos válidos (clones estructurales de un vecino real, como
 * `tests/lib/escenas.ts:clonarVecino`) FUERA de `stepWorld` —solo para medir
 * tamaño en el cable, como pide T138— y conecta hasta 12 clientes WebSocket
 * con viewports distintos. Cada «paso» del banco es un ciclo de difusión de
 * red: el cliente pide su viewport por el mensaje público `{type:'viewport'}`
 * y el servidor responde con un `state` completo proyectado en ese momento.
 * No se avanza `stepWorld` sobre la población inyectada: hacerlo activaría
 * los chunks lejanos y convertiría una medida de red en una de simulación.
 *
 * Uso:
 *   npm run banco:red -- [--clientes 12] [--escalas 40,1000,10000]
 *                        [--pasos 5] [--salida banco-red.json]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import type { World } from '../src/world/index.js';
import type { Viewport, WorldView } from '../src/shared/types.js';

export const CAMPOS_DESGLOSE = ['tiles', 'people', 'communities', 'blueprints', 'technology', 'events', 'animals', 'structures', 'stats', 'demography', 'organization', 'memories', 'places'] as const;
export type CampoDesglose = (typeof CAMPOS_DESGLOSE)[number];
export const CAMPOS_ACOTADOS: readonly CampoDesglose[] = ['people', 'communities', 'blueprints', 'tiles'];
export const TECHO_STATE_BYTES = 120 * 1024;
/** Viewport medio: el 12×8 que `tests/world-view-size.test.ts` usa como cámara pequeña. */
export const VIEWPORT_MEDIO: Viewport = { x: 0, y: 0, width: 12, height: 8 };
export const VIEWPORTS_DISTINTOS: readonly Viewport[] = [
  VIEWPORT_MEDIO,
  { x: 0, y: 0, width: 10, height: 10 },
  { x: 0, y: 0, width: 20, height: 14 },
  { x: 0, y: 0, width: 40, height: 28 },
  { x: 2, y: 1, width: 12, height: 8 },
  { x: 4, y: 2, width: 16, height: 10 },
  { x: 0, y: 0, width: 24, height: 16 },
  { x: 6, y: 3, width: 18, height: 12 },
  { x: 0, y: 0, width: 32, height: 20 },
  { x: 10, y: 5, width: 20, height: 14 },
  { x: 1, y: 0, width: 14, height: 9 },
  { x: 3, y: 4, width: 22, height: 15 },
];
const PASSWORD = 'synthetic-banco-red-password';
const COMUNIDAD_ID = 'community-banco-red';

export interface DesgloseState {
  campos: Record<CampoDesglose, number>;
  sobrecosteBytes: number;
  sumaCamposBytes: number;
  totalStateBytes: number;
  diferenciaPct: number;
  dentroDel2Pct: boolean;
}

export interface ResultadoEscala {
  habitantes: number;
  habitantesInyectados: number;
  habitantesEnVistaMedia: number;
  clientes: number;
  pasos: number;
  mensajesEsperados: number;
  mensajesRecibidos: number;
  mensajesDescartados: number;
  socketsTerminados: number;
  bytesPorPasoPorCliente: { media: number; p95: number };
  egressTotalBytes: number;
  totalStateBytes: number;
  cumpleTecho120KiB: boolean;
  desglose: DesgloseState;
  miembrosComunidadEnVista: number;
  miembrosComunidadTotal: number;
  contieneIdsLejanos: boolean;
}

export interface InformeBancoRed {
  escalas: ResultadoEscala[];
  comparacion1000a10000: null | {
    camposAcotados: Record<string, { bytes1000: number; bytes10000: number; ratio: number; acotado: boolean }>;
    ningunCampoAcotadoCreceLineal: boolean;
    stateMedioBajoTechoEnAmbas: boolean;
  };
}

const bytesUtf8 = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'undefined', 'utf8');

/** Bytes UTF-8 de cada campo del `state` más el sobrecoste de envoltura. */
export function desglosePorCampo(state: WorldView | Record<string, unknown>): DesgloseState {
  const totalStateBytes = bytesUtf8(state);
  const campos = {} as Record<CampoDesglose, number>;
  let sumaSinSobrecoste = 0;
  for (const campo of CAMPOS_DESGLOSE) {
    const valor = (state as Record<string, unknown>)[campo];
    campos[campo] = valor === undefined ? 0 : bytesUtf8(valor);
    sumaSinSobrecoste += campos[campo];
  }
  const sobrecosteBytes = Math.max(0, totalStateBytes - sumaSinSobrecoste);
  const sumaCamposBytes = sumaSinSobrecoste + sobrecosteBytes;
  const diferenciaPct = totalStateBytes === 0 ? 0 : Math.abs(sumaCamposBytes - totalStateBytes) / totalStateBytes * 100;
  return { campos, sobrecosteBytes, sumaCamposBytes, totalStateBytes, diferenciaPct, dentroDel2Pct: diferenciaPct <= 2 };
}

/**
 * Inyecta habitantes hasta llegar a `totalObjetivo` habitantes en el mundo.
 * Unos 40 quedan dentro del viewport medio (rejilla 10×4 junto a (1,1), como
 * el escenario de 10 000 de `tests/world-view-size.test.ts`) y el resto se
 * distribuye en el terreno lejano (500,500)+, fuera de todo viewport usado.
 */
export function inyectarHabitantes(world: World, totalObjetivo: number): { inyectados: number } {
  const necesarios = Math.max(0, totalObjetivo - world.people.length);
  if (necesarios === 0) return { inyectados: 0 };
  if (!world.communities.some(c => c.id === COMUNIDAD_ID)) {
    world.communities.push({ id: COMUNIDAD_ID, name: 'Comunidad banco de red', x: 5, y: 5, color: '#8899aa', members: [], culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: world.tick, cooperation: 0, disputes: 0 });
  }
  const comunidad = world.communities.find(c => c.id === COMUNIDAD_ID)!;
  const plantilla = world.people.find(p => p.role === 'neighbor');
  if (!plantilla) throw new Error('El mundo no tiene un vecino que clonar.');
  const visibles = Math.min(40, necesarios);
  for (let i = 0; i < necesarios; i++) {
    const clone = structuredClone(plantilla);
    const enVista = i < visibles;
    clone.id = enVista ? `camara-${i}` : `lejos-${i - visibles}`;
    clone.name = `Sintético banco ${i}`;
    clone.role = 'neighbor';
    clone.communityId = COMUNIDAD_ID;
    const spot = enVista
      ? { x: 1 + (i % 10), y: 1 + Math.floor(i / 10) }
      : { x: 500 + ((i - visibles) % 200), y: 500 + Math.floor((i - visibles) / 200) };
    clone.x = spot.x; clone.y = spot.y; clone.target = { ...spot };
    world.people.push(clone);
    comunidad.members.push(clone.id);
  }
  // Como en `registrarInyectados` (tests/lib/escenas.ts): sin esto el análisis
  // de organización trataría cada inyectado como nunca registrado.
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
  return { inyectados: necesarios };
}

interface ClienteMedido {
  socket: WebSocket;
  viewport: Viewport;
  estados: number;
  midiendo: boolean;
  bytesMedidos: number[];
  ultimoState: Record<string, unknown> | null;
  terminado: boolean;
  espera: { n: number; resolve: () => void }[];
}

/** Puerto efímero (0) reservado por el sistema, como `tests/lib/net.ts:freePort`:
 * `createApp` exige conocer el `origin` (con puerto) antes de escuchar. */
async function puertoEfimero(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function percentile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q))]!;
}

function conectarCliente(url: string, origin: string, cookie: string, viewport: Viewport): Promise<ClienteMedido> {
  const socket = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie }, perMessageDeflate: false });
  const cliente: ClienteMedido = { socket, viewport, estados: 0, midiendo: false, bytesMedidos: [], ultimoState: null, terminado: false, espera: [] };
  socket.on('message', (data) => {
    const raw = data.toString();
    let parsed: { type?: string; world?: Record<string, unknown> } | null = null;
    try { parsed = JSON.parse(raw) as { type?: string; world?: Record<string, unknown> }; } catch { parsed = null; }
    if (parsed?.type !== 'state' || !parsed.world) return;
    cliente.estados++;
    if (cliente.midiendo) cliente.bytesMedidos.push(Buffer.byteLength(raw, 'utf8'));
    cliente.ultimoState = parsed.world;
    for (let i = cliente.espera.length - 1; i >= 0; i--) {
      if (cliente.estados >= cliente.espera[i]!.n) { cliente.espera[i]!.resolve(); cliente.espera.splice(i, 1); }
    }
  });
  socket.on('close', () => { cliente.terminado = true; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tiempo agotado abriendo un cliente WebSocket.')), 10_000);
    socket.once('open', () => { clearTimeout(timer); resolve(cliente); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function esperarEstados(cliente: ClienteMedido, n: number, timeoutMs = 15_000): Promise<boolean> {
  if (cliente.estados >= n) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>(resolve => cliente.espera.push({ n, resolve: () => resolve(true) })),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export interface OpcionesBanco { clientes?: number; pasos?: number }

/** Mide una escala de población contra un servidor real efímero. */
export async function medirEscala(habitantes: number, opciones: OpcionesBanco = {}): Promise<ResultadoEscala> {
  const numClientes = Math.min(12, Math.max(1, Math.floor(opciones.clientes ?? 12)));
  const pasos = Math.max(1, Math.floor(opciones.pasos ?? 5));
  const dataDir = mkdtempSync(join(tmpdir(), 'banco-red-'));
  const anteriorDataDir = process.env.CARTA_DATA_DIR;
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  let app: ReturnType<typeof createApp> | undefined;
  const clientes: ClienteMedido[] = [];
  try {
    const port = await puertoEfimero();
    const origin = `http://127.0.0.1:${port}`;
    app = createApp({ store, password: PASSWORD, origin, manual: true, seed: 51926, perMessageDeflate: false });
    const { inyectados } = inyectarHabitantes(app.world, habitantes);
    app.server.listen(port, '127.0.0.1');
    await once(app.server, 'listening');
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    if (login.status !== 200) throw new Error(`El ingreso del banco falló: ${login.status}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const wsUrl = `${origin.replace('http:', 'ws:')}/ws`;
    for (let i = 0; i < numClientes; i++) {
      clientes.push(await conectarCliente(wsUrl, origin, cookie, VIEWPORTS_DISTINTOS[i % VIEWPORTS_DISTINTOS.length]!));
    }
    // Estado inicial de conexión + estado de su viewport asignado.
    for (const cliente of clientes) {
      await esperarEstados(cliente, 1);
      cliente.socket.send(JSON.stringify({ type: 'viewport', viewport: cliente.viewport }));
    }
    for (const cliente of clientes) await esperarEstados(cliente, 2);
    // Medición: cada paso pide el viewport y espera el `state` de vuelta. Los
    // bytes son los del mensaje crudo recibido (`Buffer.byteLength(raw)`).
    for (const cliente of clientes) cliente.midiendo = true;
    let descartados = 0;
    let completado = true;
    for (let paso = 0; paso < pasos && completado; paso++) {
      const esperadoPorCliente = clientes.map(c => c.estados + 1);
      for (const cliente of clientes) cliente.socket.send(JSON.stringify({ type: 'viewport', viewport: cliente.viewport }));
      const recibidos = await Promise.all(clientes.map((c, i) => esperarEstados(c, esperadoPorCliente[i]!)));
      recibidos.forEach((ok) => { if (!ok) { descartados++; completado = false; } });
    }
    for (const cliente of clientes) cliente.midiendo = false;
    const todosBytes = clientes.flatMap(c => c.bytesMedidos);
    const ordenados = [...todosBytes].sort((a, b) => a - b);
    const medio = clientes.find(c => c.viewport === VIEWPORT_MEDIO) ?? clientes[0]!;
    if (!medio.ultimoState) throw new Error('El cliente de viewport medio no recibió ningún state.');
    const desglose = desglosePorCampo(medio.ultimoState);
    const worldMedio = medio.ultimoState as unknown as WorldView;
    const comunidad = worldMedio.communities?.find(c => c.id === COMUNIDAD_ID);
    const socketsTerminados = clientes.filter(c => c.terminado).length;
    const mensajesEsperados = numClientes * pasos;
    return {
      habitantes,
      habitantesInyectados: inyectados,
      habitantesEnVistaMedia: worldMedio.people.length,
      clientes: numClientes,
      pasos,
      mensajesEsperados,
      mensajesRecibidos: todosBytes.length,
      mensajesDescartados: descartados + Math.max(0, mensajesEsperados - todosBytes.length - descartados),
      socketsTerminados,
      bytesPorPasoPorCliente: {
        media: todosBytes.length ? todosBytes.reduce((a, b) => a + b, 0) / todosBytes.length : 0,
        p95: percentile(ordenados, 0.95),
      },
      egressTotalBytes: todosBytes.reduce((a, b) => a + b, 0),
      totalStateBytes: desglose.totalStateBytes,
      cumpleTecho120KiB: desglose.totalStateBytes < TECHO_STATE_BYTES,
      desglose,
      miembrosComunidadEnVista: comunidad?.members.length ?? 0,
      miembrosComunidadTotal: comunidad?.memberCount ?? 0,
      contieneIdsLejanos: JSON.stringify(worldMedio.people).includes('"lejos-') || JSON.stringify(worldMedio.communities ?? []).includes('"lejos-'),
    };
  } finally {
    for (const cliente of clientes) { try { cliente.socket.terminate(); } catch { /* ya cerrado */ } }
    if (app) await app.close();
    store.close();
    if (anteriorDataDir === undefined) delete process.env.CARTA_DATA_DIR; else process.env.CARTA_DATA_DIR = anteriorDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Corre el banco sobre varias escalas y compara 1 000 → 10 000 habitantes. */
export async function ejecutarBanco(escalas: readonly number[] = [40, 1000, 10000], opciones: OpcionesBanco = {}): Promise<InformeBancoRed> {
  const resultados: ResultadoEscala[] = [];
  for (const escala of escalas) resultados.push(await medirEscala(escala, opciones));
  const a1000 = resultados.find(r => r.habitantes === 1000);
  const a10000 = resultados.find(r => r.habitantes === 10000);
  let comparacion: InformeBancoRed['comparacion1000a10000'] = null;
  if (a1000 && a10000) {
    const camposAcotados: Record<string, { bytes1000: number; bytes10000: number; ratio: number; acotado: boolean }> = {};
    for (const campo of CAMPOS_ACOTADOS) {
      const bytes1000 = a1000.desglose.campos[campo];
      const bytes10000 = a10000.desglose.campos[campo];
      camposAcotados[campo] = {
        bytes1000, bytes10000,
        ratio: bytes1000 === 0 ? (bytes10000 === 0 ? 1 : Infinity) : bytes10000 / bytes1000,
        // Lineal con la población sería ≈10×; acotado admite ruido de dígitos y redondeo.
        acotado: bytes10000 <= bytes1000 * 1.5 + 1024,
      };
    }
    comparacion = {
      camposAcotados,
      ningunCampoAcotadoCreceLineal: Object.values(camposAcotados).every(c => c.acotado),
      stateMedioBajoTechoEnAmbas: a1000.cumpleTecho120KiB && a10000.cumpleTecho120KiB,
    };
  }
  return { escalas: resultados, comparacion1000a10000: comparacion };
}

export function parseArgsBanco(argv: readonly string[] = process.argv): { clientes: number; escalas: number[]; pasos: number; salida?: string } {
  const valor = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const clientes = Number(valor('--clientes') ?? 12);
  const pasos = Number(valor('--pasos') ?? 5);
  const escalas = (valor('--escalas') ?? '40,1000,10000').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  if (!Number.isInteger(clientes) || clientes < 1 || clientes > 12) throw new Error('--clientes debe ser un entero entre 1 y 12.');
  if (!Number.isInteger(pasos) || pasos < 1) throw new Error('--pasos debe ser un entero positivo.');
  if (!escalas.length) throw new Error('--escalas debe listar al menos una escala positiva.');
  const salida = valor('--salida');
  return { clientes, escalas, pasos, ...(salida ? { salida } : {}) };
}

async function main(): Promise<void> {
  const { clientes, escalas, pasos, salida } = parseArgsBanco();
  const informe = await ejecutarBanco(escalas, { clientes, pasos });
  for (const r of informe.escalas) {
    console.log(`habitantes=${r.habitantes} enVistaMedia=${r.habitantesEnVistaMedia} state=${r.totalStateBytes} B (${(r.totalStateBytes / 1024).toFixed(1)} KiB) bytes/paso/cliente media=${r.bytesPorPasoPorCliente.media.toFixed(0)} p95=${r.bytesPorPasoPorCliente.p95} egress=${r.egressTotalBytes} descartados=${r.mensajesDescartados} socketsTerminados=${r.socketsTerminados} desglose±2%=${r.desglose.dentroDel2Pct}`);
    console.log(`  campos: ${CAMPOS_DESGLOSE.map(c => `${c}=${r.desglose.campos[c]}`).join(' ')} sobrecoste=${r.desglose.sobrecosteBytes}`);
  }
  if (informe.comparacion1000a10000) {
    console.log(`comparación 1000→10000: ningún campo acotado crece lineal=${informe.comparacion1000a10000.ningunCampoAcotadoCreceLineal} stateMedio<120KiB=${informe.comparacion1000a10000.stateMedioBajoTechoEnAmbas}`);
  }
  if (salida) {
    mkdirSync(dirname(salida), { recursive: true });
    writeFileSync(salida, JSON.stringify(informe, null, 2) + '\n');
    console.log(`Informe escrito en ${salida}`);
  }
}

const invocadoDirectamente = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invocadoDirectamente) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
