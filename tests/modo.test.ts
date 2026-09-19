import test from 'node:test';
import assert from 'node:assert/strict';
import { decidirModo, setModo, type Modo } from '../src/client/modo.js';

/** Storage mínimo en memoria: basta para lo que `modo.ts` usa de `Storage`. */
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); }, clear: () => data.clear(), key: () => null, get length() { return data.size; } } as Storage;
}

interface Env { query?: string; small?: boolean; memory?: number; webgl2?: boolean; noDocument?: boolean; storage?: Storage }

/** Sustituye los globales que `decidirModo` consulta y devuelve cómo restaurarlos. */
function stub(env: Env) {
  const keys = ['location', 'localStorage', 'matchMedia', 'navigator', 'document'] as const;
  const originals = Object.fromEntries(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const storage = env.storage ?? memoryStorage();
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: env.query ? `?${env.query}` : '' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (_query: string) => ({ matches: !!env.small }) });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { deviceMemory: env.memory } });
  if (env.noDocument) Reflect.deleteProperty(globalThis, 'document');
  else Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: (kind: string) => (kind === 'webgl2' && env.webgl2 !== false ? {} : null) }) } });
  return {
    storage,
    restore(): void {
      for (const key of keys) { const desc = originals[key]; if (desc) Object.defineProperty(globalThis, key, desc); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

function withEnv(env: Env, run: () => void): void {
  const h = stub(env);
  try { run(); } finally { h.restore(); }
}

const capaz: Env = { small: false, memory: 8, webgl2: true }; // escritorio típico: nada obliga a observador.

test('decidirModo — tabla de casos', () => {
  const casos: { nombre: string; env: Env; esperado: Modo }[] = [
    { nombre: 'escritorio capaz sin señal alguna de móvil ligero → completo', env: capaz, esperado: 'completo' },
    { nombre: 'pantalla ≤ 700px sin elección previa → observador', env: { ...capaz, small: true }, esperado: 'observador' },
    { nombre: 'navigator.deviceMemory < 4 → observador', env: { ...capaz, memory: 2 }, esperado: 'observador' },
    { nombre: 'deviceMemory === 4 (límite inclusivo del lado capaz) → completo', env: { ...capaz, memory: 4 }, esperado: 'completo' },
    { nombre: 'sin WebGL2 → observador', env: { ...capaz, webgl2: false }, esperado: 'observador' },
    { nombre: 'sin `document` (sin DOM comprobable) → observador, conservador', env: { ...capaz, noDocument: true }, esperado: 'observador' },
    { nombre: '?modo=observador manda aunque el dispositivo sea capaz', env: { ...capaz, query: 'modo=observador' }, esperado: 'observador' },
    { nombre: '?modo=completo manda aunque el dispositivo sea pobre', env: { small: true, memory: 1, webgl2: false, query: 'modo=completo' }, esperado: 'completo' },
    { nombre: '?modo= con valor desconocido se ignora (cae a heurística)', env: { ...capaz, query: 'modo=turbo' }, esperado: 'completo' },
  ];
  for (const caso of casos) withEnv(caso.env, () => assert.equal(decidirModo(), caso.esperado, caso.nombre));
});

test('la última elección explícita se recuerda sin volver a mirar la heurística del dispositivo', () => {
  const storage = memoryStorage();
  withEnv({ ...capaz, storage }, () => { setModo('observador'); assert.equal(decidirModo(), 'observador'); });
  // Nueva "visita": dispositivo capaz de sobra, pero la elección guardada sigue mandando.
  withEnv({ ...capaz, storage }, () => assert.equal(decidirModo(), 'observador'));
});

test('un `?modo=` válido se persiste para que la próxima visita (sin query) lo recuerde', () => {
  const storage = memoryStorage();
  withEnv({ ...capaz, storage, query: 'modo=observador' }, () => assert.equal(decidirModo(), 'observador'));
  withEnv({ ...capaz, storage }, () => assert.equal(decidirModo(), 'observador', 'debe recordarlo aunque el dispositivo ya no lo sugiera'));
});

test('setModo tolera la ausencia de localStorage (privacidad/almacenamiento bloqueado)', () => {
  withEnv({ ...capaz, noDocument: false }, () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    assert.doesNotThrow(() => setModo('observador'));
    assert.doesNotThrow(() => decidirModo());
  });
});
