/**
 * Cuerpos de átomos (carril b): pruebas unitarias sobre la arena y la química reales (`tests/lib/materia-real.ts`), sin
 * mundo ni motor. El entorno de w (sustancias, lotes de la celda, T del aire) se sustituye por lotes de la prueba.
 * Comprueban que cada operación conserva el libro exacto y que las vistas se mueven en el sentido que dice la ley.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DATO_GOLPEAR, REF_NULA, type Intento, type Registro } from '../src/world/motor/contratos.js';
import type { CtxLeyMateria } from '../src/world/motor/acceso.js';
import { crearPlantilla } from '../src/world/materia/copiar.js';
import {
  KAPPA_HUMANA, MASA_ADULTA_HUMANA, T_CUERPO, abonar, abortar, basalJ, beber, cargaKg, concebir, crearCuerpo, crecer, entorno,
  costeGestacionJ, extraer, fundarCuerpo, gestar, herir, ingerirSelecto, lotesDe, masaDe, masaLote, metabolizar, morir, pagar, parir,
  plantillaDe, plantillaHumana, plantillaPorId, provecho, reservaJ, soltar, tasasBasales, vistaCuerpo,
} from '../src/world/materia/cuerpo.js';
import { Rol, type LoteRef, type VistaCuerpo } from '../src/world/materia/tipos.js';
import { materiaReal, azarSembrado } from './lib/materia-real.js';

class RegistroPrueba implements Registro {
  private readonly ids = new Map<string, number>();
  private readonly bytes: Uint8Array[] = [];
  insertar(c: Uint8Array): number {
    const k = Buffer.from(c).toString('hex');
    let id = this.ids.get(k);
    if (id === undefined) { this.ids.set(k, id = this.bytes.length); this.bytes.push(Uint8Array.from(c)); }
    return id;
  }
  leer(id: number): Uint8Array | undefined { return this.bytes[id]; }
  get n(): number { return this.bytes.length; }
}

const m = materiaReal({ capacidad: 1024 });
after(() => m.cerrar());
const enviados: Intento[] = [];
let nonce = 1;
const azar = azarSembrado(7);
const c = {
  tick: 100, hilo: 0, materia: m.arena, quimica: m.quimica, libro: m.libro, azar,
  globales: { registro: new RegistroPrueba(), lugares: new Map(), comunidades: new Map(), version: 0 },
  terreno: { duenoChunk: Int16Array.of(0), chunkDe: (celda: number) => celda >> 8 },
  buzon: { enviar: (_h: number, i: Intento) => { enviados.push({ ...i, materia: i.materia && Float64Array.from(i.materia) }); } },
  id: () => nonce++,
} as unknown as CtxLeyMateria;

// Una celda de prueba: aire de la página (composición del mundo), suelo, charca y vegetación con fruto y hoja.
const T_AIRE = 295, CELDA = 5;
const aire = m.lote({ N2: 7_800_000, O2: 2_100_000, CO2: 200_000 }, T_AIRE, Rol.Aire);
const suelo = m.lote({ SiO2: 100_000 }, T_AIRE, Rol.Suelo);
const agua = m.lote({ H2O: 2_000_000 }, T_AIRE, Rol.Agua);
const vida = m.lote({ CH2: 400_000, proteina: 100_000, orgP: 100_000, madera: 2_000_000 }, T_AIRE, Rol.Vida);
entorno.sustancias = () => m.S as unknown as ReturnType<typeof entorno.sustancias>;
entorno.lotes = (_c, _celda, out) => { out.suelo = suelo; out.agua = agua; out.vida = vida; out.aire = aire; return out; };
entorno.temperatura = () => T_AIRE;

const exacto = (): boolean => {
  const hay = m.arena.saldo(), debe = m.esperado();
  return hay.every((v, i) => BigInt(v) + BigInt(m.libro.enVuelo[i]!) === debe[i]);
};
const vista = (): VistaCuerpo => ({ hambre: 0, sed: 0, energia: 0, salud: 0, masa: 0, carga: 0, T: 0 });
const humana = plantillaHumana(c);

test('la plantilla humana se balancea y vuelve igual del Registro', () => {
  assert.equal(humana.sintesis.dH, 0, 'asimilación: las entradas son las partes');
  assert.deepEqual([...humana.kappa], [...KAPPA_HUMANA]);
  assert.equal(humana.masaAdulta, MASA_ADULTA_HUMANA);
  const registro = new RegistroPrueba(), S = m.S;
  const otra = crearPlantilla(m.quimica, registro, {
    partes: [{ id: S.madera, nu: 20 }, { id: S.CH2, nu: 2 }, { id: S.proteina, nu: 2 }, { id: S.orgP, nu: 1 }],
    entradas: [S.CO2, S.H2O, S.NH3, S.H3PO4], subproductos: [S.O2], kappa: [0, 0, 0, 0], captura: 0.1, masaAdulta: 1, m0: 0.05, linaje: 3,
  });
  assert.ok(otra);
  const leida = plantillaPorId({ ...c, globales: { ...c.globales, registro } } as CtxLeyMateria, otra.id);
  assert.deepEqual(JSON.parse(JSON.stringify(leida)), JSON.parse(JSON.stringify(otra)));
});

test('un cuerpo fundado nace saciado, a su temperatura y con el libro exacto', () => {
  const cuerpo = crearCuerpo(c, humana.id, 60), v = vistaCuerpo(c, cuerpo, vista());
  assert.ok(Math.abs(v.salud - 1) < 1e-3 && v.hambre < 1e-3 && v.sed < 1e-3 && v.energia > 0.99, JSON.stringify(v));
  assert.ok(Math.abs(v.T - T_CUERPO) < 0.01 && Math.abs(v.masa - 60) < 3.5, JSON.stringify(v));
  assert.equal(plantillaDe(c, cuerpo), humana);
  assert.ok(exacto());
  const hambriento = vistaCuerpo(c, fundarCuerpo(c, humana.id, 30, 0.25, 0.5), vista());
  assert.ok(Math.abs(hambriento.hambre - 0.75) < 1e-3 && Math.abs(hambriento.sed - 0.5) < 1e-3 && Math.abs(hambriento.salud - 0.5) < 1e-3);
});

test('metabolizar gasta reserva y agua, respira, sostiene la temperatura y conserva', () => {
  const cuerpo = crearCuerpo(c, humana.id, 60), antes = reservaJ(c, cuerpo), co2 = m.arena.cuantos(aire, m.S.CO2);
  const aguaAntes = m.arena.cuantos(cuerpo.reserva, m.S.H2O);
  for (let t = 0; t < 200; t++) metabolizar(c, cuerpo, CELDA, 1);
  const v = vistaCuerpo(c, cuerpo, vista()), gastado = antes - reservaJ(c, cuerpo), basal = basalJ(c, cuerpo, 200);
  assert.ok(exacto(), 'libro exacto tras 200 ticks');
  assert.ok(gastado > 0.8 * basal && gastado < 1.5 * basal, `gastó ${gastado} J con un basal de ${basal} J`);
  assert.ok(Math.abs(v.T - T_CUERPO) < 1, `T ${v.T}`);
  assert.ok(v.energia > 0.6 && v.energia <= 1, `energía ${v.energia}`);
  assert.ok(v.hambre > 0.02 && v.hambre < 0.1, `hambre ${v.hambre}`);
  assert.ok(m.arena.cuantos(aire, m.S.CO2) > co2, 'el CO₂ sale al aire');
  assert.ok(m.arena.cuantos(cuerpo.reserva, m.S.H2O) < aguaAntes + gastado, 'el agua libre no crece sin beber más que el agua metabólica');
  assert.equal(m.arena.cuantos(cuerpo.reserva, m.S.proteina) + m.arena.cuantos(cuerpo.reserva, m.S.NH3), 0, 'la reserva nunca ve N');
  const tasas = tasasBasales(c, { hunger: 0, thirst: 0 });
  assert.ok(Math.abs(v.hambre - 200 * tasas.hunger) < 0.03, `la previsión de hambre (${200 * tasas.hunger}) sigue a la vista (${v.hambre})`);
});

test('pagar quema reserva hasta donde llega el O₂ y devuelve lo pagado', () => {
  const cuerpo = crearCuerpo(c, humana.id, 60);
  assert.equal(pagar(c, cuerpo, 3000), 3000);
  assert.ok(vistaCuerpo(c, cuerpo, vista()).energia < 1);
  const todo = pagar(c, cuerpo, 1e9);
  assert.ok(todo > 0 && todo < 1e9, 'un trabajo sin medida se paga solo en parte');
  assert.ok(vistaCuerpo(c, cuerpo, vista()).energia < 0.05, 'y agota el O₂ de la reserva');
  assert.ok(exacto());
});

test('comer elige lo que el cuerpo aprovecha, lo absorbe y excreta el resto al suelo', () => {
  assert.equal(provecho(c, humana, m.S.proteina), 1);
  assert.ok(provecho(c, humana, m.S.CH2) === 1, 'la grasa es parte del tejido');
  assert.ok(provecho(c, humana, m.S.madera) < 0.05, 'una persona no aprovecha la madera');
  const cuerpo = fundarCuerpo(c, humana.id, 60, 0.3, 1), antes = reservaJ(c, cuerpo);
  const comido = ingerirSelecto(c, cuerpo, vida, 0.5);
  assert.ok(comido > 0.4 && comido < 0.6, `comió ${comido} kg`);
  assert.ok(m.arena.cuantos(cuerpo.digestivo, m.S.madera) * 30 < 0.05 * comido * 1e6, 'casi nada de lo comido es madera');
  assert.ok(beber(c, cuerpo, agua, 0.3) > 0.29);
  const sueloAntes = m.atomos(suelo);
  for (let t = 0; t < 300; t++) metabolizar(c, cuerpo, CELDA, 1);
  assert.ok(reservaJ(c, cuerpo) > antes, 'la reserva sube con lo absorbido');
  assert.ok(m.atomos(suelo) > sueloAntes, 'lo no absorbido llega al suelo');
  assert.ok(exacto());
});

test('una cría crece con lo que come y un adulto no pasa de su masa adulta', () => {
  const cria = fundarCuerpo(c, humana.id, 3, 1, 1), masa0 = masaLote(c, cria.tejido);
  ingerirSelecto(c, cria, vida, 0.4);
  let ganado = 0;
  for (let t = 0; t < 200; t++) { metabolizar(c, cria, CELDA, 1); ganado += crecer(c, cria, 1); }
  assert.ok(ganado > 0.05 && Math.abs(masaLote(c, cria.tejido) - masa0 - ganado) < 1e-6, `ganó ${ganado} kg`);
  assert.ok(vistaCuerpo(c, cria, vista()).salud > masa0 / MASA_ADULTA_HUMANA);
  const adulto = crearCuerpo(c, humana.id, 60);
  ingerirSelecto(c, adulto, vida, 0.4);
  assert.ok(crecer(c, adulto, 10) < 0.01);
  assert.ok(exacto());
});

test('el tejido humano crece y gesta con alimento que sobra del mantenimiento', () => {
  const { CH2, H2O, proteina, orgP } = m.S;
  const cria = fundarCuerpo(c, humana.id, 3, 0.4, 1);
  const madre = fundarCuerpo(c, humana.id, 60, 0.4, 1);
  concebir(c, madre, { otro: 9, genoma: [], inicio: c.tick });
  for (const cuerpo of [cria, madre]) {
    m.arena.fuente(cuerpo.digestivo, Float64Array.of(proteina, 2000, orgP, 1000, H2O, 10000), m.libro);
  }
  assert.equal(crecer(c, cria, 120), 0);
  assert.equal(gestar(c, madre, 120), 0);
  for (const cuerpo of [cria, madre]) {
    m.arena.fuente(cuerpo.digestivo, Float64Array.of(CH2, 10000), m.libro);
  }
  const antesCria = reservaJ(c, cria), antesMadre = reservaJ(c, madre);
  assert.ok(crecer(c, cria, 120) > 0);
  assert.ok(gestar(c, madre, 120) > 0);
  assert.equal(reservaJ(c, cria), antesCria);
  assert.equal(reservaJ(c, madre), antesMadre);
  assert.ok(exacto());
});

test('una plantilla animal con el mismo número de linaje no usa el presupuesto humano', () => {
  const animal = crearPlantilla(c.quimica, c.globales.registro, {
    partes: humana.partes, entradas: humana.partes.map(p => p.id), subproductos: [],
    kappa: humana.kappa, captura: 0, masaAdulta: 30, m0: 1.5, linaje: humana.linaje,
  });
  assert.ok(animal);
  const cuerpo = fundarCuerpo(c, animal.id, 30, 0.4, 1), { H2O, proteina, orgP } = m.S;
  m.arena.fuente(cuerpo.digestivo, Float64Array.of(proteina, 2000, orgP, 1000, H2O, 10000), m.libro);
  concebir(c, cuerpo, { otro: 9, genoma: [], inicio: c.tick });
  assert.ok(gestar(c, cuerpo, 120) > 0);
  assert.ok(exacto());
});

test('gestar, abortar y parir mueven átomos de la madre sin crear nada', () => {
  const madre = crearCuerpo(c, humana.id, 60);
  const masaUnidad = humana.partes.reduce((mg, p) => mg + p.nu * c.quimica.sustancia(p.id).masa, 0) * 1e-6;
  const grasa = humana.sintesis.entradas.find(p => p.id === m.S.CH2)!;
  const costeGrasa = humana.m0 / masaUnidad * grasa.nu * c.quimica.sustancia(grasa.id).prop.qOxidacion;
  assert.equal(humana.sintesis.dH, 0);
  assert.ok(Math.abs(costeGestacionJ(c, madre) - costeGrasa) < 1e-6);
  concebir(c, madre, { otro: 9, genoma: [0.5], inicio: 100 });
  ingerirSelecto(c, madre, vida, 2);
  beber(c, madre, agua, 3);
  const total = masaDe(c, madre);
  let embrion = 0;
  for (let t = 0; t < 300; t++) embrion = gestar(c, madre, 1);
  assert.ok(embrion > 0.3 && embrion <= humana.m0 + 0.01, `embrión de ${embrion} kg`);
  assert.ok(Math.abs(masaDe(c, madre) + embrion - total) < 1e-6, 'lo que gana el embrión lo pierde la madre');
  assert.equal(lotesDe(madre, []).length, 4);
  const reservaAntes = reservaJ(c, madre), aguaAntes = m.arena.cuantos(madre.reserva, m.S.H2O);
  const cria = parir(c, madre);
  assert.equal(madre.gestacion, undefined);
  assert.ok(Math.abs(masaLote(c, cria.tejido) - embrion) < 1e-9);
  const v = vistaCuerpo(c, cria, vista());
  assert.ok(v.hambre < 1 && v.sed < 1 && v.salud > 0, 'la cría recibe reserva de la gestante');
  assert.ok(Math.abs(reservaJ(c, madre) + reservaJ(c, cria) - reservaAntes) < 1e-6);
  assert.equal(m.arena.cuantos(madre.reserva, m.S.H2O) + m.arena.cuantos(cria.reserva, m.S.H2O), aguaAntes);
  assert.equal(masaLote(c, cria.digestivo), 0);

  const otra = crearCuerpo(c, humana.id, 60), antes = masaDe(c, otra);
  concebir(c, otra, { otro: 9, genoma: [0.5], inicio: 100 });
  ingerirSelecto(c, otra, vida, 1);
  const conComida = masaDe(c, otra);
  for (let t = 0; t < 50; t++) gestar(c, otra, 1);
  abortar(c, otra);
  assert.ok(otra.gestacion === undefined && Math.abs(masaDe(c, otra) - conComida) < 1e-6 && conComida > antes);
  assert.ok(exacto());
});

test('herir arranca carne y baja la salud; extraer saca garantías; morir deja un cadáver con todo', () => {
  const cuerpo = crearCuerpo(c, humana.id, 60), salud = vistaCuerpo(c, cuerpo, vista()).salud;
  const golpe = new Float64Array(5);
  golpe[DATO_GOLPEAR.trabajo] = 2e6; golpe[DATO_GOLPEAR.filo] = 1; golpe[DATO_GOLPEAR.dureza] = 1;
  const carne = herir(c, cuerpo, golpe);
  assert.notEqual(carne, REF_NULA);
  const herido = vistaCuerpo(c, cuerpo, vista());
  assert.ok(herido.salud < salud && Math.abs((salud - herido.salud) * MASA_ADULTA_HUMANA - masaLote(c, carne)) < 0.01, 'la salud baja en lo desprendido');
  assert.equal(herir(c, cuerpo, new Float64Array(5)), REF_NULA);
  assert.ok(cargaKg(c, [carne]) > 0);
  const enSuelo = soltar(c, carne, CELDA);
  assert.ok(enSuelo !== REF_NULA && !m.arena.vivo(carne) && masaLote(c, enSuelo) > 0);

  const leche = extraer(c, cuerpo, 'reserva', 0.5), lana = extraer(c, cuerpo, 'fibra', 0.2);
  assert.ok(leche.length > 0 && lana.length > 0 && exacto(), 'lo extraído está en vuelo');
  abonar(c, cuerpo, leche); abonar(c, cuerpo, lana);
  assert.ok([...m.libro.enVuelo].every((x) => x === 0));

  const masa = masaDe(c, cuerpo), lotes: LoteRef[] = lotesDe(cuerpo, []);
  const cadaver = morir(c, cuerpo, CELDA);
  assert.ok(cadaver !== REF_NULA && Math.abs(masaLote(c, cadaver) - masa) < 1e-6);
  assert.ok(lotes.every((l) => !m.arena.vivo(l)));
  assert.ok(exacto());
});
