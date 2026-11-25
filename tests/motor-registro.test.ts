import assert from 'node:assert/strict';
import test from 'node:test';
import { Contadores, crearLibros } from '../src/world/motor/contadores.js';
import { RegistroContenido } from '../src/world/motor/registro.js';
import { ErrorFatalMotor } from '../src/world/paralelo/barrera.js';
import { Piscina } from '../src/world/paralelo/piscina.js';
import { contenido, crear, type DatosGlobales } from './lib/motor-hilos.js';

const MODULO = new URL('./lib/motor-hilos.ts', import.meta.url);
const texto = (b: Uint8Array | undefined) => b && new TextDecoder().decode(b);

for (const hilos of [1, 2]) test(`registro (${hilos} hilo${hilos > 1 ? 's' : ''}): el mismo contenido da el mismo id, ids densos y la carga los conserva`, () => {
  const registro = new RegistroContenido(hilos);
  const canonico = new TextEncoder().encode('receta-hacha');
  const id = registro.insertar(canonico);
  canonico[0] = 0; // el registro copia: el llamador puede reutilizar su array
  assert.equal(registro.insertar(new TextEncoder().encode('receta-hacha')), id);
  assert.equal(registro.insertar(new TextEncoder().encode('plano-casa')), id + 1);
  assert.equal(registro.insertar(new Uint8Array(0)), id + 2, 'el contenido vacío también tiene id');
  assert.equal(registro.n, 3);
  assert.equal(texto(registro.leer(id)), 'receta-hacha');
  assert.equal(registro.leer(3), undefined);
  const copia = new RegistroContenido(hilos);
  copia.cargar(registro.guardar());
  assert.equal(copia.n, 3);
  assert.equal(texto(copia.leer(1)), 'plano-casa');
  assert.equal(copia.insertar(new TextEncoder().encode('receta-hacha')), id, 'la carga reinserta con los mismos ids');
  assert.equal(copia.insertar(new TextEncoder().encode('nuevo')), 3, 'tras la carga, los ids nuevos no reutilizan ninguno');
  assert.throws(() => copia.cargar(registro.guardar()), /vacío/);
});

test('un registro compartido que supera su tope es fatal', () => {
  const registro = new RegistroContenido(2, 1024);
  assert.throws(() => { for (let j = 0; j < 100; j++) registro.insertar(new Uint8Array(64).fill(j)); }, ErrorFatalMotor);
});

test('contadores: únicos, uid desde 1 y llegar a 2^53 es fatal', () => {
  for (const hilos of [1, 2]) {
    const c = new Contadores(hilos);
    assert.equal(c.id('uid'), 1);
    assert.equal(c.id('nonce'), 0);
    const tope = new Contadores(hilos, { nonce: 2 ** 53 - 1 });
    assert.equal(tope.id('nonce'), 2 ** 53 - 1);
    assert.throws(() => tope.id('nonce'), ErrorFatalMotor);
    assert.throws(() => new Contadores(hilos, { uid: 0 }), /inválido/);
  }
});

test('28 hilos insertan y piden ids a la vez: un id por contenido, nonces únicos y libros legibles por el coordinador',
  { timeout: 600_000 }, async () => {
    const hilos = 28, porHilo = 2000;
    const registro = new RegistroContenido(hilos), contadores = new Contadores(hilos), libros = crearLibros(hilos);
    const datos: DatosGlobales = {
      prueba: 'globales', registro: registro.memoria!, contadores: contadores.memoria!, libros,
      salida: new Float64Array(new SharedArrayBuffer(hilos * 2 * porHilo * 8)), porHilo,
    };
    const piscina = new Piscina({ hilos, datos, crear, moduleURL: MODULO, exportName: 'crear' });
    try { piscina.ejecutar(0); } finally { await piscina.cerrar(); }
    const idDe = new Map<string, number>(), nonces = new Set<number>();
    for (let h = 0; h < hilos; h++) {
      for (let j = 0; j < porHilo; j++) {
        const clave = new TextDecoder().decode(contenido(h, j)), id = datos.salida[h * 2 * porHilo + j]!;
        assert.equal(idDe.get(clave) ?? id, id, `un solo id para «${clave}»`);
        idDe.set(clave, id);
        nonces.add(datos.salida[h * 2 * porHilo + porHilo + j]!);
      }
      assert.equal(libros[h]!.fuentes[1], h + 1, 'el coordinador lee el libro de cada hilo');
    }
    assert.equal(nonces.size, hilos * porHilo, 'ningún nonce repetido');
    assert.equal(registro.n, idDe.size);
    assert.deepEqual([...idDe.values()].sort((a, b) => a - b), [...Array(idDe.size).keys()], 'ids densos desde 0');
    for (const [clave, id] of idDe) assert.equal(texto(registro.leer(id)), clave);
    assert.equal(new Set(libros.map(l => l.enVuelo[0])).size, hilos, 'cada libro lo escribió un hilo distinto');
  });
