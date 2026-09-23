import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, personDetail } from '../src/world/index.js';
import { enClaro, recursoEnClaro, etiquetaReceta } from '../src/client/textos.js';

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
