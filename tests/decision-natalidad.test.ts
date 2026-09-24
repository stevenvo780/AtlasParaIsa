import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRITERIOS, type EvaluacionReplica, type IdCriterio } from '../scripts/lab/criterio-terminado.mjs';
import { evaluarDecision } from '../scripts/lab/decision-natalidad.mjs';

const panel = Array.from({ length: 12 }, (_, i) => 4001 + i);
const fuera = [4013, 4014, 4015, 4016];
const ruta = (root: string, b: string, s: number, d: number) => join(root, `${b}-${s}`, `dia-${String(d).padStart(3, '0')}.json`);
const leer = (root: string, b: string, s: number, d: number) => JSON.parse(readFileSync(ruta(root, b, s, d), 'utf8')) as Record<string, any>;
const poner = (root: string, b: string, s: number, d: number, x: Record<string, any>) => writeFileSync(ruta(root, b, s, d), JSON.stringify(x));
function dia(d: number, poblacion: number, brazo: string): Record<string, any> {
  return {
    tick: d * 2400, poblacion, vecinosMortales: poblacion - 2, nacimientos: d * 10,
    muertesPorCausa: { starvation: 0, dehydration: 0, exposure: 0, senescence: d }, faunaTotal: 100,
    fundadoresMortalesVivos: 0, generacionesMortalesVivas: [1, 2, 3],
    cooperacionAcumuladaPorTipo: { teaching: d * 10, trade: d * 3, constructionHelp: d * 2 },
    conflictosAcumulados: d, usosUtiles: 20, usosDeInventorAjeno: 6, usosSinAutorResuelto: 0,
    diversidadConductaActiva: 0.2 + 0.005 * d,
    natalidadLocal: { nacimientosDia: 10, xNacimientos: { p10: 0.2, p50: brazo === 'NAT' ? 0.3 : 0.5, p90: 0.6 },
      xFertiles: { p10: 0.4, p50: 0.6, p90: 0.8 }, bloqueadasPorLey: brazo === 'NAT' ? 1 : 0,
      kOcupado: { agua: 1000, comida: 2000 }, nSobreKOcupado: 1,
      limitante: { agua: 1, comida: 0 } },
  };
}
function escribir(root: string, b: string, s: number, dias: number, poblacion: number): void {
  mkdirSync(join(root, `${b}-${s}`));
  for (let d = 1; d <= dias; d++) poner(root, b, s, d, dia(d, poblacion, b));
  writeFileSync(join(root, `${b}-${s}`, 'replica.json'), JSON.stringify({ seed: s, dias, techoLabDetalle: { poblacionMaxima: poblacion } }));
}
function modificar(root: string, b: string, s: number, ds: number[], fn: (x: Record<string, any>, d: number) => void): void {
  for (const d of ds) { const x = leer(root, b, s, d); fn(x, d); poner(root, b, s, d, x); }
}
const dias = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function stub(fallos: Map<string, Set<IdCriterio>> = new Map()) {
  return (root: string) => ({ replicas: [...panel, ...fuera].flatMap(s => ['CTRL', 'NAT'].map(b => {
    const nombre = `${b}-${s}`;
    return { nombre, criterios: Object.fromEntries(CRITERIOS.map(id => [id,
      { estado: fallos.get(nombre)?.has(id) ? 'falla' : 'cumple', motivo: '', valores: {} }])) } as EvaluacionReplica;
  })) });
}
function campana() {
  const root = mkdtempSync(join(tmpdir(), 'nat-decision-'));
  for (const s of [...panel, ...fuera]) { escribir(root, 'CTRL', s, 60, 1000); escribir(root, 'NAT', s, 60, 900); }
  return root;
}

test('panel válido, confirmación y adopción; nivel 0,7 conserva validez sin adopción', () => {
  const root = campana();
  try {
    let inf = evaluarDecision(root, 2, stub());
    assert.equal(inf.decision, 'VÁLIDA EN PANEL');
    assert.equal(inf.resultado, 'VÁLIDA EN PANEL');
    assert.equal(inf.adopcion, true);
    assert.ok(Math.abs(inf.nivel! - 898 / 998) < 1e-12, 'el nivel cuenta vecinos mortales, no S e I');
    for (const s of panel) modificar(root, 'NAT', s, dias(1, 60), x => { x.poblacion = 700; x.vecinosMortales = 698; });
    inf = evaluarDecision(root, 2, stub());
    assert.equal(inf.resultado, 'VÁLIDA SIN ADOPCIÓN');
    assert.equal(inf.adopcion, false);
    assert.ok(Math.abs(inf.nivel! - 698 / 998) < 1e-12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('precedencia: tres inseguras, falta día 60, mecanismo solo 9/12', () => {
  const root = campana();
  try {
    for (const s of panel.slice(0, 3)) modificar(root, 'NAT', s, [60], x => { x.faunaTotal = 1; });
    assert.equal(evaluarDecision(root, 2, stub()).decision, 'INSEGURO');
    unlinkSync(ruta(root, 'NAT', panel[0]!, 60));
    assert.equal(evaluarDecision(root, 2, stub()).decision, 'DATOS INCOMPLETOS');
    poner(root, 'NAT', panel[0]!, 60, dia(60, 900, 'NAT'));
    for (const s of panel.slice(0, 3)) modificar(root, 'NAT', s, [60], x => { x.faunaTotal = 100; });
    for (const s of panel.slice(0, 3)) modificar(root, 'NAT', s, dias(30, 60), x => { x.natalidadLocal.bloqueadasPorLey = 0; });
    const inf = evaluarDecision(root, 2, stub());
    assert.equal(inf.mecanismos, 9);
    assert.equal(inf.decision, 'NO VÁLIDA');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('regulación distingue crecimiento exponencial de oscilación y tolera cuatro nulos', () => {
  const root = campana();
  try {
    const s = panel[0]!;
    modificar(root, 'NAT', s, dias(1, 60), (x, d) => { x.poblacion = Math.round(700 * Math.exp(0.004 * d)); x.vecinosMortales = x.poblacion - 2; });
    let inf = evaluarDecision(root, 2, stub());
    assert.equal(inf.panel![0]?.regulada, true);
    modificar(root, 'NAT', s, dias(1, 60), (x, d) => { x.poblacion = Math.round(900 * (1 + 0.12 * Math.sin(2 * Math.PI * d / 12))); x.vecinosMortales = x.poblacion - 2; });
    inf = evaluarDecision(root, 2, stub());
    assert.equal(inf.panel![0]?.regulada, false);
    assert.ok((inf.panel![0]?.regulacion.amplitud ?? 0) >= 0.15);
    modificar(root, 'NAT', s, dias(1, 60), x => { x.poblacion = 900; x.vecinosMortales = 898; });
    modificar(root, 'NAT', s, [45, 46, 47, 48], x => { x.natalidadLocal.nSobreKOcupado = null; });
    assert.equal(evaluarDecision(root, 2, stub()).panel![0]?.regulada, true);
    modificar(root, 'NAT', s, [49], x => { x.natalidadLocal.nSobreKOcupado = null; });
    assert.equal(evaluarDecision(root, 2, stub()).panel![0]?.regulada, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('19 días pareados no prueban mecanismo, tampoco si le faltan a CTRL', () => {
  const root = campana();
  try {
    const s = panel[0]!;
    modificar(root, 'NAT', s, dias(30, 41), x => { x.natalidadLocal.xNacimientos = null; });
    assert.equal(evaluarDecision(root, 2, stub()).panel![0]?.mecanismo, false);
    modificar(root, 'NAT', s, dias(30, 41), x => { x.natalidadLocal.xNacimientos = { p10: 0.2, p50: 0.3, p90: 0.6 }; });
    assert.equal(evaluarDecision(root, 2, stub()).panel![0]?.mecanismo, true);
    modificar(root, 'CTRL', s, dias(30, 41), x => { x.natalidadLocal.xFertiles = null; });
    assert.equal(evaluarDecision(root, 2, stub()).panel![0]?.mecanismo, false, 'CTRL con 19 días válidos: la semilla no cumple');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('C1–C7 simultáneos, criterios separados y C8 salen del evaluador congelado', () => {
  const root = campana();
  try {
    const fallos = new Map<string, Set<IdCriterio>>();
    for (const s of panel.slice(0, 2)) fallos.set(`NAT-${s}`, new Set(['supervivencia']));
    assert.equal(evaluarDecision(root, 2, stub(fallos)).decision, 'NO VÁLIDA');
    fallos.clear();
    for (const s of panel.slice(0, 2)) fallos.set(`NAT-${s}`, new Set(['diversidad']));
    assert.equal(evaluarDecision(root, 2, stub(fallos)).decision, 'NO VÁLIDA');
    fallos.clear();
    fallos.set(`CTRL-${panel[0]}`, new Set(['supervivencia']));
    fallos.set(`NAT-${panel[0]}`, new Set(['supervivencia']));
    fallos.set(`NAT-${panel[1]}`, new Set(['supervivencia']));
    assert.equal(evaluarDecision(root, 2, stub(fallos)).decision, 'VÁLIDA EN PANEL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clave requerida ausente prevalece; null explícito es un dato', () => {
  const root = campana();
  try {
    modificar(root, 'NAT', 4001, [30], x => { x.natalidadLocal.xNacimientos = null; });
    assert.notEqual(evaluarDecision(root, 2, stub()).decision, 'DATOS INCOMPLETOS');
    modificar(root, 'NAT', 4001, [30], x => { delete x.natalidadLocal.xNacimientos; });
    assert.equal(evaluarDecision(root, 2, stub()).decision, 'DATOS INCOMPLETOS');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Etapa 1 detiene por CTRL + 4 muertes de sed y observa R12/R24 sin darles puerta', () => {
  const root = mkdtempSync(join(tmpdir(), 'nat-cribado-'));
  try {
    for (const s of [4101, 4102, 4103, 4104]) for (const b of ['CTRL', 'NAT', 'NATR12', 'NATR24']) escribir(root, b, s, 20, 100);
    assert.equal(evaluarDecision(root, 1).decision, 'SEGUIR');
    modificar(root, 'NAT', 4101, [20], x => { x.muertesPorCausa.dehydration = 4; });
    const inf = evaluarDecision(root, 1);
    assert.equal(inf.decision, 'DETENER');
    assert.ok(inf.motivos!.some(x => x.includes('sed 4 > CTRL 0 + 3')));
    modificar(root, 'NATR12', 4102, [20], x => { x.poblacion = 6001; });
    assert.ok(evaluarDecision(root, 1).motivos!.some(x => x.includes('NATR12-4102: alarma')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('el corte 60 ignora archivos posteriores incluso para C1–C8', () => {
  const root = campana();
  try {
    const antes = evaluarDecision(root, 2, stub());
    const antesReal = evaluarDecision(root, 2);
    writeFileSync(ruta(root, 'NAT', 4001, 61), '{ JSON roto');
    const despues = evaluarDecision(root, 2, stub());
    assert.deepEqual(despues, antes);
    assert.deepEqual(evaluarDecision(root, 2), antesReal);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('extinción = 0 vecinos mortales aunque S e I sigan vivos; la semilla extinta cuenta 0 en el nivel', () => {
  const root = mkdtempSync(join(tmpdir(), 'nat-cribado-'));
  try {
    for (const s of [4101, 4102, 4103, 4104]) for (const b of ['CTRL', 'NAT', 'NATR12', 'NATR24']) escribir(root, b, s, 20, 100);
    modificar(root, 'NAT', 4103, dias(15, 20), x => { x.poblacion = 2; x.vecinosMortales = 0; });
    const inf = evaluarDecision(root, 1);
    assert.equal(inf.decision, 'DETENER');
    assert.ok(inf.motivos!.some(x => x.includes('4103: NAT extinta y CTRL viva')));
  } finally { rmSync(root, { recursive: true, force: true }); }
  const panelRoot = campana();
  try {
    modificar(panelRoot, 'NAT', 4001, dias(40, 60), x => { x.poblacion = 2; x.vecinosMortales = 0; });
    const inf = evaluarDecision(panelRoot, 2, stub());
    assert.equal(inf.extinciones!.NAT, 1);
    assert.equal(inf.panel!.find(f => f.semilla === 4001)!.cocientePoblacion, 0, 'la extinta no desaparece del cociente');
  } finally { rmSync(panelRoot, { recursive: true, force: true }); }
});

test('fuera de muestra: mecanismo y seguridad en la MISMA semilla (≥ 3/4)', () => {
  const root = campana();
  try {
    // 4013 sin mecanismo y 4014 insegura: 3/4 en cada condición por separado, pero solo 2/4 conjuntas.
    modificar(root, 'NAT', 4013, dias(30, 60), x => { x.natalidadLocal.bloqueadasPorLey = 0; });
    modificar(root, 'NAT', 4014, [60], x => { x.faunaTotal = 1; });
    const inf = evaluarDecision(root, 2, stub());
    assert.equal(inf.decision, 'VÁLIDA EN PANEL');
    assert.equal(inf.confirmada, false);
    assert.equal(inf.adopcion, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
