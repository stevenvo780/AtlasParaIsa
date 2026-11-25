import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ayudas de las pruebas del panel: un árbol de código mínimo (un mundo de juguete con la misma interfaz que el real,
 * en un repositorio git temporal) para probar la caché, la parada temprana y los puntos guardados en segundos. */
export const PANEL = fileURLToPath(new URL('../scripts/lab/panel.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

export const temporal = (): string => { mkdirSync('/tmp/atlas-v23-panel', { recursive: true }); return mkdtempSync('/tmp/atlas-v23-panel/prueba-'); };

const FICHEROS: Record<string, string> = {
  'package.json': '{ "type": "module" }\n',
  'src/world/params.ts': `
export const DEFAULT_PARAMS = { mundo: { gente: 6, natalidad: 2, mortalidad: 1, extincionDia: 0, fallaEnDia: 0 }, motor: { hilos: 1, gpu: [] as number[] } };
const mezclar = (base: any, extra: any): any => {
  const copia = structuredClone(base);
  const entrar = (destino: any, origen: any) => { for (const [k, v] of Object.entries(origen)) { if (v && typeof v === 'object' && !Array.isArray(v)) entrar(destino[k] ??= {}, v); else destino[k] = v; } };
  entrar(copia, extra); return copia;
};
export type WorldParams = typeof DEFAULT_PARAMS;
export const parseParams = (entrada?: any, base: WorldParams = DEFAULT_PARAMS): WorldParams => entrada === undefined ? base : mezclar(base, entrada);
const fijados = new WeakMap<object, WorldParams>();
export const setParams = (mundo: object, params: WorldParams) => { fijados.set(mundo, params); };
export const paramsOf = (mundo: object): WorldParams => fijados.get(mundo) ?? DEFAULT_PARAMS;
`,
  'src/world/index.ts': `
import { paramsOf, setParams, type WorldParams } from './params.js';
export const TICKS_PER_DAY = 2400, RULES_VERSION = 1;
export const createWorld = (semilla: number, params: WorldParams): any => {
  const mundo: any = { version: 1, seed: semilla, rng: semilla >>> 0, tick: 0, people: [], totals: { births: 0 }, tiles: [{ x: 0, y: 0, vegetation: 0.5 }],
    demographyDynamics: { deaths: 0, causes: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 } }, communities: [], structures: [], animals: [], retiredChunks: [], chunks: {} };
  setParams(mundo, params);
  for (let i = 0; i < params.mundo.gente; i++) mundo.people.push({ id: 'neighbor-' + i, role: 'neighbor' });
  return mundo;
};
const azar = (mundo: any): number => { mundo.rng = (Math.imul(mundo.rng, 1664525) + 1013904223) >>> 0; return mundo.rng / 4294967296; };
export const stepWorld = (mundo: any): void => {
  mundo.tick++;
  azar(mundo);
  if (mundo.tick % TICKS_PER_DAY !== 0) return;
  const dia = mundo.tick / TICKS_PER_DAY, m = paramsOf(mundo).mundo;
  if (m.fallaEnDia === dia) throw new Error('falla pedida');
  for (let n = Math.floor(azar(mundo) * (m.natalidad + 1)); n > 0; n--) { mundo.people.push({ id: 'neighbor-n' + mundo.totals.births, role: 'neighbor' }); mundo.totals.births++; }
  for (let n = Math.min(mundo.people.length, Math.floor(azar(mundo) * (m.mortalidad + 1))); n > 0; n--) { mundo.people.pop(); mundo.demographyDynamics.deaths++; mundo.demographyDynamics.causes.starvation++; }
  mundo.tiles[0].vegetation = (mundo.tiles[0].vegetation + azar(mundo)) / 2;
  if (m.extincionDia === dia) { mundo.demographyDynamics.deaths += mundo.people.length; mundo.demographyDynamics.causes.starvation += mundo.people.length; mundo.people = []; }
};
export const assertWorld = (mundo: any, version: number): void => { if (mundo.version !== version) throw new Error('versión'); };
`,
  'src/world/spatial.ts': 'export const bindWorldContext = (_mundo: object, _contexto: object): void => {};\n',
  'src/world/diversidad.ts': 'export const indiceDiversidad = (mundo: any) => ({ total: mundo.people.length / 10 });\n',
  'src/server/hardware-limits.ts': "import { DEFAULT_PARAMS, parseParams } from '../world/params.js';\nexport const hostOpenWorldParams = () => parseParams({ mundo: { gente: 8 } }, DEFAULT_PARAMS);\n",
};

const git = (raiz: string, ...args: string[]) => execFileSync('git', ['-C', raiz, '-c', 'user.name=prueba', '-c', 'user.email=prueba@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Un árbol de código de juguete confirmado en git. `cambios` sustituye o añade ficheros antes del commit. */
export function crearRaiz(base: string, nombre: string, cambios: Record<string, string> = {}): string {
  const raiz = join(base, nombre);
  for (const [ruta, texto] of Object.entries({ ...FICHEROS, ...cambios })) { mkdirSync(join(raiz, ruta, '..'), { recursive: true }); writeFileSync(join(raiz, ruta), texto); }
  git(raiz, 'init', '-q'); git(raiz, 'add', '-A'); git(raiz, 'commit', '-qm', 'base');
  return raiz;
}
export const confirmar = (raiz: string, ruta: string, texto: string, mensaje = 'cambio') => { writeFileSync(join(raiz, ruta), texto); git(raiz, 'add', '-A'); git(raiz, 'commit', '-qm', mensaje); };

export interface Resultado { codigo: number | null; ms: number; stdout: string; stderr: string; salida: Record<string, any> }
const entorno = { ...process.env, CARTA_PANEL_CACHE: '' };
const resultado = (codigo: number | null, ms: number, stdout: string, stderr: string): Resultado => ({ codigo, ms, stdout, stderr, salida: stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)!) : {} });
export function correrPanel(args: string[]): Resultado {
  const t0 = Date.now(), r = spawnSync(process.execPath, ['--import', TSX, PANEL, ...args], { encoding: 'utf8', env: entorno, maxBuffer: 1 << 28 });
  return resultado(r.status, Date.now() - t0, r.stdout, r.stderr);
}
export const correrPanelAsync = (args: string[]): Promise<Resultado> => new Promise(cumplir => {
  const t0 = Date.now(), hijo = spawn(process.execPath, ['--import', TSX, PANEL, ...args], { env: entorno });
  let stdout = '', stderr = '';
  hijo.stdout.on('data', b => { stdout += String(b); }); hijo.stderr.on('data', b => { stderr += String(b); });
  hijo.once('close', codigo => cumplir(resultado(codigo, Date.now() - t0, stdout, stderr)));
});

export type Fila = Record<string, any>;
export const leerFilas = (ruta: string): Fila[] => readFileSync(ruta, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
export const leerTexto = (ruta: string): string => readFileSync(ruta, 'utf8');
const TIEMPOS = ['ticksPorSegundo', 'pasoP95Ms', 'pasoMaxMs', 'rssMiB'];
/** Las filas de censo sin los campos que dependen del reloj o de la memoria del proceso. */
export const biologia = (filas: Fila[]): Fila[] => filas.filter(f => f.tipo === 'censo' || f.tipo === 'violacion').map(f => Object.fromEntries(Object.entries(f).filter(([k]) => !TIEMPOS.includes(k))));
export const sinMarca = (texto: string): string => texto.split('\n').filter(Boolean).map(l => { const f = JSON.parse(l); if (f.tipo === 'inicio') delete f.cache; return JSON.stringify(f); }).join('\n') + '\n';
