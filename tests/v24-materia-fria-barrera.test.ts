import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncFauna } from '../src/world/animals.js';
import type { ArenaLotes } from '../src/world/materia/arena.js';
import { sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, TipoIntento, refDe, unSoloDueno, type Intento } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams, setParams } from '../src/world/params.js';

test('F0 calienta el suelo de caída y el lote destino de Tomar antes de aplicar, y el vapor deja frío el suelo', async t => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-frio-barrera-'));
  const anterior = process.env.CARTA_MATERIA_FRIA_DIR;
  process.env.CARTA_MATERIA_FRIA_DIR = raiz;
  const params = parseParams('v23.materia=true,v23.guardadoCompleto=true');
  const mundo = createWorld(7, params), motor = crearMotor(mundo, { ...unSoloDueno(7), verificar: false });
  try {
    assert.equal(motor.paso([]).tick, 1);
    for (const p of mundo.people) { p.x += 192; p.target = { x: p.x, y: p.y }; }
    mundo.animals.length = 0;
    syncFauna(mundo.tiles, mundo.animals);
    assert.equal(motor.paso([]).tick, 2);

    const d = duenoSi(mundo)!, arena = d.materia as ArenaLotes, { H2O } = sustanciasDe(ctxMateriaDe(mundo));
    const salida = new Float64Array(1);
    const lote = (celda: number, rol: Rol): number => {
      assert.equal(arena.lotes(celda, rol, salida), 1);
      return salida[0]!;
    };
    const retiradas = mundo.retiredChunks.map(({ cx, cy }) => d.terrenoPercibido.paginaDe(cx, cy) * 256)
      .filter(celda => celda >= 0 && arena.estaAparcado(lote(celda, Rol.Suelo)));
    assert.ok(retiradas.length >= 2);
    const [caida, destino] = retiradas as [number, number, ...number[]];
    const sueloCaida = lote(caida, Rol.Suelo), sueloDestino = lote(destino, Rol.Suelo), aire = lote(caida, Rol.Aire);
    const activo = [...arena.muestras()].find(m => m.rol === Rol.Aire && d.chunks.includes(Math.floor(m.celda / 256)));
    assert.ok(activo);
    const antes = d.muestraMemoriaMateria()!.estadoFrio!;
    assert.equal(antes.lotesFrios, retiradas.length * 512);

    function encolar(i: Partial<Intento>): void {
      d.fase(6);
      d.buzon.enviar(0, { tipo: TipoIntento.Depositar, de: REF_NULA, a: REF_NULA, celda: caida,
        lote: REF_NULA, nonce: 701, materia: null, dato: null, bytes: null, ...i });
    }
    const garantizar = (cuantos: number) => arena.garantizar(activo.ref, { parte: Parte.Exacta, esp: H2O, cuantos, kappa: null }, d.libro);
    const aplicar = () => { d.fase(1); d.aplicar('B'); };
    setParams(mundo, { ...params, v23: { ...params.v23, intentos: true } });

    const vaporAntes = arena.cuantos(aire, H2O);
    encolar({ materia: garantizar(7), dato: Float64Array.of(Rol.Aire, 0) });
    assert.throws(() => d.prepararMateriaAntesDeF1(), /barrera F0/);
    d.fase(0);
    assert.equal(d.prepararMateriaAntesDeF1(), 0);
    assert.equal(d.pendientes().length, 1);
    aplicar();
    assert.equal(arena.cuantos(aire, H2O), vaporAntes + 7);
    assert.ok(arena.estaAparcado(sueloCaida));

    const aguaAntes = arena.cuantos(sueloCaida, H2O);
    const celdaRetirada = d.terreno.celda(d.terreno.paginaX[caida / 256]! * 16, d.terreno.paginaY[caida / 256]! * 16);
    assert.equal(celdaRetirada, REF_NULA);
    // Sin actor verificable, la garantía usa la celda que llevaba en el mensaje, aunque su tesela esté retirada.
    encolar({ tipo: TipoIntento.Concedido, a: refDe(d.frente.alta + 1, 0), nonce: 702, materia: garantizar(5) });
    encolar({ tipo: TipoIntento.Tomar, celda: activo.celda, nonce: 703,
      dato: Float64Array.of(Rol.Suelo, Parte.Exacta, H2O, 0, sueloDestino) });
    d.fase(0);
    const pendientes = d.pendientes();
    const desconocido = t.mock.method(d, 'pendientes', () => [...pendientes, {
      ...pendientes[0]!, nonce: 999, celda: REF_NULA, a: REF_NULA,
    }]);
    assert.throws(() => d.prepararMateriaAntesDeF1(), /999 sin destino demostrable/);
    desconocido.mock.restore();
    assert.ok(arena.estaAparcado(sueloDestino) && arena.estaAparcado(sueloCaida));
    assert.equal(d.prepararMateriaAntesDeF1(), 2);
    assert.equal(d.pendientes().length, pendientes.length);
    assert.ok(!arena.estaAparcado(sueloDestino) && !arena.estaAparcado(sueloCaida));
    const despues = d.muestraMemoriaMateria()!.estadoFrio!;
    assert.equal(antes.lotesFrios - despues.lotesFrios, 1024);
    aplicar();
    assert.equal(arena.cuantos(sueloCaida, H2O), aguaAntes + 5);
    const { esperado, hallado } = d.balanceMateria();
    assert.deepEqual(hallado, esperado);
    t.diagnostic(`Suelo y Vida fríos al inicio ${antes.lotesFrios}, repuestos en F0 1024, restantes ${despues.lotesFrios}`);
  } finally {
    await motor.cerrar();
    if (anterior === undefined) delete process.env.CARTA_MATERIA_FRIA_DIR;
    else process.env.CARTA_MATERIA_FRIA_DIR = anterior;
    rmSync(raiz, { recursive: true, force: true });
  }
});
