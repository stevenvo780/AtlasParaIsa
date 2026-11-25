import assert from 'node:assert/strict';
import test from 'node:test';
import { loadavg } from 'node:os';
import { ErrorFatalMotor } from '../src/world/paralelo/barrera.js';
import { Piscina } from '../src/world/paralelo/piscina.js';
import { PageArena } from '../src/world/soa/arena.js';
import { ArenaTerreno } from '../src/world/soa/terreno.js';
import { BLOQUE, BYTES_LOTE, CTL, ERR, alturaDe, byteDe, crear, valorDe, type DatosCrecimiento } from './lib/motor-hilos.js';

const MODULO = new URL('./lib/motor-hilos.ts', import.meta.url);

test('una arena compartida solo crece desde su coordinador, en bloques, y agotarla fuera de F0 es fatal', () => {
  const arena = new PageArena(1 << 20);
  const valor = arena.field('valor', Float64Array, 1);
  const otra = PageArena.conectar(arena.compartir());
  assert.throws(() => otra.prepararF0(1), /coordinador/);
  assert.throws(() => arena.field('tarde', Float64Array, 1), /antes de compartir/);
  arena.prepararF0(300, BLOQUE);
  assert.equal(arena.capacity % BLOQUE, 0);
  assert.ok(arena.capacity >= 300);
  const capacidad = arena.capacity;
  for (let s = 0; s < capacidad; s++) assert.equal(otra.reserve(), s);
  assert.equal(valor.length, capacidad, 'la vista del coordinador sigue la longitud');
  assert.throws(() => otra.reserve(), ErrorFatalMotor, 'sin holgura reservada en F0, el paso es fatal');
  otra.release(7);
  assert.throws(() => otra.release(7), /no asignada/, 'liberar dos veces no corrompe la lista libre');
  assert.equal(arena.reserve(), 7);
  assert.equal(arena.used, capacidad);
});

test('27 lectores conservan sus vistas mientras F0 crece la arena y el terreno; reservar y liberar son seguros entre 28 hilos',
  { timeout: 600_000 }, async () => {
    const hilos = 28, rondas = 24, porHilo = 500;
    const arena = new PageArena(1 << 22);
    const valor = arena.field('valor', Float64Array, 1);
    const lote = arena.field('lote', Uint8Array, BYTES_LOTE);
    arena.field('dueno', Int32Array, 1, -1);
    const terreno = new ArenaTerreno(true);
    terreno.registrarCampo('altura', 'f64');
    const datos: DatosCrecimiento = {
      prueba: 'crecimiento', arena: arena.compartir(), terreno: terreno.compartir(),
      control: new Int32Array(new SharedArrayBuffer(12)), errores: new Int32Array(new SharedArrayBuffer(32)), porHilo, rondas,
    };
    let paginas = 0;
    const altaPagina = () => {
      const c = terreno.alta(paginas, -1, 1 + paginas % (hilos - 1));
      const celdas = terreno.escritura(1 + paginas % (hilos - 1)).escribible('altura', c);
      for (let local = 0; local < 256; local++) celdas[local] = alturaDe(paginas, -1, local);
      Atomics.store(datos.control, CTL.paginas, ++paginas);
    };
    const crecer = () => {
      for (let r = 0; r < rondas; r++) {
        arena.prepararF0(BLOQUE * (r + 1), BLOQUE);
        for (let n = 0; n < BLOQUE; n++) {
          const s = arena.reserve();
          valor[s] = valorDe(s);
          for (let k = 0; k < BYTES_LOTE; k++) lote[s * BYTES_LOTE + k] = byteDe(s, k);
        }
        Atomics.store(datos.control, CTL.publicadas, arena.used);
        for (let p = 0; p < 8; p++) altaPagina();
      }
      Atomics.store(datos.control, CTL.creciendo, 0);
    };
    const piscina = new Piscina({ hilos, datos, crear: (h, d) => h === 0 ? fase => { if (fase === 0) crecer(); } : crear(h, d), moduleURL: MODULO, exportName: 'crear' });
    try {
      const bytesAntes = arena.bytes, inicio = performance.now();
      Atomics.store(datos.control, CTL.creciendo, 1);
      piscina.ejecutar(0);
      const msCrecer = performance.now() - inicio;
      const usadas = arena.used;
      arena.prepararF0((hilos - 1) * porHilo, BLOQUE);
      piscina.ejecutar(1);
      assert.equal(arena.used, usadas + (hilos - 1) * porHilo);
      piscina.ejecutar(2);
      assert.equal(arena.used, usadas, 'cada ranura reservada se liberó una vez');
      console.log(`# crecimiento: ${rondas} rondas de ${BLOQUE} lotes y ${paginas} páginas en ${msCrecer.toFixed(0)} ms con ${hilos - 1} lectores, +${((arena.bytes - bytesAntes) / 1024).toFixed(0)} kB, carga ${loadavg()[0]!.toFixed(0)}`);
    } finally {
      await piscina.cerrar();
    }
    const e = datos.errores;
    assert.equal(e[ERR.vistas], 0, 'las vistas tomadas al conectar siguen la longitud');
    assert.equal(e[ERR.lecturas], 0, 'lo publicado se lee intacto durante el crecimiento');
    assert.equal(e[ERR.ajenos], 0, 'ninguna ranura se entregó a dos hilos');
    assert.equal(paginas, rondas * 8);
    for (let p = 0; p < paginas; p++) assert.equal(terreno.campo('altura')[terreno.celda(p * 16 + 15, -1)]!, alturaDe(p, -1, 15 * 16 + 15));
  });

test('el terreno: celda y chunk según el contrato, versiones que no se reutilizan y escritura solo del dueño', () => {
  const terreno = new ArenaTerreno(true);
  terreno.registrarCampo('agua', 'f32');
  const c = terreno.alta(-1, 2, 3);
  assert.equal(terreno.paginaX[c], -1);
  assert.equal(terreno.paginaY[c], 2);
  assert.equal(terreno.duenoChunk[c], 3);
  const celda = terreno.celda(-16 + 5, 32 + 9);
  assert.equal(celda, c * 256 + (9 << 4 | 5));
  assert.equal(terreno.chunkDe(celda), c);
  assert.equal(terreno.celda(0, 0), -1, 'no residente');
  assert.throws(() => terreno.escritura(2).escribible('agua', c), /ajena/);
  terreno.escritura(3).escribible('agua', c)[9 << 4 | 5] = 1.5;
  assert.equal(terreno.campo('agua')[celda], 1.5);
  const [pagina, visible] = [terreno.versionPagina[c]!, terreno.versionVisible[c]!];
  terreno.escritura(3).marcar(c, false);
  assert.deepEqual([terreno.versionPagina[c], terreno.versionVisible[c]], [pagina + 1, visible]);
  terreno.baja(c);
  assert.equal(terreno.celda(-16 + 5, 32 + 9), -1);
  const otra = terreno.alta(7, 7, 1);
  assert.equal(otra, c, 'la ranura se reutiliza');
  assert.ok(terreno.versionPagina[otra]! > pagina + 1, 'sus versiones siguen subiendo: la GPU y la cinta no confunden la página nueva con la vieja');
  assert.throws(() => ArenaTerreno.conectar(terreno.compartir()).alta(9, 9, 1), /coordinador/);
});
