import { paramsOf } from './params.js';
import { DESGASTE_Q, type AnclaDesgaste, type StructureComponent } from '../shared/life.js';

/**
 * DESG-D: desgaste dormido por exposición (crítica adversarial del ciclo material,
 * `datos-lab/critica-ciclo-material-20261001.md`, regla de la sección final).
 * Parámetro `material.desgasteDormido ∈ {0,1}`, histórico 0. Con 0 este módulo no se
 * llama desde ningún camino caliente: ningún campo, contador ni llamada nueva.
 *
 * Física (κ = 1000 fijo, primer cribado): q(t) = max(0, q0 − aD·(ΔN−ΔR) − aR·ΔR),
 * donde N/R son revisiones de obra/lluviosas ejecutadas y (q0,n0,r0) el ancla de la
 * obra. La `condition` visible es caché derivada (q/Q): se reescribe en cada revisión
 * activa, en cada reactivación/reparación/construcción, y se PROYECTA (sin escribir)
 * en cámaras y observadores. Enteros Number exactos; ningún BigInt (`digesto.ts` y
 * JSON no lo admiten).
 */

/** Durabilidad estructural: los marcos de más frenan el desgaste. ÚNICA definición
 * (antes vivía dentro de `blueprintAffordances`; misma aritmética). */
export function durabilidadObra(components: readonly StructureComponent[]): number {
  return 1 + (components.filter(c => c === 'frame').length - 1) * 0.5;
}

/** true ⇔ la ley DESG-D rige este mundo. */
export function desgasteActivo(world: object): boolean {
  return (paramsOf(world).material?.desgasteDormido ?? 0) === 1;
}

/** Pérdida por revisión seca (aD) y lluviosa (aR) para una durabilidad. */
function tasasDesgaste(durabilidad: number): { aD: number; aR: number } {
  return durabilidad >= 1.5 ? { aD: 360_000, aR: 560_000 } : { aD: 540_000, aR: 840_000 };
}

/** q entera al horizonte (N, R) desde el ancla. Pura: mismo ancla + mismo horizonte
 * ⇒ mismo q, por activo paso a paso o dormido de un salto. */
export function desgasteQ(q0: number, n0: number, r0: number, N: number, R: number, durabilidad: number): number {
  const { aD, aR } = tasasDesgaste(durabilidad);
  const dR = R - r0, dD = (N - n0) - dR;
  return Math.max(0, q0 - aD * dD - aR * dR);
}

/** Condición proyectada q/Q, o null sin ancla (ley apagada / vista efímera). */
export function condicionProyectada(components: readonly StructureComponent[], ancla: AnclaDesgaste | null | undefined, N: number, R: number): number | null {
  if (!ancla) return null;
  return desgasteQ(ancla.q0, ancla.n0, ancla.r0, N, R, durabilidadObra(components)) / DESGASTE_Q;
}

/** Reescribe la caché `condition` desde el ancla. Sin ancla (incoherente con ley=1;
 * `assertWorld` lo rechaza en la frontera), ancla la condición actual para no
 * inventar desgaste ni curación. */
export function ponerAlDiaDesgaste(N: number, R: number, structure: { condition: number; components: readonly StructureComponent[]; anclaDesgaste?: AnclaDesgaste }): void {
  const proyectada = condicionProyectada(structure.components, structure.anclaDesgaste, N, R);
  if (proyectada !== null) { structure.condition = proyectada; return; }
  structure.anclaDesgaste = { q0: Math.round(structure.condition * DESGASTE_Q), n0: N, r0: R };
}
