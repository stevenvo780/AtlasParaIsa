/**
 * Carril w, funciones puras: el freno de nutrientes, la luz de una ventana, la calibración de las constantes nuevas, el
 * sorteo del tiempo y lo que las funciones heredadas del ecosistema hacen con y sin el puente material. No levanta
 * ningún mundo ni da pasos.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tile } from '../src/shared/types.js';
import { PROB_LLUVIA } from '../src/world/ecologia-constantes.js';
import { sortearTiempo } from '../src/world/clima.js';
import { asentarHuella, cultivateTile, enlazarMateria, harvestMaterial, rasgoPorMadera, rasgoPorPiedra, trampleTile } from '../src/world/ecosystem.js';
import { kappaDeRol } from '../src/world/materia/ley-mundo.js';
import { FISICA, LUZ_MEDIA, NOMBRE_CUENTA, CUENTA, calibrar, liebig, luzDe, luzMedia, sustanciasMundo } from '../src/world/materia/mundo.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { Rol } from '../src/world/materia/tipos.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';

const tesela = (mas: Partial<Tile> = {}): Tile => ({ x: 0, y: 0, terrain: 'grass', moisture: 0.5, vegetation: 0.5, food: 0.2, ...mas } as Tile);

test('Liebig: manda el nutriente que falta y la fijación solo cubre una parte del N', () => {
  assert.deepEqual(liebig(0.8, 0.3, 0.05), { suelo: 0.3, fijado: 0 }, 'falta P: la fijación no añade nada');
  const sinN = liebig(0, 0.9, 0.05);
  assert.equal(sinN.suelo, 0);
  assert.ok(Math.abs(sinN.fijado - 0.05) < 1e-12, 'sin N mineral solo queda lo que fija el N₂');
  const medio = liebig(0.5, 0.9, 0.05);
  assert.ok(Math.abs(medio.suelo + medio.fijado - 0.525) < 1e-12);
  for (let k = 0; k <= 10; k++) {
    const f = liebig(k / 10, 0.7, 0.05);
    assert.ok(f.suelo >= 0 && f.fijado >= 0 && f.suelo + f.fijado <= 0.7 + 1e-12, 'nunca pasa del nutriente más escaso');
  }
});

test('la luz media de un día entero es la del reloj del mundo y la de una ventana es la media de sus ticks', () => {
  assert.ok(Math.abs(luzMedia(0, TICKS_PER_DAY) - LUZ_MEDIA) < 1e-12);
  assert.equal(luzMedia(100, 100), luzDe(100));
  assert.ok(Math.abs(luzMedia(40, 43) - (luzDe(41) + luzDe(42) + luzDe(43)) / 3) < 1e-12);
});

test('la calibración da las constantes nuevas del agua y de los nutrientes con sentido físico', async () => {
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const p = calibrar(q, sustanciasMundo(q));
  assert.ok(p.llenadoCielo > 0 && p.llenadoCielo < 1, `llenado del cielo en régimen ${p.llenadoCielo}`);
  assert.ok(p.tauMar > p.tauLluvia, 'el cielo se vacía lloviendo más deprisa de lo que el mar lo llena');
  assert.ok(p.kmN > 0 && p.kmP > 0 && p.gManantial > 0 && p.gCharca > 0);
  assert.equal(p.reparto, 'strang');
  for (const o of ['hoja', 'fruto', 'tronco'] as const) assert.ok(p.crecimiento[o] > 0 && p.caida[o] > 0, o);
  // Con otra semisaturación cambia el freno de referencia y, con él, el crecimiento que deja el mismo equilibrio.
  const laxo = calibrar(q, sustanciasMundo(q), { ...FISICA, semisaturacionN: 0.1, semisaturacionP: 0.1 });
  assert.ok(laxo.crecimiento.hoja < p.crecimiento.hoja);
  await q.cerrar();
});

test('cada cuenta escalar tiene nombre con su unidad', () => {
  assert.equal(NOMBRE_CUENTA.length, CUENTA.EXTERIOR_AT);
  for (const nombre of NOMBRE_CUENTA) assert.match(nombre, /\((J|cuantos de tejido|mmol de (H₂O|átomos))\)$/);
});

test('la catálisis sale del rol: solo el suelo y el cadáver descomponen', () => {
  for (const rol of Object.values(Rol)) {
    const k = kappaDeRol(rol);
    assert.equal(k.some((x) => x > 0), rol === Rol.Suelo || rol === Rol.Cadaver);
  }
});

test('el tiempo se sortea contra PROB_LLUVIA y solo se cuenta cuando cambia', () => {
  const mundo: { weather: 'clear' | 'rain' } = { weather: 'clear' }, avisos: string[] = [];
  const avisar = (e: { text: string }) => { avisos.push(e.text); };
  sortearTiempo(mundo, PROB_LLUVIA - 1e-9, avisar);
  assert.equal(mundo.weather, 'rain');
  sortearTiempo(mundo, 0, avisar);
  sortearTiempo(mundo, PROB_LLUVIA, avisar);
  assert.equal(mundo.weather, 'clear');
  assert.equal(avisos.length, 2);
});

test('la huella, el firme y el cultivo decaen lo mismo que en el paso heredado y no añaden campos', () => {
  const t = tesela({ traffic: 0.5, cultivation: 0.3 });
  asentarHuella(t, 60, false);
  assert.ok(Math.abs(t.traffic! - (0.5 - 6 * 0.0005)) < 1e-12 && Math.abs(t.cultivation! - (0.3 - 6 * 0.00002)) < 1e-12);
  const limpia = tesela();
  asentarHuella(limpia, 60, true);
  assert.ok(!('traffic' in limpia) && !('cultivation' in limpia) && !('paved' in limpia));
  const camino = tesela({ traffic: 0.04, paved: 0.002 });
  asentarHuella(camino, 20, true);
  assert.ok(Math.abs(camino.traffic! - (0.04 - 2 * 0.00005)) < 1e-12);
  assert.ok(Math.abs(camino.paved! - 0.001) < 1e-12, 'el firme sin tránsito se deshace');
});

test('el rasgo que se ve sigue a la madera y a la piedra que quedan', () => {
  const tocon = tesela({ feature: 'stump', wood: 1.2, biome: 'forest' });
  rasgoPorMadera(tocon);
  assert.equal(tocon.feature, 'tree');
  const talado = tesela({ feature: 'pine', wood: 0 });
  rasgoPorMadera(talado);
  assert.equal(talado.feature, 'stump');
  const cantera = tesela({ feature: 'rock', stone: 0 });
  rasgoPorPiedra(cantera);
  assert.equal(cantera.feature, 'none');
});

test('talar, pisar y labrar pasan por el puente material cuando la tesela es suya y, si no, valen los escalares', () => {
  const mia = tesela({ wood: 5, feature: 'tree' }), ajena = tesela({ x: 9, wood: 5, feature: 'tree' }), actos: string[] = [];
  enlazarMateria({
    extraer(t, material, cantidad) { if (t !== mia) return undefined; actos.push(`${material} ${cantidad}`); t.wood = 0; return 5; },
    pisar(t, vegetacion) { if (t !== mia) return false; actos.push(`pisar ${vegetacion}`); return true; },
    cultivar(t, fertilidad, vegetacion) { if (t !== mia) return false; actos.push(`labrar ${fertilidad} ${vegetacion}`); return true; },
  });
  try {
    assert.equal(harvestMaterial(mia, 'wood', 8), 5);
    assert.equal(mia.feature, 'stump');
    assert.equal(mia.vegetation, 0.5, 'la vegetación ya no se toca a mano: es una vista');
    assert.equal(harvestMaterial(ajena, 'wood', 2), 2);
    assert.ok(Math.abs(ajena.vegetation - (0.5 - 2 * 0.025)) < 1e-12, 'fuera del mundo material sigue la ley escalar');
    trampleTile(mia); trampleTile(ajena);
    assert.equal(mia.vegetation, 0.5);
    assert.ok(mia.traffic! > 0, 'la huella no es materia: se sigue anotando en la tesela');
    assert.ok(ajena.vegetation < 0.45);
    assert.ok(cultivateTile(mia));
    assert.equal(mia.vegetation, 0.5);
    assert.deepEqual(actos, ['wood 8', 'pisar 0.003', 'labrar 0.06 0.04']);
  } finally { enlazarMateria(undefined); }
});
