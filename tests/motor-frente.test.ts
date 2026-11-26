import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, stepWorld } from '../src/world/index.js';
import { comprobarInvariantes } from '../src/world/invariantes.js';
import { CAMPOS_CUERPO, CUERPO_ANCHO, Clase, COLUMNAS_FIJAS, genDe, slotDe } from '../src/world/motor/contratos.js';
import { parseParams, DEFAULT_PARAMS } from '../src/world/params.js';
import { FaunaSoA } from '../src/world/soa/fauna.js';
import { faunaRegistrada } from '../src/world/soa/organismos-mundo.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';
import { materializeAnimals, especieVisual, SPECIES, type Animal } from '../src/world/animals.js';

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
  assert.ok(frente.columnas.includes('especie'));
  for (const animal of mundo.animals) {
    const s = slotDe(fauna.ref(animal));
    assert.equal(fauna.animal(s), animal);
    assert.equal(frente.vivo[s], 1);
    assert.equal(frente.decideEn[s], mundo.tick + 1);
    assert.equal(frente.clase[s], Clase.Animal);
    assert.equal(frente.col('especie')[s], SPECIES.indexOf(especieVisual(animal.species)));
    assert.equal(frente.cuerpo[s * CUERPO_ANCHO + CAMPOS_CUERPO.salud], Math.fround(animal.health));
    assert.deepEqual(structuredClone(animal), animal);
    assert.deepEqual(JSON.parse(JSON.stringify(animal)), animal);
  }
  assert.deepEqual(comprobarInvariantes(mundo, { ids: ['motor-frente'] }), []);
  const s = slotDe(fauna.ref(mundo.animals[0]!));
  (frente.col('especie') as Uint8Array)[s] ^= 1;
  assert.equal(comprobarInvariantes(mundo, { ids: ['motor-frente'] })[0]?.id, 'motor-frente');
});

test('fauna.decisiones detecta a un animal vivo que no decidió en el tick', () => {
  const mundo = createWorld(51926);
  stepWorld(mundo);
  assert.ok(mundo.animals.length > 0);
  assert.deepEqual(comprobarInvariantes(mundo, { ids: ['fauna.decisiones'] }), []);
  const animal = mundo.animals[0]!;
  animal.lastDecision = mundo.tick - 1;
  const [violacion] = comprobarInvariantes(mundo, { ids: ['fauna.decisiones'] });
  assert.equal(violacion?.id, 'fauna.decisiones');
  assert.equal(violacion?.esperado, mundo.animals.length);
  assert.equal(violacion?.observado, mundo.animals.length - 1);
});

test('FaunaSoA: el uid vive en el animal: vuelve con él del archivo, de un paso deshecho y de un clon, y uno nuevo recibe otro', () => {
  const fauna = new FaunaSoA();
  const [a, b] = materializeAnimals(7, [{ x: 0, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.5, food: 0.2, fauna: 2, species: 'deer' }], 0);
  let tick = 0;
  const uid = (animal: Animal): number => {
    fauna.publicar(++tick);
    return fauna.tabla.lectura().uid[slotDe(fauna.ref(animal))]!;
  };
  fauna.sincronizar([a!, b!]);
  const uidA = uid(a!), uidB = uid(b!);
  assert.notEqual(uidA, uidB);
  assert.deepEqual([a!.uid, b!.uid], [uidA, uidB]);
  // Un paso deshecho devuelve una copia del objeto: misma identidad, aunque la fila sea otra.
  const deshecha = structuredClone(b!);
  fauna.sincronizar([a!, deshecha]);
  assert.equal(uid(deshecha), uidB);
  // Del archivo vuelve el animal serializado.
  fauna.sincronizar([deshecha]);
  fauna.publicar(++tick);
  const archivado = JSON.parse(JSON.stringify(a!)) as Animal;
  fauna.sincronizar([deshecha, archivado]);
  assert.equal(uid(archivado), uidA);
  // Uno que nace no trae uid: recibe el siguiente, que nadie tuvo.
  const [cria] = materializeAnimals(8, [{ x: 1, y: 0, terrain: 'meadow', moisture: 0.5, vegetation: 0.5, food: 0.2, fauna: 1, species: 'deer' }], tick);
  fauna.sincronizar([deshecha, archivado, cria!]);
  assert.ok(uid(cria!) > Math.max(uidA, uidB));
});

test('personas y fauna toman el uid de un solo contador del mundo, que sobrevive al clon y a guardar y cargar', () => {
  const mundo = createWorld(51926);
  for (let i = 0; i < 300; i++) stepWorld(mundo);
  const organismos = () => [...mundo.people, ...mundo.animals];
  const uids = (m: typeof mundo) => [...m.people, ...m.animals].map(o => o.uid!);
  assert.ok(organismos().every(o => Number.isSafeInteger(o.uid) && o.uid! >= 1 && o.uid! < mundo.siguienteUid!));
  assert.equal(new Set(uids(mundo)).size, organismos().length, 'únicos entre personas y fauna');
  assert.deepEqual(uids(cloneWorld(mundo)), uids(mundo));
  const cargado = JSON.parse(JSON.stringify(mundo)) as typeof mundo;
  assertWorld(cargado);
  assert.deepEqual([uids(cargado), cargado.siguienteUid], [uids(mundo), mundo.siguienteUid]);
  // Lo que había al cargar, también la fauna de regiones archivadas, que vuelve con su uid.
  const vistos = new Set([...uids(cargado), ...cargado.retiredChunks.flatMap(c => c.animals ?? []).map(a => a.uid!)]), tope = cargado.siguienteUid!;
  for (let i = 0; i < 600; i++) stepWorld(cargado);
  const nuevos = uids(cargado).filter(u => !vistos.has(u));
  assert.ok(nuevos.length > 0, 'nacieron organismos tras la carga');
  assert.ok(nuevos.every(u => u >= tope), 'la carga continúa el contador, no lo reinicia');
  // Un uid repetido o fuera del contador no se carga.
  const repetido = JSON.parse(JSON.stringify(mundo)) as typeof mundo;
  repetido.animals[0]!.uid = repetido.people[0]!.uid;
  assert.throws(() => assertWorld(repetido));
  const fuera = JSON.parse(JSON.stringify(mundo)) as typeof mundo;
  fuera.people[0]!.uid = fuera.siguienteUid;
  assert.throws(() => assertWorld(fuera));
});
