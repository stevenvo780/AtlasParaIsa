import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Dia = { tick: number; poblacion: number; nacimientos?: number; muertes: Record<string, number>; fundadoresVivos: number;
  generacionesVivas?: number; diversidadOficios: number; recetasDistintasEnUso?: number; cooperaciones?: number;
  gini: number | null; fraccionComida: number | null; distanciaAgua: number | null; p50Ms?: number; p95Ms: number; rss?: number };
type Replica = { seed: number; params: Record<string, unknown>; sha: string; digest: string; dias: Dia[] };

function escribirReplica(directorio: string, replica: Replica): void {
  mkdirSync(directorio, { recursive: true });
  writeFileSync(join(directorio, 'replica.json'), JSON.stringify({ seed: replica.seed, params: replica.params,
    sha: replica.sha, digest: replica.digest, dias: replica.dias.length, resumen: null }));
  replica.dias.forEach((dia, indice) => writeFileSync(join(directorio, `dia-${String(indice).padStart(3, '0')}.json`), JSON.stringify(dia)));
}

function correr(entrada: string, extra: string[] = []): { status: number | null; salida: unknown } {
  const resultado = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/resumen.ts', '--entrada', entrada, ...extra], { encoding: 'utf8' });
  assert.equal(resultado.error, undefined, resultado.stderr);
  let salida: unknown = null;
  try { salida = JSON.parse(resultado.stdout.trim().split('\n').at(-1) ?? '{}'); } catch { salida = null; }
  return { status: resultado.status, salida };
}

const cerca = (actual: number, esperado: number, tolerancia = 1e-9) => assert.ok(Math.abs(actual - esperado) < tolerancia, `${actual} != ${esperado}`);

function directorioTemporal(): string {
  const directorio = mkdtempSync(join(tmpdir(), 'atlas-lab-resumen-'));
  return directorio;
}

test('agrega mediana/p10/p90 por grupo de parámetros, detecta control automático ({}) y compara delta+semáforo SC-002..005', () => {
  const raiz = directorioTemporal();
  try {
    escribirReplica(join(raiz, 'control'), {
      seed: 1, params: {}, sha: 'sha-control', digest: 'digest-control',
      dias: [
        { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.5, gini: 0.30, fraccionComida: 0.40, distanciaAgua: 5, p95Ms: 40 },
        { tick: 2400, poblacion: 16, muertes: { starvation: 0 }, fundadoresVivos: 16, diversidadOficios: 0.55, gini: 0.32, fraccionComida: 0.42, distanciaAgua: 5, p95Ms: 42 },
        { tick: 4800, poblacion: 15, muertes: { starvation: 1 }, fundadoresVivos: 15, diversidadOficios: 0.60, gini: 0.35, fraccionComida: 0.45, distanciaAgua: 5.5, p95Ms: 45 },
      ],
    });
    escribirReplica(join(raiz, 'grupo-foo', 'x'), {
      seed: 2, params: { foo: 1 }, sha: 'sha-x', digest: 'digest-x',
      dias: [
        { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.30, gini: 0.10, fraccionComida: 0.60, distanciaAgua: 3, p95Ms: 48 },
        { tick: 2400, poblacion: 15, muertes: { starvation: 1 }, fundadoresVivos: 15, diversidadOficios: 0.35, gini: 0.12, fraccionComida: 0.62, distanciaAgua: 3.2, p95Ms: 50 },
        { tick: 4800, poblacion: 13, muertes: { starvation: 1, dehydration: 1 }, fundadoresVivos: 12, diversidadOficios: 0.40, gini: 0.15, fraccionComida: 0.65, distanciaAgua: 3.5, p95Ms: 55 },
      ],
    });
    escribirReplica(join(raiz, 'grupo-foo', 'y'), {
      seed: 3, params: { foo: 1 }, sha: 'sha-y', digest: 'digest-y',
      dias: [
        { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.45, gini: 0.20, fraccionComida: 0.55, distanciaAgua: 4, p95Ms: 44 },
        { tick: 2400, poblacion: 15, muertes: { starvation: 1 }, fundadoresVivos: 15, diversidadOficios: 0.48, gini: 0.22, fraccionComida: 0.58, distanciaAgua: 4.1, p95Ms: 46 },
        { tick: 4800, poblacion: 14, muertes: { starvation: 1 }, fundadoresVivos: 13, diversidadOficios: 0.50, gini: 0.25, fraccionComida: 0.60, distanciaAgua: 4.3, p95Ms: 49 },
      ],
    });

    const { status, salida } = correr(raiz);
    assert.equal(status, 0);
    const resumen = salida as { grupos: number; replicas: number; abortadas: number; determinismoOk: boolean };
    assert.equal(resumen.grupos, 2); assert.equal(resumen.replicas, 3); assert.equal(resumen.abortadas, 0); assert.equal(resumen.determinismoOk, true);

    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    assert.equal(json.grupos.length, 2);
    const control = json.grupos.find((g: { esControl: boolean }) => g.esControl);
    const grupoFoo = json.grupos.find((g: { esControl: boolean }) => !g.esControl);
    assert.ok(control && grupoFoo, 'debe distinguir el grupo control del grupo con params');

    // Control: supervivencia 15/16, diversidad 0.60, gini 0.35 → los tres cumplen el umbral exacto → verde.
    cerca(control.metricas.supervivenciaFundadores.mediana, 15 / 16);
    cerca(control.metricas.diversidadFinal.mediana, 0.60);
    cerca(control.metricas.giniFinal.mediana, 0.35);
    assert.equal(control.semaforo, '🟢');
    assert.equal(control.comparacionControl, null, 'el propio grupo control no se compara contra sí mismo');

    // grupo-foo: 2 réplicas → mediana = rango más cercano (floor(2*0.5)=índice 1 del orden ascendente).
    cerca(grupoFoo.metricas.supervivenciaFundadores.mediana, 13 / 16); // [12/16, 13/16] ordenado → índice 1
    cerca(grupoFoo.metricas.poblacionFinalSobreInicial.mediana, 14 / 16);
    cerca(grupoFoo.metricas.diversidadFinal.mediana, 0.50);
    cerca(grupoFoo.metricas.giniFinal.mediana, 0.25);
    cerca(grupoFoo.metricas.fraccionComidaFinal.mediana, 0.65);
    cerca(grupoFoo.metricas.distanciaAguaFinal.mediana, 4.3);
    cerca(grupoFoo.metricas.p95Ms.mediana, 50);
    cerca(grupoFoo.metricas.muertesPorCausa.starvation.mediana, 2);
    cerca(grupoFoo.metricas.muertesPorCausa.dehydration.mediana, 1);
    assert.equal(grupoFoo.muertesDesconocidas, 0);
    assert.equal(grupoFoo.colapsoTemprano.detectado, false);

    // Diversidad 0.50 y gini 0.25 caen entre la mitad del umbral y el umbral verde → ámbar; supervivencia 0.8125 ≥ 0.70 → verde.
    // El semáforo del grupo es el peor de los tres → ámbar.
    assert.equal(grupoFoo.semaforo, '🟡');
    assert.ok(grupoFoo.motivos.some((m: string) => m.includes('diversidad')));
    assert.ok(grupoFoo.motivos.some((m: string) => m.includes('gini')));

    cerca(grupoFoo.comparacionControl.supervivenciaFundadores.delta, 13 / 16 - 15 / 16);
    cerca(grupoFoo.comparacionControl.diversidadFinal.delta, 0.50 - 0.60);
    cerca(grupoFoo.comparacionControl.giniFinal.delta, 0.25 - 0.35);
    cerca(grupoFoo.comparacionControl.p95Ms.delta, 50 - 42);

    const markdown = readFileSync(join(raiz, 'resumen.md'), 'utf8');
    assert.ok(markdown.includes('# Resumen del laboratorio'));
    assert.ok(markdown.includes('control'));
    assert.ok(markdown.includes('🟢'));
    assert.ok(markdown.includes('🟡'));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('detecta rotura de determinismo: misma semilla + mismo digest + mismos params con métricas distintas → 🔴', () => {
  const raiz = directorioTemporal();
  try {
    const diasBase = (poblacionFinal: number): Dia[] => [
      { tick: 0, poblacion: 20, muertes: {}, fundadoresVivos: 20, diversidadOficios: 0.5, gini: 0.4, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 30 },
      { tick: 2400, poblacion: poblacionFinal, muertes: { starvation: 20 - poblacionFinal }, fundadoresVivos: poblacionFinal, diversidadOficios: 0.5, gini: 0.4, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 31 },
    ];
    escribirReplica(join(raiz, 'a'), { seed: 99, params: { modo: 'repetido' }, sha: 'sha-a', digest: 'digest-igual', dias: diasBase(18) });
    escribirReplica(join(raiz, 'b'), { seed: 99, params: { modo: 'repetido' }, sha: 'sha-b', digest: 'digest-igual', dias: diasBase(17) });

    const { status, salida } = correr(raiz);
    assert.equal(status, 1, 'una rotura de determinismo debe marcar exitCode 1');
    assert.equal((salida as { determinismoOk: boolean }).determinismoOk, false);

    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    assert.equal(json.determinismo.ok, false);
    assert.equal(json.determinismo.conflictos.length, 1);
    assert.equal(json.determinismo.conflictos[0].seed, 99);
    assert.equal(json.determinismo.conflictos[0].digest, 'digest-igual');
    assert.match(json.determinismo.conflictos[0].primeraDiferencia, /poblacion/i);
    assert.equal(json.grupos.length, 1);
    assert.equal(json.grupos[0].semaforo, '🔴');
    assert.ok(json.grupos[0].motivos.some((m: string) => m.includes('determinismo')));

    const markdown = readFileSync(join(raiz, 'resumen.md'), 'utf8');
    assert.ok(markdown.includes('rotura de determinismo'));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('un mismo seed+digest con params DISTINTOS no cuenta como rotura de determinismo (el barrido los varía a propósito)', () => {
  const raiz = directorioTemporal();
  try {
    const dias: Dia[] = [
      { tick: 0, poblacion: 10, muertes: {}, fundadoresVivos: 10, diversidadOficios: 0.5, gini: 0.4, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 20 },
      { tick: 2400, poblacion: 9, muertes: { starvation: 1 }, fundadoresVivos: 9, diversidadOficios: 0.5, gini: 0.4, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 21 },
    ];
    escribirReplica(join(raiz, 'a'), { seed: 7, params: { recursos: 0.4 }, sha: 'sha-a', digest: 'digest-mismo', dias });
    escribirReplica(join(raiz, 'b'), { seed: 7, params: { recursos: 0.7 }, sha: 'sha-b', digest: 'digest-mismo', dias: dias.map(d => ({ ...d, poblacion: d.poblacion + 1, fundadoresVivos: d.fundadoresVivos + 1 })) });

    const { salida } = correr(raiz);
    assert.equal((salida as { determinismoOk: boolean }).determinismoOk, true);
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    assert.equal(json.determinismo.conflictos.length, 0);
    assert.equal(json.grupos.length, 2);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('colapso > 50 % en los 2 primeros días y muertes con causa desconocida fuerzan semáforo 🔴 (SC-002/SC-005)', () => {
  const raiz = directorioTemporal();
  try {
    escribirReplica(join(raiz, 'riesgo'), {
      seed: 5, params: { riesgo: true }, sha: 'sha-r', digest: 'digest-r',
      dias: [
        { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.7, gini: 0.5, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 20 },
        { tick: 2400, poblacion: 6, muertes: { mysterious: 10 }, fundadoresVivos: 6, diversidadOficios: 0.7, gini: 0.5, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 21 },
        { tick: 4800, poblacion: 5, muertes: { starvation: 1 }, fundadoresVivos: 4, diversidadOficios: 0.7, gini: 0.5, fraccionComida: 0.5, distanciaAgua: 4, p95Ms: 22 },
      ],
    });

    const { status } = correr(raiz);
    assert.equal(status, 1);
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    const grupo = json.grupos[0];
    assert.equal(grupo.semaforo, '🔴');
    assert.equal(grupo.colapsoTemprano.detectado, true);
    assert.equal(grupo.muertesDesconocidas, 10);
    assert.ok(grupo.motivos.some((m: string) => m.includes('desconocida')));
    assert.ok(grupo.motivos.some((m: string) => m.includes('colapso')));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('réplicas marcadas abortada se excluyen de las métricas pero se cuentan', () => {
  const raiz = directorioTemporal();
  try {
    escribirReplica(join(raiz, 'viva'), {
      seed: 11, params: { x: 1 }, sha: 'sha-v', digest: 'digest-v',
      dias: [{ tick: 0, poblacion: 10, muertes: {}, fundadoresVivos: 10, diversidadOficios: 0.6, gini: 0.4, fraccionComida: 0.5, distanciaAgua: 3, p95Ms: 10 },
        { tick: 2400, poblacion: 9, muertes: { starvation: 1 }, fundadoresVivos: 9, diversidadOficios: 0.6, gini: 0.4, fraccionComida: 0.5, distanciaAgua: 3, p95Ms: 11 }],
    });
    mkdirSync(join(raiz, 'abortada'), { recursive: true });
    writeFileSync(join(raiz, 'abortada', 'replica.json'), JSON.stringify({ seed: 12, params: { x: 1 }, sha: 'sha-ab', digest: 'digest-ab', dias: 0, abortada: true }));

    const { salida } = correr(raiz);
    const resumen = salida as { replicas: number; abortadas: number };
    assert.equal(resumen.replicas, 2); assert.equal(resumen.abortadas, 1);
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    assert.equal(json.grupos.length, 1);
    assert.equal(json.grupos[0].replicas, 1);
    assert.equal(json.grupos[0].abortadas, 1);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--entrada faltante y directorio inexistente fallan con error claro (sin crash silencioso)', () => {
  const resultadoSinEntrada = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/resumen.ts'], { encoding: 'utf8' });
  assert.notEqual(resultadoSinEntrada.status, 0);
  const resultadoInexistente = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/lab/resumen.ts', '--entrada', '/no/existe/atlas-lab'], { encoding: 'utf8' });
  assert.notEqual(resultadoInexistente.status, 0);
});

// --- Ronda de arreglo (revisión T018) --------------------------------------------------------

test('un grupo con TODAS sus réplicas abortadas no puede salir 🟢: semáforo 🔴, motivo explícito, exit 1', () => {
  const raiz = directorioTemporal();
  try {
    // Exactamente el caso reproducido por el revisor: 2 réplicas del mismo grupo, ambas abortadas
    // (agotaron el --timeout de T017) → 0 réplicas válidas para evaluar SC-002..005.
    mkdirSync(join(raiz, 'g1', 'a'), { recursive: true });
    writeFileSync(join(raiz, 'g1', 'a', 'replica.json'), JSON.stringify({ seed: 1, params: { riesgoSenescenciaDiario: 0.04 }, sha: 'sha-a', digest: 'digest-a', dias: 0, abortada: true }));
    mkdirSync(join(raiz, 'g1', 'b'), { recursive: true });
    writeFileSync(join(raiz, 'g1', 'b', 'replica.json'), JSON.stringify({ seed: 2, params: { riesgoSenescenciaDiario: 0.04 }, sha: 'sha-b', digest: 'digest-b', dias: 0, abortada: true }));

    const { status, salida } = correr(raiz);
    assert.equal(status, 1, 'un grupo sin réplicas válidas debe fallar con exit ≠ 0, nunca 0');
    const resumen = salida as { replicas: number; abortadas: number; semaforos: Record<string, string> };
    assert.equal(resumen.replicas, 2, 'total de réplicas descubiertas (incluye abortadas)');
    assert.equal(resumen.abortadas, 2);
    assert.ok(Object.values(resumen.semaforos).every(s => s === '🔴'), 'ningún grupo sin datos puede quedar en verde');

    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    assert.equal(json.grupos.length, 1);
    assert.equal(json.grupos[0].semaforo, '🔴');
    assert.equal(json.grupos[0].replicas, 0);
    assert.ok(json.grupos[0].motivos.some((m: string) => m.includes('sin réplicas válidas')));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('rotura de determinismo detecta diferencias en fundadoresVivos/nacimientos/generacionesVivas/recetas/cooperaciones (no solo los 5 campos originales)', () => {
  const raiz = directorioTemporal();
  try {
    // Misma semilla, mismo digest, misma serie de población y de muertes (los 5 campos que el
    // detector original SÍ comparaba) pero fundadoresVivos/nacimientos/recetas/cooperaciones
    // distintos: eso es una rotura de determinismo real (mueren/nacen habitantes distintos).
    const base = (extra: Partial<Dia>): Dia => ({ tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.5,
      gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 40, nacimientos: 0, generacionesVivas: 1, recetasDistintasEnUso: 3, cooperaciones: 10, ...extra });
    // `nacimientos` se deja IGUAL en ambas réplicas a propósito: así la primera diferencia real de
    // la iteración por claves es `fundadoresVivos` (justo la métrica de SC-002), y de paso queda
    // cubierto que generacionesVivas/recetasDistintasEnUso/cooperaciones también entran a comparar.
    escribirReplica(join(raiz, 'a'), { seed: 42, params: {}, sha: 'sha-a', digest: 'digest-igual', dias: [
      base({ fundadoresVivos: 14, generacionesVivas: 1, recetasDistintasEnUso: 3, cooperaciones: 10 }),
    ] });
    escribirReplica(join(raiz, 'b'), { seed: 42, params: {}, sha: 'sha-b', digest: 'digest-igual', dias: [
      base({ fundadoresVivos: 9, generacionesVivas: 2, recetasDistintasEnUso: 7, cooperaciones: 99 }),
    ] });

    const { status, salida } = correr(raiz);
    assert.equal((salida as { determinismoOk: boolean }).determinismoOk, false, 'fundadoresVivos/nacimientos/recetas/cooperaciones distintos con mismo seed+digest debe ser una rotura');
    assert.equal(status, 1);
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    assert.equal(json.determinismo.conflictos.length, 1);
    assert.match(json.determinismo.conflictos[0].primeraDiferencia, /fundadoresVivos/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--control NO se fusiona con un grupo de --entrada que comparta params: cada uno mantiene su propia mediana y hay delta', () => {
  const raiz = directorioTemporal();
  try {
    const controlDir = join(raiz, 'control-viejo');
    const entradaDir = join(raiz, 'barrido-nuevo');
    // Control: reglas viejas, digest distinto, supervivencia 8/16.
    escribirReplica(join(controlDir, 'r1'), { seed: 1, params: {}, sha: 'sha-c', digest: 'digest-viejo', dias: [
      { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.5, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 40 },
      { tick: 2400, poblacion: 8, muertes: { starvation: 8 }, fundadoresVivos: 8, diversidadOficios: 0.5, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 40 },
    ] });
    // Entrada: MISMOS params ({}) pero reglas nuevas, digest distinto, supervivencia 16/16.
    escribirReplica(join(entradaDir, 'r1'), { seed: 2, params: {}, sha: 'sha-e', digest: 'digest-nuevo', dias: [
      { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.5, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 40 },
      { tick: 2400, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.5, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 40 },
    ] });

    const { status, salida } = correr(entradaDir, ['--control', controlDir]);
    const resumen = salida as { grupos: number; replicas: number };
    assert.equal(resumen.grupos, 2, 'control y entrada con los mismos params deben quedar en grupos SEPARADOS');
    assert.equal(resumen.replicas, 2, 'sin duplicar réplicas');
    assert.equal(status, 0);

    const json = JSON.parse(readFileSync(join(entradaDir, 'resumen.json'), 'utf8'));
    assert.equal(json.grupos.length, 2);
    const control = json.grupos.find((g: { esControl: boolean }) => g.esControl);
    const grupoEntrada = json.grupos.find((g: { esControl: boolean }) => !g.esControl);
    assert.ok(control && grupoEntrada, 'debe distinguir el grupo control del grupo de entrada aunque compartan params');
    cerca(control.metricas.supervivenciaFundadores.mediana, 8 / 16);
    cerca(grupoEntrada.metricas.supervivenciaFundadores.mediana, 1);
    assert.ok(grupoEntrada.comparacionControl, 'debe haber comparación con el control (no se anula por compartir params)');
    cerca(grupoEntrada.comparacionControl.supervivenciaFundadores.delta, 1 - 8 / 16);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--control dentro de --entrada no se cuenta ni pesa dos veces (sin doble descubrimiento)', () => {
  const raiz = directorioTemporal();
  try {
    const controlDir = join(raiz, 'control');
    escribirReplica(join(controlDir, 'r1'), { seed: 1, params: {}, sha: 'sha-c', digest: 'digest-c', dias: [
      { tick: 0, poblacion: 10, muertes: {}, fundadoresVivos: 10, diversidadOficios: 0.5, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 10 },
    ] });
    escribirReplica(join(raiz, 'grupo', 'r2'), { seed: 2, params: { x: 1 }, sha: 'sha-x', digest: 'digest-x', dias: [
      { tick: 0, poblacion: 10, muertes: {}, fundadoresVivos: 10, diversidadOficios: 0.5, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 10 },
    ] });

    const { salida } = correr(raiz, ['--control', controlDir]);
    const resumen = salida as { replicas: number; grupos: number };
    assert.equal(resumen.replicas, 2, 'la réplica de --control (dentro de --entrada) no debe contarse dos veces');
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    const control = json.grupos.find((g: { esControl: boolean }) => g.esControl);
    assert.equal(control.replicas, 1, 'el grupo control no debe pesar el doble');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('SC-003 se mide al día 5 (no en el último día del barrido) y el día usado queda escrito en el resumen', () => {
  const raiz = directorioTemporal();
  try {
    // 10 días (0..9): diversidad sube linealmente. Al día 5 = 0.50 (no cumple, < 0.60); en el
    // último día (9) = 0.90 (cumpliría). El semáforo debe evaluar el día 5, no el último.
    const dias: Dia[] = Array.from({ length: 10 }, (_, i) => ({
      tick: i * 2400, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: i * 0.1,
      gini: 0.5, fraccionComida: 0.5, distanciaAgua: 5, p95Ms: 20,
    }));
    escribirReplica(join(raiz, 'largo'), { seed: 1, params: { dias: 10 }, sha: 'sha-l', digest: 'digest-l', dias });

    const { salida } = correr(raiz);
    assert.equal((salida as { determinismoOk: boolean }).determinismoOk, true);
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    const grupo = json.grupos[0];
    assert.equal(grupo.diaDiversidadUsado, 5, 'debe usar el día 5, no el último (9)');
    cerca(grupo.metricas.diversidadFinal.mediana, 0.5, 1e-9);
    assert.equal(grupo.semaforo, '🟡', 'diversidad 0.5 (mitad de 0.60 ≤ 0.5 < 0.60) → ámbar, NO el verde que daría el último día (0.90)');
    assert.ok(grupo.motivos.some((m: string) => m.includes('día 5')));

    const markdown = readFileSync(join(raiz, 'resumen.md'), 'utf8');
    assert.match(markdown, /\(día 5\)/, 'resumen.md debe indicar qué día se usó para la diversidad');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('SC-003 con réplicas más cortas que 6 días cae al último día disponible (comportamiento previo preservado)', () => {
  const raiz = directorioTemporal();
  try {
    const dias: Dia[] = [
      { tick: 0, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.3, gini: 0.3, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 20 },
      { tick: 2400, poblacion: 16, muertes: {}, fundadoresVivos: 16, diversidadOficios: 0.65, gini: 0.4, fraccionComida: 0.4, distanciaAgua: 5, p95Ms: 20 },
    ];
    escribirReplica(join(raiz, 'corto'), { seed: 1, params: {}, sha: 'sha-c', digest: 'digest-c', dias });
    correr(raiz);
    const json = JSON.parse(readFileSync(join(raiz, 'resumen.json'), 'utf8'));
    const grupo = json.grupos[0];
    assert.equal(grupo.diaDiversidadUsado, 1, 'con solo 2 días (índices 0,1) debe caer al último disponible');
    cerca(grupo.metricas.diversidadFinal.mediana, 0.65);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});
