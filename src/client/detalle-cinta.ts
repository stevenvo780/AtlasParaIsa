/**
 * Pide el L0 exacto de un habitante en un nivel resumido y entrega ese PersonView íntegro.
 * Lo pinta la ficha que ya existe. Aquí solo hay un botón y, si falla o sigue en camino, una nota.
 * La selección solicita el detalle cuando existe cobertura. El botón permite intentarlo de nuevo.
 */
import type { ChunkReq, ChunkResp, Nivel } from '../shared/cinta.js';
import type { PersonView, WorldView } from '../shared/types.js';
import { applyClientTapeDelta, type TapeClientDelta } from '../shared/tape-delta.js';
import { esc } from './ui-catalog.js';

const TOPE_CACHE = 4;
export const ETIQUETA_DETALLE = 'Ver ficha detallada';
export const TEXTO_PAUSA = 'Se pausa la cinta para leer el detalle.';
export const TEXTO_AUSENTE = 'No queda el detalle exacto de este instante.';
export const TEXTO_RED = 'No se pudo leer el detalle.';
export const TEXTO_BUSCANDO = 'Buscando el detalle exacto…';

export interface CoberturaNivel { nivel: Nivel; t0: number; t1: number; fotogramas: number }
/** `completa` = la vista ya trae la telemetría que L1 omite. `cabezal` es el tick ya emitido. */
export interface ContextoDetalle {
  id: string; x: number; y: number; tick: number; cabezal: number; epoca: number;
  nivel: Nivel | null; niveles: readonly CoberturaNivel[]; completa: boolean;
}
export interface PedidoDetalle { epoca: number; tick: number; id: string }
export type MotivoRechazo = 'cercano' | 'podado' | 'ausente' | 'nivel' | 'epoca';
export type JuicioDetalle = { ok: true; persona: PersonView } | { ok: false; motivo: MotivoRechazo };
export interface DepsDetalle {
  pedir: (req: ChunkReq, signal: AbortSignal) => Promise<ChunkResp>;
  /** `true` solo si estaba en marcha y quedó en pausa. */
  pausar: () => boolean;
  contexto: () => ContextoDetalle | null;
  avisar?: (texto: string) => void;
  /** La ficha visible cambió. No pide la cinta. */
  alCambiar?: () => void;
}

export const personaYaCompleta = (p: Partial<Pick<PersonView, 'energy' | 'hunger'>> | null | undefined): boolean =>
  !!p && Number.isFinite(p.energy) && Number.isFinite(p.hunger);

export function l0Cubre(niveles: readonly CoberturaNivel[], tick: number): boolean {
  const l0 = niveles.find(n => n.nivel === 0);
  return !!l0 && l0.fotogramas > 0 && tick >= l0.t0 && tick <= l0.t1;
}

/** Una tesela, la de la persona. El lector la incluye con un margen de una casilla. */
export function ventanaMinima(x: number, y: number): { x: number; y: number; w: 1; h: 1 } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cx = Math.floor(x), cy = Math.floor(y);
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy) || cx < -10_000_000 || cy < -10_000_000 || cx >= 10_000_000 || cy >= 10_000_000) return null;
  return { x: cx, y: cy, w: 1, h: 1 };
}

/** `GET /api/cinta/chunk?n=1&nivel=0&epoca=&t=&w=1&h=1`, por la red que ya usa la cinta. */
export function pedidoChunk(ctx: Pick<ContextoDetalle, 'epoca' | 'tick' | 'x' | 'y'>): ChunkReq | null {
  const v = ventanaMinima(ctx.x, ctx.y);
  if (!v || !Number.isInteger(ctx.epoca) || ctx.epoca < 0 || !Number.isInteger(ctx.tick) || ctx.tick < 0) return null;
  return { n: 1, nivel: 0, epoca: ctx.epoca, t: ctx.tick, x: v.x, y: v.y, w: v.w, h: v.h };
}

export const sePuedePedir = (ctx: ContextoDetalle | null): ctx is ContextoDetalle =>
  !!ctx && ctx.nivel !== null && ctx.nivel !== 0 && !ctx.completa && ctx.cabezal === ctx.tick && !!ctx.id && l0Cubre(ctx.niveles, ctx.tick) && !!pedidoChunk(ctx);

export const claveDetalle = (p: Pick<PedidoDetalle, 'epoca' | 'tick' | 'id'>): string => `${p.epoca}:${p.tick}:${p.id}`;

/** Tick del `baseFrame`, o la base más los deltas de ese trozo si uno cae en el tick exacto. */
function fotogramaEnTick(base: WorldView, deltas: readonly TapeClientDelta[] | undefined, tick: number): WorldView | null {
  if (!Number.isInteger(base.tick) || base.tick > tick) return null;
  if (base.tick === tick) return base;
  const pasos = [...(deltas ?? [])].filter(d => Number.isInteger(d.tick) && d.tick > base.tick && d.tick <= tick).sort((a, b) => a.tick - b.tick);
  if (pasos.at(-1)?.tick !== tick) return null;
  let frame = base;
  try {
    for (const delta of pasos) {
      if (delta.tick < frame.tick) return null;
      if (delta.tick === frame.tick) continue;
      frame = applyClientTapeDelta(frame, delta).frame;
      if (frame.tick !== delta.tick) return null;
    }
  } catch { return null; }
  return frame.tick === tick ? frame : null;
}

/** Solo L0 de la época pedida y esa id. Un tick vecino, otro nivel u otra persona no prestan campos. */
export function juzgarL0(chunk: ChunkResp, pedido: PedidoDetalle): JuicioDetalle {
  if (chunk.nivel !== 0) return { ok: false, motivo: 'nivel' };
  if (chunk.epoca !== pedido.epoca) return { ok: false, motivo: 'epoca' };
  if (!chunk.baseFrame) return { ok: false, motivo: 'podado' };
  const frame = fotogramaEnTick(chunk.baseFrame, chunk.deltas, pedido.tick);
  if (!frame) return { ok: false, motivo: 'cercano' };
  const persona = frame.people?.find(p => p.id === pedido.id);
  if (!persona || persona.id !== pedido.id || !personaYaCompleta(persona)) return { ok: false, motivo: 'ausente' };
  return { ok: true, persona };
}

type Estado = { tipo: 'oculto' } | { tipo: 'ofrecer' | 'pidiendo' | 'listo'; clave: string } | { tipo: 'aviso'; clave: string; texto: string };

function htmlControl(estado: Estado): string {
  if (estado.tipo === 'oculto' || estado.tipo === 'listo') return '';
  const ocupado = estado.tipo === 'pidiendo';
  const boton = `<button type="button" class="button secondary" data-detalle-cinta-ver${ocupado ? ' aria-busy="true" aria-disabled="true"' : ''}>${ETIQUETA_DETALLE}</button>`;
  const nota = estado.tipo === 'pidiendo' ? TEXTO_BUSCANDO : estado.tipo === 'aviso' ? estado.texto : '';
  return boton + (nota ? `<p class="drawer-note" data-detalle-cinta-aviso role="status" aria-live="polite">${esc(nota)}</p>` : '');
}

const esAbort = (error: unknown): boolean => !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';

/**
 * Botón hermano de la tarjeta. `sincronizar` no llama a la red.
 * La persona solo sale si identidad, tick y época siguen siendo los pedidos.
 */
export class DetalleCinta {
  private readonly cache: { clave: string; juicio: JuicioDetalle }[] = [];
  private estado: Estado = { tipo: 'oculto' };
  private vista: { clave: string; persona: PersonView } | null = null;
  private nodo: HTMLElement | null = null;
  private pintado = '';
  private oculto = true;
  private gen = 0;
  private avisando = false;
  private vuelo: { clave: string; ac: AbortController } | null = null;

  constructor(private readonly deps: DepsDetalle) {}
  get cacheTamano(): number { return this.cache.length; }

  personaSiCoincide(ctx: ContextoDetalle | null): PersonView | null {
    return ctx && this.vista?.clave === claveDetalle(ctx) ? this.vista.persona : null;
  }

  nodoEn(raiz: ParentNode): HTMLElement {
    let nodo = raiz.querySelector<HTMLElement>('#detalle-cinta');
    if (nodo) return nodo;
    nodo = document.createElement('section');
    nodo.id = 'detalle-cinta';
    nodo.hidden = true;
    const tarjeta = raiz.querySelector('#inhabitant-card');
    if (tarjeta) tarjeta.insertAdjacentElement('beforebegin', nodo);
    else raiz.appendChild(nodo);
    nodo.addEventListener('click', event => {
      const blanco = event.target instanceof Element ? event.target : null;
      const boton = blanco?.closest('[data-detalle-cinta-ver]');
      if (boton && boton.getAttribute('aria-disabled') !== 'true') void this.ver();
    });
    return nodo;
  }

  /** No pide. Si el instante ya no es el de la vista guardada, la suelta. */
  sincronizar(nodo: HTMLElement | null): void {
    this.nodo = nodo;
    const ctx = this.deps.contexto();
    if (!sePuedePedir(ctx)) { this.ocultar(); return; }
    const clave = claveDetalle(ctx);
    if (this.claveEstado() === clave) { this.pintar(); return; }
    this.soltar();
    this.publicar({ tipo: 'ofrecer', clave });
  }

  /** Cerrar, cambiar de pestaña, de selección o de época: no conservar la ficha ni el vuelo. */
  olvidarVista(): void {
    this.soltar();
    const ctx = this.deps.contexto();
    this.publicar(sePuedePedir(ctx) ? { tipo: 'ofrecer', clave: claveDetalle(ctx) } : { tipo: 'oculto' });
  }

  /** Se llama al elegir una persona. El paso de fotogramas solo actualiza la disponibilidad. */
  async verAlSeleccionar(): Promise<void> {
    if (this.estado.tipo === 'ofrecer') await this.ver();
  }

  /** Pausa la reproducción para conservar el instante que se está inspeccionando. */
  async ver(): Promise<void> {
    const ctx = this.deps.contexto();
    if (!sePuedePedir(ctx) || this.vuelo?.clave === claveDetalle(ctx)) return;
    const clave = claveDetalle(ctx), gen = this.gen, req = pedidoChunk(ctx);
    if (!req) return;
    this.abortar();
    if (this.deps.pausar()) this.deps.avisar?.(TEXTO_PAUSA);
    if (gen !== this.gen || !this.sigue(clave)) return;
    const guardado = this.cache.find(e => e.clave === clave)?.juicio;
    if (guardado) { this.aplicar(clave, gen, guardado); return; }
    const ac = new AbortController();
    this.vuelo = { clave, ac };
    this.publicar({ tipo: 'pidiendo', clave });
    try {
      const chunk = await this.deps.pedir(req, ac.signal);
      if (this.vuelo?.ac !== ac) return;
      this.vuelo = null;
      const juicio = juzgarL0(chunk, { epoca: ctx.epoca, tick: ctx.tick, id: ctx.id });
      this.guardar(clave, juicio);
      this.aplicar(clave, gen, juicio);
    } catch (error) {
      if (this.vuelo?.ac !== ac) return;
      this.vuelo = null;
      if (gen !== this.gen || !this.sigue(clave) || esAbort(error)) return;
      this.vista = null;
      this.publicar({ tipo: 'aviso', clave, texto: TEXTO_RED });
    }
  }

  private claveEstado(): string | null { return this.estado.tipo === 'oculto' ? null : this.estado.clave; }
  private sigue(clave: string): boolean { const ctx = this.deps.contexto(); return sePuedePedir(ctx) && claveDetalle(ctx) === clave; }

  private aplicar(clave: string, gen: number, juicio: JuicioDetalle): void {
    if (gen !== this.gen || !this.sigue(clave)) return;
    if (!juicio.ok) { this.vista = null; this.publicar({ tipo: 'aviso', clave, texto: TEXTO_AUSENTE }); return; }
    this.vista = { clave, persona: juicio.persona };
    this.publicar({ tipo: 'listo', clave });
    this.avisar();
  }

  private ocultar(): void {
    if (!this.vista && !this.vuelo && this.estado.tipo === 'oculto') { this.pintar(); return; }
    this.soltar();
    this.publicar({ tipo: 'oculto' });
  }

  private soltar(): void {
    const mostraba = this.vista !== null;
    this.vista = null;
    this.gen++;
    this.abortar();
    if (mostraba) this.avisar();
  }

  private avisar(): void {
    if (this.avisando) return;
    this.avisando = true;
    try { this.deps.alCambiar?.(); } finally { this.avisando = false; }
  }

  private abortar(): void { const vuelo = this.vuelo; this.vuelo = null; vuelo?.ac.abort(); }

  private guardar(clave: string, juicio: JuicioDetalle): void {
    const i = this.cache.findIndex(e => e.clave === clave);
    if (i >= 0) this.cache.splice(i, 1);
    this.cache.unshift({ clave, juicio });
    this.cache.length = Math.min(this.cache.length, TOPE_CACHE);
  }

  private publicar(estado: Estado): void { this.estado = estado; this.pintar(); }

  private pintar(): void {
    const html = htmlControl(this.estado), hidden = !html, nodo = this.nodo;
    if (!nodo || (this.pintado === html && this.oculto === hidden)) return;
    const activo = nodo.ownerDocument?.activeElement;
    const recuperar = !!activo && nodo.contains(activo);
    this.pintado = html; this.oculto = hidden; nodo.hidden = hidden; nodo.innerHTML = html;
    if (recuperar) {
      const destino = nodo.querySelector<HTMLElement>('[data-detalle-cinta-ver]')
        ?? nodo.parentElement?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      destino?.focus({ preventScroll: true });
    }
  }
}

/** PersonView del controlador si este contexto es el mismo id, tick y época. */
export function personaDeDetalleExactoParaContexto(cinta: DetalleCinta, ctx: ContextoDetalle | null): PersonView | null {
  return cinta.personaSiCoincide(ctx);
}
