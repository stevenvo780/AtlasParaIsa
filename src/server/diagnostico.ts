import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { World } from '../world/index.js';
import { comprobarInvariante, listaInvariantes, type RegionRef, type Violacion } from '../world/invariantes.js';
import { paramsOf } from '../world/params.js';
import { CHUNK_SIZE } from '../world/terrain.js';
import { lastTileAt } from '../world/tile-index.js';

export interface OpcionesMuestreador {
  directorio: string;
  fraccionPaso?: number;
  commit?: string;
  maxBitacoraBytes?: number;
}

export interface ResumenDiagnostico {
  tick: number;
  duras24h: number;
  blandas24h: number;
  ultimaViolacion?: string;
  comprobaciones: number;
  comprobacionesPorInvariante: Record<string, number>;
  costeMs: number;
  fraccionMedida: number;
  deudaMs: number;
  pendientesBitacora: number;
  muestreosDiferidosPorBitacora: number;
  registrosSinBitacora: number;
  errorBitacora?: string;
}

export interface RegistroBitacora {
  t: string;
  tick: number;
  reglas: number;
  commit: string;
  hilos: number;
  gpu: number[];
  rssMiB: number;
  violacion: Violacion;
  entorno: unknown;
}

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_BITACORA_BYTES = 64 * 1024 * 1024;
const ARCHIVOS_BITACORA = 8;
const MAX_CREDITO_MS = 10;
const MAX_PENDIENTES = 1024;
/** Cada registro construye su entorno de forma síncrona: un mundo corrupto no puede bloquear el paso con miles. */
const MAX_REGISTROS_POR_COMPROBACION = 8;
const MAX_REGIONES_POR_RONDA = 16;

/** Acota también las muestras que aporte un carril; NaN/Infinity deben sobrevivir al JSON. */
function pequeno(valor: unknown, profundidad = 0, vistos = new Set<object>()): unknown {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : String(valor);
  if (typeof valor === 'string') return valor.slice(0, 1000);
  if (typeof valor === 'bigint') return String(valor);
  if (valor === null || typeof valor !== 'object') return valor;
  if (vistos.has(valor)) return '[circular]';
  if (profundidad >= 5) return '[omitido]';
  vistos.add(valor);
  const resultado = Array.isArray(valor)
    ? valor.slice(0, 16).map(v => pequeno(v, profundidad + 1, vistos))
    : Object.fromEntries(Object.entries(valor).slice(0, 24).map(([k, v]) => [k, pequeno(v, profundidad + 1, vistos)]));
  vistos.delete(valor);
  return resultado;
}

function entorno(mundo: World, violacion: Violacion, region?: RegionRef): unknown {
  const tesela = region ? undefined : mundo.tiles[0];
  const contexto = violacion.contexto;
  const conCoordenadas = typeof contexto?.x === 'number' && Number.isFinite(contexto.x)
    && typeof contexto.y === 'number' && Number.isFinite(contexto.y);
  const x = conCoordenadas ? Math.floor(contexto.x as number)
    : region ? region.chunkX * CHUNK_SIZE + CHUNK_SIZE / 2 : tesela?.x ?? 0;
  const y = conCoordenadas ? Math.floor(contexto.y as number)
    : region ? region.chunkY * CHUNK_SIZE + CHUNK_SIZE / 2 : tesela?.y ?? 0;
  const teselas: unknown[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const tile = lastTileAt(mundo.tiles, x + dx, y + dy);
    if (tile) teselas.push(pequeno(tile));
  }
  // Una corrupción no debe convertir el volcado de contexto en otro barrido global.
  const cerca = <T extends { x: number; y: number }>(elementos: T[]) => elementos.slice(0, 256)
    .filter(p => Math.abs(p.x - x) <= CHUNK_SIZE && Math.abs(p.y - y) <= CHUNK_SIZE).slice(0, 8);
  return pequeno({ region, centro: { x, y }, semilla: mundo.seed, rng: mundo.rng,
    poblacion: mundo.people.length, fauna: mundo.animals.length, teselas,
    personas: cerca(mundo.people).map(p => ({ id: p.id, x: p.x, y: p.y, energy: p.energy,
      hunger: p.hunger, thirst: p.thirst, fatigue: p.fatigue, communityId: p.communityId })),
    animales: cerca(mundo.animals).map(a => ({ id: a.id, x: a.x, y: a.y, health: a.health, energy: a.energy })),
    estructuras: cerca(mundo.structures).map(s => ({ id: s.id, x: s.x, y: s.y, condition: s.condition, water: s.water, food: s.food })),
    inspeccionadosMaximo: 256 });
}

/** Llamar en el coordinador, después de la barrera de fin de paso. No modifica el mundo. */
export class Muestreador {
  readonly fichero: string;
  private readonly fraccionPaso: number;
  private readonly commit: string;
  private readonly maxBitacoraBytes: number;
  private cursor = 0;
  private readonly cursoresTeselas = new Map<string, number>();
  private creditoMs = 0;
  private costeMs = 0;
  private pasosMs = 0;
  private tick = 0;
  private ultimoTick: number | undefined;
  private ultimaViolacion: string | undefined;
  private readonly costes = new Map<string, number>();
  private readonly siguientes = new Map<string, number>();
  private readonly cobertura = new Map<string, number>();
  private readonly incidencias: { t: number; duras: number; blandas: number }[] = [];
  private cola: Promise<void> = Promise.resolve();
  private pendientes = 0;
  private diferidos = 0;
  private sinBitacora = 0;
  private errorBitacora: string | undefined;
  private bytesBitacora: number | undefined;

  constructor(opciones: OpcionesMuestreador) {
    this.fraccionPaso = opciones.fraccionPaso ?? 0.01;
    this.maxBitacoraBytes = opciones.maxBitacoraBytes ?? MAX_BITACORA_BYTES;
    if (!Number.isFinite(this.fraccionPaso) || this.fraccionPaso <= 0 || this.fraccionPaso > 1)
      throw new RangeError('fraccionPaso debe estar entre 0 y 1.');
    this.commit = opciones.commit ?? 'desconocido';
    this.fichero = join(opciones.directorio, 'diagnostico', 'invariantes.jsonl');
  }

  paso(mundo: World, stepMs: number): Violacion[] {
    if (!Number.isFinite(stepMs) || stepMs < 0) throw new RangeError('stepMs debe ser finito y no negativo.');
    const inicio = performance.now();
    try {
      if (this.ultimoTick === mundo.tick) return [];
      if (this.ultimoTick !== undefined && mundo.tick < this.ultimoTick) {
        this.siguientes.clear();
        this.creditoMs = 0;
      }
      this.ultimoTick = this.tick = mundo.tick;
      this.pasosMs += stepMs;
      this.creditoMs = Math.min(MAX_CREDITO_MS, this.creditoMs + stepMs * this.fraccionPaso);
      if (this.creditoMs <= 0) return [];
      if (this.pendientes >= MAX_PENDIENTES) { this.diferidos++; return []; }
      const invariantes = listaInvariantes();
      const violaciones: Violacion[] = [];
      const comienzo = this.cursor;
      for (let n = 0; n < invariantes.length; n++) {
        if (this.pendientes >= MAX_PENDIENTES) { this.diferidos++; break; }
        const indice = (comienzo + n) % invariantes.length;
        const inv = invariantes[indice]!;
        if (mundo.tick < (this.siguientes.get(inv.id) ?? 0)) continue;
        const rondas = inv.alcance === 'region' ? MAX_REGIONES_POR_RONDA : 1;
        let ejecutadas = 0;
        for (; ejecutadas < rondas; ejecutadas++) {
          const estimado = this.costes.get(inv.id) ?? 0.05;
          // Una comprobación JS es indivisible: si excede el crédito, la deuda difiere las siguientes.
          if (performance.now() - inicio + Math.min(estimado, MAX_CREDITO_MS / 2) > this.creditoMs) break;
          const region = inv.alcance === 'region' ? this.siguienteRegion(mundo, inv.id) : undefined;
          if (inv.alcance === 'region' && !region) break;
          const antes = performance.now();
          const encontrados = comprobarInvariante(inv, mundo, region);
          const coste = performance.now() - antes;
          this.costes.set(inv.id, Math.max(coste, estimado * 0.8 + coste * 0.2));
          this.cobertura.set(inv.id, (this.cobertura.get(inv.id) ?? 0) + 1);
          if (encontrados.length > 0) this.registrar(mundo, encontrados, region);
          for (const violacion of encontrados) violaciones.push(violacion);
        }
        if (ejecutadas > 0) {
          this.siguientes.set(inv.id, mundo.tick + inv.cadaTicks);
          this.cursor = (indice + 1) % invariantes.length;
        }
      }
      return violaciones;
    } finally {
      const duracion = performance.now() - inicio;
      this.creditoMs -= duracion;
      this.costeMs += duracion;
    }
  }

  /** Las teselas se guardan por chunks completos: avanzar CHUNK_SIZE² + 1 posiciones pasa al chunk siguiente. */
  private siguienteRegion(mundo: World, id: string): RegionRef | undefined {
    const cursor = this.cursoresTeselas.get(id) ?? 0;
    const tile = mundo.tiles[cursor % Math.max(1, mundo.tiles.length)];
    if (!tile) return undefined;
    this.cursoresTeselas.set(id, cursor + CHUNK_SIZE * CHUNK_SIZE + 1);
    return { chunkX: Math.floor(tile.x / CHUNK_SIZE), chunkY: Math.floor(tile.y / CHUNK_SIZE) };
  }

  private registrar(mundo: World, violaciones: Violacion[], region?: RegionRef): void {
    const ahora = Date.now();
    const ultima = this.incidencias[this.incidencias.length - 1];
    const cuenta = ultima?.t === ahora ? ultima : { t: ahora, duras: 0, blandas: 0 };
    if (cuenta !== ultima) this.incidencias.push(cuenta);
    for (const violacion of violaciones) {
      if (violacion.gravedad === 'dura') cuenta.duras++; else cuenta.blandas++;
    }
    this.ultimaViolacion = violaciones[violaciones.length - 1]!.id;
    this.purgar(ahora);
    const motor = paramsOf(mundo).motor;
    const registro: Omit<RegistroBitacora, 'violacion' | 'entorno'> = { t: new Date(ahora).toISOString(), tick: mundo.tick,
      reglas: mundo.version, commit: this.commit, hilos: motor.hilos, gpu: [...motor.gpu],
      rssMiB: process.memoryUsage.rss() / 1024 ** 2 };
    const registros = violaciones.slice(0, MAX_REGISTROS_POR_COMPROBACION).map(violacion => ({ violacion: pequeno(violacion), entorno: entorno(mundo, violacion, region) }));
    let escritos = 0;
    this.pendientes += registros.length;
    this.cola = this.cola.then(async () => {
      for (const entrada of registros) {
        await this.escribir(JSON.stringify({ ...registro, ...entrada }) + '\n');
        escritos++;
      }
    }).catch(error => {
      this.errorBitacora = String(error);
      this.sinBitacora += registros.length - escritos;
    }).finally(() => { this.pendientes -= registros.length; });
  }

  private async escribir(linea: string): Promise<void> {
    if (this.bytesBitacora === undefined) {
      await mkdir(join(this.fichero, '..'), { recursive: true });
      try { this.bytesBitacora = (await stat(this.fichero)).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.bytesBitacora = 0;
      }
    }
    const bytes = Buffer.byteLength(linea);
    if (this.bytesBitacora + bytes > this.maxBitacoraBytes) {
      await unlink(`${this.fichero}.${ARCHIVOS_BITACORA - 1}`).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      for (let i = ARCHIVOS_BITACORA - 2; i >= 0; i--) {
        const origen = i === 0 ? this.fichero : `${this.fichero}.${i}`;
        await rename(origen, `${this.fichero}.${i + 1}`).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      this.bytesBitacora = 0;
    }
    await appendFile(this.fichero, linea, 'utf8');
    this.bytesBitacora += bytes;
  }

  private purgar(ahora: number): void {
    const primero = this.incidencias.findIndex(c => c.t >= ahora - DIA_MS);
    if (primero < 0) this.incidencias.length = 0;
    else if (primero > 0) this.incidencias.splice(0, primero);
  }

  resumen(): ResumenDiagnostico {
    this.purgar(Date.now());
    return { tick: this.tick,
      duras24h: this.incidencias.reduce((s, c) => s + c.duras, 0),
      blandas24h: this.incidencias.reduce((s, c) => s + c.blandas, 0),
      ultimaViolacion: this.ultimaViolacion,
      comprobaciones: [...this.cobertura.values()].reduce((s, n) => s + n, 0),
      comprobacionesPorInvariante: Object.fromEntries(this.cobertura),
      costeMs: this.costeMs, fraccionMedida: this.pasosMs > 0 ? this.costeMs / this.pasosMs : 0,
      deudaMs: Math.max(0, -this.creditoMs), pendientesBitacora: this.pendientes,
      muestreosDiferidosPorBitacora: this.diferidos, registrosSinBitacora: this.sinBitacora,
      errorBitacora: this.errorBitacora };
  }

  /** Esperar al cerrar o antes de examinar la bitácora; un fallo de E/S es observable. */
  async vaciar(): Promise<void> {
    await this.cola;
    if (this.errorBitacora) throw new Error(this.errorBitacora);
  }
}
