import { CAMPOS_CUERPO, CUERPO_ANCHO, GENOMA_ANCHO, type FrenteEscritura } from '../motor/contratos.js';
import type { VistaCuerpo } from '../materia/tipos.js';

/** Columna que la ley de la fauna registra (`leyFauna.columnas`): lo que los demás leen de un animal para cazarlo,
 * ordeñarlo o evitarlo, además de las fijas. Sin columna de especie: la fauna V23 no la registra. */
export const COLUMNA_FAUNA = 'fauna';
export const CAMPOS_FAUNA = { miedo: 0, habituacion: 1, huella: 2, velocidad: 3 } as const;
export const FAUNA_ANCHO = 4;

export interface FilaFaunaV23 {
  slot: number; uid: number; x: number; y: number; chunk: number; objetivo: number; accion: number; tick: number;
  fertil: boolean; vista: VistaCuerpo; genoma: readonly number[];
  miedo: number; habituacion: number; huella: number; velocidad: number;
}

/** Escribe en F6 la fila de un animal propio en el frente t+1. Todos deciden en cada tick: `decideEn` = tick + 1.
 * `pareja` = 0 si es fértil (consiente con cualquiera compatible), −1 si no. */
export function escribirFilaFaunaV23(w: FrenteEscritura, f: FilaFaunaV23): void {
  const s = f.slot;
  w.fila(s);
  w.f64('uid')[s] = f.uid;
  w.f32('x')[s] = f.x; w.f32('y')[s] = f.y;
  w.i32('chunk')[s] = f.chunk; w.i32('objetivo')[s] = f.objetivo;
  w.u8('accion')[s] = f.accion < 0 ? 0 : f.accion;
  w.f64('decideEn')[s] = f.tick + 1;
  w.f64('pareja')[s] = f.fertil ? 0 : -1;
  const cuerpo = w.f32('cuerpo'), b = s * CUERPO_ANCHO, v = f.vista;
  cuerpo[b + CAMPOS_CUERPO.hambre] = v.hambre; cuerpo[b + CAMPOS_CUERPO.sed] = v.sed;
  cuerpo[b + CAMPOS_CUERPO.energia] = v.energia; cuerpo[b + CAMPOS_CUERPO.salud] = v.salud;
  cuerpo[b + CAMPOS_CUERPO.masa] = v.masa; cuerpo[b + CAMPOS_CUERPO.carga] = v.carga; cuerpo[b + CAMPOS_CUERPO.T] = v.T;
  const genoma = w.f32('genoma'), g = s * GENOMA_ANCHO;
  for (let k = 0; k < GENOMA_ANCHO; k++) genoma[g + k] = f.genoma[k] ?? 0;
  const fauna = w.f32(COLUMNA_FAUNA), q = s * FAUNA_ANCHO;
  fauna[q + CAMPOS_FAUNA.miedo] = f.miedo; fauna[q + CAMPOS_FAUNA.habituacion] = f.habituacion;
  fauna[q + CAMPOS_FAUNA.huella] = f.huella; fauna[q + CAMPOS_FAUNA.velocidad] = f.velocidad;
}
