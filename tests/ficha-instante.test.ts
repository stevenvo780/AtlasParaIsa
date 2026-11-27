/** Inspector de habitante: el instante abierto manda. Cero grabado se ve; lo ausente no se rellena. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SustanciaVista } from '../src/shared/materia.js';
import type { PersonView, WorldView } from '../src/shared/types.js';
import type { CuerpoVisible } from '../src/shared/vistas-v23.js';
import { cuerpoFicha, cuerpoPersonaFicha, decisionFicha, fichaMateriales, inheritedAndLearned, necesidadesPersona } from '../src/client/inspector-view.js';
import { renderPersonTelemetry } from '../src/client/telemetry-hud.js';

const mundo = (people: PersonView[] = []): WorldView =>
  ({ version: 10, sequence: 1, tick: 32, day: 1, phase: 'day', weather: 'clear', width: 8, height: 8, tiles: [], people, places: [], events: [], memories: [] }) as WorldView;

function persona(extra: Partial<PersonView> = {}): PersonView {
  return { id: 'nara', name: 'Nara', role: 'neighbor', x: 3, y: 4, color: '#abc', action: 'explore', reason: 'Recorre el terreno.', need: 'Recorrer', recentMemory: null, ...extra } as PersonView;
}

/** Lo que el clic arma en Ahora: necesidades, telemetría y secciones de causa, escucha, cuerpo y ciclo. */
function ahora(p: PersonView, view = mundo([p])): string {
  const sections = inheritedAndLearned({ ...p, working: false }, view, undefined, null);
  return `${necesidadesPersona(p)}${renderPersonTelemetry(p)}${sections.now}`;
}

const huecos = /data-meter="no-grabado"|no grabado|Salud<strong>—|Vitalidad<strong>—|Edad<strong>—|Gen<strong>—|Reserva<strong>—|Madera<strong>—|Piedra<strong>—|Sin habilidades practicadas recibidas|Compartir<strong>—|Cuidado<strong>—|Apertura<strong>—|no hereda todavía|no trae cuerpos|carece de cuerpos|no llegó completo/;

test('L1: solo necesidad y etapa, una nota de detalle completo, sin huecos ni otro habitante', () => {
  const resumida = persona({ lifeStage: 'senescent' });
  delete (resumida as { energy?: number }).energy;
  delete (resumida as { hunger?: number }).hunger;
  delete (resumida as { fatigue?: number }).fatigue;
  const otra = persona({ id: 'otra', name: 'Otra', energy: 1, hunger: 1, fatigue: 1, health: 1, age: 10, lifeStage: 'adult' });
  const view = mundo([resumida, otra]);
  const html = ahora(resumida, view);
  const sections = inheritedAndLearned(resumida, view, undefined, null);
  assert.match(html, /Ahora necesita recorrer/);
  assert.match(html, /Etapa<strong>Mayor/);
  assert.match(html, /Etapa del modelo<\/span><strong>Vejez/);
  assert.match(html, /data-detail="decision"/);
  assert.match(html, /data-detail="vitality"/);
  assert.equal((html.match(/data-grabacion="resumida"/g) ?? []).length, 1);
  assert.match(html, /fotograma detallado/);
  assert.doesNotMatch(sections.kit, /data-grabacion="resumida"/);
  assert.doesNotMatch(sections.story, /data-grabacion="resumida"/);
  assert.doesNotMatch(html, huecos);
  assert.doesNotMatch(html, /100%/);
  assert.doesNotMatch(html, /data-escucha/);
  assert.doesNotMatch(html, /data-cuerpo-ficha/);
  assert.doesNotMatch(html, /data-detail="skills"/);
  assert.match(fichaMateriales(resumida), /data-materiales="no-grabado"/);
});

test('ceros grabados se ven y no disparan la nota de grabación resumida', () => {
  const p = persona({
    energy: 0, hunger: 0, thirst: 0, fatigue: 0, health: 0, vitality: 0, age: 0, lifeStage: 'adult',
    genome: { generation: 0, parents: [], learningRate: 0, cooperation: 0, mutations: 0 },
    foodReserve: 0, foodReserveCapacity: 0, materials: { wood: 0, stone: 0 },
    skills: { farm: 0, care: 0 }, culture: { sharing: 0, stewardship: 0, openness: 0 },
    working: true, workProgress: 0,
  });
  const html = `${necesidadesPersona(p)}${renderPersonTelemetry(p)}${inheritedAndLearned(p, mundo([p]), undefined, null).now}`;
  assert.doesNotMatch(html, /data-grabacion="resumida"|data-meter="no-grabado"|no grabado/);
  for (const texto of ['Energía', 'Hambre', 'Sed', 'Cansancio', 'Salud', 'Vitalidad', '0 pasos', 'G0', '0 / 0', 'Cultivo', 'Compartir', 'Cuidado', 'Apertura']) assert.match(html, new RegExp(texto));
  assert.ok(html.includes('>0%<') || html.includes('>0%</'), html);
  assert.match(html, /Trabajo en curso <strong>0%/);
  assert.match(inheritedAndLearned(p, mundo([p])).kit, /data-detail="skills"[\s\S]*0%/);
  assert.match(fichaMateriales(p), /data-cero="si"/);
});

test('un cero no rellena el campo vecino ausente, y la reserva a medias nombra solo la mitad que hay', () => {
  const p = persona({ hunger: 0, lifeStage: 'juvenile', foodReserve: 0 });
  delete (p as { energy?: number }).energy;
  delete (p as { fatigue?: number }).fatigue;
  const html = ahora(p);
  assert.match(html, /Hambre[\s\S]*0%/);
  assert.doesNotMatch(html, /data-grabacion="resumida"|Energía|Cansancio|Sed/);
  assert.match(renderPersonTelemetry(p), /Reserva<strong>0</);
  assert.doesNotMatch(renderPersonTelemetry(p), /sin dato|0 \/ 0|— \/ —|\/ sin dato|sin dato \//);
  const soloTope = persona({ lifeStage: 'adult', foodReserveCapacity: 4 });
  assert.match(renderPersonTelemetry(soloTope), /Capacidad de reserva<strong>4/);
  assert.doesNotMatch(renderPersonTelemetry(soloTope), /sin dato|\/ sin dato|sin dato \//);
  const decision = decisionFicha(p, mundo([p]));
  assert.match(decision, /Hambre · 0%/);
  assert.doesNotMatch(decision, /Sed ·|no llegó completo/);
});

test('instante con necesidades y sin escucha ni cuerpo no resume ni acusa al mundo', () => {
  const p = persona({ energy: 0.4, hunger: 0.2, fatigue: 0.1, health: 0.5, lifeStage: 'adult', age: 40 });
  const html = ahora(p);
  assert.match(html, /Energía[\s\S]*40%/);
  assert.doesNotMatch(html, /data-grabacion="resumida"|data-escucha|data-cuerpo-ficha|no hereda todavía|no trae cuerpos|carece de cuerpos/);
  assert.equal(cuerpoPersonaFicha(p, mundo([p])), '');
  const cuerpoAusente = cuerpoFicha(undefined);
  assert.match(cuerpoAusente, /data-cuerpo-ficha="sin-dato"/);
  assert.match(cuerpoAusente, /sin dato/i);
  assert.doesNotMatch(cuerpoAusente, /no trae cuerpos|carece de cuerpos/);
});

const agua: SustanciaVista = { id: 7, clase: 1, atomos: [2, 0, 0, 1, 0, 0, 0, 0], enlaces: [], masa: 18, prop: { r: 1, dMedia: 400, tFusion: 273, tEbullicion: 373, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: .9, polaridad: .8, densidad: 1, color: 0x3f6f8a } };

test('persona: el cuerpo L0 muestra lo registrado, cero incluido, y no rellena reserva, agua ni digestivo', () => {
  const parcial = { masa: 62, carga: 0, T: 310, principal: 7 } as CuerpoVisible;
  const p = persona({
    cuerpoVisto: parcial,
    genome: { generation: 0, parents: [], learningRate: 0, cooperation: 0, mutations: 0 },
  });
  const view = mundo([p]);
  view.sustancias = [agua];
  const html = cuerpoPersonaFicha(p, view);
  assert.match(html, /62 kg/);
  assert.match(html, /data-cuerpo="carga"[\s\S]*0 kg/);
  assert.match(html, /36,9 °C/);
  assert.match(html, /H₂O/);
  assert.doesNotMatch(html, /Reserva de energía|Agua del tejido|tubo digestivo|sin dato/);
  const conCeros = cuerpoPersonaFicha(persona({
    cuerpoVisto: { masa: 10, masaAdulta: 20, reserva: 0, agua: 0, digestivo: 0, carga: 0, T: 310, principal: 7 },
  }), view);
  assert.match(conCeros, /Reserva de energía/);
  assert.match(conCeros, /Agua del tejido/);
  assert.match(conCeros, /En el tubo digestivo/);
  assert.match(conCeros, /0%/);
  assert.doesNotMatch(conCeros, /sin dato/);
  assert.match(inheritedAndLearned(p, view, undefined, null).story, /sin progenitores registrados/);
  const legado = cuerpoFicha(parcial, [agua]);
  assert.match(legado, /Reserva de energía[\s\S]*sin dato/);
  assert.match(legado, /Agua del tejido[\s\S]*sin dato/);
  assert.match(legado, /En el tubo digestivo[\s\S]*sin dato/);
  assert.match(legado, /62 kg/);
  assert.match(legado, /H₂O/);
});

test('etapa ausente sigue en sin dato y la edad no la inventa', () => {
  const p = persona({ energy: 0.5, hunger: 0.2, fatigue: 0.1, age: 999999 });
  delete (p as { lifeStage?: string }).lifeStage;
  const html = inheritedAndLearned(p, mundo([p])).now;
  assert.match(html, /Etapa del modelo<\/span><strong>Sin dato/);
  assert.doesNotMatch(html, /<strong>Vejez|<strong>Edad de crianza|<strong>Mayor/);
  assert.doesNotMatch(html, /data-grabacion="resumida"/);
  assert.doesNotMatch(renderPersonTelemetry(p), /Etapa<strong>/);
});

test('habilidades: el mapa vacío no es lo mismo que no haber llegado', () => {
  const vacio = persona({ energy: 1, hunger: 0, fatigue: 0, skills: {} });
  const sinMapa = persona({ energy: 1, hunger: 0, fatigue: 0 });
  assert.match(renderPersonTelemetry(vacio), /Ninguna habilidad en este instante/);
  assert.doesNotMatch(renderPersonTelemetry(vacio), /Sin habilidades practicadas recibidas/);
  assert.doesNotMatch(renderPersonTelemetry(sinMapa), /Ninguna habilidad en este instante|Sin habilidades practicadas recibidas|Compartir|Cuidado|Apertura/);
});
