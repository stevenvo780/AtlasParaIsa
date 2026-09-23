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

test('techoDelArchivo conserva el barrido anterior y reutiliza ambas capas de caché', () => {
  const chunks = Array.from({ length: 30_000 }, (_, index) => chunk(index,
    index % 997 === 0 ? [structure(`structure-${index * 31 + 7}`, `blueprint-${index * 17 + 3}`)] : undefined));
  chunks[12_345]!.structures = [structure('structure-987654', 'blueprint-765432')];
  chunks[23_456]!.structures = [structure('structure-legacy-23-456', 'blueprint-base')];
  reiniciarEscaneosDeArchivoParaPruebas();
  const expected = oracle(chunks);

  assert.deepEqual(techoDelArchivo(chunks), expected);
  assert.equal(expected.structure, 987654, 'incluye la identidad reanimada del archivo');
  assert.equal(expected.blueprint, 765432);
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length);
  assert.strictEqual(techoDelArchivo(chunks), techoDelArchivo(chunks));
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length, 'el mismo arreglo no vuelve a visitar chunks');
  assert.deepEqual(techoDelArchivo([...chunks]), expected);
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length, 'un arreglo clonado reutiliza el techo de cada chunk');
  assert.strictEqual(techoDeChunk(chunks[12_345]!), techoDeChunk(chunks[12_345]!));
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length);

  chunks.push(chunk(30_000, [structure('structure-999999', 'blueprint-888888')]));
  assert.equal(techoDelArchivo(chunks).structure, 999999, 'un push invalida la capa asociada al arreglo');
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length);
  chunks[chunks.length - 1] = chunk(30_001, [structure('structure-1000000', 'blueprint-999999')]);
  assert.equal(techoDelArchivo(chunks).structure, 1000000, 'un relevo splice/push de igual longitud invalida la capa');
  assert.equal(escaneosDeArchivoParaPruebas(), chunks.length + 1);
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

test('esMiembro usa identidad de objeto, igual que includes', () => {
  const member = { id: 'same' } as Person;
  const other = { id: 'other' } as Person;
  const sameId = { id: 'same' } as Person;
  const people = [member, other];

  assert.equal(esMiembro(people, member), people.includes(member));
  assert.equal(esMiembro(people, other), people.some(person => person === other));
  assert.equal(esMiembro(people, sameId), false);
  people.push(sameId);
  assert.equal(esMiembro(people, sameId), true, 'un nacimiento invalida el Set asociado al arreglo');
});
