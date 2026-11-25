// Leyes de uso de la materia (carril L): copiar (plantillas balanceadas, Liebig) y romper (desprender, quemar), sobre la
// química real de Q (sustancias internadas desde sus enlaces, reacciones con los coeficientes que elige, enmienda 1) y la
// arena real de A (`ArenaLotes`). Dobles solo para lo de M1 (el registro de plantillas y la memoria paginada, en
// tests/lib) y para lo que Q no puede dar: una reacción desbalanceada (`QuimicaCon`).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPACIDAD_ATOMO, ELEMENTOS, EPS_TENACIDAD, FRACTURA, NE } from '../src/shared/naturaleza.js';
import type { SustanciaId } from '../src/shared/materia.js';
import { DATO_GOLPEAR, refDe, type Registro } from '../src/world/motor/contratos.js';
import { Rol, libroVacio, nivelDeT, type LoteRef, type Reaccion, type ServicioQuimico } from '../src/world/materia/tipos.js';
import { indiceTipoEnlace, normalizarEnlaces } from '../src/world/materia/quimica.js';
import { cargarSustancias, crearServicioQuimico, serializarSustancias } from '../src/world/materia/servicio.js';
import { balanceada, copiar, crearPlantilla, type DatosPlantilla } from '../src/world/materia/copiar.js';
import { desprender, quemar, reparto, romper } from '../src/world/materia/romper.js';
import { arenaDe, memoriaDe } from './lib/materia-real.js';

// ── Sustancias reales, internadas en Q desde sus enlaces (≤ 8 átomos: la unidad de fórmula de Q) ──────────────────

const Q = crearServicioQuimico({ modo: 'inmediato' });
test.after(() => Q.cerrar());
type Enlace = [string, string, number, number]; // elemento, elemento, orden, cuántos
function sustancia(enlaces: Enlace[]): SustanciaId {
  const pares = enlaces.flatMap(([x, y, k, n]) => {
    const t = indiceTipoEnlace(ELEMENTOS.indexOf(x as never), ELEMENTOS.indexOf(y as never), k as 1 | 2 | 3);
    assert.ok(t >= 0, `${x}${y}${k}`);
    return [t, n];
  });
  return Q.internar(normalizarEnlaces(Uint16Array.from(pares)));
}
const H2O = sustancia([['H', 'O', 1, 2]]);
const CO2 = sustancia([['C', 'O', 2, 2]]);
const O2 = sustancia([['O', 'O', 2, 1]]);
const NH3 = sustancia([['H', 'N', 1, 3]]);
const N2 = sustancia([['N', 'N', 3, 1]]);
const H3PO4 = sustancia([['H', 'O', 1, 3], ['O', 'P', 1, 3], ['O', 'P', 2, 1]]);
const CAOH2 = sustancia([['Ca', 'O', 1, 2], ['H', 'O', 1, 2]]);
const CH2O = sustancia([['C', 'H', 1, 1], ['C', 'C', 1, 1], ['C', 'O', 1, 1], ['H', 'O', 1, 1]]); // unidad de celulosa
const CH2 = sustancia([['C', 'H', 1, 2], ['C', 'C', 1, 1]]);                                       // unidad de grasa
// La glicina (C₂H₅NO₂, 10 átomos) y el CH₅O₄P de antes no caben en una unidad de Q (≤ 8 átomos): el doble los admitía.
const MEA = sustancia([['C', 'H', 1, 3], ['C', 'N', 1, 1], ['H', 'N', 1, 2]]);                     // metilamina CH₅N
const CACO3 = sustancia([['Ca', 'O', 1, 2], ['C', 'O', 1, 2], ['C', 'O', 2, 1]]);
const ORGP = sustancia([['C', 'C', 1, 1], ['C', 'H', 1, 1], ['C', 'O', 1, 1], ['O', 'P', 1, 3], ['O', 'P', 2, 1]]); // CHO₄P sólido
const SIO2 = sustancia([['O', 'Si', 1, 4]]);
const HCHO = sustancia([['C', 'H', 1, 2], ['C', 'O', 2, 1]]); // formaldehído: mismos átomos que CH2O, otros enlaces
const CH4 = sustancia([['C', 'H', 1, 4]]);
const H2 = sustancia([['H', 'H', 1, 1]]);

const S = (id: SustanciaId) => Q.sustancia(id);
const E = (id: SustanciaId) => S(id).energia;
const atomosDe = (id: SustanciaId) => S(id).atomos.reduce((s, v) => s + v, 0);
const q: ServicioQuimico = Q;
const AMBIENTE = nivelDeT(295);

/** Q con algunas parejas cambiadas: solo para lo que Q no puede dar (una reacción desbalanceada). */
class QuimicaCon implements ServicioQuimico {
  readonly cambios = new Map<string, Reaccion | null | undefined>();
  constructor(readonly base: ServicioQuimico = Q) {}
  internar(): SustanciaId { throw new Error('L no interna sustancias'); }
  sustancia(id: SustanciaId) { return this.base.sustancia(id); }
  reaccion(a: SustanciaId, b: SustanciaId, nivelT: number) {
    const k = `${a},${b}`;
    return this.cambios.has(k) ? this.cambios.get(k) : this.base.reaccion(a, b, nivelT);
  }
}

class RegistroPrueba implements Registro {
  ids = new Map<string, number>();
  insertar(c: Uint8Array) {
    const k = Buffer.from(c).toString('hex');
    if (!this.ids.has(k)) this.ids.set(k, this.ids.size);
    return this.ids.get(k)!;
  }
  leer(): Uint8Array | undefined { return undefined; }
  get n() { return this.ids.size; }
}

// ── La arena real de A: cada prueba la suya, con su libro de fuentes ─────────────────────────────────────────

type Contenido = [SustanciaId, number][];
class Arena {
  readonly arena;
  readonly libro = libroVacio();
  /** `alReves`: las sustancias entran en el orden contrario (otras ranuras); las leyes no deben notarlo. */
  constructor(readonly alReves = false, capacidad = 256) {
    this.arena = arenaDe(memoriaDe(1, capacidad), 0, Q, H2O);
  }
  /** Una arena cargada de golpe (como de un punto de control, sin libro): para cantidades cuya energía no cabe en un
   * asiento de fuente (2⁵³ J), como 2⁵³ − 1 cuantos de O₂. */
  static cargada(lotes: [Contenido, number][]): { a: Arena; refs: LoteRef[] } {
    const a = new Arena();
    const refs = lotes.map((_, s) => refDe(s, 0));
    a.arena.cargar(lotes.map(([c, calor], s) => ({ ref: refs[s]!, celda: -1, rol: Rol.Objeto, forma: 0, dueno: 0,
      pares: Float64Array.from([...c.filter(([, n]) => n > 0).flat(), ...(calor > 0 ? [0, calor] : [])]) })), []);
    return { a, refs };
  }
  crear(contenido: Contenido = [], calor = 0): LoteRef {
    const l = this.arena.nuevo(Rol.Objeto, -1, 0);
    this.poner(l, contenido, calor);
    return l;
  }
  /** Un lote con `contenido` a T K (calor entero = T·CAPACIDAD_ATOMO·átomos). */
  aT(contenido: Contenido, T: number): LoteRef {
    return this.crear(contenido, Math.round(T * CAPACIDAD_ATOMO * contenido.reduce((s, [id, n]) => s + n * atomosDe(id), 0)));
  }
  /** Añade cantidades y calor declarados como fuente, una sustancia por asiento. */
  poner(l: LoteRef, contenido: Contenido, calor = 0): void {
    for (const [id, c] of this.alReves ? [...contenido].reverse() : contenido) {
      if (c > 0) this.arena.fuente(l, Float64Array.from([id, c]), this.libro);
    }
    if (calor > 0) this.arena.fuente(l, Float64Array.from([0, calor]), this.libro);
  }
  cuantos(l: LoteRef, id: SustanciaId) { return this.arena.cuantos(l, id); }
  calor(l: LoteRef) { return this.arena.calor(l); }
  vista(l: LoteRef) { return this.arena.vista(l); }
  /** Átomos por elemento y energía (química + calor) de toda la arena, en bigint. */
  totales(): bigint[] { return this.arena.saldo(); }
  /** Σ fuentes − Σ sumideros: lo que debe haber si ninguna ley crea ni destruye nada. */
  esperado(): bigint[] {
    return Array.from({ length: NE + 1 }, (_, i) => BigInt(this.libro.fuentes[i]!) - BigInt(this.libro.sumideros[i]!));
  }
  /** El estado entero (para comprobar que nada se movió). */
  foto(): string { return JSON.stringify([...this.arena.muestras()].map((x) => [x.ref, [...x.pares]])); }
}

const base = { kappa: [0, 0, 0] as const, captura: 0.1, masaAdulta: 1, m0: 0.05, linaje: 0 };
const datos = (partes: { id: SustanciaId; nu: number }[], entradas: SustanciaId[], subproductos: SustanciaId[] = [O2]): DatosPlantilla =>
  ({ partes, entradas, subproductos, ...base });
const golpe = (trabajo: number, filo: number, tenacidad: number, esbeltez: number, dureza: number) => {
  const d = new Float64Array(5);
  d[DATO_GOLPEAR.trabajo] = trabajo; d[DATO_GOLPEAR.filo] = filo; d[DATO_GOLPEAR.tenacidad] = tenacidad;
  d[DATO_GOLPEAR.esbeltez] = esbeltez; d[DATO_GOLPEAR.dureza] = dureza;
  return d;
};
function semilla(s: number) {
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

const foto = crearPlantilla(q, new RegistroPrueba(), datos([{ id: CH2O, nu: 1 }], [CO2, H2O]))!;
const mea = crearPlantilla(q, new RegistroPrueba(), datos([{ id: MEA, nu: 1 }], [CO2, H2O, NH3]))!;

// ── Balance ────────────────────────────────────────────────────────────────────────────────────────────────

test('balanceada: átomos y dH exactos, nada de fraccionarios', () => {
  const ok = Q.reaccion(CH2O, O2, AMBIENTE)!; // O₂ + CH₂O → CO₂ + H₂O, tal como la da Q
  assert.ok(balanceada(q, ok));
  assert.ok(ok.dH < 0, 'oxidar celulosa libera energía');
  assert.ok(!balanceada(q, { ...ok, dH: ok.dH + 1 }), 'dH que no cuadra');
  assert.ok(!balanceada(q, { ...ok, salidas: [{ id: CO2, nu: 1 }, { id: H2O, nu: 2 }] }), 'H de más');
  assert.ok(!balanceada(q, { ...ok, entradas: [{ id: CH2O, nu: 1 }, { id: O2, nu: 0.5 }] }), 'coeficiente no entero');
  assert.ok(!balanceada(q, { ...ok, entradas: [{ id: CH2O, nu: 1 }, { id: O2, nu: -1 }] }), 'coeficiente negativo');
  const escala = (k: number) => ({ entradas: ok.entradas.map((t) => ({ ...t, nu: t.nu * k })),
    salidas: ok.salidas.map((t) => ({ ...t, nu: t.nu * k })), dH: ok.dH * k });
  assert.ok(balanceada(q, escala(2 ** 30)), 'grande pero exacta');
  assert.ok(!balanceada(q, escala(2 ** 44)), 'fuera de los enteros seguros (I3): no ocurre');
  // Las reacciones de Q con p, q > 1 también: 2 CH₂ + 3 O₂ → 2 CO₂ + 2 H₂O.
  assert.ok(balanceada(q, Q.reaccion(CH2, O2, AMBIENTE)!));
  // Lo que no cabe en la cota tampoco es viable como plantilla: no puede quedar registrada una que no se copia nunca.
  const r = new RegistroPrueba();
  assert.equal(crearPlantilla(q, r, datos([{ id: CH2O, nu: 2 ** 41 }], [CO2, H2O])), null);
  assert.equal(r.n, 0);
  assert.ok(balanceada(q, crearPlantilla(q, r, datos([{ id: CH2O, nu: 2 ** 30 }], [CO2, H2O]))!.sintesis));
});

test('crearPlantilla: la fotosíntesis sale por eliminación entera', () => {
  const p = crearPlantilla(q, new RegistroPrueba(), datos([{ id: CH2O, nu: 1 }], [CO2, H2O, NH3, H3PO4]))!;
  assert.ok(p);
  assert.deepEqual(p.sintesis.entradas, [{ id: H2O, nu: 1 }, { id: CO2, nu: 1 }], 'NH₃ y H₃PO₄ con 0 salen');
  assert.deepEqual(p.sintesis.salidas, [{ id: O2, nu: 1 }, { id: CH2O, nu: 1 }]);
  assert.equal(p.sintesis.dH, E(CH2O) + E(O2) - E(CO2) - E(H2O));
  assert.ok(p.sintesis.dH > 0, 'fijar carbono cuesta energía');
  assert.ok(balanceada(q, p.sintesis));
});

test('crearPlantilla: la unidad se multiplica por el menor entero que balancea', () => {
  // CH₅N: CO₂ + H₂O + NH₃ → metilamina + 3/2 O₂, así que la unidad es de 2.
  assert.deepEqual(mea.partes, [{ id: MEA, nu: 2 }]);
  assert.deepEqual(mea.sintesis.entradas, [{ id: H2O, nu: 2 }, { id: CO2, nu: 2 }, { id: NH3, nu: 2 }]);
  assert.deepEqual(mea.sintesis.salidas, [{ id: O2, nu: 3 }, { id: MEA, nu: 2 }]);
  assert.ok(balanceada(q, mea.sintesis));
});

test('crearPlantilla: lo que no se puede balancear no es viable', () => {
  const r = new RegistroPrueba();
  assert.equal(crearPlantilla(q, r, datos([{ id: CACO3, nu: 1 }], [CO2, H2O])), null, 'falta el Ca');
  assert.equal(crearPlantilla(q, r, datos([{ id: CACO3, nu: 1 }], [CAOH2, CO2, H2O])), null, 'tendría que salir agua');
  assert.equal(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1 }], [CO2, H2O], [])), null, 'el O sobrante no puede salir');
  assert.equal(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1.5 }], [CO2, H2O])), null, 'partes no enteras');
  assert.equal(crearPlantilla(q, r, datos([], [CO2, H2O])), null, 'sin partes');
  assert.equal(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1 }], [CO2, H2O, CO2])), null, 'entrada repetida');
  assert.equal(r.n, 0, 'nada inviable entra en el registro');
});

test('crearPlantilla: con varias soluciones ≥ 0 toma la de menos especies y, a igualdad, las primeras de cada lista', () => {
  const r = new RegistroPrueba();
  // NH₃ y N₂ no tienen dónde dejar su N: la conservación los fuerza a 0 aunque el núcleo algebraico sea de dimensión 2.
  assert.deepEqual(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1 }], [CO2, H2O, NH3, N2]))!.sintesis, foto.sintesis);
  // Agua en los dos lados: el ciclo inútil H₂O → H₂O no entra en la reacción mínima.
  assert.deepEqual(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1 }], [CO2, H2O], [O2, H2O]))!.sintesis, foto.sintesis);
  // Dos fuentes de N igual de simples: manda el orden de las entradas.
  assert.deepEqual(crearPlantilla(q, r, datos([{ id: MEA, nu: 1 }], [CO2, H2O, NH3, N2]))!.sintesis, mea.sintesis);
  const conN2 = crearPlantilla(q, r, datos([{ id: MEA, nu: 1 }], [CO2, H2O, N2, NH3]))!;
  // 4 CO₂ + 10 H₂O + 2 N₂ → 4 metilaminas + 9 O₂ (18 O).
  assert.deepEqual(conN2.sintesis.entradas, [{ id: H2O, nu: 10 }, { id: CO2, nu: 4 }, { id: N2, nu: 2 }]);
  assert.deepEqual(conN2.sintesis.salidas, [{ id: O2, nu: 9 }, { id: MEA, nu: 4 }]);
  assert.ok(balanceada(q, conN2.sintesis));
});

test('crearPlantilla: una sustancia puede ser parte y entrada, o parte y subproducto', () => {
  const r = new RegistroPrueba();
  // Tejido con agua: el agua entra dos veces (una se fija en CH₂O y otra queda como agua del tejido).
  const humedo = crearPlantilla(q, r, datos([{ id: CH2O, nu: 1 }, { id: H2O, nu: 1 }], [CO2, H2O]))!;
  assert.deepEqual(humedo.sintesis.entradas, [{ id: H2O, nu: 2 }, { id: CO2, nu: 1 }]);
  assert.deepEqual(humedo.sintesis.salidas, [{ id: H2O, nu: 1 }, { id: O2, nu: 1 }, { id: CH2O, nu: 1 }]);
  // Grasa con agua desde azúcar: 6 CH₂O → (4 CH₂ + H₂O) + 2 CO₂ + H₂O; un agua es tejido y la otra residuo.
  const grasa = crearPlantilla(q, r, datos([{ id: CH2, nu: 4 }, { id: H2O, nu: 1 }], [CH2O], [CO2, H2O]))!;
  assert.deepEqual(grasa.sintesis.entradas, [{ id: CH2O, nu: 6 }]);
  assert.deepEqual(grasa.sintesis.salidas, [{ id: H2O, nu: 2 }, { id: CO2, nu: 2 }, { id: CH2, nu: 4 }]);
  for (const p of [humedo, grasa]) {
    assert.ok(balanceada(q, p.sintesis));
    const a = new Arena();
    const f = a.crear([[CO2, 100], [H2O, 100], [CH2O, 100]]), vida = a.crear([[H2O, 5]], 1e9), residuo = a.crear();
    const antes = a.totales();
    const n = copiar(a.arena, q, p, vida, [f], residuo, Infinity, 7);
    assert.equal(n, 7);
    assert.deepEqual(a.totales(), antes);
    assert.deepEqual(a.totales(), a.esperado());
    for (const t of p.partes) assert.equal(a.cuantos(vida, t.id), (t.id === H2O ? 5 : 0) + 7 * t.nu, `parte ${t.id}`);
    for (const t of p.sintesis.salidas) {
      const sobra = t.nu - (p.partes.find((x) => x.id === t.id)?.nu ?? 0);
      assert.equal(a.cuantos(residuo, t.id), 7 * sobra, `residuo ${t.id}`);
    }
  }
});

test('crearPlantilla: la plantilla no cambia si luego se tocan los datos', () => {
  const kappa: [number, number, number] = [1, 2, 3];
  const p = crearPlantilla(q, new RegistroPrueba(), { ...datos([{ id: CH2O, nu: 1 }], [CO2, H2O]), kappa })!;
  kappa[0] = 42;
  assert.deepEqual(p.kappa, [1, 2, 3]);
});

test('crearPlantilla: el id es el del registro por contenido', () => {
  const r = new RegistroPrueba();
  const a = crearPlantilla(q, r, datos([{ id: CH2O, nu: 3 }, { id: MEA, nu: 1 }], [CO2, H2O, NH3]))!;
  const b = crearPlantilla(q, r, datos([{ id: MEA, nu: 1 }, { id: CH2O, nu: 3 }], [NH3, H2O, CO2]))!;
  const c = crearPlantilla(q, r, { ...datos([{ id: CH2O, nu: 3 }, { id: MEA, nu: 1 }], [CO2, H2O, NH3]), linaje: 2 })!;
  assert.equal(a.id, b.id, 'el orden de los datos no cambia la identidad');
  assert.notEqual(a.id, c.id);
});

// ── Copiar ─────────────────────────────────────────────────────────────────────────────────────────────────

test('copiar: sintetiza en el destino, los subproductos van al residuo y conserva', () => {
  const a = new Arena();
  const aire = a.crear([[CO2, 1000]]), agua = a.crear([[H2O, 1000]]);
  const vida = a.crear([], 100 * foto.sintesis.dH + 7), residuo = a.crear();
  const antes = a.totales(), libro = structuredClone(a.libro);
  assert.equal(copiar(a.arena, q, foto, vida, [aire, agua], residuo, Infinity, 100), 100);
  assert.equal(a.cuantos(vida, CH2O), 100);
  assert.equal(a.cuantos(residuo, O2), 100);
  assert.equal(a.cuantos(vida, O2), 0);
  assert.equal(a.cuantos(aire, CO2), 900);
  assert.equal(a.cuantos(agua, H2O), 900);
  assert.equal(a.calor(vida), 7, 'la síntesis gasta exactamente n·dH');
  assert.deepEqual(a.totales(), antes);
  assert.deepEqual(a.totales(), a.esperado());
  assert.deepEqual(a.libro, libro, 'sin fuentes ni sumideros');
});

test('copiar: ley del mínimo de Liebig (manda el elemento más escaso; lo demás se queda)', () => {
  const a = new Arena();
  // La metilamina pide 2 CO₂ + 2 H₂O + 2 NH₃ por unidad: con 7 NH₃ caben 3 unidades aunque sobren C, H y O.
  const suelo = a.crear([[NH3, 7], [H2O, 500]]), aire = a.crear([[CO2, 10000]]);
  const tejido = a.crear([], 1e9), residuo = a.crear();
  const antes = a.totales();
  assert.equal(copiar(a.arena, q, mea, tejido, [aire, suelo], residuo, Infinity, 1e6), 3);
  assert.equal(a.cuantos(tejido, MEA), 6);
  assert.equal(a.cuantos(suelo, NH3), 1);
  assert.equal(a.cuantos(suelo, H2O), 500 - 6);
  assert.equal(a.cuantos(aire, CO2), 10000 - 6);
  assert.deepEqual(a.totales(), antes);
  // Sin el elemento escaso no hay síntesis y nada se mueve.
  const sinN = a.crear([[H2O, 500], [CO2, 500]]), otro = a.crear([], 1e9);
  const quieto = a.foto();
  assert.equal(copiar(a.arena, q, mea, otro, [sinN], residuo, Infinity, 1e6), 0);
  assert.equal(a.foto(), quieto);
  // Lo que no da para una unidad entera tampoco se mueve: 1 NH₃ y la unidad pide 2.
  const poco = a.crear([[NH3, 1], [H2O, 500], [CO2, 500]]);
  const quieto2 = a.foto();
  assert.equal(copiar(a.arena, q, mea, otro, [poco], residuo, Infinity, 1e6), 0);
  assert.equal(a.foto(), quieto2);
});

test('copiar: las entradas se suman entre fuentes y se toman en su orden', () => {
  const a = new Arena();
  const f1 = a.crear([[CO2, 3], [H2O, 10]]), f2 = a.crear([[CO2, 10]]);
  const vida = a.crear([], 1e9), residuo = a.crear();
  assert.equal(copiar(a.arena, q, foto, vida, [f1, f2], residuo, Infinity, 5), 5);
  assert.equal(a.cuantos(f1, CO2), 0);
  assert.equal(a.cuantos(f2, CO2), 8);
});

test('copiar: limitan la energía autorizada, el calor del destino y el ritmo', () => {
  const dH = foto.sintesis.dH;
  const caso = (calor: number, energia: number, max: number) => {
    const a = new Arena();
    const f = a.crear([[CO2, 1000], [H2O, 1000]]), vida = a.crear([], calor), r = a.crear();
    const antes = a.totales();
    const n = copiar(a.arena, q, foto, vida, [f], r, energia, max);
    assert.deepEqual(a.totales(), antes);
    assert.equal(a.cuantos(f, CO2), 1000 - n, 'lo que no se sintetiza se queda en la fuente');
    return n;
  };
  assert.equal(caso(1e9, 4.5 * dH, 100), 4, 'la energía autorizada');
  assert.equal(caso(3 * dH + dH - 1, Infinity, 100), 3, 'el calor ambiente que hay no basta para más');
  assert.equal(caso(1e9, Infinity, 2.9), 2, 'el ritmo se redondea hacia abajo');
  assert.equal(caso(1e9, Infinity, 0), 0);
  assert.equal(caso(0, Infinity, 100), 0, 'sin calor no hay síntesis endotérmica');
});

test('copiar: ningún paso intermedio pasa de 2⁵³ (I3): se copia lo que cabe', () => {
  // 2⁵³ − 1 cuantos de O₂ llevan −4,4·10¹⁸ J: no caben en un asiento de fuente, así que la arena se carga de golpe.
  const caso = (o2: number, enResiduo = 0) => {
    const { a, refs: [f, vida, r] } = Arena.cargada([[[[CO2, 10], [H2O, 10]], 0], [[[O2, o2]], 1e9], [[[O2, enResiduo]], 0]]);
    const antes = a.totales();
    const n = copiar(a.arena, q, foto, vida!, [f!], r!, Infinity, 10); // la arena real revienta con lo que no es seguro
    assert.deepEqual(a.totales(), antes);
    assert.equal(a.cuantos(f!, CO2), 10 - n, 'lo que no cabe se queda en la fuente');
    return n;
  };
  const M = Number.MAX_SAFE_INTEGER;
  assert.equal(caso(M), 0, 'el O₂ que sale pasaría por el destino lleno');
  assert.equal(caso(M - 3), 3);
  assert.equal(caso(0, M - 4), 4, 'el residuo también cuenta');
});

test('copiar: una ecuación desbalanceada no ocurre (la arena real la rechazaría lanzando)', () => {
  const a = new Arena();
  const f = a.crear([[CO2, 100], [H2O, 100]]), vida = a.crear([], 1e9), r = a.crear();
  const trucada = { ...foto, sintesis: { ...foto.sintesis, dH: foto.sintesis.dH - 1 } };
  assert.throws(() => a.arena.aplicar(vida, trucada.sintesis, 1), /balanceada/);
  assert.equal(copiar(a.arena, q, trucada, vida, [f], r, Infinity, 10), 0);
  assert.equal(a.cuantos(f, CO2), 100);
});

// ── Quemar ─────────────────────────────────────────────────────────────────────────────────────────────────

test('quemar: por demanda, recortado a existencias, el calor queda en el lote', () => {
  const dH = -Q.reaccion(CH2O, O2, AMBIENTE)!.dH;
  const a = new Arena();
  const reserva = a.aT([[CH2O, 100], [O2, 1000]], 295), calor0 = a.calor(reserva);
  const antes = a.totales();
  const J = quemar(a.arena, q, reserva, O2, 2.5 * dH);
  assert.equal(J, 3 * dH, 'quema unidades enteras: sobra menos de una');
  assert.equal(a.cuantos(reserva, CH2O), 97);
  assert.equal(a.cuantos(reserva, CO2), 3);
  assert.equal(a.calor(reserva), calor0 + 3 * dH);
  assert.deepEqual(a.totales(), antes);
  assert.equal(quemar(a.arena, q, reserva, O2, 0), 0, 'sin trabajo no quema');
  assert.equal(quemar(a.arena, q, reserva, O2, NaN), 0);
  assert.equal(quemar(a.arena, q, reserva, O2, 1e12), 97 * dH, 'no alcanza: quema todo lo que hay');
  assert.equal(a.cuantos(reserva, CH2O), 0);
  assert.deepEqual(a.totales(), antes);
  assert.deepEqual(a.totales(), a.esperado());
});

test('quemar: la grasa y el metano arden completos con los coeficientes de Q (enmienda 1), sin soltar H₂', () => {
  const grasa = Q.reaccion(CH2, O2, AMBIENTE)!, metano = Q.reaccion(CH4, O2, AMBIENTE)!;
  const nu = (r: Reaccion, lado: 'entradas' | 'salidas') => Object.fromEntries(r[lado].map((t) => [t.id, t.nu]));
  assert.deepEqual(nu(grasa, 'entradas'), { [CH2]: 2, [O2]: 3 });
  assert.deepEqual(nu(grasa, 'salidas'), { [CO2]: 2, [H2O]: 2 });
  assert.deepEqual(nu(metano, 'entradas'), { [CH4]: 1, [O2]: 2 });
  assert.deepEqual(nu(metano, 'salidas'), { [CO2]: 1, [H2O]: 2 });
  for (const alReves of [false, true]) {
    const a = new Arena(alReves);
    const l = a.aT([[CH2, 1001], [CH4, 500], [O2, 100_000]], 295), antes = a.totales();
    const J = quemar(a.arena, q, l, O2, Infinity);
    assert.equal(J, -500 * grasa.dH - 500 * metano.dH);
    assert.equal(a.cuantos(l, CH2), 1, 'una unidad suelta no llega a la pareja de 2 CH₂');
    assert.equal(a.cuantos(l, CH4), 0);
    assert.equal(a.cuantos(l, H2), 0, 'nada de H₂');
    assert.equal(a.cuantos(l, CO2), 1000 + 500);
    assert.equal(a.cuantos(l, H2O), 1000 + 1000);
    assert.equal(a.cuantos(l, O2), 100_000 - 1500 - 1000);
    assert.deepEqual(a.totales(), antes);
  }
  // Con O₂ para 1 vez de grasa (3) y un resto (2), arde la grasa una vez y el metano con lo que queda.
  const a = new Arena();
  const l = a.aT([[CH2, 10], [CH4, 10], [O2, 5]], 295);
  assert.equal(quemar(a.arena, q, l, O2, Infinity), -grasa.dH - metano.dH);
  assert.equal(a.cuantos(l, O2), 0);
});

test('quemar: sin oxidante no hay fuego; salta lo que no arde, lo encolado y lo desbalanceado', async () => {
  const a = new Arena();
  assert.equal(quemar(a.arena, q, a.aT([[CH2O, 100]], 295), O2, 100), 0, 'sin O₂');
  // Q diferido real con los mismos ids: N₂ + O₂ ya resuelto (null); CH₂ + O₂, aún encolada (undefined) este tick.
  const D = cargarSustancias(serializarSustancias(Q), { modo: 'diferido' });
  try {
    assert.equal(D.reaccion(N2, O2, AMBIENTE), undefined);
    await D.esperarBarrera();
    assert.equal(D.reaccion(N2, O2, AMBIENTE), null);
    const qq = new QuimicaCon(D);
    // Trucada con sus reactivos presentes: crearía 1 MJ de la nada si quemar no exigiera el balance (la arena real lanzaría).
    qq.cambios.set(`${SIO2},${O2}`, { ...Q.reaccion(CH2O, O2, AMBIENTE)!, a: SIO2, b: O2,
      entradas: [{ id: SIO2, nu: 1 }, { id: O2, nu: 1 }], salidas: [{ id: SIO2, nu: 1 }, { id: O2, nu: 1 }], dH: -1e6 });
    const lote = a.aT([[CH2, 50], [SIO2, 50], [N2, 50], [O2, 100]], 295), calor0 = a.calor(lote);
    const antes = a.totales();
    assert.equal(quemar(a.arena, qq, lote, O2, 1e9), 0);
    assert.deepEqual(a.totales(), antes);
    assert.equal(a.calor(lote), calor0);
    assert.equal(D.reaccion(CH2, O2, AMBIENTE), undefined, 'quemar la dejó encolada');
  } finally {
    await D.cerrar();
  }
  // El oxidante 0 no es una sustancia: Q lo toma por reacción unaria (CH₂O → H₂O + C, exotérmica) y quemaría sin O₂.
  const unaria = Q.reaccion(CH2O, 0, AMBIENTE)!;
  assert.ok(unaria.dH < 0 && balanceada(q, unaria), 'pirólisis exotérmica');
  assert.equal(quemar(a.arena, q, a.aT([[CH2O, 100]], 295), 0, 1e9), 0);
});

test('quemar: el comburente o el combustible se agotan a mitad; el orden de las ranuras no decide', () => {
  const dH1 = -Q.reaccion(CH2O, O2, AMBIENTE)!.dH, dH2 = -Q.reaccion(HCHO, O2, AMBIENTE)!.dH;
  assert.ok(dH1 > 0 && dH2 > 0 && dH1 !== dH2);
  assert.ok(CH2O < HCHO);
  for (const alReves of [false, true]) {
    const a = new Arena(alReves);
    // Un solo O₂: arde una vez el combustible de menor id, en cualquier orden de ranuras; después no se consulta Q.
    const uno = a.aT([[O2, 1], [CH2O, 10], [HCHO, 10]], 295), antes = a.totales();
    let consultas = 0;
    const contada: ServicioQuimico = { internar: () => { throw new Error('no'); }, sustancia: (id) => Q.sustancia(id),
      reaccion: (x, y, n) => { consultas++; return Q.reaccion(x, y, n); } };
    assert.equal(quemar(a.arena, contada, uno, O2, 1e9), dH1);
    assert.equal(consultas, 1, 'sin O₂ ya no pregunta a Q');
    assert.equal(a.cuantos(uno, HCHO), 10);
    assert.deepEqual(a.totales(), antes);
    // Combustible escaso: se acaba el primero y sigue con el segundo hasta pagar.
    const dos = a.aT([[O2, 100], [CH2O, 3], [HCHO, 10]], 295), antes2 = a.totales();
    assert.equal(quemar(a.arena, q, dos, O2, 3 * dH1 + 2 * dH2 - 1), 3 * dH1 + 2 * dH2);
    assert.equal(a.cuantos(dos, CH2O), 0);
    assert.equal(a.cuantos(dos, HCHO), 8);
    assert.equal(quemar(a.arena, q, dos, O2, Infinity), 8 * dH2, 'trabajo infinito: quema lo que hay sin pedir veces infinitas');
    assert.deepEqual(a.totales(), antes2);
  }
});

// ── Romper ─────────────────────────────────────────────────────────────────────────────────────────────────

test('reparto: el filo y la palanca concentran; se gasta el más blando', () => {
  const r = reparto(golpe(100, 1, 0.5, 4, 0.8), { dureza: 0.4, tenacidad: 0.49 });
  assert.equal(r.blanco, 100 * 2 * 3 / (0.49 + EPS_TENACIDAD));
  assert.equal(r.util, 100 * 2 * 3 * 0.25 * 0.5, 'el útil, el doble de duro, se gasta con r⁻² = ¼');
  const blando = reparto(golpe(100, 0, 0, 0, 0.2), { dureza: 0.8, tenacidad: 0 });
  assert.equal(blando.blanco, 100 * (0.25 ** 2) / EPS_TENACIDAD);
  assert.equal(blando.util, 100);
  assert.deepEqual(reparto(golpe(10, 0, 0, 0, 0), { dureza: 0, tenacidad: 0.99 }), { blanco: 10, util: 10 }, 'blando contra blando');
  assert.equal(reparto(golpe(10, 0, 0, 0, 0.5), { dureza: 0, tenacidad: 0.99 }).util, 0, 'contra lo blando no se gasta');
});

test('romper: desprende la misma química con su calor, insesgado, y conserva', () => {
  const a = new Arena(false, 2100);
  const madera = a.aT([[CH2O, 100000], [ORGP, 1000], [H2O, 3]], 295);
  const v = a.vista(madera);
  // La dureza y la tenacidad salen de la composición (arena real): la celulosa no es rígida y su tenacidad es 0,47.
  assert.equal(v.dureza, 0);
  assert.ok(Math.abs(v.tenacidad - S(CH2O).prop.tenacidad) < 0.01, `tenacidad ${v.tenacidad}`);
  const dMedia = (id: SustanciaId) => S(id).prop.dMedia;
  const cohesion = FRACTURA * (100000 * dMedia(CH2O) + 1000 * dMedia(ORGP) + 3 * dMedia(H2O));
  const antes = a.totales();
  let desgaste = 0, frags = 0;
  // Útil de madera (dureza 0, tenacidad 0,5, esbeltez 4): P = 3·trabajo; 2.000 golpes desprenden el 1 % de la cohesión.
  const azar = semilla(7), trabajo = 0.01 * cohesion * (v.tenacidad + EPS_TENACIDAD) / 3 / 2000, fragmentos: LoteRef[] = [];
  for (let i = 0; i < 2000; i++) {
    const frag = a.crear();
    fragmentos.push(frag);
    const r = romper(a.arena, q, madera, frag, golpe(trabajo, 0, 0.5, 4, 0), azar);
    desgaste += r.desgaste; frags += r.cuantos;
  }
  assert.deepEqual(a.totales(), antes);
  // f ≈ 1 % acumulado entre 2.000 golpes: ≈ 1 % de cada sustancia (el agua, con 3 cuantos, la cubre la prueba de desprender).
  assert.ok(Math.abs(100000 - a.cuantos(madera, CH2O) - 1000) < 80, `celulosa ${a.cuantos(madera, CH2O)}`);
  assert.ok(Math.abs(1000 - a.cuantos(madera, ORGP) - 10) < 12, `fosfato orgánico ${a.cuantos(madera, ORGP)}`);
  assert.ok(Math.abs(desgaste - 2000 * 3 * trabajo * 0.5) < 1e-6 * desgaste, 'blando contra blando: r = 1, se gasta (1 − tenacidad)');
  assert.ok(frags > 0);
  // Los fragmentos juntos salen a la misma T que la madera (el redondeo hacia abajo del calor pierde < 1 J por golpe).
  let calor = 0, atomos = 0;
  for (const l of fragmentos) { const T = a.vista(l).T; calor += a.calor(l); atomos += T > 0 ? a.calor(l) / (CAPACIDAD_ATOMO * T) : 0; }
  const T = a.vista(madera).T;
  assert.ok(Math.abs(calor / (CAPACIDAD_ATOMO * atomos) - T) / T < 0.05, `T ${calor / (CAPACIDAD_ATOMO * atomos)} frente a ${T}`);
});

test('desprender: fracción conocida, redondeo con tiradas fijas por id y calor exacto en proporción a los átomos', () => {
  const coh = FRACTURA * (10 * S(H2O).prop.dMedia + 10 * S(CO2).prop.dMedia);
  assert.ok(H2O < CO2);
  for (const alReves of [false, true]) {
    const a = new Arena(alReves);
    // f = ¼: 2,5 cuantos de cada una; la primera tirada (H₂O, id menor) redondea arriba y la segunda (CO₂) abajo.
    const l = a.crear([[H2O, 10], [CO2, 10]], 1001), b = a.crear(), tiradas = [0.4, 0.6];
    assert.equal(desprender(a.arena, q, l, b, coh / 4, () => tiradas.shift()!), 5);
    assert.equal(a.cuantos(b, H2O), 3);
    assert.equal(a.cuantos(b, CO2), 2);
    assert.equal(a.calor(b), Math.floor(1001 * 15 / 60), '15 de 60 átomos: ⌊1001/4⌋');
  }
  // Calor enorme: el reparto es el cociente exacto, sin el redondeo del doble (4 de 5 aguas: 12 de 15 átomos).
  const a = new Arena(), M = Number.MAX_SAFE_INTEGER;
  const l = a.crear([[H2O, 5]], M), b = a.crear();
  assert.equal(desprender(a.arena, q, l, b, FRACTURA * 4 * S(H2O).prop.dMedia, () => 0.99), 4);
  assert.equal(a.calor(b), Number(BigInt(M) * 12n / 15n));
  assert.equal(a.calor(l) + a.calor(b), M);
});

test('desprender: un cuanto cuesta FRACTURA·D̄ J (enmienda 1); la mitad de la cohesión se lleva la mitad exacta', () => {
  const a = new Arena();
  const l = a.aT([[SIO2, 1000], [CACO3, 10]], 295), b = a.crear(), c = a.crear(), antes = a.totales();
  const coh = FRACTURA * (1000 * S(SIO2).prop.dMedia + 10 * S(CACO3).prop.dMedia);
  assert.equal(desprender(a.arena, q, l, b, coh / 2, () => 0.5), 505);
  assert.equal(a.cuantos(b, SIO2), 500);
  assert.equal(a.cuantos(b, CACO3), 5);
  // Lo que queda tiene la mitad de la cohesión: pagarla entera se lo lleva todo, y pagar el doble no da más.
  assert.equal(desprender(a.arena, q, l, c, 2 * coh, () => 0.5), 505);
  assert.equal(a.cuantos(l, SIO2) + a.cuantos(l, CACO3), 0);
  assert.equal(a.calor(l), 0);
  assert.deepEqual(a.totales(), antes);
});

test('romper: un golpe enorme se lleva el lote entero con todo su calor; el blando no rompe y se gasta', () => {
  const a = new Arena();
  const roca = a.aT([[SIO2, 500], [CACO3, 20]], 295), calor0 = a.calor(roca);
  assert.ok(a.vista(roca).dureza > 0, 'el SiO₂ percola: la roca es rígida');
  const frag = a.crear(), antes = a.totales();
  const r = romper(a.arena, q, roca, frag, golpe(1e12, 0, 0, 0, 0.9), semilla(1));
  assert.equal(r.cuantos, 520);
  assert.equal(a.calor(roca), 0);
  assert.equal(a.calor(frag), calor0);
  assert.deepEqual(a.totales(), antes);
  // Útil de madera (dureza 0) contra una roca rígida: r = 0, nada se desprende y el útil se gasta con `desprender`.
  const roca2 = a.aT([[SIO2, 500]], 295), util = a.aT([[CH2O, 200]], 295), polvo = a.crear();
  const antes2 = a.totales();
  const r2 = romper(a.arena, q, roca2, a.crear(), golpe(1000, 0, 0.47, 2, a.vista(util).dureza), semilla(2));
  assert.equal(r2.cuantos, 0);
  assert.equal(r2.desgaste, 1000 * (1 + 0.47 * 2) * (1 - 0.47));
  assert.ok(desprender(a.arena, q, util, polvo, r2.desgaste, semilla(3)) > 0);
  assert.equal(desprender(a.arena, q, a.crear(), polvo, 1e9, semilla(4)), 0, 'lote vacío');
  assert.equal(desprender(a.arena, q, util, polvo, 0, semilla(5)), 0, 'sin trabajo');
  assert.deepEqual(a.totales(), antes2);
  assert.deepEqual(a.totales(), a.esperado());
});

// ── Propiedad: ninguna plantilla ni ecuación crea o destruye átomos o energía ──────────────────────────────

/** Oráculo independiente y de fuerza bruta: ¿hay coeficientes enteros en [0, tope] con la unidad > 0 que balanceen los
 * átomos? (columna 0 = la unidad, después subproductos con + y entradas con −). */
function haySolucion(cols: number[][], tope: number): boolean {
  const z = new Array<number>(cols.length).fill(0);
  for (;;) {
    let i = 0;
    while (i < z.length && z[i] === tope) z[i++] = 0;
    if (i === z.length) return false;
    z[i]!++;
    if (z[0]! > 0 && cols[0]!.every((_, k) => cols.reduce((s, c, j) => s + c[k]! * z[j]!, 0) === 0)) return true;
  }
}

test('al azar por semilla: toda plantilla viable está balanceada, cumple Liebig y las tres leyes conservan al entero', (t) => {
  const tejidos = [CH2O, CH2, MEA, CACO3, ORGP, H2O];
  const pool = [CO2, H2O, NH3, H3PO4, CAOH2, O2, N2];
  let viables = 0, oraculo = 0, sintetizadas = 0, quemado = 0, roto = 0;
  for (let s = 1; s <= 400; s++) {
    const azar = semilla(s), entero = (n: number) => 1 + Math.floor(azar() * n);
    const partes = tejidos.filter(() => azar() < 0.5).map((id) => ({ id, nu: entero(s % 4 === 0 ? 2 : 40) }));
    // La mitad de las semillas toma el entorno de una planta (fuentes minerales, sale O₂); la otra mitad reparte al azar
    // los papeles de entrada, subproducto o ausente (a menudo imposibles: deben dar null).
    const papel = pool.map((id) => (s <= 200 ? (id === O2 ? 0.7 : id === N2 ? 1 : azar() * 0.65) : azar()));
    const entradas = pool.filter((_, i) => papel[i]! < 0.55), subproductos = pool.filter((_, i) => papel[i]! >= 0.55 && papel[i]! < 0.8);
    const p = crearPlantilla(q, new RegistroPrueba(), { partes, entradas, subproductos, ...base });
    if (!p) {
      // Un null nunca descarta una solución: el oráculo no encuentra ninguna con coeficientes pequeños.
      const cols = [Array.from({ length: NE }, (_, k) => partes.reduce((a, x) => a + x.nu * S(x.id).atomos[k]!, 0)),
        ...subproductos.map((id) => [...S(id).atomos]), ...entradas.map((id) => [...S(id).atomos].map((v) => -v))];
      if (partes.length > 0 && s % 4 === 0 && cols.length <= 7) { oraculo++; assert.ok(!haySolucion(cols, 4), `semilla ${s}: null con solución`); }
      continue;
    }
    viables++;
    assert.ok(balanceada(q, p.sintesis), `semilla ${s}`);
    assert.ok(p.sintesis.entradas.every((x) => entradas.includes(x.id)), 'solo entradas ofrecidas');
    assert.ok(p.partes.every((x) => p.sintesis.salidas.some((y) => y.id === x.id && y.nu >= x.nu)), 'las partes salen enteras');

    const a = new Arena(azar() < 0.5, 8);
    const fuente = a.crear(pool.map((id) => [id, Math.floor(azar() * 5000)] as [SustanciaId, number]), entero(1e6));
    const destino = a.crear([[O2, entero(1000)]], entero(1e8)), residuo = a.crear();
    const antes = a.totales(), libro = structuredClone(a.libro), calor0 = a.calor(destino);
    const existencias = p.sintesis.entradas.map((x) => a.cuantos(fuente, x.id));
    const energia = azar() * 1e8, max = azar() * 50, dH = p.sintesis.dH;
    const n = copiar(a.arena, q, p, destino, [fuente], residuo, energia, max);
    const liebig = Math.min(...p.sintesis.entradas.map((x, i) => Math.floor(existencias[i]! / x.nu)));
    assert.equal(n, Math.min(Math.floor(max), liebig, dH > 0 ? Math.floor(Math.min(energia, calor0) / dH) : Infinity), `semilla ${s}`);
    for (const x of p.sintesis.salidas) {
      assert.equal(a.cuantos(residuo, x.id), n * (x.nu - (p.partes.find((y) => y.id === x.id)?.nu ?? 0)), 'al residuo, lo que no es parte');
    }
    sintetizadas += n;
    quemado += quemar(a.arena, q, destino, O2, azar() * 1e5);
    roto += romper(a.arena, q, destino, a.crear(), golpe(azar() * 1e6, azar(), azar(), azar() * 5, azar()), azar).cuantos;
    assert.deepEqual(a.totales(), antes, `semilla ${s}`);
    assert.deepEqual(a.totales(), a.esperado(), `semilla ${s}`);
    assert.deepEqual(a.libro, libro, 'las leyes no declaran fuentes ni sumideros');

    const trucada = { ...p, sintesis: { ...p.sintesis, salidas: p.sintesis.salidas.map((x, i) => (i === 0 ? { ...x, nu: x.nu + 1 } : x)) } };
    assert.ok(!balanceada(q, trucada.sintesis));
    const quieto = a.totales();
    assert.equal(copiar(a.arena, q, trucada, destino, [fuente], residuo, Infinity, 50), 0);
    assert.deepEqual(a.totales(), quieto);
  }
  t.diagnostic(`viables ${viables}/400, nulls contrastados con el oráculo ${oraculo}, unidades sintetizadas ${sintetizadas}, J quemados ${quemado}, cuantos rotos ${roto}`);
  assert.ok(viables >= 60 && oraculo >= 20, `plantillas viables: ${viables} de 400; oráculo ${oraculo}`);
  assert.ok(sintetizadas > 0 && quemado > 0 && roto > 0);
});
