import type { Instantanea } from './contratos.js';
import { tomarFaunaVerificada, type TramoFaunaVerificada } from './fauna-corte.js';
import { tomarPersonasVerificadas, type PersonasCorteVerificadas } from './personas-corte.js';
import { tomarTeselasVerificadas, type TeselasCorteVerificadas } from './teselas-corte.js';

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
  teselas: TeselasCorteVerificadas | undefined;
  personas: PersonasCorteVerificadas | undefined;
} {
  const capturar = pendientes.get(sello);
  if (!capturar) throw new Error('Corte de guardado inválido o ya consumido.');
  pendientes.delete(sello);
  const instantanea = capturar();
  return { instantanea, fauna: tomarFaunaVerificada(instantanea.world.animals),
    teselas: tomarTeselasVerificadas(instantanea.world.tiles),
    personas: tomarPersonasVerificadas(instantanea.world.people) };
}
