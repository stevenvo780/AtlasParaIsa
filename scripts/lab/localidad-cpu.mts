/** Lee una ventana de reparto desde JSON y devuelve los planes comparados sin arrancar el motor. */
import { readFileSync } from 'node:fs';
import { compararLocalidad, type OpcionesLocalidad } from '../../src/world/motor/localidad.js';

const ayuda = `node --import tsx scripts/lab/localidad-cpu.mts <traza.json|->
La traza contiene hilos y medida con las columnas chunks, px, py, costeMs, dueno, hiloMs.
Opcionalmente incluye opciones con dominioPorHilo, presupuestoPasoMs, pasoObservadoMs y calibracion.
Calibracion contiene pasos, serieMs, haloMsPorExtremo, otroDominioMsPorExtremo y cesionMsPorExtremo.
La medida de cada chunk debe excluir los costes que se añadan en calibracion.`;

const [ruta, sobra] = process.argv.slice(2);
if (!ruta || ruta === '--help') {
  console.log(ayuda);
  process.exitCode = ruta ? 0 : 2;
} else {
  if (sobra !== undefined) throw new Error(ayuda);
  const { hilos, medida, opciones } = JSON.parse(readFileSync(ruta === '-' ? 0 : ruta, 'utf8')) as {
    hilos: number; medida: Record<string, unknown>; opciones?: OpcionesLocalidad;
  };
  const columna = (nombre: string, valido: (n: number) => boolean = Number.isFinite): number[] => {
    const datos = medida?.[nombre];
    if (!Array.isArray(datos) || !datos.every(n => typeof n === 'number' && valido(n))) throw new Error(`Columna inválida: ${nombre}`);
    return datos;
  };
  const int32 = (n: number): boolean => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff;
  const int16 = (n: number): boolean => Number.isInteger(n) && n >= -0x8000 && n <= 0x7fff;
  const resultado = compararLocalidad({
    chunks: Int32Array.from(columna('chunks', int32)), px: Int32Array.from(columna('px', int32)), py: Int32Array.from(columna('py', int32)),
    costeMs: Float64Array.from(columna('costeMs')), dueno: Int16Array.from(columna('dueno', int16)), hiloMs: Float64Array.from(columna('hiloMs')),
  }, hilos, opciones);
  console.log(JSON.stringify(resultado, (_clave, valor: unknown) => valor instanceof Int16Array ? Array.from(valor) : valor, 2));
}
