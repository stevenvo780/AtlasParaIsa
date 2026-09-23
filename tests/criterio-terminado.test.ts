import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UMBRALES_POR_DEFECTO, colaNormalSuperior, evaluarConjunto, evaluarSerieDiversidad, mannKendall, parsearArgumentos, pendienteSen, type Informe } from '../scripts/lab/criterio-terminado.mjs';
import { calibrar, mulberry32 } from '../scripts/lab/calibrar-c8.mjs';

type Dia = Record<string, unknown>;

/** Un día de una réplica sana en el formato de replica.ts: al día 20 cumple los 8 criterios con
 * ventana 10 (los 14 fundadores mortales mueren de vejez uno por día, 3 nacimientos/día, 3 tipos de
 * cooperación, 1 conflicto/día, 30 % de uso ajeno cada día, diversidad creciente, balance exacto). */
function diaSano(d: number): Dia {
  const nacimientos = 3 * d, senescence = Math.min(14, d), starvation = Math.floor(d / 5);
  const poblacion = 16 + nacimientos - senescence - starvation, fundadoresMortalesVivos = 14 - senescence;
  return {
    tick: d * 2400, poblacion, nacimientos,
    muertesPorCausa: { starvation, dehydration: 0, exposure: 0, senescence },
    fundadoresVivos: fundadoresMortalesVivos + 2, generacionesVivas: 4, diversidadOficios: 2, diversidadConducta: 0.2 + 0.01 * d,
    vecinosMortales: poblacion - 2, fundadoresMortalesVivos, generacionesMortalesVivas: d < 14 ? [0, 1, 2] : [1, 2, 3],
    usosUtiles: 20, usosDeInventorAjeno: 6, usosSinAutorResuelto: 0, fraccionUsoAjeno: 0.3, usosConEnsenanzaRecordada: 3,
    cooperacionAcumuladaPorTipo: { teaching: 10 * d, trade: 3 * d, constructionHelp: 2 * d },
    otrasCooperacionesAcumuladas: d, conflictosAcumulados: d,
  };
}

function escribir(raiz: string, nombre: string, dias: Dia[], terminada: boolean, extra: Record<string, string> = {}): void {
  const dir = join(raiz, nombre);
  mkdirSync(dir, { recursive: true });
  for (const dia of dias) writeFileSync(join(dir, `dia-${String(Number(dia.tick) / 2400).padStart(3, '0')}.json`), JSON.stringify(dia));
  for (const [fichero, texto] of Object.entries(extra)) writeFileSync(join(dir, fichero), texto);
  if (terminada) writeFileSync(join(dir, 'replica.json'), JSON.stringify({ seed: 1, dias: dias.length }));
}

const rango = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function fixture(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-'));
  // Brazo A: todo cumplido / extinguida / en curso / campo ausente.
  escribir(raiz, 'A-1', rango(20).map(diaSano), true);
  escribir(raiz, 'A-2', rango(9).map(d => d < 9 ? diaSano(d) : { ...diaSano(d), poblacion: 2, vecinosMortales: 0, generacionesMortalesVivas: [] }), true);
  escribir(raiz, 'A-3', rango(7).map(diaSano), false, { 'dia-008.json': '{"tick": 192' });
  escribir(raiz, 'A-4', rango(20).map(d => { const { conflictosAcumulados: _c, usosDeInventorAjeno: _u, ...resto } = diaSano(d); return resto; }), true);
  // Brazo B: dos sanas, una aún corriendo con dia-D ya escrito.
  escribir(raiz, 'B-5', rango(22).map(diaSano), false);
  escribir(raiz, 'B-6', rango(20).map(diaSano), true);
  // Brazo C: sin conflictos + balance roto + diversidad decreciente / corta / extinguida.
  escribir(raiz, 'C-7', rango(20).map(d => ({ ...diaSano(d), conflictosAcumulados: 0, diversidadConducta: 0.6 - 0.01 * d,
    ...(d === 20 ? { poblacion: Number(diaSano(20).poblacion) - 1 } : {}) })), true);
  escribir(raiz, 'C-8', rango(15).map(diaSano), true);
  escribir(raiz, 'C-9', rango(12).map(d => ({ ...diaSano(d), ...(d >= 6 ? { poblacion: 2, vecinosMortales: 0 } : {}) })), true);
  mkdirSync(join(raiz, 'sin-semilla'));
  writeFileSync(join(raiz, 'progreso.log'), 'no es una réplica\n');
  return raiz;
}

const replica = (inf: Informe, nombre: string) => inf.replicas.find(r => r.nombre === nombre)!;
const brazo = (inf: Informe, nombre: string) => inf.brazos.find(b => b.brazo === nombre)!;

test('criterio de terminado: todo cumplido, extinguida, en curso, campo ausente y veredictos por brazo', () => {
  const raiz = fixture();
  try {
    const inf = evaluarConjunto(raiz, { dia: 20 });
    assert.equal(inf.dia, 20);
    assert.deepEqual(inf.ventana, { desde: 11, hasta: 20, dias: 10 });

    // Todo cumplido.
    const sana = replica(inf, 'A-1');
    assert.equal(sana.estado, 'evaluada');
    assert.equal(sana.todos, 'cumple');
    for (const [id, r] of Object.entries(sana.criterios!)) assert.equal(r.estado, 'cumple', `${id}: ${r.motivo}`);
    assert.equal(sana.criterios!.recambio.valores.nacimientosVentana, 30);
    assert.deepEqual(sana.criterios!.cooperacion.valores.relevantes, ['teaching', 'trade', 'constructionHelp']);
    assert.equal(sana.criterios!.muertes.valores.residuoBalance, 0);

    // Extinguida (no llega al día D): falla los 8, cuenta como evaluada.
    const extinta = replica(inf, 'A-2');
    assert.equal(extinta.estado, 'extinguida');
    assert.equal(extinta.diaExtincion, 9);
    assert.equal(extinta.todos, 'falla');
    assert.ok(Object.values(extinta.criterios!).every(r => r.estado === 'falla'));

    // En curso (sin replica.json ni dia-D): excluida; su último fichero a medias se ignora con aviso.
    const enCurso = replica(inf, 'A-3');
    assert.equal(enCurso.estado, 'en-curso');
    assert.equal(enCurso.ultimoDia, 7);
    assert.equal(enCurso.criterios, null);
    assert.ok(inf.avisos.some(a => a.includes('A-3/dia-008.json')));

    // Campo ausente: «desconocido», nunca aprobado.
    const incompleta = replica(inf, 'A-4');
    assert.equal(incompleta.criterios!.conflictos.estado, 'desconocido');
    assert.equal(incompleta.criterios!.tecnologia.estado, 'desconocido');
    assert.equal(incompleta.criterios!.supervivencia.estado, 'cumple');
    assert.equal(incompleta.todos, 'desconocido');

    const a = brazo(inf, 'A');
    assert.deepEqual([a.semillas, a.evaluadas, a.extinguidas, a.enCurso, a.cortas, a.cumplenTodos, a.todosDesconocido], [4, 3, 1, 1, 0, 1, 1]);
    assert.equal(a.fraccionSobreEvaluadas, 1 / 3);
    assert.equal(a.veredicto, 'indeterminado');
    assert.deepEqual(a.porCriterio.conflictos, { cumple: 1, falla: 1, desconocido: 1 });

    // Réplica aún corriendo pero con dia-D escrito: se evalúa.
    const b = brazo(inf, 'B');
    assert.equal(replica(inf, 'B-5').estado, 'evaluada');
    assert.equal(b.evaluadasAunCorriendo, 1);
    assert.equal(b.veredicto, 'mayoría');

    // Sin ningún conflicto: falla y lo dice; balance roto; diversidad decreciente.
    const sinConflictos = replica(inf, 'C-7');
    assert.equal(sinConflictos.criterios!.conflictos.estado, 'falla');
    assert.match(sinConflictos.criterios!.conflictos.motivo, /ningún conflicto en toda la réplica/);
    assert.equal(sinConflictos.criterios!.muertes.estado, 'falla');
    assert.equal(sinConflictos.criterios!.muertes.valores.residuoBalance, -1);
    assert.equal(sinConflictos.criterios!.diversidad.estado, 'falla');
    assert.equal(replica(inf, 'C-8').estado, 'corta');
    assert.equal(replica(inf, 'C-9').estado, 'extinguida');
    assert.equal(brazo(inf, 'C').veredicto, 'no mayoría');

    // Un directorio que no es <brazo>-<semilla> se ignora y se dice; los ficheros sueltos (*.log), en silencio.
    assert.deepEqual(inf.ignorados, ['sin-semilla (el nombre no es <brazo>-<semilla>)']);
    assert.deepEqual(inf.brazos.map(x => x.brazo), ['A', 'B', 'C']);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: umbrales ajustables, --dia comun y réplica ilegible', () => {
  const raiz = fixture();
  try {
    const laxo = evaluarConjunto(raiz, { dia: 20, conflictosMin: 0 });
    assert.equal(replica(laxo, 'C-7').criterios!.conflictos.estado, 'cumple');
    const comun = evaluarConjunto(raiz, { dia: 'comun' });
    assert.equal(comun.dia, 7, 'mínimo de los últimos días de las réplicas no extinguidas (A-3 va por el 7)');
    assert.equal(replica(comun, 'A-3').estado, 'evaluada');
    // Un fichero intermedio corrupto hace la réplica ilegible: evaluada con los 8 desconocidos.
    writeFileSync(join(raiz, 'B-6', 'dia-010.json'), '{roto');
    const ilegible = replica(evaluarConjunto(raiz, { dia: 20 }), 'B-6');
    assert.equal(ilegible.estado, 'ilegible');
    assert.equal(ilegible.todos, 'desconocido');
    assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--dia', 'comun', '--uso-ajeno-min', '0.2', '--diversidad-regla', 'y']).umbrales,
      { dia: 'comun', usoAjenoMin: 0.2, diversidadRegla: 'y' });
    assert.throws(() => parsearArgumentos(['--entrada', 'x', '--mayoria', '2']), /--mayoria/);
    assert.throws(() => parsearArgumentos(['--entrada', 'x', '--desconocida', '1']), /Argumento desconocido/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: la CLI imprime la tabla con los umbrales y escribe el JSON de --salida', () => {
  const raiz = fixture();
  try {
    const salida = join(raiz, 'informe', 'criterio.json');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/criterio-terminado.mts', '--entrada', raiz, '--dia', '20', '--salida', salida], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CRITERIO DE TERMINADO/);
    assert.match(r.stdout, /C7 tecnología +usos de inventor ajeno/);
    assert.match(r.stdout, /MAYORÍA/);
    assert.match(r.stdout, /corte PROVISIONAL en el día 20 < 60/);
    const json = JSON.parse(readFileSync(salida, 'utf8')) as Informe;
    assert.equal(json.dia, 20);
    assert.equal(json.umbrales.usoAjenoMin, 0.15);
    assert.deepEqual(json.brazos.map(b => [b.brazo, b.veredicto]), [['A', 'indeterminado'], ['B', 'mayoría'], ['C', 'no mayoría']]);
    const sinEntrada = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/criterio-terminado.mts'], { encoding: 'utf8' });
    assert.equal(sinEntrada.status, 1);
    assert.match(sinEntrada.stderr, /Falta --entrada/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: revisión — nada se aprueba por una sola muestra, un campo ausente o un tipo residual', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-rev-'));
  try {
    // C3: sin generacionesMortalesVivas, generacionesVivas cuenta la generación 0 de S e I aunque ya no
    // quede ningún fundador mortal: 3 generaciones «vivas» pueden ser solo 2 mortales ⇒ desconocido.
    const sinMortales = (d: number, g: number) => { const { generacionesMortalesVivas: _g, ...resto } = diaSano(d); return { ...resto, generacionesVivas: g }; };
    escribir(raiz, 'G-1', rango(20).map(d => sinMortales(d, 3)), true);
    escribir(raiz, 'G-2', rango(20).map(d => sinMortales(d, 4)), true);
    escribir(raiz, 'G-3', rango(20).map(d => sinMortales(d, 2)), true);
    // C8: diversidad constante (no crece) y serie decreciente con un pico aislado el día D.
    escribir(raiz, 'V-1', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: 0.3 })), true);
    escribir(raiz, 'V-2', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: d === 20 ? 0.7 : 0.6 - 0.01 * d })), true);
    // C4: un tipo con 2 actos en la ventana (17 % de 12) no es «relevante».
    escribir(raiz, 'K-1', rango(20).map(d => ({ ...diaSano(d), cooperacionAcumuladaPorTipo: { teaching: d, trade: Math.floor(d / 5), constructionHelp: 0 } })), true);
    // C1: la población cae por debajo de 16 dentro de la ventana y se recupera el día D.
    escribir(raiz, 'P-1', rango(20).map(d => d === 15 ? { ...diaSano(d), poblacion: 12, vecinosMortales: 10 } : diaSano(d)), true);
    // Extinción sin vecinosMortales (métricas antiguas): población 2 = solo S e I, inmortales.
    escribir(raiz, 'X-1', rango(12).map(d => { const { vecinosMortales: _v, ...resto } = diaSano(d); return d >= 9 ? { ...resto, poblacion: 2 } : resto; }), true);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    assert.equal(replica(inf, 'G-1').criterios!.generaciones.estado, 'desconocido');
    assert.equal(replica(inf, 'G-1').todos, 'desconocido');
    assert.equal(replica(inf, 'G-2').criterios!.generaciones.estado, 'cumple');
    assert.equal(replica(inf, 'G-3').criterios!.generaciones.estado, 'falla');
    assert.equal(replica(inf, 'V-1').criterios!.diversidad.estado, 'falla');
    assert.match(replica(inf, 'V-1').criterios!.diversidad.motivo, /constante/);
    assert.equal(replica(inf, 'V-2').criterios!.diversidad.estado, 'falla');
    assert.equal(replica(inf, 'K-1').criterios!.cooperacion.estado, 'falla');
    assert.equal(replica(inf, 'P-1').criterios!.supervivencia.estado, 'falla');
    assert.equal(replica(inf, 'X-1').estado, 'extinguida');
    assert.equal(replica(inf, 'X-1').diaExtincion, 9);

    // C8 con dos días (5 y 6): ni pendiente ni comparación de bloques con una sola muestra por extremo.
    assert.equal(replica(evaluarConjunto(raiz, { dia: 6 }), 'V-2').criterios!.diversidad.estado, 'desconocido');

    // C6: con un solo día leído el balance se hace desde el estado inicial (16, 0, 0), no se da por bueno.
    escribir(raiz, 'B-1', [{ ...diaSano(1), poblacion: 15, nacimientos: 0, muertesPorCausa: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 } }], true);
    const uno = replica(evaluarConjunto(raiz, { dia: 1, causasMin: 0 }), 'B-1').criterios!.muertes;
    assert.equal(uno.valores.residuoBalance, -1);
    assert.equal(uno.estado, 'falla');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: una réplica en curso que lleva horas sin escribir se avisa como posible proceso muerto', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-rev-'));
  try {
    escribir(raiz, 'E-1', rango(5).map(diaSano), false);
    escribir(raiz, 'E-2', rango(5).map(diaSano), false);
    const antiguo = new Date(Date.now() - 5 * 3600 * 1000);
    for (const n of rango(5)) utimesSync(join(raiz, 'E-1', `dia-00${n}.json`), antiguo, antiguo);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    assert.equal(replica(inf, 'E-1').estado, 'en-curso');
    assert.ok(inf.avisos.some(a => a.startsWith('E-1:') && /proceso muerto/.test(a)), inf.avisos.join('\n'));
    assert.ok(!inf.avisos.some(a => a.startsWith('E-2:')));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// Instrumentos de 2026-09-22 (scripts/lab/instrumentos.ts): `foodShared` dentro de
// `cooperacionAcumuladaPorTipo` y `diversidadConductaTiempo` junto a la serie antigua.

test('criterio de terminado: C4 cuenta foodShared anidado en cooperacionAcumuladaPorTipo como un tipo más', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr-'));
  try {
    // Solo enseñanza tipificada por world.totals: sin foodShared es UN tipo (falla); con 4 actos de comida
    // compartida por día (40 en la ventana, 29 % de 140) son dos tipos relevantes (cumple).
    const soloEnsenanza = (d: number) => ({ ...diaSano(d), cooperacionAcumuladaPorTipo: { teaching: 10 * d, trade: 0, constructionHelp: 0 } });
    escribir(raiz, 'F-1', rango(20).map(soloEnsenanza), true);
    escribir(raiz, 'F-2', rango(20).map(d => ({ ...soloEnsenanza(d), cooperacionAcumuladaPorTipo: { teaching: 10 * d, trade: 0, constructionHelp: 0, foodShared: 4 * d } })), true);
    // Formatos mezclados: el día base (10) no trae foodShared y el día D sí ⇒ desconocido, no 80 actos «de la ventana».
    escribir(raiz, 'F-3', rango(20).map(d => d <= 10 ? soloEnsenanza(d) : { ...soloEnsenanza(d), cooperacionAcumuladaPorTipo: { teaching: 10 * d, trade: 0, constructionHelp: 0, foodShared: 4 * d } }), true);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    const sin = replica(inf, 'F-1').criterios!.cooperacion, con = replica(inf, 'F-2').criterios!.cooperacion, mezcla = replica(inf, 'F-3').criterios!.cooperacion;
    assert.equal(sin.estado, 'falla');
    assert.deepEqual(sin.valores.relevantes, ['teaching']);
    assert.equal(con.estado, 'cumple', con.motivo);
    assert.deepEqual(con.valores.relevantes, ['teaching', 'foodShared']);
    assert.deepEqual(con.valores.porTipo, { teaching: 100, trade: 0, constructionHelp: 0, foodShared: 40 });
    assert.match(con.motivo, /foodShared 40 \(29 %\)/);
    assert.equal(mezcla.estado, 'desconocido');
    assert.match(mezcla.motivo, /falta foodShared en el día 10/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: C8 usa diversidadConductaTiempo si está (y no hay activa), informa la serie antigua como secundaria y --diversidad-campo elige', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr-'));
  try {
    // Serie antigua decreciente (explorar inflado) y serie por tiempo creciente en el mismo mundo.
    escribir(raiz, 'T-1', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: 0.6 - 0.01 * d, diversidadConductaTiempo: 0.2 + 0.01 * d })), true);
    // Sin el instrumento: auto cae en la serie antigua y no hay secundaria.
    escribir(raiz, 'T-2', rango(20).map(diaSano), true);
    const auto = evaluarConjunto(raiz, { dia: 20 });
    const t1 = replica(auto, 'T-1').criterios!.diversidad;
    assert.equal(t1.estado, 'cumple', t1.motivo);
    assert.equal(t1.valores.campo, 'diversidadConductaTiempo');
    assert.deepEqual((t1.valores.secundarias as Record<string, unknown>[]).map(s => [s.campo, s.estado]), [['diversidadConducta', 'falla']]);
    assert.match(t1.motivo, /^diversidadConductaTiempo: Mann-Kendall .* · secundaria diversidadConducta \(no decide\): falla/);
    const t2 = replica(auto, 'T-2').criterios!.diversidad;
    assert.equal(t2.estado, 'cumple');
    assert.equal(t2.valores.campo, 'diversidadConducta');
    assert.deepEqual(t2.valores.secundarias, []);
    assert.match(auto.descripcionCriterios.diversidad, /diversidadConductaActiva \(si falta, diversidadConductaTiempo; si falta, diversidadConducta\)/);

    const antigua = evaluarConjunto(raiz, { dia: 20, diversidadCampo: 'diversidadConducta' });
    const a1 = replica(antigua, 'T-1').criterios!.diversidad;
    assert.equal(a1.estado, 'falla');
    assert.equal(a1.valores.campo, 'diversidadConducta');
    assert.deepEqual((a1.valores.secundarias as Record<string, unknown>[]).map(s => [s.campo, s.estado]), [['diversidadConductaTiempo', 'cumple']]);
    // Forzar la serie por tiempo en una réplica que no la tiene: campo ausente ⇒ desconocido, nunca aprobado.
    const tiempo = evaluarConjunto(raiz, { dia: 20, diversidadCampo: 'diversidadConductaTiempo' });
    assert.equal(replica(tiempo, 'T-2').criterios!.diversidad.estado, 'desconocido');
    assert.equal(replica(tiempo, 'T-1').criterios!.diversidad.estado, 'cumple');

    assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--diversidad-campo', 'tiempo']).umbrales, { diversidadCampo: 'diversidadConductaTiempo' });
    assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--diversidad-campo', 'actividad']).umbrales, { diversidadCampo: 'diversidadConducta' });
    assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--diversidad-campo', 'auto']).umbrales, { diversidadCampo: 'auto' });
    for (const malo of ['otra', 'constructor', '__proto__']) assert.throws(() => parsearArgumentos(['--entrada', 'x', '--diversidad-campo', malo]), /--diversidad-campo/);

    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/criterio-terminado.mts', '--entrada', raiz, '--dia', '20', '--diversidad-campo', 'actividad'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /C8 diversidad +diversidadConducta días 5\.\.D: Mann-Kendall unilateral creciente p < 0\.05/);
    assert.match(cli.stdout, /--diversidad-campo/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// Preregistro del criterio C8 (orquestador, noche 2026-09-22, decidido antes de ver corridas largas):
// en modo auto decide `diversidadConductaActiva` (ticks por acción sin descansar) si está; las demás
// series se informan como secundarias; y la serie evaluada debe tener dato en ≥ 80 % de los días del
// tramo (días base..D), si no C8 es «desconocido», nunca «cumple».

test('criterio de terminado: C8 con cobertura < 80 % del tramo es «desconocido», nunca «cumple» (hueco del verificador)', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-activa-'));
  try {
    // Caso del verificador: la serie por tiempo solo existe los días 5-7 (creciente) y la antigua está
    // completa y cae. Antes, auto elegía la serie por tiempo (aparecía algún día) y la aprobaba con 3 puntos.
    escribir(raiz, 'H-1', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: 0.6 - 0.01 * d, ...(d >= 5 && d <= 7 ? { diversidadConductaTiempo: 0.2 + 0.01 * d } : {}) })), true);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    const c8 = replica(inf, 'H-1').criterios!.diversidad;
    assert.equal(c8.estado, 'desconocido', c8.motivo);
    assert.equal(c8.valores.campo, 'diversidadConductaTiempo');
    assert.equal(c8.valores.puntos, 3);
    assert.equal(c8.valores.cobertura, 3 / 16);
    assert.match(c8.motivo, /^diversidadConductaTiempo: dato en solo 3\/16 días del tramo 5\.\.20 \(19 % < 80 %\): no representa el tramo; sin dato: 8-20 · secundaria diversidadConducta \(no decide\): falla/);
    assert.equal(replica(inf, 'H-1').todos, 'desconocido', 'una semilla con C8 desconocido no «cumple todos»');
    // Forzada, cualquier serie con poca cobertura también es «desconocido» (se aplica a todas).
    assert.equal(replica(evaluarConjunto(raiz, { dia: 20, diversidadCampo: 'diversidadConductaTiempo' }), 'H-1').criterios!.diversidad.estado, 'desconocido');
    assert.equal(replica(evaluarConjunto(raiz, { dia: 20, diversidadCampo: 'diversidadConducta' }), 'H-1').criterios!.diversidad.estado, 'falla');

    // Tramo 5..20 = 16 días; 13 con dato (81 %) pasa la cobertura, 12 (75 %) no. Pero con D = 20 los
    // bloques (k = 8: días 5..12 y 13..20) cubren todo el tramo, y los huecos 9-11 caen en el inicial:
    // desconocido por extremos incompletos (verificador de INSTR-2), aunque la cobertura bastaría.
    const conHuecos = (dias: number, sinDato: (d: number) => boolean) => rango(dias).map(d => ({ ...diaSano(d), ...(sinDato(d) ? {} : { diversidadConductaActiva: 0.2 + 0.01 * d }) }));
    escribir(raiz, 'H-2', conHuecos(20, d => d >= 9 && d <= 11), true);
    escribir(raiz, 'H-3', conHuecos(20, d => d >= 9 && d <= 12), true);
    const frontera = evaluarConjunto(raiz, { dia: 20 });
    const h2 = replica(frontera, 'H-2').criterios!.diversidad, h3 = replica(frontera, 'H-3').criterios!.diversidad;
    assert.equal(h2.valores.campo, 'diversidadConductaActiva');
    assert.equal(h2.estado, 'desconocido', h2.motivo);
    assert.equal(h2.valores.cobertura, 13 / 16);
    assert.match(h2.motivo, /sin dato en los días 9-11 de los extremos del tramo \(bloques días 5\.\.12 y 13\.\.20/);
    assert.equal(h3.estado, 'desconocido', h3.motivo);
    assert.match(h3.motivo, /12\/16 días .* sin dato: 9-12/);

    // Frontera de cobertura con el medio libre: D = 40, tramo 5..40 = 36 días, bloques 5..14 y 31..40.
    // Huecos 15-21 (29/36 = 81 %) se evalúa; 15-22 (28/36 = 78 %) no.
    escribir(raiz, 'H-4', conHuecos(40, d => d >= 15 && d <= 21), true);
    escribir(raiz, 'H-5', conHuecos(40, d => d >= 15 && d <= 22), true);
    const frontera40 = evaluarConjunto(raiz, { dia: 40 });
    const h4 = replica(frontera40, 'H-4').criterios!.diversidad, h5 = replica(frontera40, 'H-5').criterios!.diversidad;
    assert.equal(h4.estado, 'cumple', h4.motivo);
    assert.equal(h4.valores.cobertura, 29 / 36);
    // v2: con huecos, el «cumple» se sostiene con los 7 días en su valor más desfavorable.
    assert.ok((h4.valores.pPesimista as number) < 0.05);
    assert.match(h4.motivo, /se sostiene con los 7 día\(s\) sin dato \(15-21\) en su valor más desfavorable/);
    // v1 (informada): la pendiente favorable no decide; aprueba la comparación de bloques (completos).
    const v1 = h4.valores.reglasAntiguas as Record<string, unknown>;
    assert.equal(v1.o, 'cumple');
    assert.equal(v1.pendienteDecide, false);
    assert.match(v1.motivo as string, /favorable pero con 7 día\(s\) sin dato \(15-21\): no decide; media días 5\.\.14 0\.295 → días 31\.\.40 0\.555/);
    assert.equal(h5.estado, 'desconocido', h5.motivo);
    assert.match(h5.motivo, /28\/36 días .* sin dato: 15-22/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: C8 en auto decide con diversidadConductaActiva; tiempo y antigua son secundarias', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-activa-'));
  try {
    // Activa completa y creciente; la de tiempo (dominada por descansar) y la antigua (explorar inflado) caen.
    escribir(raiz, 'A-1', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: 0.6 - 0.01 * d, diversidadConductaTiempo: 0.5 - 0.01 * d, diversidadConductaActiva: 0.3 + 0.01 * d })), true);
    // Y al revés: la activa completa cae aunque las otras dos crezcan ⇒ falla (no se elige la que aprueba).
    escribir(raiz, 'A-2', rango(20).map(d => ({ ...diaSano(d), diversidadConductaTiempo: 0.2 + 0.01 * d, diversidadConductaActiva: 0.6 - 0.01 * d })), true);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    const a1 = replica(inf, 'A-1').criterios!.diversidad, a2 = replica(inf, 'A-2').criterios!.diversidad;
    assert.equal(a1.estado, 'cumple', a1.motivo);
    assert.equal(a1.valores.campo, 'diversidadConductaActiva');
    assert.equal(a1.valores.cobertura, 1);
    assert.deepEqual((a1.valores.secundarias as Record<string, unknown>[]).map(s => [s.campo, s.estado]), [['diversidadConductaTiempo', 'falla'], ['diversidadConducta', 'falla']]);
    assert.match(a1.motivo, /^diversidadConductaActiva: Mann-Kendall .* · secundaria diversidadConductaTiempo \(no decide\): falla, .* · secundaria diversidadConducta \(no decide\): falla/);
    assert.equal(replica(inf, 'A-1').todos, 'cumple');
    assert.equal(a2.estado, 'falla', a2.motivo);
    assert.equal(a2.valores.campo, 'diversidadConductaActiva');
    assert.deepEqual((a2.valores.secundarias as Record<string, unknown>[]).map(s => [s.campo, s.estado]), [['diversidadConductaTiempo', 'cumple'], ['diversidadConducta', 'cumple']]);
    // --diversidad-campo fuerza otra serie; la activa pasa a secundaria.
    const tiempo = replica(evaluarConjunto(raiz, { dia: 20, diversidadCampo: 'diversidadConductaTiempo' }), 'A-2').criterios!.diversidad;
    assert.equal(tiempo.estado, 'cumple');
    assert.deepEqual((tiempo.valores.secundarias as Record<string, unknown>[]).map(s => s.campo), ['diversidadConductaActiva', 'diversidadConducta']);

    assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--diversidad-campo', 'activa']).umbrales, { diversidadCampo: 'diversidadConductaActiva' });
    assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--diversidad-campo', 'diversidadConductaActiva']).umbrales, { diversidadCampo: 'diversidadConductaActiva' });
    assert.throws(() => parsearArgumentos(['--entrada', 'x', '--diversidad-campo', 'activo']), /auto, activa, tiempo o actividad/);
    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/criterio-terminado.mts', '--entrada', raiz, '--dia', '20'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /C8 diversidad +diversidadConductaActiva \(si falta, diversidadConductaTiempo; si falta, diversidadConducta\) días 5\.\.D: Mann-Kendall .*< 80 % de los días del tramo ⇒ desconocido/);
    assert.match(cli.stdout, /auto\|activa\|tiempo\|actividad|--diversidad-campo/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// Endurecimiento tras el verificador de INSTR-2 (noche 2026-09-22). Los sintéticos reproducen los suyos
// (esconder-final-1, ocultar-bajos-2, epsilon-3, duplicado-6) con los mismos valores; con el código de
// bce5a88 los cuatro daban C8 = «cumple».

const cae = (d: number) => 0.6 - 0.01 * d;
/** Serie ruidosa del verificador (índice = día): cae en conjunto; sus días más bajos (0,10) son 16, 18 y 20. */
const RUIDO = [0, 0.30, 0.30, 0.30, 0.30, 0.40, 0.20, 0.39, 0.21, 0.38, 0.22, 0.37, 0.23, 0.36, 0.24, 0.35, 0.10, 0.34, 0.10, 0.33, 0.10];

test('criterio de terminado: C8 exige el día D y los dos bloques completos (esconder el final o los días bajos no aprueba)', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr2-'));
  try {
    // esconder-final-1: la activa sube los días 5..17 y faltan 18..20 (13/16 = 81 % ≥ 80 %). Antes el
    // bloque final era «¿?» y la regla «o» aprobaba con la pendiente de los días que quedaban.
    escribir(raiz, 'esconder-final-1', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: cae(d), diversidadConductaActiva: d <= 17 ? 0.3 + 0.01 * d : undefined })), true);
    // ocultar-bajos-2: la serie completa cae (completa-22 falla); sin sus 3 días más bajos (16, 18, 20,
    // escritos como null) la pendiente de los 13 restantes sale positiva.
    escribir(raiz, 'ocultar-bajos-2', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: cae(d), diversidadConductaActiva: [16, 18, 20].includes(d) ? null : RUIDO[d] })), true);
    escribir(raiz, 'completa-22', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: cae(d), diversidadConductaActiva: RUIDO[d] })), true);
    // Solo falta el día D: tampoco.
    escribir(raiz, 'sin-D-3', rango(20).map(d => ({ ...diaSano(d), diversidadConductaActiva: d === 20 ? null : 0.2 + 0.01 * d })), true);
    for (const regla of ['mk', 'o', 'y'] as const) {
      const inf = evaluarConjunto(raiz, { dia: 20, diversidadRegla: regla });
      const final = replica(inf, 'esconder-final-1').criterios!.diversidad;
      assert.equal(final.estado, 'desconocido', `${regla}: ${final.motivo}`);
      assert.equal(final.valores.cobertura, 13 / 16);
      assert.deepEqual(final.valores.diasSinDatoEnExtremos, [18, 19, 20]);
      assert.match(final.motivo, /^diversidadConductaActiva: sin dato en los días 18-20 de los extremos del tramo \(bloques días 5\.\.12 y 13\.\.20, que deben estar completos\)/);
      assert.equal(replica(inf, 'esconder-final-1').todos, 'desconocido');
      const bajos = replica(inf, 'ocultar-bajos-2').criterios!.diversidad;
      assert.equal(bajos.estado, 'desconocido', `${regla}: ${bajos.motivo}`);
      assert.match(bajos.motivo, /sin dato en los días 16, 18, 20 de los extremos/);
      assert.equal(replica(inf, 'completa-22').criterios!.diversidad.estado, 'falla', 'la serie completa que los huecos escondían falla');
      const sinD = replica(inf, 'sin-D-3').criterios!.diversidad;
      assert.equal(sinD.estado, 'desconocido', `${regla}: ${sinD.motivo}`);
      assert.match(sinD.motivo, /sin dato en el día 20 de los extremos/);
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: C8 con huecos en el medio del tramo — una pendiente favorable no aprueba sola', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr2-'));
  try {
    // D = 40: bloques 5..14 (0,30) y 31..40 (0,29, completos; el final es más bajo). El medio baja a 0,10
    // y a 0,0 los días 23..29; sin esos 7 días (29/36 = 81 % de cobertura) la pendiente pasa de −6,8e-4
    // a +8,7e-4/día. Con la regla «o» eso aprobaba C8 aunque la serie completa falle.
    const serie = (d: number) => d <= 14 ? 0.30 : d <= 22 ? 0.10 : d <= 29 ? 0.0 : d === 30 ? 0.25 : 0.29;
    escribir(raiz, 'medio-1', rango(40).map(d => ({ ...diaSano(d), diversidadConductaActiva: d >= 23 && d <= 29 ? null : serie(d) })), true);
    escribir(raiz, 'medio-completa-2', rango(40).map(d => ({ ...diaSano(d), diversidadConductaActiva: serie(d) })), true);
    // v2 (por defecto): Mann-Kendall de los días con dato ya es negativo (S = −92): falla, igual que la completa.
    const v2 = evaluarConjunto(raiz, { dia: 40 });
    for (const nombre of ['medio-1', 'medio-completa-2']) {
      const c8 = replica(v2, nombre).criterios!.diversidad;
      assert.equal(c8.estado, 'falla', `${nombre}: ${c8.motivo}`);
      assert.ok((c8.valores.S as number) < 0);
    }
    assert.equal(replica(v2, 'medio-1').criterios!.diversidad.valores.S, -92);
    // Reglas v1 (reproducción explícita):
    const inf = evaluarConjunto(raiz, { dia: 40, diversidadRegla: 'o' });
    const medio = replica(inf, 'medio-1').criterios!.diversidad, completa = replica(inf, 'medio-completa-2').criterios!.diversidad;
    assert.ok((medio.valores.pendiente as number) > 0, 'la pendiente con huecos sale favorable');
    assert.equal(medio.valores.pendienteDecide, false);
    assert.equal(medio.estado, 'desconocido', medio.motivo);
    assert.match(medio.motivo, /^diversidadConductaActiva: regla v1 «o»: pendiente .* favorable pero con 7 día\(s\) sin dato \(23-29\): no decide; media días 5\.\.14 0\.3 → días 31\.\.40 0\.29/);
    assert.ok((completa.valores.pendiente as number) < 0);
    assert.equal(completa.estado, 'falla', completa.motivo);
    // Regla «y»: la pendiente con huecos no cuenta y los bloques caen ⇒ falla (la pendiente nunca aprueba).
    assert.equal(replica(evaluarConjunto(raiz, { dia: 40, diversidadRegla: 'y' }), 'medio-1').criterios!.diversidad.estado, 'falla');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: C8 con una serie casi constante falla (tolerancia relativa, no igualdad exacta)', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr2-'));
  try {
    // epsilon-3: 0,3 constante y 0,3 + 1e-15 el día D. Antes: max ≠ min, pendiente 2,2e-17 ≥ 0 ⇒ cumple.
    escribir(raiz, 'epsilon-3', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: cae(d), diversidadConductaActiva: d === 20 ? 0.3 + 1e-15 : 0.3 })), true);
    // Fuera de [0, 1] (el índice es una fracción): datos incoherentes ⇒ desconocido con cualquier regla.
    escribir(raiz, 'escala-4', rango(20).map(d => ({ ...diaSano(d), diversidadConductaActiva: d === 20 ? 300 + 1e-7 : 300 })), true);
    // Amplitud grande pero sin tendencia: una V simétrica sobre el tramo 5..20 (pendiente 0, S = 0) no crece.
    escribir(raiz, 'uve-5', rango(20).map(d => ({ ...diaSano(d), diversidadConductaActiva: 0.3 + 0.05 * Math.abs(d - 12.5) })), true);
    // Una tendencia pequeña pero real (1e-6/día): v1 la aprueba; v2 no (subida de Sen 1,5e-5 < 0,02).
    escribir(raiz, 'leve-6', rango(20).map(d => ({ ...diaSano(d), diversidadConductaActiva: 0.3 + 1e-6 * d })), true);
    for (const regla of ['mk', 'o', 'y'] as const) {
      const inf = evaluarConjunto(raiz, { dia: 20, diversidadRegla: regla });
      const prefijo = regla === 'mk' ? '' : `regla v1 «${regla}»: `;
      const epsilon = replica(inf, 'epsilon-3').criterios!.diversidad;
      assert.equal(epsilon.estado, 'falla', `${regla}: ${epsilon.motivo}`);
      assert.ok(epsilon.motivo.startsWith(`diversidadConductaActiva: ${prefijo}serie constante (0.3; amplitud 1.0e-15 ≤ 1.0e-9) en 16 días: no crece`), epsilon.motivo);
      const escala = replica(inf, 'escala-4').criterios!.diversidad;
      assert.equal(escala.estado, 'desconocido', `${regla}: ${escala.motivo}`);
      assert.match(escala.motivo, /índice de diversidad fuera de \[0, 1\] o no numérico \(día 5 = 300, día 6 = 300, día 7 = 300, … 16 días\): datos incoherentes/);
      const uve = replica(inf, 'uve-5').criterios!.diversidad;
      assert.equal(uve.estado, 'falla', `${regla}: ${uve.motivo}`);
      if (regla === 'mk') assert.match(uve.motivo, /Mann-Kendall S = 0, z = 0, p = 0\.5 ≥ 0\.05/);
      else assert.match(uve.motivo, /serie sin tendencia \(\|pendiente\| .*≤ 1\.0e-9\) en 16 días: no crece/);
      const leve = replica(inf, 'leve-6').criterios!.diversidad;
      assert.equal(leve.estado, regla === 'mk' ? 'falla' : 'cumple', `${regla}: ${leve.motivo}`);
      if (regla === 'mk') assert.match(leve.motivo, /p = [0-9.e-]+ < 0\.05 .*subida 1\.50e-5 < 0\.02/);
    }
    assert.match(evaluarConjunto(raiz, { dia: 20 }).descripcionCriterios.diversidad, /serie constante \(amplitud ≤ 1e-9, relativa\) ⇒ falla/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: dos ficheros para el mismo día o un nombre no canónico hacen la réplica ilegible con error explícito', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr2-'));
  try {
    // duplicado-6: además de dia-019.json y dia-020.json (serie que cae), dia-19.json y dia-20.json con la
    // activa en 5. Antes el que se leía después pisaba al otro en silencio y C8 aprobaba.
    escribir(raiz, 'duplicado-6', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: cae(d), diversidadConductaActiva: cae(d) })), true, {
      'dia-20.json': JSON.stringify({ ...diaSano(20), diversidadConducta: 1, diversidadConductaActiva: 5 }),
      'dia-19.json': JSON.stringify({ ...diaSano(19), diversidadConductaActiva: 5 }),
    });
    // Un nombre no canónico suelto (sin su dia-NNN.json) tampoco se acepta: ni 1 dígito ni 4 con cero de más.
    escribir(raiz, 'suelto-7', rango(20).filter(d => d !== 7).map(diaSano), true, { 'dia-7.json': JSON.stringify(diaSano(7)) });
    escribir(raiz, 'cuatro-8', rango(20).filter(d => d !== 20).map(diaSano), true, { 'dia-0020.json': JSON.stringify(diaSano(20)) });
    escribir(raiz, 'sana-9', rango(20).map(diaSano), true);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    const dup = replica(inf, 'duplicado-6');
    assert.equal(dup.estado, 'ilegible');
    assert.equal(dup.nota, 'ficheros duplicados para el mismo día: dia-019.json y dia-19.json (día 19); dia-020.json y dia-20.json (día 20); no se elige uno');
    assert.equal(dup.todos, 'desconocido');
    assert.ok(Object.values(dup.criterios!).every(c => c.estado === 'desconocido'));
    const suelto = replica(inf, 'suelto-7');
    assert.equal(suelto.estado, 'ilegible');
    assert.match(suelto.nota!, /^nombre de día no canónico: dia-7\.json \(se espera dia-007\.json\); solo se aceptan dia-NNN\.json de 3 dígitos/);
    const cuatro = replica(inf, 'cuatro-8');
    assert.equal(cuatro.estado, 'ilegible');
    assert.match(cuatro.nota!, /dia-0020\.json \(se espera dia-020\.json\)/);
    assert.equal(replica(inf, 'sana-9').todos, 'cumple');
    assert.equal(inf.brazos.find(b => b.brazo === 'duplicado')!.ilegibles, 1);
    // La CLI lo dice en la línea de la réplica.
    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/criterio-terminado.mts', '--entrada', raiz, '--dia', '20'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /duplicado-6 +\?{8} .*ficheros duplicados para el mismo día: dia-019\.json y dia-19\.json/);
    // El nombre canónico desde el día 1000 (padStart(3) no recorta) sí se acepta.
    const mil = mkdtempSync(join(tmpdir(), 'atlas-criterio-instr2-'));
    try {
      escribir(mil, 'larga-1', [998, 999, 1000].map(diaSano), true);
      const larga = replica(evaluarConjunto(mil, { dia: 1000 }), 'larga-1');
      assert.equal(larga.estado, 'evaluada', larga.nota ?? '');
      assert.equal(larga.ultimoDia, 1000);
    } finally { rmSync(mil, { recursive: true, force: true }); }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

// ── Preregistro v2 de C8 (orquestador, 2026-09-22 21:45) y coherencia (verificador de INSTR-3) ─────────
// Los sintéticos reproducen los del verificador (verif-instr3/ataque.mts y ruido.mts) con los mismos
// valores, a D = 60: su réplica sana con diversidadConductaActiva = 0,2 + 0,005·d.

function diaSano60(d: number, div = 0.2 + 0.005 * d): Dia {
  const { diversidadConducta: _v, ...resto } = diaSano(d);
  return { ...resto, diversidadConductaActiva: div };
}
const cae60 = (d: number) => 0.6 - 0.005 * d;

test('criterio de terminado: sintéticos del verificador de INSTR-3 con el C8 v2 y las comprobaciones de coherencia', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-v2-'));
  try {
    const D = 60, dias = rango(D);
    escribir(raiz, 'sano-1', dias.map(d => diaSano60(d)), true);
    escribir(raiz, 'cae-2', dias.map(d => diaSano60(d, cae60(d))), true);
    // Sin tick y con la serie en orden inverso; tick no numérico.
    escribir(raiz, 'sintick-fuera-3', [], true, Object.fromEntries(dias.map(d => { const x = diaSano60(d, cae60(D + 1 - d)); delete x.tick; return [`dia-${String(d).padStart(3, '0')}.json`, JSON.stringify(x)]; })));
    escribir(raiz, 'tickstring-4', [], true, Object.fromEntries(dias.map(d => [`dia-${String(d).padStart(3, '0')}.json`, JSON.stringify({ ...diaSano60(d, cae60(D + 1 - d)), tick: 'x' })])));
    // C3: una sola generación repetida; basura.
    escribir(raiz, 'gendup-5', dias.map(d => ({ ...diaSano60(d), generacionesMortalesVivas: [2, 2, 2] })), true);
    escribir(raiz, 'genbasura-6', dias.map(d => ({ ...diaSano60(d), generacionesMortalesVivas: ['a', null, {}] })), true);
    // C8: bloques extremos iguales con el medio alto y luego bajo (pendiente negativa); bloque final 1e-12 más alto.
    escribir(raiz, 'bloques-iguales-7', dias.map(d => diaSano60(d, d <= 14 ? 0.3 : d <= 32 ? 0.6 : d <= 50 ? 0.1 : 0.3)), true);
    escribir(raiz, 'bloque-eps-8', dias.map(d => diaSano60(d, d <= 14 ? 0.3 : d <= 50 ? 0.5 - 0.01 * (d - 15) : 0.3 + 1e-12)), true);
    // Constante con +1e-6 el día D.
    escribir(raiz, 'bump-9', dias.map(d => diaSano60(d, d === D ? 0.3 + 1e-6 : 0.3)), true);
    // C7: 1 uso con autor conocido por día (10 en la ventana) con 0/1 ajenos alternos: coherente pero escaso.
    escribir(raiz, 'c7-incoh-10', dias.map(d => ({ ...diaSano60(d), usosUtiles: 20, usosSinAutorResuelto: 19, usosDeInventorAjeno: d % 2 ? 0 : 1 })), true);
    // C4: un alias del mismo mecanismo.
    escribir(raiz, 'c4-alias-11', dias.map(d => ({ ...diaSano60(d), cooperacionAcumuladaPorTipo: { teaching: 10 * d, Teaching: 10 * d } })), true);
    // C2: fundadores mortales negativos.
    escribir(raiz, 'c2-neg-13', dias.map(d => ({ ...diaSano60(d), fundadoresMortalesVivos: -5 })), true);
    // Semillas duplicadas en el brazo x (x-1, x-01, x-001 = semilla 1) y tres semillas que caen.
    for (const n of ['x-1', 'x-01', 'x-001']) escribir(raiz, n, dias.map(d => diaSano60(d)), true);
    for (const n of ['x-2', 'x-3', 'x-4']) escribir(raiz, n, dias.map(d => diaSano60(d, cae60(d))), true);

    const inf = evaluarConjunto(raiz);
    assert.equal(inf.dia, 60);
    const c8 = (nombre: string) => replica(inf, nombre).criterios!.diversidad;

    const sano = replica(inf, 'sano-1');
    assert.equal(sano.todos, 'cumple', JSON.stringify(sano.criterios));
    assert.equal(c8('sano-1').valores.S, 1540);
    assert.ok((c8('sano-1').valores.p as number) < 1e-20);
    assert.ok(Math.abs((c8('sano-1').valores.subida as number) - 0.275) < 1e-12, 'Sen 0,005/día × 55 días');
    assert.equal(c8('sano-1').valores.factor, 1, 'una recta exacta no tiene autocorrelación que corregir');
    assert.equal((c8('sano-1').valores.reglasAntiguas as Record<string, unknown>).o, 'cumple');
    assert.equal(c8('cae-2').estado, 'falla');

    for (const [nombre, nota] of [['sintick-fuera-3', /^dia-001\.json: tick ausente; se espera 1·2400 = 2400$/], ['tickstring-4', /^dia-001\.json: tick no numérico \("x"\)/]] as const) {
      const r = replica(inf, nombre);
      assert.equal(r.estado, 'ilegible', nombre);
      assert.match(r.nota!, nota);
      assert.equal(r.todos, 'desconocido');
    }
    const gendup = replica(inf, 'gendup-5').criterios!.generaciones;
    assert.equal(gendup.estado, 'desconocido', gendup.motivo);
    assert.match(gendup.motivo, /repite generaciones \[2, 2, 2\] \(1 distinta\(s\) de 3\): datos incoherentes/);
    assert.equal(replica(inf, 'gendup-5').todos, 'desconocido');
    const basura = replica(inf, 'genbasura-6').criterios!.generaciones;
    assert.equal(basura.estado, 'desconocido');
    assert.match(basura.motivo, /no son enteros ≥ 0 \("a", null, \{\}\)/);

    // bloques-iguales-7 y bloque-eps-8: con la regla v1 «o» y ≥ aprobaban por bloques iguales; ahora
    // fallan en v2 (S < 0) y también en la v1 informada (bloques con tolerancia 1e-9).
    for (const nombre of ['bloques-iguales-7', 'bloque-eps-8']) {
      assert.equal(c8(nombre).estado, 'falla', c8(nombre).motivo);
      assert.ok((c8(nombre).valores.S as number) < 0);
      assert.equal((c8(nombre).valores.reglasAntiguas as Record<string, unknown>).o, 'falla');
    }
    // bump-9: la regla v1 «o» lo aprueba (pendiente 1,9e-9 > tolerancia); v2 no: la subida de Sen es 0.
    assert.equal(c8('bump-9').estado, 'falla', c8('bump-9').motivo);
    assert.equal(c8('bump-9').valores.subida, 0);
    assert.equal((c8('bump-9').valores.reglasAntiguas as Record<string, unknown>).o, 'cumple');

    const c7 = replica(inf, 'c7-incoh-10').criterios!.tecnologia;
    assert.equal(c7.estado, 'desconocido', c7.motivo);
    assert.match(c7.motivo, /^solo 10 usos útiles con autor conocido en la ventana \(< 20; 200 usos útiles\)/);
    const c4 = replica(inf, 'c4-alias-11').criterios!.cooperacion;
    assert.equal(c4.estado, 'falla', c4.motivo);
    assert.deepEqual(c4.valores.relevantes, ['teaching']);
    assert.deepEqual(c4.valores.clavesNoContadas, ['Teaching']);
    assert.match(c4.motivo, /no cuentan: Teaching/);
    const c2 = replica(inf, 'c2-neg-13');
    assert.equal(c2.estado, 'ilegible');
    assert.match(c2.nota!, /^dia-001\.json: fundadoresMortalesVivos = -5: contadores y poblaciones deben ser enteros ≥ 0$/);

    for (const n of ['x-1', 'x-01', 'x-001']) {
      const r = replica(inf, n);
      assert.equal(r.estado, 'ilegible', n);
      assert.equal(r.nota, 'semilla duplicada en el brazo «x»: x-001, x-01, x-1 resuelven a la semilla 1; no se elige una');
    }
    for (const n of ['x-2', 'x-3', 'x-4']) assert.equal(c8(n).estado, 'falla');
    const x = brazo(inf, 'x');
    // Las 3 ilegibles cuentan como «desconocido»: el brazo no puede declararse ni mayoría ni no mayoría.
    assert.deepEqual([x.semillas, x.ilegibles, x.cumplenTodos, x.todosDesconocido, x.veredicto], [6, 3, 0, 3, 'indeterminado']);
    assert.ok(inf.avisos.includes('semilla duplicada en el brazo «x»: x-001, x-01, x-1 resuelven a la semilla 1; no se elige una'));
    // Ningún caso incoherente llega a «cumple todos».
    for (const r of inf.replicas) if (!['sano-1'].includes(r.nombre)) assert.notEqual(r.todos, 'cumple', r.nombre);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: C8 v2 con ruido estacionario del verificador aprueba ≤ 7 %; la regla v1 «o», ~60 %', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-v2-'));
  try {
    // ruido.mts del verificador: 0,3 + U(−0,1; 0,1) cada día con su LCG (semilla 12345), 300 réplicas.
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const N = 300;
    for (let i = 1; i <= N; i++) escribir(raiz, `ruido-${i}`, rango(60).map(d => diaSano60(d, 0.3 + 0.2 * (rnd() - 0.5))), true);
    const cumplen = (inf: Informe) => inf.replicas.filter(r => r.criterios?.diversidad.estado === 'cumple').length;
    const v2 = evaluarConjunto(raiz), v1 = evaluarConjunto(raiz, { diversidadRegla: 'o' });
    assert.ok(cumplen(v2) <= 0.07 * N, `v2: ${cumplen(v2)}/${N}`);
    assert.equal(cumplen(v2), 7);
    assert.ok(cumplen(v1) >= 0.5 * N, `v1 «o»: ${cumplen(v1)}/${N}`);
    assert.equal(cumplen(v1), 180);
    assert.equal(brazo(v2, 'ruido').veredicto, 'no mayoría');
    assert.equal(brazo(v1, 'ruido').veredicto, 'mayoría', 'la v1 declaraba «mayoría» con ruido puro');
    assert.match(v1.avisos[0]!, /^C8 decidido con la regla v1 «o», NO la preregistrada/);
    assert.ok(!v2.avisos.some(a => a.startsWith('C8 decidido')));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: coherencia — contadores enteros ≥ 0, acumulados que no decrecen, C7 día a día, índice en [0, 1]', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-v2-'));
  try {
    escribir(raiz, 'ok-1', rango(20).map(diaSano), true);
    // Contadores no enteros o negativos en cualquier día: ilegible (el fichero está roto).
    escribir(raiz, 'frac-2', rango(20).map(d => d === 7 ? { ...diaSano(d), poblacion: 20.5 } : diaSano(d)), true);
    escribir(raiz, 'causa-3', rango(20).map(d => d === 12 ? { ...diaSano(d), muertesPorCausa: { starvation: -1, dehydration: 0, exposure: 0, senescence: 12 } } : diaSano(d)), true);
    escribir(raiz, 'coop-4', rango(20).map(d => d === 20 ? { ...diaSano(d), cooperacionAcumuladaPorTipo: { teaching: '200', trade: 60, constructionHelp: 40 } } : diaSano(d)), true);
    // Una clave fuera de la lista cerrada con basura no rompe nada: no cuenta.
    escribir(raiz, 'otra-5', rango(20).map(d => ({ ...diaSano(d), cooperacionAcumuladaPorTipo: { teaching: 10 * d, trade: 3 * d, constructionHelp: 2 * d, ayuda: -3 } })), true);
    // C7: un día con más usos ajenos que usos con autor conocido.
    escribir(raiz, 'c7-dia-6', rango(20).map(d => d === 15 ? { ...diaSano(d), usosSinAutorResuelto: 15, usosDeInventorAjeno: 6 } : diaSano(d)), true);
    // C7: sin ningún uso útil en la ventana.
    escribir(raiz, 'c7-cero-7', rango(20).map(d => ({ ...diaSano(d), usosUtiles: 0, usosDeInventorAjeno: 0, usosSinAutorResuelto: 0 })), true);
    // C5 / C2: acumulados que decrecen dentro de la ventana.
    escribir(raiz, 'decrece-8', rango(20).map(d => ({ ...diaSano(d), conflictosAcumulados: d === 20 ? 5 : d, nacimientos: d === 20 ? 10 : 3 * d })), true);
    // C8: índice fuera de [0, 1] un solo día, o no numérico.
    escribir(raiz, 'div-9', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: d === 13 ? 1.2 : 0.2 + 0.01 * d })), true);
    escribir(raiz, 'div-10', rango(20).map(d => ({ ...diaSano(d), diversidadConducta: d === 13 ? '0.33' : 0.2 + 0.01 * d })), true);
    // La serie preferida (activa) con basura TODOS los días: se elige igual (no se cae a la antigua, que aprobaría).
    escribir(raiz, 'div-11', rango(20).map(d => ({ ...diaSano(d), diversidadConductaActiva: 'alta' })), true);
    const inf = evaluarConjunto(raiz, { dia: 20 });
    assert.equal(replica(inf, 'ok-1').todos, 'cumple');
    assert.match(replica(inf, 'frac-2').nota!, /^dia-007\.json: poblacion = 20\.5: contadores/);
    assert.match(replica(inf, 'causa-3').nota!, /^dia-012\.json: muertesPorCausa\.starvation = -1:/);
    assert.match(replica(inf, 'coop-4').nota!, /^dia-020\.json: cooperacionAcumuladaPorTipo\.teaching = "200":/);
    for (const n of ['frac-2', 'causa-3', 'coop-4']) assert.equal(replica(inf, n).estado, 'ilegible');
    const otra = replica(inf, 'otra-5');
    assert.equal(otra.todos, 'cumple');
    assert.deepEqual(otra.criterios!.cooperacion.valores.clavesNoContadas, ['ayuda']);
    const dia = replica(inf, 'c7-dia-6').criterios!.tecnologia;
    assert.equal(dia.estado, 'desconocido');
    assert.match(dia.motivo, /usosDeInventorAjeno > usosUtiles − usosSinAutorResuelto .* los días 15: datos incoherentes/);
    const cero = replica(inf, 'c7-cero-7').criterios!.tecnologia;
    assert.equal(cero.estado, 'falla');
    assert.equal(cero.motivo, 'ningún uso útil en la ventana');
    const decrece = replica(inf, 'decrece-8').criterios!;
    assert.equal(decrece.conflictos.estado, 'desconocido');
    assert.match(decrece.conflictos.motivo, /conflictosAcumulados decrece \(10 el día 10 → 5 el día 20\)/);
    assert.equal(decrece.recambio.estado, 'desconocido');
    assert.match(decrece.recambio.motivo, /nacimientos acumulados decrecen \(30 el día 10 → 10 el día 20\)/);
    const div9 = replica(inf, 'div-9').criterios!.diversidad, div10 = replica(inf, 'div-10').criterios!.diversidad;
    assert.equal(div9.estado, 'desconocido');
    assert.match(div9.motivo, /fuera de \[0, 1\] o no numérico \(día 13 = 1\.2\)/);
    assert.equal(div10.estado, 'desconocido');
    assert.match(div10.motivo, /\(día 13 = "0\.33"\)/);
    const div11 = replica(inf, 'div-11').criterios!.diversidad;
    assert.equal(div11.estado, 'desconocido', div11.motivo);
    assert.equal(div11.valores.campo, 'diversidadConductaActiva');
    assert.match(div11.motivo, /^diversidadConductaActiva: índice de diversidad fuera de \[0, 1\] o no numérico \(día 5 = "alta".* · secundaria diversidadConducta \(no decide\): cumple/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: C8 v2 con huecos en el medio — esconder los días bajos no aprueba (cota pesimista de S)', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-criterio-v2-'));
  try {
    // Ruido estacionario (mulberry32, semilla 1) que falla completo; sin sus 11 días más bajos de 30..50
    // (45/56 = 80 % de cobertura; bloques 5..14 y 51..60 completos) Mann-Kendall saldría p = 0,0099.
    const rnd = mulberry32(1), serie = Array.from({ length: 61 }, () => 0.3 + 0.2 * (rnd() - 0.5));
    const ocultos = rango(21).map(i => 29 + i).sort((a, b) => serie[a]! - serie[b]!).slice(0, 11).sort((a, b) => a - b);
    escribir(raiz, 'completa-1', rango(60).map(d => diaSano60(d, serie[d])), true);
    escribir(raiz, 'oculta-2', rango(60).map(d => ({ ...diaSano60(d, serie[d]), diversidadConductaActiva: ocultos.includes(d) ? null : serie[d] })), true);
    const inf = evaluarConjunto(raiz);
    const completa = replica(inf, 'completa-1').criterios!.diversidad, oculta = replica(inf, 'oculta-2').criterios!.diversidad;
    assert.equal(completa.estado, 'falla', completa.motivo);
    assert.equal(oculta.valores.cobertura, 45 / 56);
    assert.ok((oculta.valores.p as number) < 0.05, 'con los días que quedan, el test sale significativo');
    assert.ok((oculta.valores.subida as number) >= 0.02);
    assert.ok((oculta.valores.pPesimista as number) >= 0.05);
    assert.equal(oculta.estado, 'desconocido', oculta.motivo);
    assert.match(oculta.motivo, /con 11 día\(s\) sin dato \(.*\) en su valor más desfavorable p = [0-9.]+ ≥ 0\.05: no se sostiene/);
    assert.equal(replica(inf, 'oculta-2').todos, 'desconocido');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('criterio de terminado: Mann-Kendall, Sen y la normal con valores de referencia', () => {
  // 1..10 creciente: S = 45, Var(S) = 10·9·25/18 = 125, z = 44/√125.
  const recta = mannKendall(rango(10).map(d => [d, d] as [number, number]), 0, 'ninguna');
  assert.equal(recta.S, 45);
  assert.equal(recta.varS, 125);
  assert.ok(Math.abs(recta.z - 44 / Math.sqrt(125)) < 1e-12);
  // [1, 2, 2, 3]: S = 5; un empate de 2 ⇒ Var(S) = (4·3·13 − 2·1·9)/18 = 138/18; z = 4/√(138/18).
  const empates = mannKendall([[1, 1], [2, 2], [3, 2], [4, 3]], 0, 'ninguna');
  assert.equal(empates.S, 5);
  assert.ok(Math.abs(empates.varS - 138 / 18) < 1e-12);
  assert.ok(Math.abs(empates.z - 4 / Math.sqrt(138 / 18)) < 1e-12);
  // Sen: pendientes {1, 0,5, 2/3, 0, 0,5, 1} ⇒ mediana (0,5 + 2/3)/2.
  assert.ok(Math.abs(pendienteSen([[1, 1], [2, 2], [3, 2], [4, 3]])! - (0.5 + 2 / 3) / 2) < 1e-12);
  // Normal: P(Z ≥ 1,6448536) = 0,05; P(Z ≥ 0) = 0,5; P(Z ≥ 3) = 1,3499e-3.
  assert.ok(Math.abs(colaNormalSuperior(1.6448536269514722) - 0.05) < 1e-7);
  assert.ok(Math.abs(colaNormalSuperior(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(colaNormalSuperior(3) - 1.3498980316301e-3) < 1e-8);
  // Empates por tolerancia: 0,3 y 0,3 + 1e-12 son la misma clase (S = 0); los factores nunca bajan de 1.
  const casi = mannKendall(rango(12).map(d => [d, d % 2 ? 0.3 : 0.3 + 1e-12] as [number, number]), 1e-9);
  assert.deepEqual([casi.S, casi.clases, casi.varS], [0, 1, 0]);
  const rnd = mulberry32(7), ar: [number, number][] = [];
  for (let d = 5, e = 0; d <= 60; d++) { e = 0.7 * e + 0.2 * (rnd() - 0.5); ar.push([d, 0.3 + e]); }
  const mk = mannKendall(ar, 1e-9);
  assert.ok(mk.factor >= Math.max(mk.factorHamedRao, mk.factorAr1) - 1e-12 && mk.factorHamedRao >= 1 && mk.factorAr1 >= 1);
  assert.ok(mk.r1 > 0.3, `r₁* de un AR(1) φ = 0,7: ${mk.r1}`);
  // n < 10 días con dato ⇒ desconocido (la normal no vale).
  const u = { ...UMBRALES_POR_DEFECTO, causasConocidas: [...UMBRALES_POR_DEFECTO.causasConocidas] };
  assert.equal(evaluarSerieDiversidad(d => 0.1 * d, 13, u).estado, 'desconocido');
  assert.match(evaluarSerieDiversidad(d => 0.01 * d, 13, u).motivo, /^9 días con dato \(< 10\)/);
  assert.equal(evaluarSerieDiversidad(d => 0.01 * d, 14, u).estado, 'cumple');
});

test('criterio de terminado: banderas del preregistro v2 de C8', () => {
  assert.deepEqual(parsearArgumentos(['--entrada', 'x', '--subida-min', '0.05', '--correccion-mk', 'hamed-rao', '--diversidad-regla', 'mk', '--usos-con-autor-min', '30']).umbrales,
    { subidaMin: 0.05, correccionMk: 'hamed-rao', diversidadRegla: 'mk', usosConAutorMin: 30 });
  assert.throws(() => parsearArgumentos(['--entrada', 'x', '--correccion-mk', 'hamed']), /--correccion-mk: hamed-rao-ar1, hamed-rao o ninguna/);
  assert.throws(() => parsearArgumentos(['--entrada', 'x', '--diversidad-regla', 'x']), /«mk» \(preregistro v2\), «o» o «y» \(v1\)/);
  assert.equal(UMBRALES_POR_DEFECTO.diversidadRegla, 'mk');
  assert.equal(UMBRALES_POR_DEFECTO.subidaMin, 0.02);
  assert.equal(UMBRALES_POR_DEFECTO.correccionMk, 'hamed-rao-ar1');
});

test('criterio de terminado: calibración de C8 (1000 series por caso, semilla fija) dentro de las cotas del preregistro v2', () => {
  const c = calibrar({ series: 1000 });
  const fila = (caso: string, D: number) => c.filas.find(f => f.caso === caso && f.D === D)!;
  for (const D of [60, 30]) {
    assert.ok(fila('estacionaria', D).cumple.v2 <= 0.07, `estacionaria D=${D}: ${fila('estacionaria', D).cumple.v2}`);
    for (const caso of ['ar1', 'ar1-var']) {
      assert.ok(fila(caso, D).cumple.v2 <= 0.10, `${caso} D=${D}: ${fila(caso, D).cumple.v2}`);
      // Por qué la corrección AR(1): sin corrección, y solo con Hamed-Rao, el AR(1) pasaba del 10 %.
      assert.ok(fila(caso, D).cumple.v2SinCorreccion > 0.10 && fila(caso, D).cumple.v2HamedRao > 0.10);
    }
    assert.ok(fila('baja-0.001', D).cumple.v2 <= 0.02);
    // Por qué v2: la regla v1 «o» aprobaba ruido estacionario en más de la mitad de las series.
    assert.ok(fila('estacionaria', D).cumple.v1o >= 0.5);
    for (const f of c.filas.filter(x => x.D === D)) assert.equal(f.desconocidos, 0, `${f.caso}: series completas, n ≥ 10`);
  }
  // Potencia para 0,003/día: 100 % a D = 60; ~51 % a D = 30 (25 días de tramo con ruido ±0,1).
  assert.ok(fila('sube-0.003', 60).cumple.v2 >= 0.99);
  assert.ok(fila('sube-0.003', 30).cumple.v2 >= 0.4);
  assert.ok(fila('sube-0.001', 60).cumple.v2 >= 0.5);
  // Tabla exacta del README (determinista: mulberry32, semilla 20260922).
  assert.deepEqual(Object.fromEntries(c.filas.map(f => [`${f.caso}/${f.D}`, f.cumple.v2])), {
    'estacionaria/60': 0.040, 'ar1/60': 0.072, 'ar1-var/60': 0.069, 'sube-0.001/60': 0.586, 'sube-0.003/60': 1, 'baja-0.001/60': 0, 'paseo/60': 0.197, 'satura/60': 0.990,
    'estacionaria/30': 0.032, 'ar1/30': 0.074, 'ar1-var/30': 0.073, 'sube-0.001/30': 0.107, 'sube-0.003/30': 0.509, 'baja-0.001/30': 0.012, 'paseo/30': 0.209, 'satura/30': 0.956,
  });
  // Determinista: la misma semilla da la misma tabla.
  assert.deepEqual(calibrar({ series: 40 }), calibrar({ series: 40 }));
});
