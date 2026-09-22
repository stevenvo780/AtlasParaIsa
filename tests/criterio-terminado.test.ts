import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluarConjunto, parsearArgumentos, type Informe } from '../scripts/lab/criterio-terminado.mjs';

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
    const json = JSON.parse(readFileSync(salida, 'utf8')) as Informe;
    assert.equal(json.dia, 20);
    assert.equal(json.umbrales.usoAjenoMin, 0.15);
    assert.deepEqual(json.brazos.map(b => [b.brazo, b.veredicto]), [['A', 'indeterminado'], ['B', 'mayoría'], ['C', 'no mayoría']]);
    const sinEntrada = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/criterio-terminado.mts'], { encoding: 'utf8' });
    assert.equal(sinEntrada.status, 1);
    assert.match(sinEntrada.stderr, /Falta --entrada/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});
