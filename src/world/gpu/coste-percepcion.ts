import type { Plan } from '../motor/contratos.js';

const MUESTRAS_INICIALES = 2;
const SONDA_CADA = 64;
const MEJORA_MINIMA = 0.05;

interface Medida { muestras: number; coste: number; ultimo: number; pospuestaHasta: number }
interface Perfil { despachos: number; medidas: Map<string, Medida> }

/** Escoge con tiempo de pared del despacho completo. Las rutas más simples ganan cuando la diferencia es pequeña. */
export class CostePercepcion {
  readonly #planes = new WeakMap<readonly Plan[], Map<number, Perfil>>();

  elegir(planes: readonly Plan[], actores: number, rutas: readonly number[][]) {
    let bandas = this.#planes.get(planes);
    if (!bandas) this.#planes.set(planes, bandas = new Map());
    const banda = Math.floor(2 * Math.log2(actores));
    let perfil = bandas.get(banda);
    if (!perfil) bandas.set(banda, perfil = { despachos: 0, medidas: new Map() });
    const despacho = ++perfil.despachos;
    const candidatas = rutas.map(tarjetas => {
      const clave = tarjetas.join(',');
      let medida = perfil.medidas.get(clave);
      if (!medida) perfil.medidas.set(clave, medida = { muestras: 0, coste: 0, ultimo: 0, pospuestaHasta: 0 });
      return { tarjetas, medida };
    });
    const disponibles = candidatas.filter(c => c.medida.pospuestaHasta <= despacho);
    const comparables = disponibles.length ? disponibles : candidatas;
    let elegida = comparables.reduce((a, b) => b.medida.muestras < a.medida.muestras ? b : a);
    if (elegida.medida.muestras >= MUESTRAS_INICIALES) {
      if (despacho % SONDA_CADA === 0) elegida = comparables.reduce((a, b) => b.medida.ultimo < a.medida.ultimo ? b : a);
      else elegida = comparables.reduce((a, b) => b.medida.coste < a.medida.coste * (1 - MEJORA_MINIMA) ? b : a);
    }
    const { tarjetas, medida } = elegida;
    medida.ultimo = despacho;
    return {
      tarjetas,
      observar(ms: number) {
        const coste = Math.max(ms, 0.001) / actores;
        medida.coste = medida.muestras === 0 ? coste : 0.75 * medida.coste + 0.25 * coste;
        medida.muestras++;
      },
      posponer() { medida.pospuestaHasta = despacho + SONDA_CADA; },
    };
  }
}
