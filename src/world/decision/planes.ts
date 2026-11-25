/**
 * Planes de percepción de las personas (ARQ-motor §3.4): lo que `choose` mira de su ventana r = 7 expresado como
 * `Consulta` y cerebro del contrato, para que lo ejecute cualquier hilo o la GPU. Los umbrales son los de siempre y
 * viven aquí una sola vez: los usan los planes y la validación exacta del dueño.
 *
 * Las personas no llevan `ConsultaOrganismo`: el dueño necesita de todos modos la lista viva de quien tiene cerca
 * (`nearbyPeople`, para la pareja, el hambriento, los recolectores observados y la observación del cerebro), y elegir
 * sobre ella con el hambre de ahora es lo que hace después `share`. Una consulta percibida al empezar la fase daría
 * otro ranking y solo costaría trabajo.
 */
import { CEREBRO, type Consulta, type Plan } from '../motor/contratos.js';

/** Umbrales de las búsquedas de `choose`, en sus unidades de siempre: los leen los planes y la validación exacta con que
 * el dueño acepta o rehace una celda percibida. */
export const UMBRAL = {
  comida: 0.025,        // alimento visible para comer: > 0,025
  agua: 0.005,          // agua potable: > 0,005
  material: 1,          // madera o piedra para recolectar: ≥ 1
  humedadCultivo: 0.25, vegetacionCultivo: 0.8,   // cultivo: humedad > 0,25 y vegetación < 0,8
  humedadObra: 0.2, vegetacionObra: 0.15,          // obra: humedad > 0,2 y vegetación > 0,15
  hambreAjena: 0.27,    // alguien con hambre a quien compartir: > 0,27, a ≤ 2 celdas
  radioCompartir: 2,
} as const;

/** Campos del terreno que leen los planes, por nombre (`Terreno.campos`). */
export const CAMPOS_PERCEPCION = ['terreno', 'comida', 'aguaPotable', 'madera', 'piedra', 'humedad', 'vegetacion'] as const;

/** Códigos de `terreno`: posición + 1 (0 = sin tesela), los mismos que el SoA residente. */
export const TERRENOS = ['water', 'soil', 'meadow', 'shelter'] as const;
/** Tierra: todo terreno salvo el agua; tierra sin techo: suelo y pradera. */
const TIERRA = [TERRENOS.indexOf('soil') + 1, TERRENOS.indexOf('shelter') + 1] as const;
const TIERRA_DESCUBIERTA = [TERRENOS.indexOf('soil') + 1, TERRENOS.indexOf('meadow') + 1] as const;

/** Índices de las consultas de celda dentro del plan de personas. */
export const CONSULTA = { comida: 0, agua: 1, madera: 2, piedra: 3, maderaYPiedra: 4, cultivo: 5, obra: 6 } as const;
/** `planes[PLAN.x].id === PLAN.x`: con cerebro (política activa y sin urgencia) o sin él. */
export const PLAN = { conCerebro: 0, sinCerebro: 1 } as const;

const F32 = new Float32Array(1), I32 = new Int32Array(F32.buffer);
/** Mayor float32 que no supera a `x`. */
export function f32Abajo(x: number): number {
  F32[0] = x;
  if (F32[0]! <= x) return F32[0]!;
  I32[0] = F32[0]! > 0 ? I32[0]! - 1 : F32[0]! < 0 ? I32[0]! + 1 : -0x7fffffff;   // de 0 (redondeado desde arriba) al menor negativo
  return F32[0]!;
}
/** Menor float32 que no queda por debajo de `x`. */
export function f32Arriba(x: number): number { return -f32Abajo(-x); }

/** Planes de personas contra los nombres de `Terreno.campos` de quien percibe.
 * Los filtros del contrato son inclusivos y en f32, y las leyes son desigualdades en f64 (muchas estrictas): cada
 * cota se redondea hacia fuera, así que el filtro deja pasar todo lo que la ley admite y, como mucho, la franja de
 * menos de un ulp f32 que la separa de la ley. El dueño valida la celda ganadora con la ley exacta y, si cae en esa
 * franja, la busca otra vez: ninguna celda válida se pierde. */
export function planesPersonas(campos: readonly string[]): Plan[] {
  const campo = (nombre: typeof CAMPOS_PERCEPCION[number]): number => {
    const i = campos.indexOf(nombre);
    if (i < 0) throw new Error(`El terreno no tiene el campo «${nombre}»`);
    return i;
  };
  const terreno = campo('terreno');
  const consulta = (alcanzable: boolean, filtros: number[], pesos: [number, number][] = []): Consulta => ({
    campos: Int32Array.from(pesos, ([c]) => c), pesos: Float32Array.from(pesos, ([, w]) => w),
    pesoDist: 1, pesoPasos: 0, filtros: Float32Array.from(filtros), alcanzable,
  });
  const celdas: Consulta[] = [];
  celdas[CONSULTA.comida] = consulta(true, [campo('comida'), f32Abajo(UMBRAL.comida), Infinity], [[campo('comida'), -2]]);
  celdas[CONSULTA.agua] = consulta(true, [campo('aguaPotable'), f32Abajo(UMBRAL.agua), Infinity]);
  celdas[CONSULTA.madera] = consulta(false, [campo('madera'), UMBRAL.material, Infinity]);
  celdas[CONSULTA.piedra] = consulta(false, [campo('piedra'), UMBRAL.material, Infinity]);
  celdas[CONSULTA.maderaYPiedra] = consulta(false, [campo('madera'), UMBRAL.material, Infinity, campo('piedra'), UMBRAL.material, Infinity]);
  celdas[CONSULTA.cultivo] = consulta(false, [terreno, ...TIERRA_DESCUBIERTA, campo('humedad'), f32Abajo(UMBRAL.humedadCultivo), Infinity,
    campo('vegetacion'), -Infinity, f32Arriba(UMBRAL.vegetacionCultivo)]);
  celdas[CONSULTA.obra] = consulta(false, [terreno, ...TIERRA_DESCUBIERTA, campo('humedad'), f32Abajo(UMBRAL.humedadObra), Infinity,
    campo('vegetacion'), f32Abajo(UMBRAL.vegetacionObra), Infinity]);
  const transitable = Float32Array.of(terreno, ...TIERRA);
  // Sin tabla W: la ventaja comparativa (aptitud · rasgos) depende de la urgencia y del candidato, y sigue en `choose`.
  const plan = (id: number, acciones: number): Plan => ({ id, transitable, celdas, organismos: [], acciones, w: null });
  return [plan(PLAN.conCerebro, CEREBRO.acciones), plan(PLAN.sinCerebro, 0)];
}
