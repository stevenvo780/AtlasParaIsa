import { test } from 'node:test';

export class AzarPropiedades {
  constructor(private estado: number) { this.estado >>>= 0; }
  siguiente(): number { this.estado = (Math.imul(this.estado, 1664525) + 1013904223) >>> 0; return this.estado / 2 ** 32; }
  entero(minimo: number, maximo: number): number { return minimo + Math.floor(this.siguiente() * (maximo - minimo + 1)); }
  elegir<T>(valores: readonly T[]): T { return valores[this.entero(0, valores.length - 1)]!; }
}

/** La semilla del caso queda en el error para repetir exactamente la entrada fallida. */
export function propiedad<T>(nombre: string, opciones: { casos: number; semilla: number; repeticiones?: number },
  generar: (azar: AzarPropiedades, semilla: number) => T,
  comprobar: (entrada: T, semilla: number) => void | Promise<void>) {
  return test(nombre, async () => {
    const repeticiones = opciones.repeticiones ?? 3;
    if (!Number.isSafeInteger(opciones.casos) || opciones.casos < 1 || !Number.isSafeInteger(repeticiones) || repeticiones < 1) throw new RangeError('Casos y repeticiones deben ser enteros positivos.');
    const azar = new AzarPropiedades(opciones.semilla);
    for (let caso = 0; caso < opciones.casos; caso++) {
      const semilla = azar.entero(0, 0xffffffff);
      for (let repeticion = 0; repeticion < repeticiones; repeticion++) {
        try { await comprobar(generar(new AzarPropiedades(semilla), semilla), semilla); }
        catch (causa) { throw new Error(`${nombre}: semilla=${semilla}, caso=${caso}, repeticion=${repeticion}`, { cause: causa }); }
      }
    }
  });
}
