import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluarPanel } from '../scripts/lab/panel-corto/evaluar.mjs';

const semillas = [51926, 19104, 19101, 19103];
const panel = semillas.flatMap(semilla => [1, 2, 3].map(replica => ({ semilla, replica, ruta: `${semilla}-${replica}` })));
const perfil = { hilos: 29, gpu: [], cada: 240 };
const causasIniciales = { starvation: 2, dehydration: 0, exposure: 0, senescence: 0 };
const rutaCli = fileURLToPath(new URL('../scripts/lab/panel-corto/evaluar.mts', import.meta.url));

function datosCorrida(semilla: number, objetivoDias: number, ticksObjetivo: number, poblacionDia: (d: number) => number = d => d >= 21 ? 19 : 18) {
  const inicio = { tipo: 'inicio', semilla, tick: 0, dia: 0, ticksPorDia: 2400, comprobar: true, ...perfil, puertaCorta: {
    cohorteFundadoraHomogenea: true, poblacionInicial: 18, nacimientosIniciales: 2, muertesIniciales: 2, muertesPorCausaIniciales: causasIniciales,
  } };
  let poblacionAnterior = 18, nacimientos = 2, muertes = 2, fundadoresMortalesVivos = 18;
  const muertesPorCausa = { ...causasIniciales };
  const diaria = Array.from({ length: objetivoDias }, (_, i) => {
    const dia = i + 1, poblacion = poblacionDia(dia);
    const muertosHoy = Math.max(Number(fundadoresMortalesVivos > 0), poblacionAnterior - poblacion);
    nacimientos += poblacion - poblacionAnterior + muertosHoy;
    muertes += muertosHoy;
    muertesPorCausa[dia % 2 ? 'starvation' : 'dehydration'] += muertosHoy;
    fundadoresMortalesVivos = Math.max(0, fundadoresMortalesVivos - muertosHoy);
    poblacionAnterior = poblacion;
    return { tipo: 'dia', dia, tick: Math.min(dia * 2400, ticksObjetivo), poblacion, nacimientos, muertes, muertesPorCausa: { ...muertesPorCausa },
      fundadoresMortalesVivos, conservacion: { ok: true } as { ok: boolean } | null };
  });
  const fin = { tipo: 'fin', estado: 'completo', duras: 0, violaciones: 0, tick: ticksObjetivo, puertaCorta: {
    pasosMedidos: ticksObjetivo, pasoMaximoMs: 30_000, pasosSobre30s: 0, rssPicoKiB: 70_000, comprobacionesRegiones: 100_000,
  } };
  return { inicio, diaria, fin, violaciones: [] as { tipo: string; gravedad: string }[], codigo: 0 };
}

function expediente(t: TestContext, modo: 'panel' | 'smoke' = 'panel') {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-panel-corto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifiesto = { commit: 'd5b6faa', modo, perfil, ramFisicaBytes: 100_000 * 1024, objetivoDias: modo === 'panel' ? 30 : 1,
    ticksObjetivo: modo === 'panel' ? 72_000 : 24, replicas: modo === 'panel' ? panel : panel.slice(0, 1) };
  const grabarManifiesto = () => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifiesto));
  const datos = (i: number, poblacionDia?: (d: number) => number) => datosCorrida(manifiesto.replicas[i].semilla, manifiesto.objetivoDias, manifiesto.ticksObjetivo, poblacionDia);
  const grabar = (i: number, corrida = datos(i)) => {
    const ruta = join(dir, manifiesto.replicas[i].ruta);
    mkdirSync(ruta, { recursive: true });
    writeFileSync(join(ruta, 'corrida.jsonl'), [corrida.inicio, ...corrida.diaria, ...corrida.violaciones, corrida.fin].map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(join(ruta, 'codigo.exit'), `${corrida.codigo}\n`);
  };
  grabarManifiesto();
  manifiesto.replicas.forEach((_, i) => grabar(i));
  return { dir, manifiesto, grabarManifiesto, datos, grabar };
}

test('el panel completo admite los límites inclusivos exactos de M5 y M6', t => {
  const { dir, datos, grabar } = expediente(t);
  const ensayo = datos(0);
  ensayo.violaciones.push({ tipo: 'violacion', gravedad: 'blanda' });
  ensayo.fin.violaciones = 1;
  ensayo.fin.puertaCorta.comprobacionesRegiones = 1;
  const otra = datos(1);
  otra.fin.puertaCorta.comprobacionesRegiones = 1;
  const tercera = datos(2);
  tercera.fin.puertaCorta.comprobacionesRegiones = 99_998;
  grabar(0, ensayo);
  grabar(1, otra);
  grabar(2, tercera);
  const informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'cumple');
  assert.equal(informe.aprobado, true);
  assert.equal(informe.codigoSalida, 0);
  assert.equal(informe.replicas.length, 12);
  assert.equal(informe.metricas?.M5.tasaBlandas, 1e-6);
  assert.equal(informe.replicas[0].M5.tasaBlandas, 1);
  assert.equal(informe.replicas[0].M6.rssPorcentaje, 70);
  assert.equal(informe.replicas[0].M3.C2.nacimientosD21aD30, 1);
  assert.equal(informe.replicas[0].M3.C6.causasDistintas, 2);
});

test('exige IDs exactos, un cierre por réplica y todos los días en secuencia', t => {
  const { dir, manifiesto, grabarManifiesto, datos, grabar } = expediente(t);
  const ensayo = datos(0);
  ensayo.diaria.splice(10, 1);
  grabar(0, ensayo);
  let informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'desconocido');
  assert.match(informe.errores.join('\n'), /Cobertura diaria 29\/30/);
  assert.equal(informe.replicas[0].M3.C6.estado, 'desconocido');
  assert.equal(informe.codigoSalida, 1);
  grabar(0);
  rmSync(join(dir, panel[1].ruta, 'codigo.exit'));
  grabar(2, { ...datos(2), fin: { ...datos(2).fin, estado: 'extinta' } });
  informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'desconocido');
  assert.match(informe.errores.join('\n'), /codigo.exit ausente/);
  assert.match(informe.errores.join('\n'), /Cierre ausente, interrumpido/);
  manifiesto.replicas = [...manifiesto.replicas.slice(0, 11), { semilla: 919, replica: 3, ruta: '919-3' }];
  grabarManifiesto();
  informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'desconocido');
  assert.match(informe.errores.join('\n'), /doce IDs/);
});

test('M1 informa la extinción de una cohorte homogénea y recupera el umbral con otra cohorte', t => {
  const { dir, datos, grabar } = expediente(t);
  const ensayo = datos(0, d => d >= 25 ? 0 : d >= 21 ? 19 : 18);
  grabar(0, ensayo);
  let informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'cumple');
  assert.equal(informe.metricas?.M1.estado, 'falla');
  assert.equal(informe.metricas?.M1.estadoExigible, 'cumple');
  assert.equal(informe.replicas[0].M1.diaExtincion, 25);
  assert.equal(informe.metricas?.M2.cumplen, 11);
  assert.equal(informe.metricas?.M4.cumplen, 11);
  ensayo.inicio.puertaCorta.cohorteFundadoraHomogenea = false;
  grabar(0, ensayo);
  informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'falla');
  assert.equal(informe.metricas?.M1.estadoExigible, 'falla');
});

test('M2 combina mínimo diario y cierre por réplica; M4 solicita revisión con dos fuera de intervalo', t => {
  const { dir, datos, grabar } = expediente(t);
  for (const i of [0, 1, 2]) grabar(i, datos(i, d => d === 20 ? 7 : d >= 21 ? 19 : 18));
  for (const i of [3, 4]) grabar(i, datos(i, d => d === 15 ? 100 : d >= 21 ? 19 : 18));
  const informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'falla');
  assert.deepEqual(informe.metricas?.M2, { estado: 'falla', cumplen: 9, desconocidos: 0, minimo: 10 });
  assert.equal(informe.metricas?.M4.cumplen, 10);
  assert.equal(informe.metricas?.M4.requiereRevisionHumana, true);
});

test('M3 comprueba C2 y C6 en cada réplica, con la ventana tardía y el balance diario', t => {
  const { dir, datos, grabar } = expediente(t);
  grabar(0, datos(0, () => 18));
  const ensayo = datos(1);
  ensayo.diaria[3].poblacion++;
  grabar(1, ensayo);
  const causaAjena = datos(2);
  for (const d of causaAjena.diaria) {
    Object.assign(d.muertesPorCausa, { causaAjena: d.muertesPorCausa.dehydration });
    d.muertesPorCausa.dehydration = 0;
  }
  grabar(2, causaAjena);
  const informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'falla');
  assert.equal(informe.metricas?.M3.estado, 'falla');
  assert.equal(informe.replicas[0].M3.C2.estado, 'falla');
  assert.equal(informe.replicas[1].M3.C6.estado, 'falla');
  assert.deepEqual(informe.replicas[1].M3.C6.residuos.map(r => r.dia), [4, 5]);
  assert.deepEqual(informe.replicas[2].M3.C6.causasDesconocidas, ['causaAjena']);
});

test('M5 conserva los indicios materiales y M6 rechaza sobrepasos en una sola réplica', t => {
  const { dir, datos, grabar } = expediente(t);
  const sinMateria = datos(0);
  sinMateria.diaria[3].conservacion = null;
  grabar(0, sinMateria);
  let informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'desconocido');
  assert.equal(informe.metricas?.M5.estado, 'desconocido');
  sinMateria.diaria[3].conservacion = { ok: false };
  grabar(0, sinMateria);
  const lenta = datos(1);
  lenta.fin.puertaCorta.pasoMaximoMs = 30_001;
  lenta.fin.puertaCorta.pasosSobre30s = 1;
  grabar(1, lenta);
  const grande = datos(2);
  grande.fin.puertaCorta.rssPicoKiB = 70_001;
  grabar(2, grande);
  informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'falla');
  assert.equal(informe.metricas?.M5.estado, 'falla');
  assert.deepEqual(informe.replicas[0].M5.fallosMateriales, [4]);
  assert.equal(informe.metricas?.M6.estado, 'falla');
  assert.equal(informe.replicas[1].M6.estado, 'falla');
  assert.equal(informe.replicas[2].M6.estado, 'falla');
});

test('M5 rechaza una violación dura medida y detecta si el cierre contradice la bitácora', t => {
  const { dir, datos, grabar } = expediente(t);
  const ensayo = datos(0);
  ensayo.violaciones.push({ tipo: 'violacion', gravedad: 'dura' });
  ensayo.fin.estado = 'violacion';
  ensayo.fin.violaciones = 1;
  ensayo.fin.duras = 1;
  ensayo.codigo = 2;
  grabar(0, ensayo);
  let informe = evaluarPanel(dir);
  assert.equal(informe.instrumentacion, 'completa');
  assert.equal(informe.metricas?.M5.estado, 'falla');
  assert.equal(informe.veredicto, 'falla');
  ensayo.violaciones.pop();
  grabar(0, ensayo);
  informe = evaluarPanel(dir);
  assert.equal(informe.veredicto, 'desconocido');
  assert.match(informe.errores.join('\n'), /distintos de la bitácora/);
});

test('el smoke parcial verifica instrumentación con estado no_aplica y salida distinta de cero si queda incompleto', t => {
  const { dir, datos, grabar } = expediente(t, 'smoke');
  const correr = () => spawnSync(process.execPath, ['--import', 'tsx', rutaCli, dir], { encoding: 'utf8' });
  let resultado = correr();
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.equal(JSON.parse(resultado.stdout).veredicto, 'no_aplica');
  assert.equal(JSON.parse(resultado.stdout).aprobado, false);
  const ensayo = datos(0);
  ensayo.fin.puertaCorta.pasosMedidos--;
  grabar(0, ensayo);
  resultado = correr();
  assert.equal(resultado.status, 1, resultado.stderr);
  assert.equal(JSON.parse(resultado.stdout).instrumentacion, 'incompleta');
  assert.equal(JSON.parse(resultado.stdout).aprobado, false);
});
