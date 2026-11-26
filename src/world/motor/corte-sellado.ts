import type { Instantanea } from './contratos.js';
import { tomarFaunaVerificada, type TramoFaunaVerificada } from './fauna-corte.js';

const marca = Symbol('corte de guardado');
export interface CorteGuardadoSellado { readonly [marca]: true; }

const pendientes = new WeakMap<CorteGuardadoSellado, () => Instantanea>();

/** El motor entrega la captura a Store sin publicar una referencia a su mundo mutable. */
export function crearCorteGuardado(capturar: () => Instantanea): CorteGuardadoSellado {
  const sello: CorteGuardadoSellado = Object.freeze({ [marca]: true as const });
  pendientes.set(sello, capturar);
  return sello;
}

export function consumirCorteGuardado(sello: CorteGuardadoSellado): {
  instantanea: Instantanea;
  fauna: readonly TramoFaunaVerificada[] | undefined;
} {
  const capturar = pendientes.get(sello);
  if (!capturar) throw new Error('Corte de guardado inválido o ya consumido.');
  pendientes.delete(sello);
  const instantanea = capturar();
  return { instantanea, fauna: tomarFaunaVerificada(instantanea.world.animals) };
}
