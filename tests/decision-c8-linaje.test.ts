import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluarDecision } from '../scripts/lab/decision-c8-linaje.mjs';

const semillas = Array.from({ length: 12 }, (_, i) => 2001 + i);
const dias = Array.from({ length: 60 }, (_, i) => i + 1);
const ruta = (raiz: string, brazo: string, s: number, d: number) => join(raiz, `${brazo}-${s}`, `dia-${String(d).padStart(3, '0')}.json`);
const leer = (raiz: string, brazo: string, s: number, d: number): Record<string, unknown> => JSON.parse(readFileSync(ruta(raiz, brazo, s, d), 'utf8')) as Record<string, unknown>;
const poner = (raiz: string, brazo: string, s: number, d: number, valor: Record<string, unknown>) => writeFileSync(ruta(raiz, brazo, s, d), JSON.stringify(valor));
function diaSano(d: number, pendiente: number): Record<string, unknown> {
  const nacimientos = 3 * d, senescence = Math.min(14, d), starvation = Math.floor(d / 5);
  const poblacion = 16 + nacimientos - senescence - starvation;
  return {
    tick: d * 2400, poblacion, vecinosMortales: poblacion - 2, nacimientos,
    muertesPorCausa: { starvation, dehydration: 0, exposure: 0, senescence },
    fundadoresVivos: 2 + 14 - senescence, fundadoresMortalesVivos: 14 - senescence,
    generacionesVivas: 4, generacionesMortalesVivas: d < 14 ? [0, 1, 2] : [1, 2, 3],
    usosUtiles: 20, usosDeInventorAjeno: 6, usosSinAutorResuelto: 0,
    cooperacionAcumuladaPorTipo: { teaching: 10 * d, trade: 3 * d, constructionHelp: 2 * d },
    otrasCooperacionesAcumuladas: d, conflictosAcumulados: d,
    diversidadConductaVentana: 0.2 + pendiente * d,
    diversidadConductaVentanaGen1: 0.2 + pendiente * d,
    diversidadConductaActiva: 0.2 + 0.005 * d,
    diversidadPerfilesJS: 0.2 + pendiente * d,
    muertesMenores8Dias: 0, vocacionVarianza: 0.01 * d, vocacionCoincidencia: 0.4,
    approachHogar: 0.2, maderaMediaAdultos: 4, piedraMediaAdultos: 3,
    cambiosHogar: 2, linajesHerfindahl: 0.15,
  };
}
function escribir(raiz: string, brazo: string, s: number, pendiente: number): void {
  mkdirSync(join(raiz, `${brazo}-${s}`));
  for (const d of dias) poner(raiz, brazo, s, d, diaSano(d, pendiente));
  writeFileSync(join(raiz, `${brazo}-${s}`, 'replica.json'), JSON.stringify({ seed: s, dias: 60 }));
}
function brazo(inf: ReturnType<typeof evaluarDecision>, nombre: string) { return inf.brazos.find(b => b.brazo === nombre)!; }

test('decisión preregistrada: conjunción, precedencia, umbrales, contraste, identidad y fuera de muestra', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-c8-decision-'));
  try {
    for (const [i, s] of semillas.entries()) {
      escribir(raiz, 'CTRL2', s, 0);
      escribir(raiz, 'CTRL', s, 0);
      escribir(raiz, 'VOC', s, i < 7 ? 0.005 : i < 11 ? 0.0001 : 0);
      escribir(raiz, 'HOG', s, i < 7 ? 0.005 : i < 10 ? 0.0001 : 0);
      escribir(raiz, 'VOCHOG', s, i < 4 ? 0.005 : 0);
    }
    for (const s of [2013, 2014, 2015, 2016]) {
      escribir(raiz, 'CTRL2', s, 0);
      escribir(raiz, 'VOC', s, 0.005);
    }
    let inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'VOC').decision, 'EXITO_PANEL');
    assert.equal(brazo(inf, 'HOG').decision, 'EXITO_PANEL');
    assert.equal(inf.confirmacion?.brazo, 'VOC', 'empate: VOC precede a HOG');
    assert.equal(inf.confirmacion?.adopcion, true);
    assert.equal(brazo(inf, 'VOC').contraste?.positivos, 11);
    assert.equal(brazo(inf, 'VOC').contraste?.mejoraAtribuible, true);
    assert.equal(brazo(inf, 'HOG').contraste?.positivos, 10);
    assert.equal(brazo(inf, 'HOG').contraste?.mejoraAtribuible, false);
    assert.equal(brazo(inf, 'VOCHOG').decision, 'NO_EXITO');
    assert.equal(brazo(inf, 'VOCHOG').refutado, true, '4/12');
    assert.equal(inf.identidadCtrlCtrl2.diferencias.length, 0);

    // Si VOC deja de aprobar y HOG empata con VOCHOG, se elige HOG.
    for (const d of dias) {
      poner(raiz, 'VOC', 2001, d, diaSano(d, 0));
      for (const s of semillas.slice(4, 7)) poner(raiz, 'VOCHOG', s, d, diaSano(d, 0.005));
    }
    inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'HOG').exitos, 7);
    assert.equal(brazo(inf, 'VOCHOG').exitos, 7);
    assert.equal(inf.confirmacion?.brazo, 'HOG');
    for (const d of dias) {
      poner(raiz, 'VOC', 2001, d, diaSano(d, 0.005));
      for (const s of semillas.slice(4, 7)) poner(raiz, 'VOCHOG', s, d, diaSano(d, 0));
    }

    // C8 aprueba en siete, pero C1 y C6 fallan justo en esas siete: la intersección es cero.
    const originales = semillas.slice(0, 7).map(s => leer(raiz, 'VOC', s, 60));
    semillas.slice(0, 7).forEach(s => poner(raiz, 'VOC', s, 60, { ...leer(raiz, 'VOC', s, 60), poblacion: 15, vecinosMortales: 13 }));
    inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'VOC').semillas.filter(x => x.criterios?.diversidad.estado === 'cumple').length, 7);
    assert.equal(brazo(inf, 'VOC').decision, 'NO_EXITO');
    assert.equal(brazo(inf, 'VOC').exitos, 0);
    semillas.slice(0, 7).forEach((s, i) => poner(raiz, 'VOC', s, 60, originales[i]!));

    // Cinco éxitos quedan en NO_EXITO sin la etiqueta refutado.
    for (const s of semillas.slice(5, 7)) for (const d of dias) {
      const x = leer(raiz, 'VOC', s, d);
      poner(raiz, 'VOC', s, d, { ...x, diversidadConductaVentana: 0.2, diversidadConductaVentanaGen1: 0.2 });
    }
    inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'VOC').exitos, 5);
    assert.equal(brazo(inf, 'VOC').decision, 'NO_EXITO');
    assert.equal(brazo(inf, 'VOC').refutado, false);
    for (const s of semillas.slice(5, 7)) for (const d of dias) poner(raiz, 'VOC', s, d, diaSano(d, 0.005));

    // Cuatro inseguras prevalecen incluso cuando hay siete éxitos de semilla.
    const seguridadOriginal = semillas.slice(0, 4).map(s => leer(raiz, 'VOC', s, 60));
    semillas.slice(0, 4).forEach(s => poner(raiz, 'VOC', s, 60, { ...leer(raiz, 'VOC', s, 60), muertesMenores8Dias: 100 }));
    inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'VOC').exitos, 7);
    assert.equal(brazo(inf, 'VOC').seguras, 8);
    assert.equal(brazo(inf, 'VOC').decision, 'INSEGURO');
    semillas.slice(0, 4).forEach((s, i) => poner(raiz, 'VOC', s, 60, seguridadOriginal[i]!));

    // Un día 60 ausente sin extinción ocupa el primer nivel de precedencia.
    renameSync(ruta(raiz, 'VOC', 2001, 60), ruta(raiz, 'VOC', 2001, 60) + '.guardado');
    inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'VOC').decision, 'DATOS_INCOMPLETOS');
    renameSync(ruta(raiz, 'VOC', 2001, 60) + '.guardado', ruta(raiz, 'VOC', 2001, 60));

    // La serie antigua presente no rescata una ventana oficial ausente.
    const original = leer(raiz, 'VOC', 2001, 30);
    const { diversidadConductaVentana: _ventana, ...sinVentana } = original;
    poner(raiz, 'VOC', 2001, 30, sinVentana);
    inf = evaluarDecision(raiz, 60);
    assert.equal(brazo(inf, 'VOC').decision, 'DATOS_INCOMPLETOS');
    assert.equal(brazo(inf, 'VOC').semillas[0]?.exito, false);
    poner(raiz, 'VOC', 2001, 30, original);

    // La identidad compara claves compartidas salvo rendimiento e instrumentos nuevos.
    poner(raiz, 'CTRL', 2001, 1, { ...leer(raiz, 'CTRL', 2001, 1), nacimientos: 999, p50Ms: 123 });
    inf = evaluarDecision(raiz, 60);
    assert.ok(inf.identidadCtrlCtrl2.diferencias.some(x => x.includes('2001/dia-001.json: nacimientos')));
    assert.ok(!inf.identidadCtrlCtrl2.diferencias.some(x => x.includes('p50Ms')));
    const corte20 = evaluarDecision(raiz, 20);
    assert.equal(brazo(corte20, 'VOC').decision, 'CONTINUAR');
    assert.equal(brazo(corte20, 'VOC').seguras, 12);
    const seguridad20 = semillas.slice(0, 4).map(s => leer(raiz, 'VOC', s, 20));
    semillas.slice(0, 4).forEach(s => poner(raiz, 'VOC', s, 20, { ...leer(raiz, 'VOC', s, 20), muertesMenores8Dias: 100 }));
    assert.equal(brazo(evaluarDecision(raiz, 20), 'VOC').decision, 'DETENER');
    semillas.slice(0, 4).forEach((s, i) => poner(raiz, 'VOC', s, 20, seguridad20[i]!));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});
