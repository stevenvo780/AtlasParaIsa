import assert from 'node:assert/strict';
import test from 'node:test';
import { leyInteracciones } from '../src/world/actuar/interacciones.js';
import type { CtxLey } from '../src/world/motor/acceso.js';
import { REF_NULA, TipoIntento, refDe, type Buzon, type Intento } from '../src/world/motor/contratos.js';
import type { Person } from '../src/world/mundo/tipos.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';

test('S e I leen la misma compañía publicada y el vínculo de I llega por el buzón de su dueño', () => {
  const [nombre, tipo, ancho] = leyInteracciones.columnas![0];
  assert.equal(tipo, 'u8');
  assert.equal(ancho, 1);
  const compania = new Uint8Array(2);
  const frente = {
    alta: 2, vivo: Uint8Array.of(1, 1), gen: Int32Array.of(5, 3),
    uid: Float64Array.of(1, 2), x: Float32Array.of(15, 16), y: Float32Array.of(0, 0),
    dueno: Int32Array.of(0, 1),
    col(c: string) { assert.equal(c, nombre); return compania; },
  };
  const tick = 300;
  const parametros = { ...DEFAULT_PARAMS, social: { ...DEFAULT_PARAMS.social, vinculoEncuentro: 1 } };
  const mensaje: [number, Intento][] = [], sucesos: string[] = [];
  const dueños = (['S', 'I'] as const).map((role, slot) => {
    const p = {
      id: role.toLowerCase(), role, x: frente.x[slot], y: frente.y[slot], action: 'rest', socialLoad: 0,
      fatigue: 0.2, closeness: 0.5, lastMeeting: 0, bonds: {} as Person['bonds'],
      partnerMemory: undefined as Person['partnerMemory'], experiences: [] as Person['experiences'],
    };
    const buzon = { enviar(destino, i) { mensaje.push([destino, i]); } } satisfies Pick<Buzon, 'enviar'>;
    const c = {
      tick, hilo: slot, frente, mundo: { tick, places: [], adaptationEnabled: false }, params: parametros, buzon,
      personas: new Map([[slot, p]]),
      escritura: { u8(c: string) { assert.equal(c, nombre); return compania; } },
      ref: (uid: number) => uid > 0 ? refDe(uid - 1, frente.gen[uid - 1]) : REF_NULA,
      uidDe: (id: string) => id === 's' ? 1 : id === 'i' ? 2 : 0,
      idDe: (uid: number) => uid === 1 ? 's' : uid === 2 ? 'i' : undefined,
      id: () => 17,
      suceso: (e: { kind: string }) => { sucesos.push(e.kind); return 'encuentro-1'; },
    } as unknown as CtxLey;
    return { c, p };
  });
  const [s, i] = dueños;
  dueños.forEach(({ c }) => leyInteracciones.F6!(c));
  assert.deepEqual([...compania], [1, 1]);
  dueños.forEach(({ c }) => leyInteracciones.F4!(c));

  assert.equal(s.p.lastMeeting, tick);
  assert.equal(i.p.lastMeeting, tick);
  assert.equal(s.p.fatigue, i.p.fatigue);
  assert.deepEqual(sucesos, ['meeting']);
  assert.equal(s.p.experiences[0].causeId, 'encuentro-1');
  assert.equal(s.p.bonds.i, 0.2 + 0.08);
  assert.equal(i.p.bonds.s, undefined);
  assert.equal(mensaje.length, 1);
  const [[destino, intento]] = mensaje;
  assert.equal(destino, 1);
  assert.equal(intento.tipo, TipoIntento.Vincular);
  assert.equal(intento.a, refDe(1, 3));
  assert.equal(leyInteracciones.aplicar!.Vincular!(i.c, intento), 'hecho');
  assert.equal(i.p.bonds.s, 0.2 + 0.08);
});
