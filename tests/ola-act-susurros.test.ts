import test from 'node:test';
import assert from 'node:assert/strict';
import { ALCANCE_VOZ, CAIDA_AUDIBLE, RADIO_AUDIBLE, audibilidad, enqueueWhisper, oyentesDeArreglo, stepWhispers, stepWhispersCon,
  type OyentesSusurro, type WhisperPersonLike, type WhisperRecord } from '../src/world/whispers.js';

function oyente(id: string, x: number, y: number): WhisperPersonLike {
  return { id, name: id, x, y, hunger: 0.1, thirst: 0.1, fatigue: 0.1, genome: { alleles: Array<number>(16).fill(0.9) } };
}

function cola(): WhisperRecord[] {
  const ws: WhisperRecord[] = [];
  for (let k = 0; k < 6; k++) enqueueWhisper(ws, { x: 10 * k, y: 3, intent: 'explore' }, 0, 1);
  return ws;
}

test('stepWhispersCon sobre el arreglo da lo mismo que stepWhispers', () => {
  const gente = Array.from({ length: 40 }, (_, i) => oyente(`p${i}`, (i * 7) % 61, (i * 11) % 17));
  const a = cola(), b = cola();
  for (let tick = 10; tick <= 3000; tick += 10) {
    const ra = stepWhispers(a, gente, tick, 7);
    const rb = stepWhispersCon(b, oyentesDeArreglo(gente), tick, 7);
    assert.deepEqual(rb.heard.map(h => [h.whisper.id, h.person.id]), ra.heard.map(h => [h.whisper.id, h.person.id]));
    assert.deepEqual(rb.faded.map(f => [f.whisper.id, f.reason]), ra.faded.map(f => [f.whisper.id, f.reason]));
  }
  assert.deepEqual(b, a);
});

test('el radio del índice espacial es donde la voz cae a CAIDA_AUDIBLE', () => {
  assert.ok(Math.abs(audibilidad(RADIO_AUDIBLE) - CAIDA_AUDIBLE) < 1e-12);
  assert.ok(RADIO_AUDIBLE > ALCANCE_VOZ);
});

test('un regional solo lo oye quien la fuente de oyentes deja cerca', () => {
  const lejos = oyente('lejos', 0, 0), cerca = oyente('cerca', 500, 500);
  const fuente: OyentesSusurro = {
    porId: id => (id === 'lejos' ? lejos : id === 'cerca' ? cerca : undefined),
    cerca: (x, y, f) => { for (const p of [lejos, cerca]) if (Math.hypot(p.x - x, p.y - y) <= RADIO_AUDIBLE) f(p); },
  };
  const ws: WhisperRecord[] = [];
  enqueueWhisper(ws, { x: 500, y: 501, intent: 'travel' }, 0, 1);
  for (let tick = 10; tick <= 7000 && ws[0]!.status === 'latent'; tick += 10) stepWhispersCon(ws, fuente, tick, 3);
  assert.equal(ws[0]!.status, 'heard');
  assert.equal(ws[0]!.heardById, 'cerca');
});
