/**
 * Resumen público de la técnica sobre lotes (`v23.tecnica`). Viaja en `PersonView.tecnicaVista`.
 * Ausente = este fotograma no la grabó. `recetas` vacía = la persona tiene técnica y no recuerda ninguna.
 * Los pasos ausentes de una receta citada = el registro no los tenía en ese tick; no se inventan.
 */
import type { PasoTecnico, TecnicaPersona } from './technology.js';

export interface PasoVisible { op: PasoTecnico['op']; texto: string }
export interface RecetaVisible {
  id: number;
  generacion: number;
  /** Paso en que se usó, aprendió o enseñó por última vez. */
  usada: number;
  padres: number[];
  /** Definida solo si el registro del mismo tick devolvió la receta. */
  pasos?: PasoVisible[];
}
export interface ProcesoVisible {
  tipo: 'research' | 'craft';
  receta: number;
  /** Índice del paso en curso. */
  paso: number;
  total: number;
  desde: number;
  pasos: PasoVisible[];
}
export interface TecnicaVisible {
  recetas: RecetaVisible[];
  /** Recordadas y no listadas (el resumen cabe las más recientes). */
  omitidas: number;
  proceso: ProcesoVisible | null;
  intentos: number;
}

const MAX_RECETAS = 8;
const n = (value: number, digits = 1): string => value.toLocaleString('es-CO', { maximumFractionDigits: digits });

function medida(value: number, unidad: string, digits = 1): string {
  return Number.isFinite(value) ? `${n(value, digits)} ${unidad}` : 'medida no grabada';
}

/** Texto de un paso tal como está guardado. Un cero numérico se dice; un campo ausente no se rellena. */
export function textoPaso(paso: PasoTecnico): string {
  if (paso.op === 'romper') {
    const f = paso.forma;
    const rasgos = [
      Number.isFinite(f.filo) && f.filo > 0 ? `filo ${n(f.filo * 100, 0)} %` : '',
      Number.isFinite(f.hueco) && f.hueco > 0 ? `hueco ${n(f.hueco * 100, 0)} %` : '',
      Number.isFinite(f.largo) && f.largo > 0 ? `largo ${medida(f.largo, 'm', 3)}` : '',
      Number.isFinite(f.ancho) && f.ancho > 0 ? `ancho ${medida(f.ancho, 'm', 3)}` : '',
      Number.isFinite(f.grueso) && f.grueso > 0 ? `grueso ${medida(f.grueso, 'm', 3)}` : '',
    ].filter(Boolean);
    return rasgos.length ? `Romper con ${rasgos.join(', ')}` : 'Romper (la forma registrada no trae medidas)';
  }
  if (paso.op === 'unir') {
    const masa = Number.isFinite(paso.masa) ? medida(paso.masa, 'kg', 3) : 'masa no grabada';
    const insumo = Number.isFinite(paso.insumo) ? `insumo nº ${paso.insumo}` : 'insumo no grabado';
    return `Unir ${masa} del ${insumo}`;
  }
  const hasta = paso.hasta ?? {};
  const partes: string[] = [];
  if (Number.isFinite(hasta.T)) partes.push(`hasta ${medida(hasta.T!, 'K')}`);
  if (Number.isFinite(hasta.ticks)) partes.push(hasta.ticks === 0 ? 'durante 0 ticks' : `durante ${n(hasta.ticks!, 0)} ticks`);
  const verbo = paso.op === 'calentar' ? 'Calentar' : 'Mojar';
  return partes.length ? `${verbo} ${partes.join(', ')}` : `${verbo} (el límite no vino grabado)`;
}

/** Huella de lo que cambia el resumen. No incluye el reloj del fotograma: el uso y el inicio ya están. */
export function claveTecnica(t: TecnicaPersona): string {
  const recetas = t.recetas.map(r => `${r.id}:${r.usada}:${r.generacion}:${r.padres.join('.')}`).sort().join(',');
  const p = t.proceso;
  if (!p) return `${t.intentos}|${recetas}|`;
  const pasos = p.proceso.pasos.map(paso => paso.op === 'romper'
    ? `r${paso.forma.largo},${paso.forma.ancho},${paso.forma.grueso},${paso.forma.hueco},${paso.forma.filo}`
    : paso.op === 'unir' ? `u${paso.insumo},${paso.forma},${paso.masa}`
      : `${paso.op}:${paso.hasta.T ?? ''},${paso.hasta.ticks ?? ''}`).join(';');
  return `${t.intentos}|${recetas}|${p.tipo}:${p.receta}:${p.proceso.i}:${p.proceso.desde}:${pasos}`;
}

const cacheTecnica = new WeakMap<TecnicaPersona, { clave: string; vista: TecnicaVisible }>();

/**
 * `leer` solo corre si la huella cambió. Las recetas del registro son inmutables por id:
 * repetir el mismo estado no vuelve a leerlas ni a rehacer los textos.
 * El tick del fotograma no entra en la vista: lo pone la cinta. `usada` y `desde` sí.
 */
export function tecnicaVisible(t: TecnicaPersona, leer?: (id: number) => readonly PasoTecnico[] | null): TecnicaVisible {
  const clave = claveTecnica(t);
  const previa = cacheTecnica.get(t);
  if (previa?.clave === clave) return previa.vista;
  const vista = resumenTecnica(t, leer);
  cacheTecnica.set(t, { clave, vista });
  return vista;
}

/**
 * `leer` resuelve el id en el registro. `null` = citada y no estaba.
 * Sin `leer`, las recetas viajan citadas y sin pasos.
 */
export function resumenTecnica(t: TecnicaPersona, leer?: (id: number) => readonly PasoTecnico[] | null): TecnicaVisible {
  const orden = [...t.recetas].sort((a, b) => b.usada - a.usada || a.id - b.id);
  const visibles = orden.slice(0, MAX_RECETAS);
  const proceso = t.proceso;
  return {
    recetas: visibles.map(r => {
      const leida = leer?.(r.id);
      return {
        id: r.id, generacion: r.generacion, usada: r.usada, padres: [...r.padres],
        ...(leida ? { pasos: leida.map(p => ({ op: p.op, texto: textoPaso(p) })) } : {}),
      };
    }),
    omitidas: Math.max(0, orden.length - visibles.length),
    proceso: proceso ? {
      tipo: proceso.tipo, receta: proceso.receta, paso: proceso.proceso.i, total: proceso.proceso.pasos.length,
      desde: proceso.proceso.desde, pasos: proceso.proceso.pasos.map(p => ({ op: p.op, texto: textoPaso(p) })),
    } : null,
    intentos: t.intentos,
  };
}
