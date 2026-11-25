import { registrar } from '../invariantes.js';
import { REF_NULA, type LotePercepcion, type Percepcion } from '../motor/contratos.js';
import type { World } from '../mundo/tipos.js';

const muestras = new WeakMap<World, { tick: number; actores: number; percepcion: Percepcion }>();

/** B2 entrega la muestra al diagnóstico, que la lee en la barrera de publicación. */
export function observarPercepcionGpu(mundo: World, lote: LotePercepcion, percepcion: Percepcion): void {
  muestras.set(mundo, { tick: lote.tick, actores: lote.slots.length, percepcion });
}

registrar({
  id: 'm3.percepcion', carril: 'M3', gravedad: 'dura', alcance: 'global', cadaTicks: 60,
  comprobar(mundo) {
    const muestra = muestras.get(mundo);
    if (!muestra || muestra.tick !== mundo.tick) return [];
    const { actores, percepcion: p } = muestra;
    const fallo = (detalle: string, indice?: number) => [
      { id: 'm3.percepcion', tick: mundo.tick, gravedad: 'dura' as const, detalle, contexto: { actores, indice } },
    ];
    if (p.celda.length !== actores * p.q || p.pasos.length !== p.celda.length || p.valor.length !== p.celda.length
      || p.organismo.length !== actores * p.v || p.utilidad.length !== actores * p.a)
      return fallo('Lote de percepción desalineado.');
    for (let i = 0; i < p.celda.length; i++) {
      if (p.celda[i] === -1 ? p.pasos[i] !== -1 || p.valor[i] !== Infinity
        : p.celda[i]! < 0 || p.pasos[i]! < -1 || !Number.isFinite(p.valor[i]))
        return fallo('Resultado de celda inválido.', i);
    }
    for (let i = 0; i < p.organismo.length; i++) {
      const ref = p.organismo[i]!;
      if (ref !== REF_NULA && (!Number.isSafeInteger(ref) || ref < 0))
        return fallo('Referencia de percepción inválida.', i);
    }
    for (let i = 0; i < p.utilidad.length; i++)
      if (!Number.isFinite(p.utilidad[i])) return fallo('Utilidad de percepción no finita.', i);
    return [];
  },
});
