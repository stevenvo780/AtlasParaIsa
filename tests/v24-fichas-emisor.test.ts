/**
 * Emisor real de fichas: el reloj no reabre una persona, la casa sale de sus lotes
 * y una reacción solo se muestra si `aplicar` la ejecutó.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { registrarSustanciasBase } from '../scripts/lab-materia.mjs';
import { paramsDeEncender } from '../scripts/lab/encender.mjs';
import { fichaReaccion, structureCard } from '../src/client/inspector-view.js';
import { cicloVacio, leerMateria, renderPanelMateria } from '../src/client/panel-materia.js';
import { fuenteFotograma } from '../src/server/cinta/fuente.js';
import { vistaParaEmision } from '../src/server/sim-worker.js';
import { estadoVista, fotogramaAVista } from '../src/server/cinta/vista.js';
import { CONTROL_ENLACE_BYTES, enlaceCinta, regionesRanura, SERIE_CAMPOS, type Fotograma, type Suceso } from '../src/shared/fotograma.js';
import { codigoForma } from '../src/shared/materia.js';
import type { RuntimeStats } from '../src/shared/types.js';
import { escalon } from '../src/shared/interruptores.js';
import { tecnicaVisible } from '../src/shared/tecnica-visible.js';
import type { TecnicaPersona } from '../src/shared/technology.js';
import type { StructureView } from '../src/shared/life.js';
import { createWorld, stepWorld, tileAt } from '../src/world/index.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { EmisorFotoDueno, type ParteFotoDueno } from '../src/world/motor/fotograma-dueno.js';
import type { FotogramaEnCurso, SucesoEnlaceCinta } from '../src/world/motor/fotograma.js';
import { celdaObra, colocarPieza, type EstadoObra } from '../src/world/materia/piezas.js';
import { pasoLote } from '../src/world/materia/paso.js';
import { anotarReaccionAplicada, reaccionObservadaDe } from '../src/world/materia/reaccion-observada.js';
import type { ServicioQuimicoImpl } from '../src/world/materia/servicio.js';
import { Rol } from '../src/world/materia/tipos.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { crearSAB, crecerSAB } from '../src/world/soa/arena.js';
import { chunkKey } from '../src/world/terrain.js';
import { materiaReal } from './lib/materia-real.js';

const RUNTIME: RuntimeStats = {
  stepMs: 0, p95StepMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: 0,
  processRssMiB: 0, tickHz: 0, fraccionSerial: 0,
  fases: {
    maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0,
    demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0,
  },
};

function decodificar(bloques: readonly Uint8Array[]): SucesoEnlaceCinta[] {
  const salida: SucesoEnlaceCinta[] = [];
  for (const bloque of bloques) {
    const view = new DataView(bloque.buffer, bloque.byteOffset, bloque.byteLength);
    let offset = 0;
    while (offset < bloque.byteLength) {
      const len = view.getUint32(offset, true);
      offset += 4;
      salida.push(deserialize(bloque.subarray(offset, offset + len)) as SucesoEnlaceCinta);
      offset += len;
    }
  }
  return salida;
}

function marco(tick: number, sucesos: readonly Suceso[]): Fotograma {
  return {
    epoca: 1, completo: true, saltados: 0, n: 0, paginas: new Int32Array(),
    celdas: new Uint8Array(), sucesos: [0, 0], serie: new Float64Array(SERIE_CAMPOS.length),
    reparto: null, tick, organismos: new Uint8Array(),
  };
}

test('la técnica visible no guarda el reloj y no relee la receta si nada cambió', () => {
  const tecnica: TecnicaPersona = {
    recetas: [{ id: 4, usada: 10, generacion: 1, padres: [1], vector: [] }],
    proceso: null, avanzadoEn: 1, intentos: 2, ultimoIntento: 1,
  };
  let lecturas = 0;
  const leer = (id: number) => { lecturas++; return id === 4 ? [{ op: 'calentar' as const, hasta: { T: 900 } }] : null; };
  const primera = tecnicaVisible(tecnica, leer);
  const segunda = tecnicaVisible(tecnica, leer);
  assert.equal(primera, segunda);
  assert.equal(lecturas, 1);
  assert.equal('tick' in primera, false);
  tecnica.avanzadoEn = 999;
  tecnica.ultimoIntento = 999;
  assert.equal(tecnicaVisible(tecnica, leer), primera);
  assert.equal(lecturas, 1);
  tecnica.intentos = 3;
  const cambiada = tecnicaVisible(tecnica, leer);
  assert.equal(cambiada.intentos, 3);
  assert.equal(lecturas, 2);
});

test('el emisor real no reabre a la persona cuando solo avanza el reloj', async t => {
  const mundo = createWorld(7, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, unSoloDueno(7));
  t.after(() => motor.cerrar());
  const descriptor = {
    control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES),
    ranuras: [crearSAB(0, 16 * 1024 * 1024)],
    versiones: crearSAB(0, 65536),
    sucesos: new SharedArrayBuffer(1024 * 1024),
  };
  const enlace = enlaceCinta(descriptor);
  motor.enlazar(descriptor);
  motor.cargar({ world: mundo, materia: null }, 0);
  const d = duenoSi(mundo)!;
  const persona = mundo.people[0]!;
  const tecnica: TecnicaPersona = {
    recetas: [{ id: 4, usada: 10, generacion: 1, padres: [], vector: [] }],
    proceso: { tipo: 'craft', receta: 4, generacion: 1, padres: [], proceso: { lote: 1, pasos: [{ op: 'unir', insumo: 7, forma: 0, masa: 1.5 }], i: 0, desde: 3, x: 1, y: 2 } },
    avanzadoEn: 1, intentos: 2, ultimoIntento: 1,
  };
  persona.technology.tecnica = tecnica;
  const emisor = new EmisorFotoDueno(mundo);
  const ranura = descriptor.ranuras[0]!;
  crecerSAB(ranura, regionesRanura(0, 0).total);
  let gen = 0;
  function emitir(completo: boolean): ParteFotoDueno {
    mundo.tick += 1;
    for (const p of mundo.people) p.bornAt += 1;
    const f: FotogramaEnCurso = { ranura, completo, tick: mundo.tick, epoca: 0, versiones: enlace.versiones! };
    const parte = emisor.emitir(d, f, [], d.organismos, (px, py) => d.terrenoPercibido.paginaDe(px, py), gen, 0, false);
    assert.equal(parte.desbordado, false);
    assert.equal(parte.compatFallback, false);
    gen += 1;
    return parte;
  }
  const personasDe = (parte: ParteFotoDueno) => decodificar(parte.altasBloques).filter(s => s.tipo === 'persona' || s.tipo === 'textosPersona');
  const primera = emitir(true);
  const altaInicial = personasDe(primera).find(s => s.tipo === 'persona' && s.id === String(persona.uid));
  assert.ok(altaInicial && altaInicial.tipo === 'persona' && altaInicial.vista);
  assert.equal(altaInicial.vista.tecnicaVista?.intentos, 2);
  assert.equal(altaInicial.vista.tecnicaVista?.recetas[0]?.usada, 10);
  assert.equal(altaInicial.vista.tecnicaVista?.proceso?.desde, 3);
  assert.equal('tick' in (altaInicial.vista.tecnicaVista ?? {}), false);

  tecnica.avanzadoEn = mundo.tick + 1;
  tecnica.ultimoIntento = mundo.tick + 1;
  const quieta = emitir(false);
  assert.equal(personasDe(quieta).length, 0, 'avanzar el reloj no es un cambio de la ficha');

  tecnica.intentos = 5;
  tecnica.recetas[0]!.usada = 80;
  const cursoTecnico = tecnica.proceso!;
  tecnica.proceso = { ...cursoTecnico, proceso: { ...cursoTecnico.proceso, pasos: [{ op: 'unir', insumo: 7, forma: 0, masa: 0.25 }] } };
  const cambio = emitir(false);
  const alta = personasDe(cambio).find(s => s.tipo === 'persona' && s.id === String(persona.uid));
  assert.equal(cambio.tick, mundo.tick);
  assert.ok(alta && alta.tipo === 'persona' && alta.vista);
  assert.equal(alta.vista.tecnicaVista?.intentos, 5);
  assert.equal(alta.vista.tecnicaVista?.recetas[0]?.usada, 80);
  assert.equal(alta.vista.tecnicaVista?.proceso?.pasos[0]?.texto.includes('0,25') || alta.vista.tecnicaVista?.proceso?.pasos[0]?.texto.includes('0.25'), true);
});

function casaConPieza() {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'obra' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), persona = mundo.people.find(p => p.role === 'neighbor')!;
  const sitio = tileAt(mundo, persona)!;
  const punto = { x: sitio.x, y: sitio.y };
  const contigua = [{ x: sitio.x + 1, y: sitio.y }, { x: sitio.x - 1, y: sitio.y }].find(p => {
    const tile = tileAt(mundo, p);
    return tile && tile.terrain !== 'water' && chunkKey(p.x, p.y) === chunkKey(punto.x, punto.y) && celdaObra(c, p) >= 0;
  });
  assert.ok(contigua);
  const plano = mundo.blueprints[0]!;
  const obra: EstadoObra = { piezas: [], pendiente: null, agua: -1, comida: -1, terminada: true };
  const s: StructureView & { obraMaterial: EstadoObra } = {
    ...contigua, id: `structure-${++mundo.structureCounter}`, name: plano.name, blueprintId: plano.id,
    cells: [contigua, punto], components: [...plano.components], condition: 1, water: 0, food: 0, uses: 0,
    builtAt: mundo.tick, builderId: persona.id, obraMaterial: obra,
  };
  mundo.structures.push(s);
  const celda = celdaObra(c, punto);
  const { SiO2 } = registrarSustanciasBase(c.quimica as ServicioQuimicoImpl);
  const forma = codigoForma({ largo: 1, ancho: 1, grueso: 0.2, hueco: 0, filo: 0 });
  const lote = c.materia.nuevo(Rol.Objeto, celda, forma);
  c.materia.fuente(lote, Float64Array.of(SiO2, 500_000, 0, 2_000_000), c.libro);
  colocarPieza(c, s.id, lote, celda);
  return { mundo, c, s, SiO2 };
}

test('emisor, cinta e inspector muestran la pieza real de la casa y no la repiten', async t => {
  const { mundo, c, s, SiO2 } = casaConPieza();
  const d = duenoSi(mundo)!;
  const emisor = new EmisorFotoDueno(mundo);
  const ranura = crearSAB(0, 1024 * 1024);
  crecerSAB(ranura, regionesRanura(0, 0).total);
  const versiones = new Float64Array(crearSAB(0, 65536));
  let lecturas = 0;
  const ver = c.materia.vista.bind(c.materia);
  c.materia.vista = (lote) => { lecturas++; return ver(lote); };
  function emitir(completo: boolean, gen: number): ParteFotoDueno {
    mundo.tick += 1;
    const f: FotogramaEnCurso = { ranura, completo, tick: mundo.tick, epoca: 0, versiones };
    const parte = emisor.emitir(d, f, [], d.organismos, (px, py) => d.terrenoPercibido.paginaDe(px, py), gen, 0, false);
    assert.equal(parte.desbordado, false);
    assert.equal(parte.compatFallback, false);
    return parte;
  }
  const alta = emitir(true, 0);
  const estructuras = decodificar(alta.altasBloques).filter((ev): ev is Extract<SucesoEnlaceCinta, { tipo: 'estructura' }> => ev.tipo === 'estructura' && ev.id === s.id);
  assert.equal(estructuras.length, 1);
  const pieza = estructuras[0]?.tipo === 'estructura' ? estructuras[0].vista?.piezas : undefined;
  assert.equal(pieza?.length, 1);
  assert.equal(pieza?.[0]?.principal, SiO2);
  assert.ok((pieza?.[0]?.masa ?? 0) > 0);
  assert.equal(pieza?.[0]?.rol, 'pieza');
  const lecturasDeAlta = lecturas;
  assert.ok(lecturasDeAlta > 0);

  const quieta = emitir(false, 1);
  const otraVez = decodificar(quieta.altasBloques).filter(ev => ev.tipo === 'estructura');
  assert.equal(otraVez.length, 0);
  assert.equal(lecturas, lecturasDeAlta, 'la pieza quieta no vuelve a leerse');

  const fuente = fuenteFotograma(mundo, 1, 'fichas', RUNTIME, () => 10, () => undefined);
  const f: FotogramaEnCurso = { ranura, completo: true, tick: mundo.tick, epoca: 1, versiones };
  const corte = fuente.corte(d, f, new Int32Array());
  const globales = corte.sucesos.filter(ev => ev.tipo === 'mundo' || ev.tipo === 'clima' || ev.tipo === 'sustancia');
  const vista = fotogramaAVista(estadoVista(1), marco(mundo.tick, [...globales, estructuras[0]!]), [...globales, estructuras[0]!], 1).vista;
  const casa = vista.structures?.find(item => item.id === s.id);
  assert.ok(casa?.piezas?.length);
  const html = structureCard(casa!, vista);
  assert.match(html, /data-pieza=/);
  assert.match(html, /kg/);
  assert.doesNotMatch(html, /data-piezas="no-grabado"/);
  const sinReaccion = { ...vista, reaccionObservada: undefined };
  const formula = structureCard(casa!, sinReaccion);
  assert.match(formula, /data-reaccion="no-grabado"/);
  assert.match(formula, /fórmula de una pieza no es una reacción/);
  assert.doesNotMatch(formula, /data-reaccion="aplicada"/);
  assert.match(formula, /data-pieza=/);
  t.diagnostic(`pieza ${SiO2} masa ${pieza?.[0]?.masa} lecturas ${lecturasDeAlta}`);
});

test('una reacción aplicada viaja en la vista viva y en la cinta; sin el campo no se inventa', async t => {
  const mundo = createWorld(11, parseParams({ v23: escalon('materia') }, DEFAULT_PARAMS));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo);
  const d = duenoSi(mundo)!;
  const fuente = fuenteFotograma(mundo, 1, 'reaccion', RUNTIME, () => 10, () => undefined);
  const ranura = crearSAB(0, 1024 * 1024);
  const versiones = new Float64Array(crearSAB(0, 4096));
  const curso = (completo: boolean): FotogramaEnCurso => ({ ranura, completo, tick: mundo.tick, epoca: 1, versiones });
  const antes = fuente.corte(d, curso(true), new Int32Array());
  fuente.confirmar(curso(true));
  let observada = reaccionObservadaDe(c.materia);
  if (!observada) {
    const cabeceraPrevia = antes.sucesos.find(ev => ev.tipo === 'mundo');
    assert.equal(cabeceraPrevia?.tipo === 'mundo' ? cabeceraPrevia.vista?.reaccionObservada : 'no', undefined);
    const { H2, O2 } = registrarSustanciasBase(c.quimica as ServicioQuimicoImpl);
    const lote = c.materia.nuevo(Rol.Objeto, -1, 0);
    c.materia.fuente(lote, Float64Array.of(H2, 1_000_000, O2, 500_000, 0, 2_000_000_000), c.libro);
    const veces = pasoLote({
      arena: c.materia, quimica: c.quimica, azar: () => 0.5,
      anotar: (reaccion, aplicadas, loteAplicado) => anotarReaccionAplicada(c.materia, reaccion, aplicadas, loteAplicado, c.tick),
    }, lote, 1, [0, 0, 0, 200]);
    assert.ok(veces > 0);
    observada = reaccionObservadaDe(c.materia);
    assert.ok(observada);
    assert.equal(observada.lote, lote);
    assert.equal(observada.tick, mundo.tick);
    assert.equal(observada.veces, veces);
    assert.ok(observada.a === H2 || observada.b === H2);
  }
  const viva = vistaParaEmision(mundo);
  assert.deepEqual(viva.reaccionObservada, observada);
  const despues = fuente.corte(d, curso(true), new Int32Array());
  const cabecera = despues.sucesos.find(ev => ev.tipo === 'mundo');
  assert.equal(cabecera?.tipo, 'mundo');
  if (cabecera?.tipo !== 'mundo') return;
  assert.deepEqual(cabecera.vista?.reaccionObservada, observada);
  const enCable = despues.sucesos.map(ev => deserialize(serialize(ev)) as Suceso);
  const cabeceraCable = enCable.find(ev => ev.tipo === 'mundo');
  assert.deepEqual(cabeceraCable?.tipo === 'mundo' ? cabeceraCable.vista?.reaccionObservada : undefined, observada);
  const conDato = fotogramaAVista(estadoVista(1), marco(mundo.tick, enCable), enCable, 1).vista;
  const panel = renderPanelMateria(leerMateria(conDato.materia), cicloVacio(), conDato.sustancias, conDato.tick, conDato.reaccionObservada);
  assert.match(panel, /data-reaccion="aplicada"/);
  assert.match(panel, new RegExp(`data-tick="${observada.tick}"`));
  assert.match(panel, new RegExp(`data-lote="${observada.lote}"`));
  assert.match(panel, /lote nº/);
  const previa = antes.sucesos.map(ev => {
    if (ev.tipo !== 'mundo' || !ev.vista) return ev;
    const vista = { ...ev.vista };
    delete vista.reaccionObservada;
    return { ...ev, vista };
  });
  const sinCampo = fotogramaAVista(estadoVista(1), marco(mundo.tick, previa), previa, 1).vista;
  assert.equal(sinCampo.reaccionObservada, undefined);
  const panelViejo = renderPanelMateria(leerMateria(sinCampo.materia), cicloVacio(), sinCampo.sustancias, sinCampo.tick, sinCampo.reaccionObservada);
  assert.match(panelViejo, /data-reaccion="no-grabado"/);
  assert.match(panelViejo, /No se deduce de las sustancias presentes/);
  assert.doesNotMatch(panelViejo, /data-reaccion="aplicada"/);
  assert.equal(fichaReaccion(undefined, 'mundo').includes('data-reaccion="no-grabado"'), true);
  t.diagnostic(JSON.stringify(observada));
});

test('anotar una reacción no cambia los cuantos del paso', async () => {
  async function brazo(anotar: boolean) {
    const m = materiaReal();
    try {
      const l = m.lote({ H2: 1000, O2: 400 }, 295);
      const ctx = m.ctx(2);
      if (anotar) ctx.anotar = (reaccion, veces, lote) => anotarReaccionAplicada(m.arena, reaccion, veces, lote, 42);
      const veces = pasoLote(ctx, l, 1, [0, 0, 0, 200]);
      return {
        veces,
        h2: m.arena.cuantos(l, m.S.H2),
        o2: m.arena.cuantos(l, m.S.O2),
        h2o: m.arena.cuantos(l, m.S.H2O),
        tick: reaccionObservadaDe(m.arena)?.tick,
      };
    } finally { await m.cerrar(); }
  }
  const sin = await brazo(false);
  const con = await brazo(true);
  assert.deepEqual({ veces: con.veces, h2: con.h2, o2: con.o2, h2o: con.h2o }, { veces: sin.veces, h2: sin.h2, o2: sin.o2, h2o: sin.h2o });
  assert.equal(sin.tick, undefined);
  assert.equal(con.tick, 42);
  assert.ok(con.veces > 0);
  const m = materiaReal();
  try {
    const l = m.lote({ H2: 1000, O2: 400 }, 295);
    const ctx = m.ctx(3);
    ctx.anotar = (reaccion, veces, lote) => anotarReaccionAplicada(m.arena, reaccion, veces, lote, 42);
    assert.ok(pasoLote(ctx, l, 1, [0, 0, 0, 200]) > 0);
    ctx.anotar = (reaccion, veces, lote) => anotarReaccionAplicada(m.arena, reaccion, veces, lote, 99);
    pasoLote(ctx, l, 1, [0, 0, 0, 200]);
    assert.equal(reaccionObservadaDe(m.arena)?.tick, 42);
  } finally { await m.cerrar(); }
});
