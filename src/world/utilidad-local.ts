/** Regla 2′: own paid returns and a permutation of existing productive score slots. */
export const OFICIOS = ['gather', 'forage', 'hunt', 'farm', 'build', 'repair', 'research', 'craft'] as const;
export type Oficio = typeof OFICIOS[number];
export type AprendizajeUtilidadLocal = Partial<Record<Oficio, { q: number; intentos: number }>>;
export interface AprendizUtilidadLocal {
  genome: { learningRate: number };
  utilidadLocal?: AprendizajeUtilidadLocal;
}
export interface ConductaUtilidadLocal {
  utilidadLocal?: 0 | 1;
  utilidadLocalGhat?: readonly number[];
}
export function esOficio(accion: string): accion is Oficio {
  return (OFICIOS as readonly string[]).includes(accion);
}

/** No unpaid rejection, old reward, nominal duration or inherited prior is an observation. */
export function registrarRetornoProductivo(persona: AprendizUtilidadLocal, accion: string, beneficio: number,
  trabajoPagado: number, conducta: ConductaUtilidadLocal): void {
  if (conducta.utilidadLocal !== 1 || !esOficio(accion) || trabajoPagado === 0) return;
  if (!Number.isSafeInteger(trabajoPagado) || trabajoPagado < 0 || !Number.isFinite(beneficio) || beneficio < 0)
    throw new RangeError('Retorno productivo inválido.');
  const escala = conducta.utilidadLocalGhat?.[OFICIOS.indexOf(accion)];
  if (escala === undefined || !Number.isFinite(escala) || escala <= 0) throw new RangeError('Escala productiva no congelada.');
  const y = Math.max(0, Math.min(1, beneficio / trabajoPagado / escala));
  const anterior = persona.utilidadLocal?.[accion];
  const q = anterior ? anterior.q + persona.genome.learningRate * (y - anterior.q) : y;
  const intentos = anterior ? Math.min(Number.MAX_SAFE_INTEGER, anterior.intentos + 1) : 1;
  (persona.utilidadLocal ??= {})[accion] = { q, intentos };
}

/** Input is already in the baseline's stable score order; never sort it globally again. */
export function permutarOficiosProductivos<T extends { action: string; score: number }>(candidatos: T[],
  persona: AprendizUtilidadLocal, conducta: ConductaUtilidadLocal, ready: boolean): void {
  if (conducta.utilidadLocal !== 1 || !ready) return;
  const aprendizaje = persona.utilidadLocal;
  if (!aprendizaje) return;
  const ranuras: number[] = [], productivos: { candidato: T; orden: number; q?: number; ajustada: number }[] = [];
  let suma = 0, definidos = 0;
  for (let i = 0; i < candidatos.length; i++) {
    const candidato = candidatos[i]!;
    if (!esOficio(candidato.action)) continue;
    const observado = aprendizaje[candidato.action];
    const q = observado && observado.intentos >= 3 ? observado.q : undefined;
    if (q !== undefined) { suma += q; definidos++; }
    ranuras.push(i); productivos.push({ candidato, orden: i, q, ajustada: candidato.score });
  }
  if (definidos === 0 || productivos.length < 2) return;
  const media = suma / definidos, puntuaciones = productivos.map(p => p.candidato.score);
  for (const p of productivos) if (p.q !== undefined) p.ajustada += 0.3 * (p.q - media);
  productivos.sort((a, b) => b.ajustada - a.ajustada || a.orden - b.orden);
  for (let i = 0; i < productivos.length; i++) {
    const candidato = productivos[i]!.candidato;
    candidato.score = puntuaciones[i]!;
    candidatos[ranuras[i]!] = candidato;
  }
}

/** Optional sparse state survives old snapshots without inventing observations. */
export function aprendizajeUtilidadLocalValido(value: unknown): value is AprendizajeUtilidadLocal | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > OFICIOS.length) return false;
  return entries.every(([accion, observado]) => esOficio(accion) && observado && typeof observado === 'object'
    && !Array.isArray(observado) && Object.keys(observado).length === 2
    && Object.hasOwn(observado, 'q') && Object.hasOwn(observado, 'intentos')
    && typeof observado.q === 'number' && Number.isFinite(observado.q) && observado.q >= 0 && observado.q <= 1
    && Number.isSafeInteger(observado.intentos) && observado.intentos >= 1);
}
