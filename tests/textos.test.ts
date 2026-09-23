import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, personDetail } from '../src/world/index.js';
import { enClaro, recursoEnClaro, etiquetaReceta } from '../src/client/textos.js';
import { textoDeExperiencia } from '../src/client/inspector-view.js';
import { recortarHito } from '../src/client/visit-memory.js';

/** Claves internas en inglés e identificadores que no deben llegar a la pantalla tras `enClaro`. */
const PROHIBIDOS: [string, RegExp][] = [
  ['operación', /\b(combine|separate|form|abrade|heat|cool|compress|weave)\b/],
  ['especie', /\b(hare|deer|boar|fish|wolf|fox)\b/],
  ['estrategia', /\b(supply|assist|teach|trade|tools)\b/],
  ['contexto', /\b(ready|hungry|thirsty|tired|partner-tired|shelter-tired|food-hungry|rain-shelter)\b/],
  ['especialidad', /\b(research|craft|invent|repair|approach|accompany|retreat)\b/],
  ['causa', /\b(starvation|dehydration|exposure|senescence)\b/],
  ['identificador', /\b(neighbor|descendant|animal|recipe|blueprint|product)-/],
  ['episodio', /\be\d+\b/],
  ['decimal inglés', /\d\.\d/],
  ['coordenadas que parecen un decimal', /\(-?\d+,-?\d+\)/],
];

test('M6: tras enClaro, ningún texto de un mundo sembrado real conserva claves en inglés ni identificadores', () => {
  const world = createWorld(51926);
  const textos = new Map<string, string>(), especialidades = new Set<string>(), recursos = new Set<string>();
  const add = (origen: string, text: string | null | undefined): void => { if (text) textos.set(text, origen); };
  for (let i = 0; i < 1200; i++) {
    stepWorld(world);
    for (const e of world.events) { add(`evento ${e.kind}`, e.text); add(`causa ${e.kind}`, e.cause); for (const p of e.death?.previous ?? []) add('muerte', p); }
    if (i % 100 === 99) {
      const view = projectWorld(world);
      for (const p of world.people) {
        add('intención', p.reason); add('recuerdo', p.recentMemory);
        for (const x of personDetail(world, p.id)!.experiences) add('experiencia', x.text);
      }
      for (const p of view.people) if (p.specialty) especialidades.add(p.specialty);
      for (const id of view.organization?.maintenance.depletedResources ?? []) recursos.add(id);
      for (const d of view.organization?.observedDependencies ?? []) recursos.add(d.resourceId);
    }
  }
  assert.ok(textos.size > 50, `textos reunidos: ${textos.size}`);
  const fallos: string[] = [];
  for (const [text, origen] of textos) {
    const claro = enClaro(text, { world: projectWorld(world) });
    for (const [nombre, re] of PROHIBIDOS) if (re.test(claro)) fallos.push(`${origen} · ${nombre}: «${claro}» (original «${text}»)`);
  }
  for (const s of especialidades) { const claro = enClaro(s, {}, 'especialidad'); for (const [nombre, re] of PROHIBIDOS) if (re.test(claro)) fallos.push(`especialidad · ${nombre}: «${claro}»`); }
  for (const id of recursos) { const claro = recursoEnClaro(id, { technology: projectWorld(world).technology }); for (const [nombre, re] of PROHIBIDOS) if (re.test(claro)) fallos.push(`recurso · ${nombre}: «${claro}»`); }
  assert.deepEqual(fallos.slice(0, 20), [], `${fallos.length} textos con claves internas (si world/*.ts cambió una plantilla, completa textos.ts)`);
});

test('M6: un texto sin claves sale idéntico y lo desconocido pasa tal cual', () => {
  for (const text of ['S e I compartieron una pausa. Después podrán volver a sus propios caminos.', 'La lluvia humedece la tierra; el alimento crecerá si también hay luz.', 'Algo nuevo que la ley aún no nombra: zeta-9.'])
    assert.equal(enClaro(text), text);
});

test('M6: traducciones concretas de la auditoría', () => {
  assert.equal(enClaro('wolf animal-51926--12--6-2 muere por depredación.'), 'Un lobo muere por depredación.');
  assert.equal(enClaro('Estrategia teach; recursos o trabajo transferidos realmente.'), 'Estrategia: enseñar; recursos o trabajo transferidos realmente.');
  assert.equal(enClaro('Consecuencia observada 0.120 en contexto ready.'), 'Consecuencia observada 0,120 en contexto: disponible.');
  assert.equal(enClaro('Entregó el objeto product-203, con 12 unidades de masa.'), 'Entregó un objeto, con 12 unidades de masa.');
  assert.equal(enClaro('La 6 descubrió abrade·combine 58: abrade → combine.'), 'La 6 descubrió Desgastar · Unir 58: desgastar → unir.');
  assert.equal(enClaro('materiales · research', {}, 'especialidad'), 'materiales · investigación');
  assert.equal(recursoEnClaro('raw:wood'), 'madera en bruto');
  assert.equal(recursoEnClaro('residue:stone'), 'residuo de piedra');
  assert.equal(recursoEnClaro('recipe:recipe-157'), 'procedimiento 157');
  assert.equal(etiquetaReceta({ id: 'recipe-12', name: 'heat·form 12' }), 'Calentar · Dar forma 12');
});

/*
 * Constitución: «la carta (S e I, recuerdos) solo la cambia Steven». Los recuerdos llegan a la pantalla
 * por `reason` («Influye «título»»), por la crónica (evento `memory` «al recordar «título»», gesto
 * `remember` «Se hizo disponible «título»» y sus causas con el id) y como experiencia o `recentMemory`
 * (el texto entero). Se generan con el mundo real (decide() y el gesto) y se comprueba que lo mostrado
 * conserva cada título y cada texto byte a byte.
 */
type MundoReal = ReturnType<typeof createWorld>;

/** Lleva a S al lugar del recuerdo y le da el contexto que la ley exige para que el recuerdo influya.
 * Devuelve las intenciones (`reason`) de S e I en cada paso: la siguiente decisión las reemplaza. */
function forzarRecuerdo(world: MundoReal, memoryId: string): string[] {
  const memory = world.memories.find(m => m.id === memoryId)!;
  const place = world.places.find(p => p.id === memory.placeId)!;
  const s = world.people.find(p => p.role === 'S')!, i = world.people.find(p => p.role === 'I')!;
  s.x = place.x; s.y = place.y; i.x = place.x; i.y = place.y + 1;
  if (memory.context === 'partner-tired') { i.fatigue = 0.6; s.socialLoad = 0; }
  if (memory.context === 'shelter-tired') s.fatigue = 0.7;
  if (memory.context === 'rain-shelter') { world.weather = 'rain'; s.fatigue = 0.3; }
  const razones: string[] = [];
  for (let k = 0; k < 3 && !s.reason.includes(`«${memory.title}»`); k++) {
    s.decisionAt = world.tick; stepWorld(world); razones.push(s.reason, i.reason);
  }
  return razones;
}

/** Textos que la ley escribió citando o copiando la carta, con cómo los muestra la interfaz. */
function textosConCarta(world: MundoReal, razones: string[]): { origen: string; original: string; mostrado: string }[] {
  const view = projectWorld(world), out: { origen: string; original: string; mostrado: string }[] = [];
  const add = (origen: string, original: string | undefined, mostrado: string): void => {
    if (original) out.push({ origen, original, mostrado });
  };
  for (const r of razones) add('reason', r, enClaro(r, { world: view }));
  for (const p of world.people.filter(x => x.role !== 'neighbor')) {
    if (p.recentMemory) add(`recentMemory ${p.role}`, p.recentMemory, enClaro(p.recentMemory, { world: view }));
    for (const x of personDetail(world, p.id)!.experiences) {
      const cause = world.events.find(e => e.id === x.causeId);
      add(`experiencia ${p.role}`, x.text, textoDeExperiencia(x.text, cause, view));
      // Sin el recuerdo en el estado (p. ej. retirado de la carta), la causa basta para no tocarlo.
      add(`experiencia sin memories ${p.role}`, x.text, textoDeExperiencia(x.text, cause, { ...view, memories: [] }));
    }
  }
  for (const e of world.events) {
    add(`crónica ${e.kind}`, e.text, enClaro(e.text, { world: view }));
    add(`causa ${e.kind}`, e.cause, enClaro(e.cause, { world: view }));
    // La despedida de un difunto repite episodios previos sin contexto de mundo (inspector-view.ts).
    add(`episodio previo ${e.kind}`, e.text, enClaro(e.text));
  }
  return out;
}

/** Para cada recuerdo: su cita «título» y su texto entero se muestran idénticos donde la ley los puso. */
function fallosDeCarta(world: MundoReal, razones: string[]): string[] {
  const fallos: string[] = [];
  for (const { origen, original, mostrado } of textosConCarta(world, razones)) for (const m of world.memories) {
    const cita = `«${m.title}»`;
    if (original.includes(cita) && !mostrado.includes(cita)) fallos.push(`${origen}: «${mostrado}» perdió ${cita}`);
    if (original === m.text && mostrado !== m.text) fallos.push(`${origen}: «${mostrado}» ≠ texto de ${m.id}`);
    // Las causas de la ley nombran el recuerdo por id: se muestra su título, literal.
    if (origen.startsWith('causa') && original.includes(m.id) && !mostrado.includes(cita)) {
      fallos.push(`${origen}: «${mostrado}» no cita ${m.id}`);
    }
  }
  return fallos;
}

/** El mundo por defecto (semilla de `createWorld()`, la carta real) con cada recuerdo en juego. */
function mundoConCadaRecuerdo(preparar?: (world: MundoReal) => void): { world: MundoReal; razones: string[] } {
  const world = createWorld();
  preparar?.(world);
  for (let i = 0; i < 5; i++) stepWorld(world);
  const razones = ['sample-accompany', 'sample-rest', 'sample-rain'].flatMap(id => forzarRecuerdo(world, id));
  // El gesto `remember` cita cada recuerdo de la carta, también el que nunca cambia decisiones.
  for (const m of world.memories) {
    for (let i = 0; i < 31; i++) stepWorld(world);
    const place = world.places.find(p => p.id === m.placeId)!, s = world.people.find(p => p.role === 'S')!;
    s.x = place.x; s.y = place.y;
    const [result] = stepWorld(world, [{ id: `recordar-${m.id}`, kind: 'remember', x: place.x, y: place.y, memoryId: m.id }]);
    assert.ok(result?.accepted, `gesto ${m.id}: ${result?.message}`);
  }
  return { world, razones };
}

test('Constitución: cada recuerdo de la carta real se muestra literal en reason, crónica y experiencias', () => {
  const { world, razones } = mundoConCadaRecuerdo();
  const textos = textosConCarta(world, razones);
  for (const m of world.memories) {
    assert.ok(textos.some(x => x.original.includes(`«${m.title}»`)), `la ley citó «${m.title}»`);
  }
  for (const id of ['sample-accompany', 'sample-rest', 'sample-rain']) {
    const m = world.memories.find(x => x.id === id)!;
    assert.ok(textos.some(x => x.origen.startsWith('reason') && x.original.includes(`Influye «${m.title}»`)), `reason con ${id}`);
    assert.ok(textos.some(x => x.origen.startsWith('experiencia') && x.original === m.text), `experiencia con el texto de ${id}`);
  }
  assert.deepEqual(fallosDeCarta(world, razones), []);
});

test('Constitución: un recuerdo con claves, ids, decimales y coordenadas se muestra sin ninguna transformación', () => {
  const hostiles = [
    { title: 'Calor 1.5 · heat·form 12 e42 wolf (3,4)',
      text: 'Recuerdo: research en neighbor-3, 0.25 de fox; contexto ready. recipe-7 · blueprint-2 · product-9.' },
    { title: 'Dijo «sí» a las 2.30 · Estrategia teach',
      text: 'Recordatorio sample-rest; recuerdo sample-rain; Causa del modelo: starvation (12,5) e7.' },
    { title: 'hare deer boar', text: 'Nace fox animal-1-2-3. descendant-4 · abrade → combine.' },
    { title: 'Un techo · 0.5', text: 'Preferencia por research con 1.25 y (0,0).' },
    { title: 'e1', text: 'e1' },
  ];
  const { world, razones } = mundoConCadaRecuerdo(w => w.memories.forEach((m, i) => Object.assign(m, hostiles[i])));
  assert.ok(razones.some(r => r.includes(`Influye «${hostiles[1]!.title}»`)), 'la ley citó el título hostil en una intención');
  assert.deepEqual(fallosDeCarta(world, razones), []);
  // Sin el recuerdo en el estado, la cita entre «» sigue literal; también una cita recortada.
  const citados = ['S eligió descansar al recordar «Calor 1.5 · heat·form 12 e42 wolf (3,4)».',
    'Antes: S eligió descansar al recordar «Calor 1.5 · heat'];
  for (const citado of citados) {
    assert.equal(enClaro(citado), citado);
  }
  // Lo que no es carta se sigue traduciendo en el mismo texto.
  assert.equal(enClaro('Consecuencia 0.120 en contexto ready. Influye «Un techo · 0.5», material de prueba.'),
    'Consecuencia 0,120 en contexto: disponible. Influye «Un techo · 0.5», material de prueba.');
});

test('Constitución: un hito guardado por el navegador no parte una cita de la carta', () => {
  const base = `${'x'.repeat(380)} al recordar «Un título de la carta que no cabe entero».`;
  const recortado = recortarHito(base, 400);
  assert.ok(recortado.length <= 400 && !recortado.includes('«') && recortado.endsWith('…'), recortado);
  assert.equal(recortarHito('corto «entero».', 400), 'corto «entero».');
  const anidado = `${'y'.repeat(370)} «Dijo «sí» y luego mucho más texto de la carta».`;
  assert.ok(!recortarHito(anidado, 400).includes('«'), 'una cita con comillas dentro también se deja fuera entera');
});

test('M6: las coordenadas de la ley no se confunden con un decimal', () => {
  assert.equal(enClaro('Olmo y Vera junto a El claro de las vueltas (12,5).'), 'Olmo y Vera junto a El claro de las vueltas (12, 5).');
  assert.equal(enClaro('Funcionó cosechar en (12, 5); 0.5 de beneficio.'), 'Funcionó cosechar en (12, 5); 0,5 de beneficio.');
  assert.equal(enClaro('Ocurrió en (-3,7), paso 40.'), 'Ocurrió en (-3, 7), paso 40.');
});
