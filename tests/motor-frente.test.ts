import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld } from '../src/world/index.js';
import { comprobarInvariantes } from '../src/world/invariantes.js';
import { CAMPOS_CUERPO, CUERPO_ANCHO, Clase, COLUMNAS_FIJAS, genDe, slotDe } from '../src/world/motor/contratos.js';
import { parseParams, DEFAULT_PARAMS } from '../src/world/params.js';
import { FaunaSoA, faunaRegistrada } from '../src/world/soa/fauna.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';
import { decisionesFauna, materializeAnimals, SPECIES, type Animal } from '../src/world/animals.js';

test('motor-frente conserva el frente t mientras cada dueño escribe t+1', () => {
  const tabla = new TablaOrganismosSoA(true);
  tabla.columna('especie', 'u8', 1);
  const s = slotDe(tabla.alta(0, Clase.Animal)), otro = slotDe(tabla.alta(1, Clase.Persona));
  const escritura = tabla.escritura(0);
  escritura.fila(s);
  escritura.f32('x')[s] = 123;
  escritura.u8('especie')[s] = 4;
  assert.throws(() => escritura.fila(otro));
  assert.throws(() => tabla.publicar(1), /selló/);
  tabla.escritura(1).fila(otro);
  tabla.publicar(1);

  const lectura = tabla.lectura();
  const copia = Float32Array.from(lectura.x);
  assert.equal(lectura.x[s], 123);
  assert.equal(lectura.col('especie')[s], 4);
  assert.deepEqual(lectura.columnas, [...COLUMNAS_FIJAS.map(([nombre]) => nombre), 'especie']);
  assert.ok(lectura.x.buffer instanceof SharedArrayBuffer);

  const siguiente = tabla.escritura(0);
  siguiente.fila(s);
  tabla.escritura(1).fila(otro);
  siguiente.f32('x')[s] = -5;
  tabla.verificarFrente();
  assert.deepEqual(Float32Array.from(lectura.x), copia);
  tabla.publicar(2);
  assert.equal(tabla.lectura().x[s], -5);

  (tabla.lectura().x as Float32Array)[s] = 7;
  assert.throws(() => tabla.verificarFrente(), /CRC|frente/i);
});

test('motor-frente: una referencia caduca al morir y el slot se reutiliza tras la cuarentena', () => {
  const tabla = new TablaOrganismosSoA();
  const original = tabla.alta(0, Clase.Animal), slot = slotDe(original);
  const escritura = tabla.escritura(0);
  escritura.fila(slot);
  escritura.f32('x')[slot] = -13;
  tabla.publicar(1);
  tabla.baja(0, original);
  const inmediata = tabla.alta(0, Clase.Animal);
  assert.notEqual(slotDe(inmediata), slot);
  tabla.publicar(2);

  assert.equal(tabla.lectura().vivo[slot], 0);
  assert.ok(tabla.lectura().gen[slot]! > genDe(original));
  assert.equal(tabla.lectura().x[slot], -13);
  assert.notEqual(slotDe(tabla.alta(0, Clase.Animal)), slot);
  tabla.publicar(3);
  assert.notEqual(slotDe(tabla.alta(0, Clase.Animal)), slot);
  tabla.publicar(4);
  const nueva = tabla.alta(0, Clase.Animal);
  assert.equal(slotDe(nueva), slot);
  assert.ok(genDe(nueva) > genDe(original));
});

test('stepWorld publica la fauna del tick y conserva las vistas clonables', () => {
  const params = parseParams({ motor: { ...DEFAULT_PARAMS.motor, depuracion: true } }, DEFAULT_PARAMS);
  const mundo = createWorld(51926, params);
  stepWorld(mundo);
  const fauna = faunaRegistrada(mundo)!;
  const frente = fauna.tabla.lectura();
  assert.equal(frente.tick, mundo.tick);
  assert.equal(frente.columnas.at(-1), 'especie');
  for (const animal of mundo.animals) {
    const s = slotDe(fauna.ref(animal));
    assert.equal(fauna.animal(s), animal);
    assert.equal(frente.vivo[s], 1);
    assert.equal(frente.decideEn[s], Math.max(mundo.tick + 1, animal.lastDecision + 8));
    assert.equal(frente.clase[s], Clase.Animal);
    assert.equal(frente.col('especie')[s], SPECIES.indexOf(animal.species));
    assert.equal(frente.cuerpo[s * CUERPO_ANCHO + CAMPOS_CUERPO.salud], Math.fround(animal.health));
    assert.deepEqual(structuredClone(animal), animal);
    assert.deepEqual(JSON.parse(JSON.stringify(animal)), animal);
  }
  assert.deepEqual(comprobarInvariantes(mundo, { ids: ['motor-frente'] }), []);
  const s = slotDe(fauna.ref(mundo.animals[0]!));
  (frente.col('especie') as Uint8Array)[s] ^= 1;
  assert.equal(comprobarInvariantes(mundo, { ids: ['motor-frente'] })[0]?.id, 'motor-frente');
});

test('fauna.decisiones: cada animal vencido decide una vez en el tick, hasta el cupo', () => {
  const mundo = createWorld(51926);
  let decisiones = 0;
  for (let i = 0; i < 48; i++) {
    stepWorld(mundo);
    assert.deepEqual(comprobarInvariantes(mundo, { ids: ['fauna.decisiones'] }), []);
    const actividad = decisionesFauna(mundo)!;
    assert.equal(actividad.tick, mundo.tick);
    assert.equal(actividad.decisiones, Math.min(actividad.vencidos, actividad.cupo));
    decisiones += actividad.decisiones;
  }
  assert.ok(decisiones > mundo.animals.length, 'en 48 ticks cada animal vence al menos una vez');
});

test('FaunaSoA: el uid se conserva al volver del archivo o al deshacer un paso, y una muerte lo libera', () => {
  const fauna = new FaunaSoA();
  const [a, b] = materializeAnimals(7, [{ x: 0, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.5, food: 0.2, fauna: 2, species: 'deer' }], 0);
  let tick = 0;
  const uid = (animal: Animal): number => {
    fauna.publicar(++tick);
    return fauna.tabla.lectura().uid[slotDe(fauna.ref(animal))]!;
  };
  const viva = (animal: Animal): Animal => ({ ...structuredClone(animal), health: 1 });
  fauna.sincronizar([a!, b!]);
  const uidA = uid(a!), uidB = uid(b!);
  assert.notEqual(uidA, uidB);
  b!.health = 0;
  const deshecha = viva(b!);
  fauna.sincronizar([a!, deshecha]);
  assert.equal(uid(deshecha), uidB);
  fauna.sincronizar([deshecha]);
  fauna.publicar(++tick);
  fauna.sincronizar([deshecha, a!]);
  assert.equal(uid(a!), uidA);
  deshecha.health = 0;
  fauna.sincronizar([a!]);
  fauna.publicar(++tick);
  const otra = viva(deshecha);
  fauna.sincronizar([a!, otra]);
  assert.ok(uid(otra) > Math.max(uidA, uidB));
});
