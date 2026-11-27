/** Fichas de persona, casa, materia y recetas: evidencia, cero y dato no grabado. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cuerpoDeColumna } from '../src/shared/cuerpo-columna.js';
import { disposicion, ESQUEMA_ORGANISMO, SERIE_CAMPOS } from '../src/shared/fotograma.js';
import type { SustanciaVista } from '../src/shared/materia.js';
import { ClaseSustancia } from '../src/shared/materia.js';
import { resumenTecnica, textoPaso } from '../src/shared/tecnica-visible.js';
import type { PasoTecnico, TecnicaPersona } from '../src/shared/technology.js';
import type { PersonView, StructureView, WorldView } from '../src/shared/types.js';
import { fichaMateriales, fichaTecnica, inheritedAndLearned, structureCard } from '../src/client/inspector-view.js';
import { renderPanelMateria } from '../src/client/panel-materia.js';
import { estadoVista, fotogramaAVista } from '../src/server/cinta/vista.js';
import type { SucesoFotograma } from '../src/world/motor/fotograma.js';
import { Clase } from '../src/world/motor/contratos.js';

const agua: SustanciaVista = {
  id: 7, clase: ClaseSustancia.Molecula, atomos: [2, 0, 0, 1, 0, 0, 0, 0], enlaces: [0, 2], masa: 18,
  prop: { r: 1, dMedia: 400, tFusion: 273, tEbullicion: 373, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: .9, polaridad: .8, densidad: 1, color: 0x3f6f8a },
};
const mundo = (extra: Partial<WorldView> = {}): WorldView => ({ people: [], tick: 40, events: [], sustancias: [agua], ...extra }) as WorldView;

test('la columna del fotograma no fabrica un cuerpo de ceros', () => {
  assert.equal(cuerpoDeColumna(undefined, { masa: 0, principal: 0, carga: 0, T: 0 }), undefined);
  assert.equal(cuerpoDeColumna(undefined, { masa: Number.NaN, principal: 0 }), undefined);
  const parcial = cuerpoDeColumna(undefined, { masa: 12.5, principal: 7, carga: 0, T: 310 });
  assert.equal(parcial?.masa, 12.5);
  assert.equal(parcial?.principal, 7);
  assert.equal(parcial?.carga, 0);
  assert.equal(parcial?.reserva, undefined);
  assert.equal(parcial?.agua, undefined);
  const previo = cuerpoDeColumna({ masa: 32, masaAdulta: 45, reserva: 0.5, agua: 0.5, digestivo: 0, carga: 0, T: 300, principal: 12 }, { masa: 32.25, principal: 0, T: 301 });
  assert.equal(previo?.masa, 32.25);
  assert.equal(previo?.principal, 12);
  assert.equal(previo?.reserva, 0.5);
  assert.equal(previo?.T, 301);
});

test('la cinta entrega el cuerpo y la sustancia del mismo tick, y no los inventa si no vinieron', () => {
  const { ancho, desde } = disposicion(ESQUEMA_ORGANISMO);
  const uid = 2 ** 40 + 7;
  const fila = (masa: number, principal: number, carga: number, temperatura: number): Uint8Array => {
    const bytes = new Uint8Array(ancho);
    const bin = new DataView(bytes.buffer);
    bin.setFloat64(desde.uid, uid, true);
    bin.setUint8(desde.clase, Clase.Persona);
    bin.setFloat32(desde.x, 3, true);
    bin.setFloat32(desde.y, 4, true);
    bin.setUint8(desde.accion, 5);
    bin.setFloat32(desde.masa, masa, true);
    bin.setUint32(desde.principal, principal, true);
    bin.setFloat32(desde.fatiga, 0.2, true);
    bin.setFloat32(desde.carga, carga, true);
    bin.setFloat32(desde.T, temperatura, true);
    return bytes;
  };
  const campos: SucesoFotograma[] = [
    { tipo: 'mundo', id: '', vista: { width: 40, height: 28 } },
    { tipo: 'clima', id: '', vista: 'clear' },
    { tipo: 'persona', id: String(uid), vista: { id: 'ada', role: 'neighbor', fatigue: 0.2 } },
    { tipo: 'texto', uid, campo: 'name', valor: 'Ada' },
    { tipo: 'texto', uid, campo: 'color', valor: '#abc' },
    { tipo: 'texto', uid, campo: 'reason', valor: 'Descansa' },
    { tipo: 'texto', uid, campo: 'need', valor: 'sueño' },
    { tipo: 'sustancia', sustancia: agua },
  ];
  const serie = new Float64Array(SERIE_CAMPOS.length);
  const base = {
    epoca: 1, completo: true, saltados: 0, n: 1, paginas: new Int32Array(),
    celdas: new Uint8Array(), sucesos: [0, 0] as [number, number], serie, reparto: null,
  };
  const vista = estadoVista(1);
  const conDato = fotogramaAVista(vista, { ...base, tick: 40, organismos: fila(12.5, 7, 1.25, 310) }, campos, 1);
  const persona = conDato.vista.people[0]!;
  assert.equal(persona.id, 'ada');
  assert.equal(persona.cuerpoVisto?.masa, 12.5);
  assert.equal(persona.cuerpoVisto?.principal, 7);
  assert.equal(persona.cuerpoVisto?.carga, 1.25);
  assert.equal(persona.cuerpoVisto?.reserva, undefined);
  assert.equal(conDato.vista.sustancias?.some(s => s.id === 7), true);
  assert.equal(conDato.catalogo.at(-1)?.t, 40);

  const sinDato = fotogramaAVista(estadoVista(2), { ...base, epoca: 2, tick: 8, organismos: fila(0, 0, 0, 0) }, campos.filter(s => s.tipo !== 'sustancia'), 2);
  assert.equal(sinDato.vista.people[0]?.cuerpoVisto, undefined);
  assert.equal(sinDato.vista.sustancias, undefined);

  const sigue = fotogramaAVista(vista, { ...base, tick: 41, completo: true, organismos: fila(12.5, 7, 1.25, 310) }, campos.filter(s => s.tipo !== 'sustancia'), 3);
  assert.equal(sigue.vista.sustancias?.some(s => s.id === 7), true);
  assert.equal(sigue.vista.tick, 41);
});

test('la técnica sobre lotes se dice con sus pasos y no se cruza con el catálogo legado', () => {
  const romper: PasoTecnico = { op: 'romper', forma: { largo: 0.2, ancho: 0.02, grueso: 0.01, hueco: 0, filo: 0.8 } };
  const unir: PasoTecnico = { op: 'unir', insumo: 7, forma: 0, masa: 0 };
  const calentar: PasoTecnico = { op: 'calentar', hasta: { T: 900 } };
  assert.match(textoPaso(unir), /0 kg/);
  assert.match(textoPaso(calentar), /900/);
  assert.doesNotMatch(textoPaso({ op: 'mojar', hasta: {} }), /0 K/);
  const tecnica: TecnicaPersona = {
    recetas: [{ id: 4, usada: 10, generacion: 2, padres: [1], vector: [] }],
    proceso: { tipo: 'craft', receta: 4, generacion: 2, padres: [1], proceso: { lote: 1, pasos: [romper, unir], i: 1, desde: 30, x: 1, y: 2 } },
    avanzadoEn: 40, intentos: 0, ultimoIntento: 40,
  };
  const resumen = resumenTecnica(tecnica, id => id === 4 ? [romper, calentar] : null);
  assert.equal('tick' in resumen, false);
  assert.equal(resumen.recetas[0]?.usada, 10);
  assert.equal(resumen.proceso?.desde, 30);
  assert.equal(resumen.intentos, 0);
  const html = fichaTecnica(resumen);
  assert.match(html, /data-tecnica="ok"/);
  assert.match(html, /data-tick="10"/);
  assert.match(html, /Romper con/);
  assert.match(html, /Unir 0 kg/);
  assert.match(html, /0 intentos/);
  assert.match(html, /Sale de las recetas nº 1/);
  assert.doesNotMatch(html, /N\/A|n\/a/);
  const citada = resumenTecnica({ ...tecnica, recetas: [{ id: 9, usada: 10, generacion: 1, padres: [], vector: [] }], proceso: null }, () => null);
  assert.match(fichaTecnica(citada), /no estaban en el registro/);
  assert.match(fichaTecnica(citada), /No consta de qué receta sale/);
  const vacia = resumenTecnica({ ...tecnica, recetas: [], proceso: null, intentos: 0 }, () => null);
  assert.match(fichaTecnica(vacia), /data-recetas="ninguna"/);
  assert.match(fichaTecnica(undefined), /data-tecnica="no-grabado"/);
  assert.doesNotMatch(fichaTecnica(undefined), /No recuerda ningún procedimiento ahora/);

  const persona = { id: 'ada', name: 'Ada', role: 'neighbor', x: 0, y: 0, color: '#abc', action: 'craft', reason: '', energy: 1, hunger: 0, fatigue: 0, need: 'oficio', tecnicaVista: resumen } as PersonView;
  const kit = inheritedAndLearned(persona, mundo(), undefined, null, () => undefined, [], { repertorio: 'no-grabado' }).kit;
  assert.match(kit, /data-tecnica="ok"/);
  assert.match(kit, /data-procedures="no-grabado"/);
  assert.match(kit, /recipe nº|Receta nº 4/);
  assert.doesNotMatch(kit, /No recuerda ningún procedimiento ahora/);
  assert.doesNotMatch(kit, /Cargando su repertorio/);
});

test('la casa nombra la pieza cuando hay ficha y dice la ausencia cuando no', () => {
  const casa = { id: 'casa', name: 'Casa', x: 1, y: 2, blueprintId: null, components: ['frame'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null } as unknown as StructureView;
  assert.match(structureCard(casa, mundo()), /data-piezas="no-grabado"/);
  assert.match(structureCard({ ...casa, piezas: [] }, mundo()), /data-piezas="ninguna"/);
  const conPieza = structureCard({ ...casa, piezas: [{ x: 1, y: 2, rol: 'pieza', forma: 0, principal: 7, masa: 3, T: 290 }] }, mundo());
  assert.match(conPieza, /H₂O/);
  assert.match(conPieza, /3 kg/);
  const sinFicha = structureCard({ ...casa, piezas: [{ x: 1, y: 2, rol: 'pieza', forma: 0, principal: 99, masa: 1, T: 280 }] }, mundo());
  assert.match(sinFicha, /sustancia nº 99/);
  assert.match(sinFicha, /no vino en esta vista/);
  assert.match(fichaMateriales({ materials: { wood: 0, stone: 2 } }), /data-cero="si"/);
  assert.match(fichaMateriales({}), /data-materiales="no-grabado"/);
  assert.match(renderPanelMateria(null), /sin la ley de materia/);
  assert.match(renderPanelMateria(null), /data-reaccion="no-grabado"/);
  assert.doesNotMatch(structureCard(casa, mundo()), /data-reaccion="aplicada"/);
  const soloCatalogo = renderPanelMateria(null, undefined, [agua]);
  assert.match(soloCatalogo, /data-libro="no-grabado"/);
  assert.match(soloCatalogo, /Sustancias del catálogo recibido/);
  assert.match(soloCatalogo, new RegExp(`data-sustancia="${agua.id}"`));
  assert.doesNotMatch(soloCatalogo, /0 mmol|\d+ kg/);
  assert.match(renderPanelMateria(null, undefined, undefined, 150, undefined, true), /data-libro="no-grabado"/);
});
