/** Progreso optativo en stderr. Cada etapa periódica se marca antes de ejecutarse
 * y al volver, incluso si se repite dentro de 2 s. Los pasos consecutivos se
 * agrupan en tramos de 2 s: en un bloqueo, su marca indica el tick de apertura
 * del tramo. `dtMs` mide la pared del tramo. M6 mide cada paso en `puertaCorta`.
 * La escritura síncrona deja la marca visible si el hilo se bloquea. */
import { writeSync } from 'node:fs';

export type FaseAvance = 'paso' | 'reunion' | 'verificacion' | 'archivo' | 'censo' | 'digesto';
export type BordeAvance = 'inicio' | 'fin';

/** Intervalo de muestreo entre pasos consecutivos. */
export const INTERVALO_AVANCE_MS = 2_000;

export interface MarcaAvance {
  tipo: 'avance';
  fase: FaseAvance;
  borde: BordeAvance;
  /** Frontera del borde: inicio del tramo, o tick ya recorrido al cerrarlo. */
  tick: number;
  /** Solo en `fin`: tick del `inicio` de este tramo. */
  tickInicio?: number;
  /** Solo en `fin`: pared del tramo, en milisegundos enteros. */
  dtMs?: number;
}

export interface Avance {
  /** Justo antes de la fase. Puede escribir `inicio` y el `fin` del tramo anterior. */
  entrar(fase: FaseAvance, tick: number): void;
  /** Justo después. Cierra la etapa periódica o el tramo de pasos vencido. */
  salir(fase: FaseAvance, tick: number): void;
  /** Cierra el tramo abierto al terminar la corrida. */
  cerrar(tick: number): void;
}

const quieto = (): void => {};
const AVANCE_QUIETO: Avance = { entrar: quieto, salir: quieto, cerrar: quieto };

/** `CARTA_PANEL_AVANCE=1` exacto. Cualquier otro valor, incluido vacío, lo deja apagado. */
export function panelAvanceActivo(env: { CARTA_PANEL_AVANCE?: string } = process.env): boolean {
  return env.CARTA_PANEL_AVANCE === '1';
}

export interface OpcionesAvance {
  intervaloMs?: number;
  /** Por defecto, `writeSync` al fd de stderr. Una excepción apaga el avance. */
  escribir?: (linea: string) => void;
  /** Por defecto, `performance.now`. */
  ahora?: () => number;
  /** `false` devuelve un avance que no lee el reloj ni escribe. */
  activo?: boolean;
}

interface Tramo {
  fase: FaseAvance;
  tickInicio: number;
  tInicio: number;
  ultimoTick: number;
}

function escribirStderr(linea: string): void {
  writeSync(process.stderr.fd, linea);
}

export function crearAvance(opciones: OpcionesAvance = {}): Avance {
  if (opciones.activo === false) return AVANCE_QUIETO;
  const intervaloMs = opciones.intervaloMs ?? INTERVALO_AVANCE_MS;
  if (!Number.isFinite(intervaloMs) || intervaloMs < 0) throw new Error('intervaloMs inválido');
  const reloj = opciones.ahora ?? (() => performance.now());
  const escribir = opciones.escribir ?? escribirStderr;
  let acepta = true;
  let frontera = Number.NEGATIVE_INFINITY;
  let tramo: Tramo | null = null;

  const emitir = (linea: string): void => {
    if (!acepta) return;
    try { escribir(linea); }
    catch { acepta = false; }
  };
  const tickFrontera = (tick: number): number => {
    if (!Number.isFinite(tick) || tick < frontera) return frontera;
    frontera = tick;
    return tick;
  };
  const emitirFin = (abierto: Tramo, t: number): void => {
    const tick = tickFrontera(abierto.ultimoTick < abierto.tickInicio ? abierto.tickInicio : abierto.ultimoTick);
    const dt = t - abierto.tInicio;
    const marca: MarcaAvance = {
      tipo: 'avance', fase: abierto.fase, borde: 'fin', tick, tickInicio: abierto.tickInicio,
      dtMs: dt > 0 && Number.isFinite(dt) ? Math.round(dt) : 0,
    };
    emitir(`${JSON.stringify(marca)}\n`);
  };
  const emitirInicio = (fase: FaseAvance, tick: number): number => {
    const marcaTick = tickFrontera(tick);
    const marca: MarcaAvance = { tipo: 'avance', fase, borde: 'inicio', tick: marcaTick };
    emitir(`${JSON.stringify(marca)}\n`);
    return marcaTick;
  };

  return {
    entrar(fase, tick) {
      if (!acepta || !Number.isFinite(tick)) return;
      const abierto = tramo;
      const t = reloj();
      if (abierto?.fase === 'paso' && fase === 'paso' && t - abierto.tInicio < intervaloMs) return;
      if (abierto !== null) emitirFin(abierto, t);
      const tickInicio = emitirInicio(fase, tick);
      tramo = { fase, tickInicio, tInicio: t, ultimoTick: tickInicio };
    },
    salir(fase, tick) {
      const abierto = tramo;
      if (!acepta || abierto === null || abierto.fase !== fase) return;
      if (Number.isFinite(tick) && tick > abierto.ultimoTick) abierto.ultimoTick = tick;
      const t = reloj();
      if (fase === 'paso' && t - abierto.tInicio < intervaloMs) return;
      emitirFin(abierto, t);
      tramo = null;
    },
    cerrar(tick) {
      const abierto = tramo;
      if (!acepta || abierto === null) return;
      if (Number.isFinite(tick) && tick > abierto.ultimoTick) abierto.ultimoTick = tick;
      emitirFin(abierto, reloj());
      tramo = null;
    },
  };
}
