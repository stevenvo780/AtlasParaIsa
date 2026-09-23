import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructureView } from '../src/shared/life.js';
import type { Person } from '../src/world/index.js';
import {
  esMiembro,
  escaneosDeArchivoParaPruebas,
  reiniciarEscaneosDeArchivoParaPruebas,
  techoDeChunk,
  techoDelArchivo,
  type TechoArchivo,
} from '../src/world/indices.js';
import type { Chunk } from '../src/world/terrain.js';

const structure = (id: string, blueprintId: string): StructureView => ({
  id, blueprintId, x: 0, y: 0, name: 'Refugio', components: ['frame', 'roof'], condition: 1,
  water: 0, food: 0, uses: 0, builtAt: 0, builderId: null,
});

const chunk = (index: number, structures?: StructureView[]): Chunk => ({
  key: `${index},0`, cx: index, cy: 0, tiles: [], discovered: true, places: [], lastTick: 0, structures,
});

function oracle(chunks: readonly Chunk[]): TechoArchivo {
  const result: TechoArchivo = { blueprint: 0, structure: 0, blueprintCorrupto: false, structureCorrupto: false };
  for (const current of chunks) for (const item of current.structures ?? []) {
    for (const [prefix, key, corrupt] of [
      ['blueprint', 'blueprint', 'blueprintCorrupto'],
      ['structure', 'structure', 'structureCorrupto'],
    ] as const) {
      const id = prefix === 'blueprint' ? item.blueprintId : item.id;
      if (!id.startsWith(`${prefix}-`)) continue;
      const suffix = id.slice(prefix.length + 1); if (!/^\d+$/.test(suffix)) continue;
      const reserved = Number(suffix);
      if (!Number.isSafeInteger(reserved)) result[corrupt] = true;
      else result[key] = Math.max(result[key], reserved);
    }
  }
  return result;
}

test('techoDelArchivo conserva el barrido anterior y reutiliza ambas capas de caché dentro del mismo paso', () => {
  const chunks = Array.from({ length: 30_000 }, (_, index) => chunk(index,
    index % 997 === 0 ? [structure(`structure-${index * 31 + 7}`, `blueprint-${index * 17 + 3}`)] : undefined));
  chunks[12_345]!.structures = [structure('structure-987654', 'blueprint-765432')];
  chunks[23_456]!.structures = [structure('structure-legacy-23-456', 'blueprint-base')];
  reiniciarEscaneosDeArchivoParaPruebas();
  const expected = oracle(chunks);
  const paso1 = 1;

  assert.deepEqual(techoDelArchivo(chunks, paso1), expected);
  assert.equal(expected.structure, 987654, 'incluye la identidad reanimada del archivo');
  assert.equal(expected.blueprint, 765432);
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length);
  assert.strictEqual(techoDelArchivo(chunks, paso1), techoDelArchivo(chunks, paso1));
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length, 'el mismo arreglo, mismo paso, no vuelve a visitar chunks');
  assert.deepEqual(techoDelArchivo([...chunks], paso1), expected);
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length, 'un arreglo clonado reutiliza el techo de cada chunk (caché por chunk, no por arreglo)');
  assert.strictEqual(techoDeChunk(chunks[12_345]!), techoDeChunk(chunks[12_345]!));
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length);

  chunks.push(chunk(30_000, [structure('structure-999999', 'blueprint-888888')]));
  assert.equal(techoDelArchivo(chunks, paso1).structure, 999999, 'un push invalida la capa asociada al arreglo, incluso dentro del mismo paso (cambia la longitud)');
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length);
});

test('techoDelArchivo: un relevo de un elemento intermedio (splice sin cambiar longitud) queda obsoleto como mucho un paso, nunca más', () => {
  // Hallazgo de la ronda de integración E0-INT2: validar la capa por arreglo solo con
  // longitud+primero+último (la versión original de esta tarea) no detecta
  // `retiredChunks.splice(i, 1, nuevo)` con `i` intermedio: longitud, primero y último quedan
  // iguales. Hoy nada en `src/world` hace ese relevo, pero PERF3 hace que `retiredChunks` pueda
  // vivir muchos pasos sin cambiar de referencia, así que la capa debe acotar lo obsoleto al
  // paso en curso en vez de a "mientras primero/último/longitud coincidan".
  const chunks = [chunk(0, [structure('structure-10', 'blueprint-10')]), chunk(1, [structure('structure-20', 'blueprint-20')]),
    chunk(2, [structure('structure-15', 'blueprint-15')])];
  const paso1 = 100;
  assert.deepEqual(techoDelArchivo(chunks, paso1), { blueprint: 20, structure: 20, blueprintCorrupto: false, structureCorrupto: false });

  // Relevo del elemento intermedio (índice 1, ni el primero ni el último): misma longitud, mismo
  // primero, mismo último.
  chunks.splice(1, 1, chunk(1, [structure('structure-999999', 'blueprint-999999')]));
  assert.equal(chunks.length, 3);

  // Sin cruzar a un paso nuevo el resultado sigue siendo el del caché anterior (límite aceptado y
  // documentado: dentro de un mismo paso no se revalida el contenido, igual que `isHostMember` en
  // `technology.ts`/`technology-water.ts` o la rejilla de personas de T141).
  assert.deepEqual(techoDelArchivo(chunks, paso1), { blueprint: 20, structure: 20, blueprintCorrupto: false, structureCorrupto: false },
    'dentro del mismo paso el relevo intermedio aún no se refleja (límite aceptado, acotado a un paso)');

  // En el paso siguiente (nueva `version` = `world.tick` en producción) el resultado es fresco:
  // esto es lo que garantiza que el relevo nunca queda obsoleto más allá del paso en el que ocurre.
  const paso2 = 101;
  assert.deepEqual(techoDelArchivo(chunks, paso2), { blueprint: 999999, structure: 999999, blueprintCorrupto: false, structureCorrupto: false },
    'el paso siguiente recalcula desde cero y ve el relevo intermedio');
});

test('techoDelArchivo sin `version` (fuera de un paso) siempre es fresco, incluso ante un relevo intermedio', () => {
  const chunks = [chunk(0, [structure('structure-10', 'blueprint-10')]), chunk(1, [structure('structure-20', 'blueprint-20')]),
    chunk(2, [structure('structure-15', 'blueprint-15')])];
  assert.equal(techoDelArchivo(chunks).structure, 20);
  chunks.splice(1, 1, chunk(1, [structure('structure-999999', 'blueprint-999999')]));
  assert.equal(techoDelArchivo(chunks).structure, 999999, 'sin `version` no se cachea nada a nivel de arreglo: cada llamada es exacta');
});

test('la corrupción de sufijos se conserva por prefijo y los ids legacy no cuentan', () => {
  const huge = '9'.repeat(40);
  const blueprintCorrupt = chunk(1, [structure('structure-41', `blueprint-${huge}`)]);
  const structureCorrupt = chunk(2, [structure(`structure-${huge}`, 'blueprint-37')]);
  const legacy = chunk(3, [structure('structure-legacy-3-4', 'blueprint-base')]);

  assert.deepEqual(techoDelArchivo([blueprintCorrupt, legacy]), {
    blueprint: 0, structure: 41, blueprintCorrupto: true, structureCorrupto: false,
  });
  assert.deepEqual(techoDelArchivo([structureCorrupt, legacy]), {
    blueprint: 37, structure: 0, blueprintCorrupto: false, structureCorrupto: true,
  });
});

test('esMiembro usa identidad de objeto, igual que includes, y reutiliza el Set dentro del mismo paso', () => {
  const member = { id: 'same' } as Person;
  const other = { id: 'other' } as Person;
  const sameId = { id: 'same' } as Person;
  const people = [member, other];
  const paso1 = 1;

  assert.equal(esMiembro(people, member, paso1), people.includes(member));
  assert.equal(esMiembro(people, other, paso1), people.some(person => person === other));
  assert.equal(esMiembro(people, sameId, paso1), false);
  people.push(sameId);
  assert.equal(esMiembro(people, sameId, paso1), true, 'un nacimiento invalida el Set asociado al arreglo (cambia la longitud), incluso dentro del mismo paso');
});

test('esMiembro: un relevo de un elemento intermedio queda obsoleto como mucho un paso, nunca más', () => {
  // Hallazgo de la ronda de integración E0-INT2: cachear el Set validando solo `length` no
  // detecta `people[i] = otraPersona` con la misma longitud. Hoy nada en `src/world` hace ese
  // relevo sobre `world.people`, pero por la misma razón que `techoDelArchivo` (PERF3: el arreglo
  // puede vivir muchos pasos sin cambiar de referencia) la capa debe acotar lo obsoleto al paso en
  // curso.
  const original = { id: 'original' } as Person;
  const reemplazo = { id: 'reemplazo' } as Person;
  const people: Person[] = [{ id: 'a' } as Person, original, { id: 'c' } as Person];
  const paso1 = 5;

  assert.equal(esMiembro(people, original, paso1), true);
  assert.equal(esMiembro(people, reemplazo, paso1), false);

  people[1] = reemplazo; // relevo intermedio in situ, misma longitud

  assert.equal(esMiembro(people, reemplazo, paso1), false, 'dentro del mismo paso el relevo aún no se refleja (límite aceptado, acotado a un paso)');
  assert.equal(esMiembro(people, original, paso1), true, 'el Set cacheado de este paso sigue conteniendo al miembro reemplazado');

  const paso2 = 6;
  assert.equal(esMiembro(people, reemplazo, paso2), true, 'el paso siguiente recalcula desde cero y ve el relevo');
  assert.equal(esMiembro(people, original, paso2), false);
});

test('esMiembro sin `version` (fuera de un paso) siempre es fresco, incluso ante un relevo intermedio', () => {
  const original = { id: 'original' } as Person;
  const reemplazo = { id: 'reemplazo' } as Person;
  const people: Person[] = [{ id: 'a' } as Person, original, { id: 'c' } as Person];

  assert.equal(esMiembro(people, original), true);
  people[1] = reemplazo;
  assert.equal(esMiembro(people, reemplazo), true, 'sin `version` no se cachea nada a nivel de arreglo: cada llamada es exacta');
  assert.equal(esMiembro(people, original), false);
});
