import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clase, REF_NULA, genDe, slotDe } from '../src/world/motor/contratos.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';

test('el índice compartido se publica con el frente y sigue las bajas, cesiones y el reúso', () => {
  const coordinador = new TablaOrganismosSoA(false, { reservaFilas: 32, indiceUidCompartido: true });
  const descriptor = coordinador.compartirTabla();
  assert.ok(descriptor.indiceUid instanceof SharedArrayBuffer);
  const dueno = TablaOrganismosSoA.conectar(descriptor, 1);
  const lector = TablaOrganismosSoA.conectar(descriptor, 2);
  const primero = coordinador.alta(0, Clase.Persona), segundo = dueno.alta(1, Clase.Animal);
  const a = slotDe(primero), b = slotDe(segundo);
  const uid = 2 ** 40 + 87;
  coordinador.escritura(0).f64('uid')[a] = uid;
  dueno.escritura(1).f64('uid')[b] = uid;
  assert.equal(dueno.refPublicada(uid), REF_NULA);
  coordinador.publicar(0);
  assert.equal(coordinador.refPublicada(uid), segundo);
  assert.equal(lector.refPublicada(uid), segundo);
  assert.equal(dueno.refPublicada(uid), segundo);

  dueno.baja(1, segundo);
  assert.equal(dueno.refPublicada(uid), segundo);
  coordinador.publicar(0);
  assert.equal(dueno.refPublicada(uid), primero);
  coordinador.ceder(0, primero, 1);
  coordinador.publicar(1);
  assert.equal(dueno.refPublicada(uid), primero);
  assert.equal(dueno.lectura().dueno[a], 1);
  coordinador.publicar(2);

  const nuevo = dueno.alta(1, Clase.Animal);
  assert.equal(slotDe(nuevo), b);
  assert.equal(genDe(nuevo), genDe(segundo) + 1);
  dueno.escritura(1).f64('uid')[b] = uid + 1;
  assert.equal(coordinador.refPublicada(uid + 1), REF_NULA);
  coordinador.publicar(3);
  assert.equal(lector.refPublicada(uid), primero);
  assert.equal(lector.refPublicada(uid + 1), nuevo);

  dueno.escritura(1).f64('uid')[b] = uid + 2;
  assert.equal(lector.refPublicada(uid + 1), nuevo);
  coordinador.publicar(3);
  assert.equal(lector.refPublicada(uid + 1), REF_NULA);
  assert.equal(lector.refPublicada(uid + 2), nuevo);
});
