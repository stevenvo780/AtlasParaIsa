import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { DEFAULT_PARAMS, paramsOf } from '../src/world/params.js';
import { demographicTraits, initialDemography, updateDemography } from '../src/world/demography.js';
import {
  analizar, bondadAjuste, colaChiCuadrado, curvaSupervivencia, mulberry32, NECESIDADES_REFERENCIA, paramsDeCorrida, poblar, probabilidadesEdad, remuestreo, transitorio, coherenciaEscala,
  type Grupo, type Individuo, type Registro, type Zona,
} from '../scripts/lab/poblacion.mjs';

const DIA = TICKS_PER_DAY;
const ZONA: Zona = { x: 0, y: 0, ancho: 48, alto: 32 };
const abierto = () => paramsDeCorrida({ regimen: 'abierto', hilos: 1, gpu: [] });
const sembrado = (semilla: number, n: number, zona = ZONA, siembra = semilla, params = abierto()) => {
  const mundo = createWorld(semilla, params);
  return { mundo, ...poblar(mundo, { n, zona, siembra }) };
};

test('estadística: colas de la χ² conocidas', () => {
  assert.ok(Math.abs(colaChiCuadrado(3.841459, 1) - 0.05) < 1e-5);
  assert.ok(Math.abs(colaChiCuadrado(18.307038, 10) - 0.05) < 1e-5);
  assert.ok(Math.abs(colaChiCuadrado(2, 2) - Math.exp(-1)) < 1e-12);
});

test('la curva de supervivencia coincide con las tiradas reales de la ley de longevidad', { timeout: 600_000 }, () => {
  const { mundo, sembrados } = sembrado(51926, 1, ZONA, 51926, DEFAULT_PARAMS);
  const cuerpo = paramsOf(mundo).cuerpo;
  for (const persona of sembrados.slice(0, 1)) {
    const curva = curvaSupervivencia(persona.genome, cuerpo), rasgos = demographicTraits(persona.genome, cuerpo);
    // Más fina, la curva apenas cambia: el paso de 0,05 días no sesga la esperanza.
    assert.ok(Math.abs(curvaSupervivencia(persona.genome, cuerpo, 24).esperanza / curva.esperanza - 1) < 0.01);
    const cuerpos = 1000, muertes: number[] = [];
    for (let j = 0; j < cuerpos; j++) {
      let estado = initialDemography(0), paso = 0;
      for (;;) {
        const t = updateDemography({ id: `mc-${persona.id}-${j}`, state: estado, traits: rasgos, ...NECESIDADES_REFERENCIA },
          { exposure: 0, shelter: 0, protected: false, seed: mundo.seed, tick: paso++, senescence: cuerpo }, curva.paso);
        if (t.death) { muertes.push(estado.age + curva.paso); break; }
        estado = t.state;
      }
    }
    // Kolmogórov–Smirnov contra la curva en su rejilla (α = 0,01).
    let d = 0;
    curva.l.forEach((l, k) => { d = Math.max(d, Math.abs(muertes.filter(m => m > k * curva.paso).length / cuerpos - l)); });
    assert.ok(d < 1.63 / Math.sqrt(cuerpos), `KS ${d.toFixed(4)} con ${persona.id}`);
  }
});

test('(b) las edades sembradas siguen la población estacionaria de la ley (χ²) y la prueba tiene potencia', { timeout: 600_000 }, () => {
  const { mundo, sembrados } = sembrado(19104, 1000, { x: -16, y: -16, ancho: 80, alto: 64 }, 19104, DEFAULT_PARAMS);
  assertWorld(mundo);
  const cuerpo = paramsOf(mundo).cuerpo, clases = 30;
  const esperada = new Array<number>(clases).fill(0);
  for (const p of sembrados) probabilidadesEdad(curvaSupervivencia(p.genome, cuerpo), DIA, clases).forEach((x, i) => { esperada[i]! += x / sembrados.length; });
  const histograma = (edades: number[]) => { const h = new Array<number>(clases).fill(0); for (const e of edades) h[Math.min(clases - 1, Math.floor(e / DIA))]!++; return h; };
  const ajuste = bondadAjuste(histograma(sembrados.map(p => p.demography.age)), esperada);
  assert.ok(ajuste.p > 0.01, `χ²=${ajuste.chi2.toFixed(1)} gl=${ajuste.gl} p=${ajuste.p}`);
  assert.ok(ajuste.gl >= 15, 'la prueba usa casi todas las clases de un día');
  // Con edades uniformes en el mismo intervalo, o la cohorte coetánea de createWorld, la prueba rechaza.
  const azar = mulberry32(1), maxima = Math.max(...sembrados.map(p => p.demography.age));
  assert.ok(bondadAjuste(histograma(sembrados.map(() => azar() * maxima)), esperada).p < 1e-6);
  assert.ok(bondadAjuste(histograma(sembrados.map(() => 2 * DIA)), esperada).p < 1e-6);
  // Cada edad es coherente con su cuerpo: age = tick − bornAt, y nadie arranca muerto.
  for (const p of sembrados) {
    assert.equal(p.demography.age, mundo.tick - p.bornAt);
    assert.ok(p.demography.health > 0 && p.demography.deathCause === null);
  }
});

/** Registro sintético: tasas conocidas por habitante y día, con o sin un transitorio sin nacimientos el primer día. */
function registroSintetico(semilla: number, n: number, dias: number, b: number, m: number, sinNacimientosDia1: boolean): Registro {
  const azar = mulberry32(semilla), individuos: Individuo[] = [];
  const nuevo = (desde: number, origen: Individuo['origen']): Individuo => {
    const i: Individuo = { id: `p${individuos.length}`, origen, x0: Math.floor(azar() * 48), y0: Math.floor(azar() * 32), desde, hasta: null, causa: null, hijos: [], parejas: [] };
    individuos.push(i); return i;
  };
  let vivos = Array.from({ length: n }, () => nuevo(0, 'inicial'));
  const paso = 120, fin = dias * DIA;
  for (let t = paso; t <= fin; t += paso) {
    const siguientes: Individuo[] = [];
    for (const i of vivos) {
      if (azar() < m * paso / DIA) { i.hasta = t; i.causa = 'starvation'; continue; }
      siguientes.push(i);
      if (azar() < 0.05 * paso / DIA) i.parejas.push(t);
      if ((!sinNacimientosDia1 || t > DIA) && azar() < b * paso / DIA) { i.hijos.push(t, t); siguientes.push(nuevo(t, 'nacido')); }
    }
    vivos = siguientes;
  }
  const dia = (d: number) => ({ dia: d, tick: d * DIA, vivos: 0, fueraDeZona: 0, muestras: 1, embudo: { adultosFertiles: 1, listos: 1, conPareja: 1, conParejaYLugar: 1 }, hambre: new Array(10).fill(0), sed: new Array(10).fill(0), msPared: 1, ticksPorSegundo: 1, carga: [0, 0, 0] });
  const piramide = { anchoDias: 1, clases: [], etapas: { juveniles: 0, fertiles: 0, mayores: 0 } };
  return { inicio: 0, fin, zona: ZONA, caminables: 1536, individuos, dias: Array.from({ length: dias }, (_, k) => dia(k + 1)), piramideInicial: piramide, piramideFinal: piramide, violaciones: { duras: 0, blandas: 0, comprobaciones: 0 } };
}

test('las tasas por habitante recuperan las verdaderas con su IC y el transitorio se detecta', () => {
  const constante = registroSintetico(1, 2000, 5, 0.3, 0.2, false);
  const a = analizar(constante, { transitorio: 1, bloque: 8 });
  for (const [tasa, verdad] of [['nacimientos', 0.3], ['muertes', 0.2], ['r', 0.1]] as const) {
    const e = a.bloques[tasa];
    assert.ok(e.ic95[0] <= verdad && verdad <= e.ic95[1], `${tasa}: ${e.valor} [${e.ic95}] no cubre ${verdad}`);
  }
  assert.equal(transitorio(constante).dias, 1, 'sin transitorio real queda el mínimo');
  assert.equal(transitorio(registroSintetico(2, 2000, 5, 0.3, 0.2, true), 0).dias, 1, 'un primer día sin nacimientos es transitorio');
  // Cobertura del IC por bloques en réplicas independientes: cerca del 95 %.
  let cubre = 0;
  for (let s = 0; s < 40; s++) { const e = analizar(registroSintetico(100 + s, 400, 4, 0.3, 0.2, false), { transitorio: 0, bloque: 8, replicas: 400 }).bloques.r; if (e.ic95[0] <= 0.1 && 0.1 <= e.ic95[1]) cubre++; }
  assert.ok(cubre >= 34, `cobertura ${cubre}/40`);
});

test('coherencia de escala: dos mitades con la misma tasa coinciden y con otra tasa no', () => {
  const corrida = (registro: Registro, n: number, zona: Zona) => ({ archivo: '', opciones: { semilla: 1, n, zona } as never, registro: { ...registro, zona }, msTotal: 0, carga: { inicio: [0], fin: [0] }, maxRssMiB: 0 });
  const izq = { ...ZONA, ancho: 24 }, der = { ...ZONA, x: 24, ancho: 24 };
  const iguales = coherenciaEscala([corrida(registroSintetico(1, 2000, 5, 0.3, 0.2, false), 2000, ZONA),
    corrida(registroSintetico(2, 1000, 5, 0.3, 0.2, false), 1000, izq), corrida(registroSintetico(3, 1000, 5, 0.3, 0.2, false), 1000, der)], 1, 8);
  assert.equal(iguales.length, 1);
  assert.ok(iguales[0]!.coinciden);
  const distintas = coherenciaEscala([corrida(registroSintetico(1, 2000, 5, 0.3, 0.2, false), 2000, ZONA),
    corrida(registroSintetico(2, 1000, 5, 0.5, 0.2, false), 1000, izq), corrida(registroSintetico(3, 1000, 5, 0.5, 0.2, false), 1000, der)], 1, 8);
  assert.ok(!distintas[0]!.coinciden);
});

test('el remuestreo de un solo grupo no inventa incertidumbre', () => {
  const g: Grupo = { exposicion: 10, nacimientos: 3, muertes: { starvation: 1, dehydration: 0, exposure: 0, senescence: 1 }, parejas: 2 };
  const { estimaciones } = remuestreo([g], 50);
  assert.equal(estimaciones.r.valor, 0.1);
  assert.deepEqual(estimaciones.r.ic95, [0.1, 0.1]);
});

