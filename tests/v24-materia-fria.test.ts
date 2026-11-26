import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { syncFauna } from '../src/world/animals.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { cloneWorld, createWorld } from '../src/world/index.js';
import type { ArenaLotes } from '../src/world/materia/arena.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, TipoIntento, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams, setParams } from '../src/world/params.js';
import { bindWorldContext } from '../src/world/spatial.js';

test('el retiro material usa un archivo y conserva VMAT, balance y reapertura', async t => {
  const directorio = mkdtempSync(join(tmpdir(), 'atlas-materia-fria-'));
  const disco = join(directorio, 'frio');
  // Cada escena arranca con el mismo grupo de caminantes y sin fauna en la región que se quiere retirar.
  const params = parseParams('v23.materia=true,v23.guardadoCompleto=true');
  const anterior = process.env.CARTA_MATERIA_FRIA_DIR;
  t.after(() => {
    if (anterior === undefined) delete process.env.CARTA_MATERIA_FRIA_DIR;
    else process.env.CARTA_MATERIA_FRIA_DIR = anterior;
    rmSync(directorio, { recursive: true, force: true });
  });

  async function escena(frío?: string, perderDestino = false) {
    if (frío) process.env.CARTA_MATERIA_FRIA_DIR = frío;
    else delete process.env.CARTA_MATERIA_FRIA_DIR;
    const semilla = 7, mundo = createWorld(semilla, params);
    const motor = crearMotor(mundo, unSoloDueno(semilla));
    const origen = mundo.people.map(({ x, y }) => ({ x, y }));
    const mover = (dx: number) => {
      mundo.animals.length = 0;
      syncFauna(mundo.tiles, mundo.animals);
      for (let i = 0; i < mundo.people.length; i++) {
        const p = mundo.people[i]!, { x, y } = origen[i]!;
        p.x = x + dx; p.y = y;
        p.target = { x: p.x, y: p.y };
      }
    };
    let persistida;
    try {
      motor.paso([]);
      const dueno = duenoSi(mundo)!;
      if (perderDestino) {
        assert.equal(dueno.muestraMemoriaMateria()?.estadoFrio?.paginasFrias, 0);
        rmSync(frío!, { recursive: true });
      }
      const corte = () => {
        const cp = motor.instantanea().materia;
        assert.ok(cp);
        const balance = dueno.balanceMateria();
        assert.deepEqual(balance.hallado, balance.esperado);
        return { vmat: codificarCheckpoint(cp), mundo: digestoCanonico(mundo), saldo: balance.hallado };
      };
      const presentes = new Set(Object.keys(mundo.chunks));
      mover(192);
      motor.paso([]);
      assert.ok(mundo.retiredChunks.length > 0);
      const arena = dueno.materia as ArenaLotes, métricas = dueno.muestraMemoriaMateria()?.estadoFrio;
      const retirada = mundo.retiredChunks.find(p => presentes.has(p.key) && !p.animals?.length && !p.structures?.length)!;
      const celda = dueno.terrenoPercibido.paginaDe(retirada.cx, retirada.cy) * 256;
      const referencia = new Float64Array(1);
      const lote = (rol: Rol): number => {
        assert.equal(arena.lotes(celda, rol, referencia), 1);
        return referencia[0]!;
      };
      const suelo = lote(Rol.Suelo), aire = lote(Rol.Aire);
      let rutaFria: string | undefined;
      if (frío && !perderDestino) {
        const subdirectorio = join(frío, readdirSync(frío)[0]!);
        const archivo = rutaFria = join(subdirectorio, `${celda / 256}.bin`);
        const otroArchivo = readdirSync(subdirectorio).find(p => p !== `${celda / 256}.bin`)!;
        const otraCelda = Number(otroArchivo.split('.')[0]) * 256;
        assert.equal(arena.lotes(otraCelda, Rol.Suelo, referencia), 1);
        arena.muestra(referencia[0]!);
        const originales = readFileSync(archivo), alterados = Buffer.from(originales);
        alterados[0]! ^= 1;
        writeFileSync(archivo, alterados);
        try { assert.throws(() => arena.muestra(suelo), /Archivo frío corrupto/); }
        finally { writeFileSync(archivo, originales); }
      }
      const fuente = [...arena.muestras()].find(m => m.rol === Rol.Aire && dueno.chunks.includes(Math.floor(m.celda / 256)))!.ref;
      const { H2O } = sustanciasDe(ctxMateriaDe(mundo));
      const entregar = (rol: Rol, nonce: number) => {
        const materia = arena.garantizar(fuente, { parte: Parte.Exacta, esp: H2O, cuantos: 100, kappa: null }, dueno.libro);
        assert.ok(materia.length > 0);
        setParams(mundo, { ...params, v23: { ...params.v23, intentos: true } });
        try {
          dueno.fase(6);
          dueno.buzon.enviar(0, { tipo: TipoIntento.Depositar, de: REF_NULA, a: REF_NULA, lote: REF_NULA, celda,
            nonce, materia, dato: Float64Array.of(rol, 0), bytes: null });
          dueno.fase(1);
          dueno.aplicar('B');
          assert.ok(dueno.libro.enVuelo.every(n => n === 0));
        } finally { setParams(mundo, params); }
      };
      const aguaAire = arena.cuantos(aire, H2O);
      entregar(Rol.Aire, 201);
      assert.equal(arena.cuantos(aire, H2O), aguaAire + 100);
      assert.equal(arena.estaAparcado(suelo), Boolean(frío) && !perderDestino, 'el vapor pendiente no promueve el suelo');
      const dormido = corte();
      if (perderDestino) {
        assert.equal(métricas?.errorEscritura, 'ENOENT');
        assert.equal(métricas?.lotesFrios, 0, 'una escritura fallida conserva todos los lotes en RAM');
      } else if (frío) {
        assert.ok(métricas && métricas.paginasFrias > 0 && métricas.bytesEnDisco > 0);
        assert.equal(métricas.lotesFrios, 512 * métricas.paginasFrias);
        assert.equal(readdirSync(frío).length, 1);
        const store = new Store(join(directorio, 'piloto.sqlite'));
        try {
          const instantanea = motor.instantanea();
          store.guardar({ ...instantanea, world: cloneWorld(instantanea.world) });
          persistida = store.cargarGuardadoCompleto()!;
          assert.deepEqual(codificarCheckpoint(persistida.instantanea.materia!), dormido.vmat);
        } finally { store.close(); }
      } else assert.equal(métricas, undefined);

      const aguaSuelo = arena.cuantos(suelo, H2O);
      if (rutaFria) {
        // Fuerza un fallo de unlink después de que se validó la lectura de la página.
        rmSync(rutaFria);
        mkdirSync(rutaFria);
      }
      entregar(Rol.Suelo, 202);
      assert.equal(arena.cuantos(suelo, H2O), aguaSuelo + 100);
      assert.equal(arena.estaAparcado(suelo), false, 'la mutación promueve la página antes de abonar');
      if (rutaFria) assert.equal(dueno.muestraMemoriaMateria()?.estadoFrio?.errorLimpieza, 'EISDIR');
      mover(0);
      motor.paso([]);
      const activo = corte();
      const reutilizable = motor.instantanea();
      return { dormido, activo, persistida, reutilizable, métricas, origen, retirada: retirada.key };
    } finally { await motor.cerrar(); }
  }

  const base = await escena();
  mkdirSync(disco);
  const frío = await escena(disco);
  assert.deepEqual(frío.dormido, base.dormido);
  assert.deepEqual(frío.activo, base.activo);
  assert.deepEqual(readdirSync(disco), []);
  const repetido = crearMotor(frío.reutilizable.world, unSoloDueno(7));
  try {
    repetido.cargar(frío.reutilizable, frío.reutilizable.materia!.epoca);
    assert.deepEqual(codificarCheckpoint(repetido.instantanea().materia!), frío.activo.vmat);
  } finally { await repetido.cerrar(); }
  mkdirSync(disco, { recursive: true });
  const fallida = await escena(disco, true);
  assert.deepEqual(fallida.dormido, base.dormido);
  assert.deepEqual(fallida.activo, base.activo);
  mkdirSync(disco, { recursive: true });
  const guardada = frío.persistida!;
  const durable = new Store(join(directorio, 'piloto.sqlite'));
  const recarga = crearMotor(guardada.instantanea.world, unSoloDueno(7));
  try {
    bindWorldContext(guardada.instantanea.world, durable.context);
    recarga.cargar(guardada.instantanea, guardada.epoca);
    const dueno = duenoSi(recarga.vista())!;
    assert.deepEqual(dueno.balanceMateria().hallado, frío.dormido.saldo);
    assert.equal(dueno.muestraMemoriaMateria()?.estadoFrio?.paginasFrias, 0);
    for (const [i, p] of recarga.vista().people.entries()) Object.assign(p, frío.origen[i], { target: frío.origen[i] });
    recarga.paso([]);
    assert.ok(recarga.vista().chunks[frío.retirada]);
    const saldo = dueno.balanceMateria();
    assert.deepEqual(saldo.hallado, saldo.esperado);
  } finally {
    await recarga.cerrar();
    durable.close();
  }
});
