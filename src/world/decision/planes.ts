/**
 * Planes de percepción de las personas (ARQ-motor §3.4): lo que `choose` mira de su ventana r = 7 expresado como
 * `Consulta`, `ConsultaOrganismo` y cerebro del contrato, para que lo ejecute cualquier hilo o la GPU. Los umbrales
 * son los de siempre y viven aquí una sola vez: los usan los planes y las búsquedas exactas de `choose`.
 */
import { CAMPOS_CUERPO, CEREBRO, Clase, type Consulta, type ConsultaOrganismo, type Plan } from '../motor/contratos.js';

/** Umbrales de las búsquedas de `choose`, en sus unidades de siempre. */
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

/** Índices de las consultas de celda y de organismo dentro del plan de personas. */
export const CONSULTA = { comida: 0, agua: 1, madera: 2, piedra: 3, maderaYPiedra: 4, cultivo: 5, obra: 6 } as const;
export const ORGANISMO = { pareja: 0, hambriento: 1 } as const;
/** `planes[PLAN.x].id === PLAN.x`: con cerebro (política activa y sin urgencia) o sin él. */
export const PLAN = { conCerebro: 0, sinCerebro: 1 } as const;
/** Columna registrada que marca a S e I (rol distinto de vecino). */
export const COLUMNA_PROTEGIDO = 'protegido';

const F32 = new Float32Array(1), I32 = new Int32Array(F32.buffer);
/** Menor float32 estrictamente mayor que `x`: los filtros son inclusivos y en f32, y las leyes dicen «>». */
export function masDe(x: number): number {
  F32[0] = x;
  if (F32[0]! > x) return F32[0]!;
  I32[0] = F32[0]! >= 0 ? I32[0]! + 1 : I32[0]! - 1;
  return F32[0]!;
}
/** Mayor float32 estrictamente menor que `x`. */
export function menosDe(x: number): number { return -masDe(-x); }

/** Planes de personas contra los nombres de `Terreno.campos` y `FrentePublico.columnas` de quien percibe. */
export function planesPersonas(campos: readonly string[], columnas: readonly string[]): Plan[] {
  const campo = (nombre: typeof CAMPOS_PERCEPCION[number]): number => {
    const i = campos.indexOf(nombre);
    if (i < 0) throw new Error(`El terreno no tiene el campo «${nombre}»`);
    return i;
  };
  const columna = (nombre: string): number => {
    const i = columnas.indexOf(nombre);
    if (i < 0) throw new Error(`El frente no tiene la columna «${nombre}»`);
    return i;
  };
  const terreno = campo('terreno');
  const consulta = (alcanzable: boolean, filtros: number[], pesos: [number, number][] = []): Consulta => ({
    campos: Int32Array.from(pesos, ([c]) => c), pesos: Float32Array.from(pesos, ([, w]) => w),
    pesoDist: 1, pesoPasos: 0, filtros: Float32Array.from(filtros), alcanzable,
  });
  const celdas: Consulta[] = [];
  celdas[CONSULTA.comida] = consulta(true, [campo('comida'), masDe(UMBRAL.comida), Infinity], [[campo('comida'), -2]]);
  celdas[CONSULTA.agua] = consulta(true, [campo('aguaPotable'), masDe(UMBRAL.agua), Infinity]);
  celdas[CONSULTA.madera] = consulta(false, [campo('madera'), UMBRAL.material, Infinity]);
  celdas[CONSULTA.piedra] = consulta(false, [campo('piedra'), UMBRAL.material, Infinity]);
  celdas[CONSULTA.maderaYPiedra] = consulta(false, [campo('madera'), UMBRAL.material, Infinity, campo('piedra'), UMBRAL.material, Infinity]);
  celdas[CONSULTA.cultivo] = consulta(false, [terreno, ...TIERRA_DESCUBIERTA, campo('humedad'), masDe(UMBRAL.humedadCultivo), Infinity,
    campo('vegetacion'), -Infinity, menosDe(UMBRAL.vegetacionCultivo)]);
  celdas[CONSULTA.obra] = consulta(false, [terreno, ...TIERRA_DESCUBIERTA, campo('humedad'), masDe(UMBRAL.humedadObra), Infinity,
    campo('vegetacion'), masDe(UMBRAL.vegetacionObra), Infinity]);
  const cuerpo = columna('cuerpo');
  const organismos: ConsultaOrganismo[] = [];
  organismos[ORGANISMO.pareja] = { radio: 7, clase: Clase.Persona, filtros: Float32Array.of(columna(COLUMNA_PROTEGIDO), 0, 1, 1), criterio: 0, columna: 0, componente: 0 };
  organismos[ORGANISMO.hambriento] = { radio: UMBRAL.radioCompartir, clase: Clase.Persona,
    filtros: Float32Array.of(cuerpo, CAMPOS_CUERPO.hambre, masDe(UMBRAL.hambreAjena), Infinity), criterio: 1, columna: cuerpo, componente: CAMPOS_CUERPO.hambre };
  const transitable = Float32Array.of(terreno, ...TIERRA);
  // Sin tabla W: la ventaja comparativa (aptitud · rasgos) depende de la urgencia y del candidato, y sigue en `choose`.
  const plan = (id: number, acciones: number): Plan => ({ id, transitable, celdas, organismos, acciones, w: null });
  return [plan(PLAN.conCerebro, CEREBRO.acciones), plan(PLAN.sinCerebro, 0)];
}
