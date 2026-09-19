import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICKS_PER_DAY, phaseAt } from '../src/world/index.js';
import { tinteDeFase, sombraLarga, brilloAgua, humoDeHogar, type Phase } from '../src/client/luz.js';

const PHASES: readonly Phase[] = ['dawn', 'day', 'dusk', 'night'];
// Puntos intermedios reales de cada fase (no los bordes), usando los cortes conocidos de phaseAt.
const PHASE_BOUNDS_MID = { dawn: 150, day: 900, dusk: 1650, night: 2100 };

test('tinteDeFase no da saltos mayores a 0,05 (normalizado) entre ticks consecutivos, ni siquiera cruzando de fase', () => {
  let previous = tinteDeFase(phaseAt(0), 0);
  for (let tick = 1; tick < TICKS_PER_DAY; tick++) {
    const current = tinteDeFase(phaseAt(tick), tick);
    assert.ok(Math.abs(current.r - previous.r) / 255 <= 0.05, `salto de r en tick ${tick}`);
    assert.ok(Math.abs(current.g - previous.g) / 255 <= 0.05, `salto de g en tick ${tick}`);
    assert.ok(Math.abs(current.b - previous.b) / 255 <= 0.05, `salto de b en tick ${tick}`);
    assert.ok(Math.abs(current.a - previous.a) <= 0.05, `salto de alpha en tick ${tick}`);
    previous = current;
  }
  // El ciclo cierra: el último tick del día debe seguir cerca del primero (tick 0 envuelto).
  const wrapped = tinteDeFase(phaseAt(0), TICKS_PER_DAY);
  assert.ok(Math.abs(wrapped.a - previous.a) <= 0.05, 'salto de alpha al envolver tick 2400 -> 0');
});

test('tinteDeFase mantiene alpha en [0, 0.45] en toda fase y todo tick del día, con caracter propio por fase', () => {
  for (const phase of PHASES) for (let tick = 0; tick < TICKS_PER_DAY; tick += 37) {
    const tinte = tinteDeFase(phase, tick);
    assert.ok(tinte.a >= 0 && tinte.a <= 0.45, `alpha fuera de rango en ${phase}@${tick}: ${tinte.a}`);
    assert.ok(tinte.r >= 0 && tinte.r <= 255 && tinte.g >= 0 && tinte.g <= 255 && tinte.b >= 0 && tinte.b <= 255);
  }
  // Amanecer y atardecer cálidos (rojo domina), noche azulada (azul domina sobre rojo), día casi sin tinte.
  const dawn = tinteDeFase('dawn', PHASE_BOUNDS_MID.dawn), dusk = tinteDeFase('dusk', PHASE_BOUNDS_MID.dusk);
  const day = tinteDeFase('day', PHASE_BOUNDS_MID.day), night = tinteDeFase('night', PHASE_BOUNDS_MID.night);
  assert.ok(dawn.r > dawn.b, 'el amanecer debe ser cálido');
  assert.ok(dusk.r > dusk.b, 'el atardecer debe ser cálido');
  assert.ok(night.b > night.r, 'la noche debe ser azulada');
  assert.ok(day.a < dawn.a && day.a < dusk.a && day.a < night.a, 'el día debe ser el más neutro (menor alpha)');
});

test('tinteDeFase, sombraLarga, brilloAgua y humoDeHogar son deterministas', () => {
  assert.deepEqual(tinteDeFase('dusk', 1650), tinteDeFase('dusk', 1650));
  assert.deepEqual(sombraLarga('day', 900), sombraLarga('day', 900));
  assert.equal(brilloAgua(500, 12, -7, 'rain'), brilloAgua(500, 12, -7, 'rain'));
  assert.deepEqual(humoDeHogar(300, 42), humoDeHogar(300, 42));
});

test('sombraLarga es nula de noche, y de día tiene longitud larga al ras y opacidad real (nunca ausente) al mediodía', () => {
  for (let tick = 1800; tick < TICKS_PER_DAY; tick += 53) {
    assert.deepEqual(sombraLarga('night', tick), { dx: 0, dy: 0, alpha: 0 });
  }
  const morning = sombraLarga('dawn', 300); // borde amanecer/día: ángulo solar rasante, sombra larga
  const noon = sombraLarga('day', 900); // mediodía solar: sombra corta, NO ausente
  assert.ok(Math.abs(morning.dx) > Math.abs(noon.dx), 'la sombra a media mañana debe ser más larga que al mediodía');
  // Cota inferior real (antes `noon` daba exactamente {-0,0,0} y estas dos aserciones
  // pasaban por construcción sin poder distinguir "sombra corta" de "sombra ausente").
  assert.ok(noon.alpha > 0, 'la opacidad al mediodía debe ser real, no cero');
  assert.ok(noon.dy > 0, 'la sombra debe tener extensión vertical real al mediodía, no cero');
  assert.ok(noon.alpha > morning.alpha, 'la opacidad crece con la luz directa y es máxima al mediodía, como visual-state.ts::daylightAt (shadowAlpha = sun·0.2)');
  for (let tick = 0; tick < 1800; tick += 41) {
    const sombra = sombraLarga(phaseAt(tick), tick);
    assert.ok(sombra.alpha >= 0 && sombra.alpha <= 0.4);
    assert.ok(Math.abs(sombra.dx) <= 10.001 && Math.abs(sombra.dy) <= 3.501);
  }
});

test('brilloAgua está en [0,1], es periódico y la lluvia acorta el período', () => {
  for (let tick = 0; tick < 500; tick += 17) {
    const value = brilloAgua(tick, 3, 8, 'clear');
    assert.ok(value >= 0 && value <= 1);
  }
  const CLEAR_PERIOD = 240, RAIN_PERIOD = 90;
  for (const tick of [0, 5, 100, 239]) {
    assert.ok(Math.abs(brilloAgua(tick, 4, 4, 'clear') - brilloAgua(tick + CLEAR_PERIOD, 4, 4, 'clear')) < 1e-9);
    assert.ok(Math.abs(brilloAgua(tick, 4, 4, 'rain') - brilloAgua(tick + RAIN_PERIOD, 4, 4, 'rain')) < 1e-9);
  }
  // Clima distinto -> misma celda no repite exactamente cada RAIN_PERIOD bajo 'clear' (frecuencias distintas).
  assert.notEqual(brilloAgua(10, 4, 4, 'clear'), brilloAgua(10 + RAIN_PERIOD, 4, 4, 'clear'));
  // Celdas distintas están desfasadas de forma determinista (no todas titilan a la par).
  assert.notEqual(brilloAgua(30, 1, 1, 'clear'), brilloAgua(30, 2, 5, 'clear'));
});

test('humoDeHogar da entre 3 y 5 partículas deterministas por semilla, cada una en rangos sanos', () => {
  for (const seed of [1, 42, 999, 123456]) {
    const particles = humoDeHogar(0, seed);
    assert.ok(particles.length >= 3 && particles.length <= 5, `semilla ${seed} dio ${particles.length} partículas`);
    // El número de partículas es propio de la semilla (la chimenea), no cambia con el tick.
    assert.equal(humoDeHogar(777, seed).length, particles.length);
    for (const p of particles) {
      assert.ok(p.alpha >= 0 && p.alpha <= 0.35);
      assert.ok(Math.abs(p.dx) <= 1.501);
      assert.ok(p.dy <= 0 && p.dy >= -12);
    }
  }
  // Semillas distintas producen humo distinto (no hay un único patrón fijo).
  assert.notDeepEqual(humoDeHogar(50, 1), humoDeHogar(50, 2));
});
