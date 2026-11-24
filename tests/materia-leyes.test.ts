// Leyes de uso de la materia (carril L): copiar (plantillas balanceadas, Liebig) y romper (desprender, quemar).
// La arena, el registro y la química son dobles mínimos de este fichero: los de verdad son de los carriles A, M1 y Q.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPACIDAD_ATOMO, ELEMENTOS, NE, TABLA } from '../src/shared/naturaleza.js';
import { ClaseSustancia, TIPOS, type SustanciaId } from '../src/shared/materia.js';
import { DATO_GOLPEAR, type Registro } from '../src/world/motor/contratos.js';
import {
  libroVacio, type ArenaMateria, type Ecuacion, type Libro, type LoteRef, type Pedido, type Reaccion, type Rol,
  type ServicioQuimico, type Sustancia, type Traslado, type VistaLote,
} from '../src/world/materia/tipos.js';
import { balanceada, copiar, crearPlantilla, type DatosPlantilla } from '../src/world/materia/copiar.js';
import { desprender, quemar, reparto, romper } from '../src/world/materia/romper.js';

// ── Sustancias reales, construidas desde sus enlaces con TIPOS ───────────────────────────────────────────────

type Enlace = [string, string, number, number]; // elemento, elemento, orden, cuántos
const sustancias = new Map<SustanciaId, Sustancia>();
function sustancia(enlaces: Enlace[]): SustanciaId {
  const id = sustancias.size + 1, usos = new Array<number>(NE).fill(0), pares: number[] = [];
  let energia = 0, suma = 0;
  for (const [x, y, k, n] of enlaces) {
    const [e, f] = [ELEMENTOS.indexOf(x as never), ELEMENTOS.indexOf(y as never)].sort((a, b) => a - b) as [number, number];
    const tipo = TIPOS.findIndex((t) => t.e === e && t.f === f && t.k === k);
    assert.ok(tipo >= 0, `${x}${y}${k}`);
    usos[e] += k * n; usos[f] += k * n;
    energia -= TIPOS[tipo]!.d * n; suma += TIPOS[tipo]!.d * n;
    pares.push(tipo, n);
  }
  const atomos = Uint8Array.from(usos.map((u, e) => u / TABLA[e]!.valencia));
  assert.ok(atomos.every((a, e) => a === usos[e]! / TABLA[e]!.valencia), 'valencias saturadas');
  const masa = atomos.reduce((s, a, e) => s + a * TABLA[e]!.masa, 0);
  const prop = { r: 0, dMedia: suma / enlaces.reduce((s, x) => s + x[3], 0), tFusion: 0, tEbullicion: 0, qOxidacion: 0,
    dureza: 0, tenacidad: 0, flexibilidad: 0, polaridad: 0, densidad: 1, color: 0 };
  sustancias.set(id, { id, clase: ClaseSustancia.Unidad, enlaces: Uint16Array.from(pares), atomos, masa, energia, prop });
  return id;
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
const GLY = sustancia([['H', 'N', 1, 2], ['C', 'N', 1, 1], ['C', 'H', 1, 2], ['C', 'C', 1, 1],
  ['C', 'O', 2, 1], ['C', 'O', 1, 1], ['H', 'O', 1, 1]]);                                          // C₂H₅NO₂
const CACO3 = sustancia([['Ca', 'O', 1, 2], ['C', 'O', 1, 2], ['C', 'O', 2, 1]]);
const FOSFATO = sustancia([['C', 'H', 1, 3], ['C', 'O', 1, 1], ['O', 'P', 1, 3], ['O', 'P', 2, 1], ['H', 'O', 1, 2]]); // CH₅O₄P
const SIO2 = sustancia([['O', 'Si', 1, 4]]);

const E = (id: SustanciaId) => sustancias.get(id)!.energia;
/** Reacción a + b → productos con dH exacto (como las daría Q). */
const reac = (a: SustanciaId, b: SustanciaId, salidas: { id: SustanciaId; nu: number }[]): Reaccion => ({
  a, b, nivelT: 0, ea: 0, catalisis: -1, entradas: [{ id: a, nu: 1 }, { id: b, nu: 1 }], salidas,
  dH: salidas.reduce((s, t) => s + t.nu * E(t.id), 0) - E(a) - E(b),
});

class QuimicaPrueba implements ServicioQuimico {
  reacciones = new Map<string, Reaccion | null | undefined>([[`${CH2O},${O2}`, reac(CH2O, O2, [{ id: CO2, nu: 1 }, { id: H2O, nu: 1 }])]]);
  internar(): SustanciaId { throw new Error('L no interna sustancias'); }
  sustancia(id: SustanciaId) { return sustancias.get(id)!; }
  reaccion(a: SustanciaId, b: SustanciaId) { return this.reacciones.get(`${a},${b}`) ?? null; }
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

// ── Arena mínima: conserva por construcción y recorta como el contrato ─────────────────────────────────────

interface LotePrueba { esp: Map<SustanciaId, number>; calor: number; dureza: number; tenacidad: number }
class ArenaPrueba implements ArenaMateria {
  tabla: LotePrueba[] = [];
  libro: Libro = libroVacio();
  crear(contenido: [SustanciaId, number][] = [], calor = 0, dureza = 0, tenacidad = 0): LoteRef {
    this.tabla.push({ esp: new Map(contenido), calor, dureza, tenacidad });
    return this.tabla.length - 1;
  }
  nuevo(_rol: Rol, _celda: number, _forma: number) { return this.crear(); }
  especies(l: LoteRef, ids: Uint32Array) {
    const vivas = [...this.tabla[l]!.esp].filter(([, c]) => c > 0).map(([id]) => id);
    vivas.slice(0, ids.length).forEach((id, i) => { ids[i] = id; });
    return vivas.length;
  }
  cuantos(l: LoteRef, id: SustanciaId) { return this.tabla[l]!.esp.get(id) ?? 0; }
  calor(l: LoteRef) { return this.tabla[l]!.calor; }
  vista(l: LoteRef): VistaLote {
    const lote = this.tabla[l]!;
    let atomos = 0;
    for (const [id, c] of lote.esp) atomos += c * sustancias.get(id)!.atomos.reduce((s, v) => s + v, 0);
    return { masa: 0, T: lote.calor / (CAPACIDAD_ATOMO * atomos), fase: 0, dureza: lote.dureza, tenacidad: lote.tenacidad,
      sellado: 0, aislamiento: 0, energia: 0, digerible: 0, agua: 0, color: 0, forma: 0, principal: 0 };
  }
  mover(t: Traslado) {
    const c = Math.min(t.cuantos, this.cuantos(t.de, t.esp));
    assert.ok(Number.isSafeInteger(c) && c >= 0, 'traslado entero');
    this.tabla[t.de]!.esp.set(t.esp, this.cuantos(t.de, t.esp) - c);
    this.tabla[t.a]!.esp.set(t.esp, this.cuantos(t.a, t.esp) + c);
    return c;
  }
  moverCalor(de: LoteRef, a: LoteRef, j: number) {
    const c = Math.min(j, this.tabla[de]!.calor);
    assert.ok(Number.isSafeInteger(c) && c >= 0, 'calor entero');
    this.tabla[de]!.calor -= c; this.tabla[a]!.calor += c;
    return c;
  }
  aplicar(l: LoteRef, e: Ecuacion, veces: number) {
    const lote = this.tabla[l]!;
    let v = Math.floor(veces);
    for (const t of e.entradas) v = Math.min(v, Math.floor(this.cuantos(l, t.id) / t.nu));
    if (e.dH > 0) v = Math.min(v, Math.floor(lote.calor / e.dH));
    if (!(v > 0)) return 0;
    for (const t of e.entradas) lote.esp.set(t.id, this.cuantos(l, t.id) - v * t.nu);
    for (const t of e.salidas) lote.esp.set(t.id, this.cuantos(l, t.id) + v * t.nu);
    lote.calor -= v * e.dH;
    return v;
  }
  liberar(): void { throw new Error('no lo usa L'); }
  vivo() { return true; }
  propio() { return true; }
  adoptar(): void { throw new Error('no lo usa L'); }
  lotes(): number { throw new Error('no lo usa L'); }
  formar(): void { throw new Error('no lo usa L'); }
  moverParte(_d: LoteRef, _a: LoteRef, _p: Pedido): number { throw new Error('no lo usa L'); }
  garantizar(): Float64Array { throw new Error('no lo usa L'); }
  abonar(): void { throw new Error('no lo usa L'); }
  fuente(): void { throw new Error('no lo usa L'); }
  sumidero(): Float64Array { throw new Error('no lo usa L'); }

  /** Átomos por elemento y energía (química + calor) de toda la arena, en bigint. */
  totales(): bigint[] {
    const t = new Array<bigint>(NE + 1).fill(0n);
    for (const lote of this.tabla) {
      for (const [id, c] of lote.esp) {
        const s = sustancias.get(id)!;
        for (let k = 0; k < NE; k++) t[k]! += BigInt(c) * BigInt(s.atomos[k]!);
        t[NE]! += BigInt(c) * BigInt(s.energia);
      }
      t[NE]! += BigInt(lote.calor);
    }
    return t;
  }
}

const q = new QuimicaPrueba();
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

// ── Balance ────────────────────────────────────────────────────────────────────────────────────────────────

test('balanceada: átomos y dH exactos, nada de fraccionarios', () => {
  const ok = reac(CH2O, O2, [{ id: CO2, nu: 1 }, { id: H2O, nu: 1 }]);
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
  // C₂H₅NO₂: 2 CO₂ + H₂O + NH₃ → glicina + 3/2 O₂, así que la unidad es de 2 glicinas.
  const p = crearPlantilla(q, new RegistroPrueba(), datos([{ id: GLY, nu: 1 }], [CO2, H2O, NH3]))!;
  assert.deepEqual(p.partes, [{ id: GLY, nu: 2 }]);
  assert.deepEqual(p.sintesis.entradas, [{ id: H2O, nu: 2 }, { id: CO2, nu: 4 }, { id: NH3, nu: 2 }]);
  assert.deepEqual(p.sintesis.salidas, [{ id: O2, nu: 3 }, { id: GLY, nu: 2 }]);
  assert.ok(balanceada(q, p.sintesis));
});

test('crearPlantilla: lo que no se puede balancear no es viable', () => {
  const r = new RegistroPrueba();
  assert.equal(crearPlantilla(q, r, datos([{ id: CACO3, nu: 1 }], [CO2, H2O])), null, 'falta el Ca');
  assert.equal(crearPlantilla(q, r, datos([{ id: GLY, nu: 1 }], [CO2, H2O, NH3, N2])), null, 'dos fuentes de N: ambiguo');
  assert.equal(crearPlantilla(q, r, datos([{ id: CACO3, nu: 1 }], [CAOH2, CO2, H2O])), null, 'tendría que salir agua');
  assert.equal(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1 }], [CO2, H2O], [O2, H2O])), null, 'agua en los dos lados');
  assert.equal(crearPlantilla(q, r, datos([{ id: CH2O, nu: 1.5 }], [CO2, H2O])), null, 'partes no enteras');
  assert.equal(crearPlantilla(q, r, datos([], [CO2, H2O])), null, 'sin partes');
  assert.equal(r.n, 0, 'nada inviable entra en el registro');
});

test('crearPlantilla: el id es el del registro por contenido', () => {
  const r = new RegistroPrueba();
  const a = crearPlantilla(q, r, datos([{ id: CH2O, nu: 3 }, { id: GLY, nu: 1 }], [CO2, H2O, NH3]))!;
  const b = crearPlantilla(q, r, datos([{ id: GLY, nu: 1 }, { id: CH2O, nu: 3 }], [NH3, H2O, CO2]))!;
  const c = crearPlantilla(q, r, { ...datos([{ id: CH2O, nu: 3 }, { id: GLY, nu: 1 }], [CO2, H2O, NH3]), linaje: 2 })!;
  assert.equal(a.id, b.id, 'el orden de los datos no cambia la identidad');
  assert.notEqual(a.id, c.id);
});

// ── Copiar ─────────────────────────────────────────────────────────────────────────────────────────────────

const foto = crearPlantilla(q, new RegistroPrueba(), datos([{ id: CH2O, nu: 1 }], [CO2, H2O]))!;
const gly = crearPlantilla(q, new RegistroPrueba(), datos([{ id: GLY, nu: 1 }], [CO2, H2O, NH3]))!;

test('copiar: sintetiza en el destino, los subproductos van al residuo y conserva', () => {
  const a = new ArenaPrueba();
  const aire = a.crear([[CO2, 1000]]), agua = a.crear([[H2O, 1000]]);
  const vida = a.crear([], 100 * foto.sintesis.dH + 7), residuo = a.crear();
  const antes = a.totales();
  assert.equal(copiar(a, q, foto, vida, [aire, agua], residuo, Infinity, 100), 100);
  assert.equal(a.cuantos(vida, CH2O), 100);
  assert.equal(a.cuantos(residuo, O2), 100);
  assert.equal(a.cuantos(vida, O2), 0);
  assert.equal(a.cuantos(aire, CO2), 900);
  assert.equal(a.cuantos(agua, H2O), 900);
  assert.equal(a.calor(vida), 7, 'la síntesis gasta exactamente n·dH');
  assert.deepEqual(a.totales(), antes);
  assert.deepEqual(a.libro, libroVacio(), 'sin fuentes ni sumideros');
});

test('copiar: ley del mínimo de Liebig (manda el elemento más escaso; lo demás se queda)', () => {
  const a = new ArenaPrueba();
  // La glicina pide 4 CO₂ + 2 H₂O + 2 NH₃ por unidad: con 7 NH₃ caben 3 unidades aunque sobren C, H y O.
  const suelo = a.crear([[NH3, 7], [H2O, 500]]), aire = a.crear([[CO2, 10000]]);
  const tejido = a.crear([], 1e9), residuo = a.crear();
  const antes = a.totales();
  assert.equal(copiar(a, q, gly, tejido, [aire, suelo], residuo, Infinity, 1e6), 3);
  assert.equal(a.cuantos(tejido, GLY), 6);
  assert.equal(a.cuantos(suelo, NH3), 1);
  assert.equal(a.cuantos(suelo, H2O), 500 - 6);
  assert.equal(a.cuantos(aire, CO2), 10000 - 12);
  assert.deepEqual(a.totales(), antes);
  // Sin el elemento escaso no hay síntesis y nada se mueve.
  const sinN = a.crear([[H2O, 500], [CO2, 500]]), otro = a.crear([], 1e9);
  const quieto = structuredClone(a.tabla);
  assert.equal(copiar(a, q, gly, otro, [sinN], residuo, Infinity, 1e6), 0);
  assert.deepEqual(a.tabla, quieto);
});

test('copiar: las entradas se suman entre fuentes y se toman en su orden', () => {
  const a = new ArenaPrueba();
  const f1 = a.crear([[CO2, 3], [H2O, 10]]), f2 = a.crear([[CO2, 10]]);
  const vida = a.crear([], 1e9), residuo = a.crear();
  assert.equal(copiar(a, q, foto, vida, [f1, f2], residuo, Infinity, 5), 5);
  assert.equal(a.cuantos(f1, CO2), 0);
  assert.equal(a.cuantos(f2, CO2), 8);
});

test('copiar: limitan la energía autorizada, el calor del destino y el ritmo', () => {
  const dH = foto.sintesis.dH;
  const caso = (calor: number, energia: number, max: number) => {
    const a = new ArenaPrueba();
    const f = a.crear([[CO2, 1000], [H2O, 1000]]), vida = a.crear([], calor), r = a.crear();
    const antes = a.totales();
    const n = copiar(a, q, foto, vida, [f], r, energia, max);
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

test('copiar: una ecuación desbalanceada no ocurre', () => {
  const a = new ArenaPrueba();
  const f = a.crear([[CO2, 100], [H2O, 100]]), vida = a.crear([], 1e9), r = a.crear();
  const trucada = { ...foto, sintesis: { ...foto.sintesis, dH: foto.sintesis.dH - 1 } };
  assert.equal(copiar(a, q, trucada, vida, [f], r, Infinity, 10), 0);
  assert.equal(a.cuantos(f, CO2), 100);
});

// ── Quemar ─────────────────────────────────────────────────────────────────────────────────────────────────

test('quemar: por demanda, recortado a existencias, el calor queda en el lote', () => {
  const dH = -reac(CH2O, O2, [{ id: CO2, nu: 1 }, { id: H2O, nu: 1 }]).dH;
  const a = new ArenaPrueba();
  const reserva = a.crear([[CH2O, 100], [O2, 1000]], 1000);
  const antes = a.totales();
  const J = quemar(a, q, reserva, O2, 2.5 * dH);
  assert.equal(J, 3 * dH, 'quema unidades enteras: sobra menos de una');
  assert.equal(a.cuantos(reserva, CH2O), 97);
  assert.equal(a.cuantos(reserva, CO2), 3);
  assert.equal(a.calor(reserva), 1000 + 3 * dH);
  assert.deepEqual(a.totales(), antes);
  assert.equal(quemar(a, q, reserva, O2, 0), 0, 'sin trabajo no quema');
  assert.equal(quemar(a, q, reserva, O2, 1e12), 97 * dH, 'no alcanza: quema todo lo que hay');
  assert.equal(a.cuantos(reserva, CH2O), 0);
  assert.deepEqual(a.totales(), antes);
});

test('quemar: sin oxidante no hay fuego; salta lo que no arde, lo encolado y lo desbalanceado', () => {
  const a = new ArenaPrueba();
  assert.equal(quemar(a, q, a.crear([[CH2O, 100]], 1000), O2, 100), 0, 'sin O₂');
  const qq = new QuimicaPrueba();
  qq.reacciones.set(`${CH2},${O2}`, undefined);                                                       // encolada en Q
  qq.reacciones.set(`${SIO2},${O2}`, { ...reac(CH2O, O2, [{ id: CO2, nu: 1 }, { id: H2O, nu: 1 }]), dH: -1e6 }); // trucada
  // GLY + O₂: Q no da reacción (null).
  const lote = a.crear([[CH2, 50], [SIO2, 50], [GLY, 50], [O2, 100]], 1000);
  const antes = a.totales();
  assert.equal(quemar(a, qq, lote, O2, 1e9), 0);
  assert.deepEqual(a.totales(), antes);
  assert.equal(a.cuantos(lote, SIO2), 50);
});

// ── Romper ─────────────────────────────────────────────────────────────────────────────────────────────────

test('reparto: el filo y la palanca concentran; se gasta el más blando', () => {
  const r = reparto(golpe(100, 1, 0.5, 4, 0.8), { dureza: 0.4, tenacidad: 0.49 });
  assert.equal(r.blanco, 100 * 2 * 3 / 0.5);
  assert.equal(r.util, 100 * 2 * 3 * 0.25 * 0.5);
  const blando = reparto(golpe(100, 0, 0, 0, 0.2), { dureza: 0.8, tenacidad: 0 });
  assert.equal(blando.blanco, 100 * (0.25 ** 2) / 0.01);
  assert.equal(blando.util, 100);
  assert.deepEqual(reparto(golpe(10, 0, 0, 0, 0), { dureza: 0, tenacidad: 0.99 }), { blanco: 10, util: 10 }, 'blando contra blando');
  assert.equal(reparto(golpe(10, 0, 0, 0, 0.5), { dureza: 0, tenacidad: 0.99 }).util, 0, 'contra lo blando no se gasta');
});

test('romper: desprende la misma química con su calor, insesgado, y conserva', () => {
  const a = new ArenaPrueba();
  const madera = a.crear([[CH2O, 100000], [GLY, 1000], [H2O, 3]], 7_000_000, 0.3, 0.49);
  const dMedia = (id: SustanciaId) => sustancias.get(id)!.prop.dMedia;
  const cohesion = 100000 * dMedia(CH2O) + 1000 * dMedia(GLY) + 3 * dMedia(H2O);
  const antes = a.totales();
  let desgaste = 0, frags = 0;
  const azar = semilla(7), trabajo = 0.01 * cohesion * 0.5 / 3 / 2000;
  for (let i = 0; i < 2000; i++) {
    const frag = a.crear();
    const r = romper(a, q, madera, frag, golpe(trabajo, 0, 0.5, 4, 0.6), azar);
    desgaste += r.desgaste; frags += r.cuantos;
  }
  assert.deepEqual(a.totales(), antes);
  // f ≈ 1 % por golpe acumulado entre 2.000 golpes: ≈ 1 % de cada sustancia (redondeo insesgado también en el agua).
  assert.ok(Math.abs(100000 - a.cuantos(madera, CH2O) - 1000) < 80, `celulosa ${a.cuantos(madera, CH2O)}`);
  assert.ok(Math.abs(1000 - a.cuantos(madera, GLY) - 10) < 12, `proteína ${a.cuantos(madera, GLY)}`);
  assert.ok(Math.abs(desgaste - 2000 * 3 * trabajo * 0.25 * 0.5) < 1e-6 * desgaste, 'el útil, el doble de duro, se gasta con r⁻² = ¼');
  assert.ok(frags > 0);
  // Los fragmentos juntos salen a la misma T que la madera (el redondeo hacia abajo del calor pierde < 1 J por golpe).
  let calor = 0, atomos = 0;
  for (let l = 1; l < a.tabla.length; l++) { calor += a.calor(l); atomos += a.vista(l).T > 0 ? a.calor(l) / (CAPACIDAD_ATOMO * a.vista(l).T) : 0; }
  const T = a.vista(madera).T;
  assert.ok(Math.abs(calor / (CAPACIDAD_ATOMO * atomos) - T) / T < 0.05, `T ${calor / (CAPACIDAD_ATOMO * atomos)} frente a ${T}`);
});

test('romper: un golpe enorme se lleva el lote entero con todo su calor; el blando no rompe y se gasta', () => {
  const a = new ArenaPrueba();
  const roca = a.crear([[SIO2, 500], [CACO3, 20]], 123_457, 0.9, 0.2);
  const frag = a.crear(), antes = a.totales();
  const r = romper(a, q, roca, frag, golpe(1e12, 0, 0, 0, 0.9), semilla(1));
  assert.equal(r.cuantos, 520);
  assert.equal(a.calor(roca), 0);
  assert.equal(a.calor(frag), 123_457);
  assert.deepEqual(a.totales(), antes);
  // Útil de madera contra una roca dura: casi nada se desprende y el útil se gasta con `desprender`.
  const roca2 = a.crear([[SIO2, 500]], 1000, 0.9, 0.2), util = a.crear([[CH2O, 200]], 500, 0.1, 0.5), polvo = a.crear();
  const antes2 = a.totales();
  const r2 = romper(a, q, roca2, a.crear(), golpe(1000, 0, 0.5, 2, 0.1), semilla(2));
  assert.equal(r2.cuantos, 0);
  assert.ok(r2.desgaste > 0);
  assert.ok(desprender(a, q, util, polvo, r2.desgaste, semilla(3)) > 0);
  assert.equal(desprender(a, q, a.crear(), polvo, 1e9, semilla(4)), 0, 'lote vacío');
  assert.equal(desprender(a, q, util, polvo, 0, semilla(5)), 0, 'sin trabajo');
  assert.deepEqual(a.totales(), antes2);
});

// ── Propiedad: ninguna plantilla ni ecuación crea o destruye átomos o energía ──────────────────────────────

test('al azar por semilla: toda plantilla viable está balanceada, cumple Liebig y las tres leyes conservan al entero', (t) => {
  const tejidos = [CH2O, CH2, GLY, CACO3, FOSFATO];
  const pool = [CO2, H2O, NH3, H3PO4, CAOH2, O2, N2];
  let viables = 0, sintetizadas = 0, quemado = 0, roto = 0;
  for (let s = 1; s <= 400; s++) {
    const azar = semilla(s), entero = (n: number) => 1 + Math.floor(azar() * n);
    const partes = tejidos.filter(() => azar() < 0.5).map((id) => ({ id, nu: entero(40) }));
    // La mitad de las semillas toma el entorno de una planta (fuentes minerales, sale O₂); la otra mitad reparte al azar
    // los papeles de entrada, subproducto o ausente (casi siempre ambiguos o imposibles: deben dar null).
    const papel = pool.map((id) => (s <= 200 ? (id === O2 ? 0.7 : id === N2 ? 1 : azar() * 0.65) : azar()));
    const entradas = pool.filter((_, i) => papel[i]! < 0.55), subproductos = pool.filter((_, i) => papel[i]! >= 0.55 && papel[i]! < 0.8);
    const p = crearPlantilla(q, new RegistroPrueba(), { partes, entradas, subproductos, ...base });
    if (!p) continue;
    viables++;
    assert.ok(balanceada(q, p.sintesis), `semilla ${s}`);
    assert.ok(p.partes.every((x) => p.sintesis.salidas.some((y) => y.id === x.id && y.nu === x.nu)), 'las partes salen enteras');

    const a = new ArenaPrueba();
    const fuente = a.crear(pool.map((id) => [id, Math.floor(azar() * 5000)] as [SustanciaId, number]), entero(1e6));
    const destino = a.crear([[O2, entero(1000)]], entero(1e8)), residuo = a.crear();
    const antes = a.totales(), calor0 = a.calor(destino), existencias = p.sintesis.entradas.map((x) => a.cuantos(fuente, x.id));
    const energia = azar() * 1e8, max = azar() * 50, dH = p.sintesis.dH;
    const n = copiar(a, q, p, destino, [fuente], residuo, energia, max);
    const liebig = Math.min(...p.sintesis.entradas.map((x, i) => Math.floor(existencias[i]! / x.nu)));
    assert.equal(n, Math.min(Math.floor(max), liebig, dH > 0 ? Math.floor(Math.min(energia, calor0) / dH) : Infinity), `semilla ${s}`);
    sintetizadas += n;
    quemado += quemar(a, q, destino, O2, azar() * 1e5);
    roto += romper(a, q, destino, a.crear(), golpe(azar() * 1e6, azar(), azar(), azar() * 5, azar()), azar).cuantos;
    assert.deepEqual(a.totales(), antes, `semilla ${s}`);
    assert.deepEqual(a.libro, libroVacio());

    const trucada = { ...p, sintesis: { ...p.sintesis, salidas: p.sintesis.salidas.map((x, i) => (i === 0 ? { ...x, nu: x.nu + 1 } : x)) } };
    assert.ok(!balanceada(q, trucada.sintesis));
    const quieto = a.totales();
    assert.equal(copiar(a, q, trucada, destino, [fuente], residuo, Infinity, 50), 0);
    assert.deepEqual(a.totales(), quieto);
  }
  t.diagnostic(`viables ${viables}/400, unidades sintetizadas ${sintetizadas}, J quemados ${quemado}, cuantos rotos ${roto}`);
  assert.ok(viables >= 60, `plantillas viables: ${viables} de 400`);
  assert.ok(sintetizadas > 0 && quemado > 0 && roto > 0);
});
