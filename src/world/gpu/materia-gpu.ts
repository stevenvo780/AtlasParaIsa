import { channel } from 'node:diagnostics_channel';
import { ClaseSustancia, type SustanciaId } from '../../shared/materia.js';
import { CAPACIDAD_ATOMO, EPSILON_G, NU, R, S_GAS } from '../../shared/naturaleza.js';
import { medir, pasoLote, PASES_ENCADENADOS, type CtxPaso } from '../materia/paso.js';
import { ServicioQuimicoImpl } from '../materia/servicio.js';
import { FAMILIAS_CATALITICAS, nivelDeLote, type Kappa, type LoteRef, type Reaccion } from '../materia/tipos.js';
import { ErrorDispositivo, type CanalGpu } from '../motor/contratos.js';
import { CanalGpuOcupado, enviarOrden, recibirRespuesta, reservarCanalGpu } from './canal.js';

// kPa y mg/kg, respectivamente. Son las mismas conversiones que usa paso.ts.
const ATMOSFERA = 101.325, MG_POR_KG = 1e6;
const U32 = 2 ** 32, I32_MAX = 2 ** 31 - 1;
const FILA_PENDIENTE = U32 - 1;
const perfilGpu = channel('atlas:materia:gpu'), perfilCuda = channel('atlas:materia:cuda');

/** `desde` lleva n + 1 offsets en elementos de `tripletas` (no en bytes), incluido el final.
 * Cada lote lleva las tripletas (a, b, veces) en orden de aplicación o la marca (0, 0, 0) para rehacerlo en CPU. */
export interface VecesGpu { desde: Int32Array; tripletas: Float64Array; ms?: number; lotesCpu?: number }

export interface PasoMateriaGpu {
  lanzar(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number, tick: number): void;
  esperar(plazoMs: number): VecesGpu;
  cerrar(): void;
}

/** El plazo de transporte comienza tras el envío. Solo el dueño aplica la propuesta recibida. */
export function lanzarMateriaGpuConPlazo(paso: PasoMateriaGpu, c: CtxPaso, lotes: ArrayLike<LoteRef>,
  kappas: ArrayLike<number>, dt: number, tick: number, plazoMs: number) {
  paso.lanzar(c, lotes, kappas, dt, tick);
  const vence = performance.now() + plazoMs;
  return () => {
    const propuesta = paso.esperar(Math.max(0, vence - performance.now()));
    aplicarVecesGpu(c, lotes, kappas, propuesta, dt);
    return { tripletas: propuesta.tripletas.length / 3 - (propuesta.lotesCpu ?? 0), ms: propuesta.ms };
  };
}

/** Relee cada fila con el nivel inicial, antes de mutar ningún lote. Solo el dueño aplica las ecuaciones. */
export function aplicarVecesGpu(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, r: VecesGpu, dt: number): number {
  if (r.desde.length !== lotes.length + 1 || r.desde[0] !== 0 || r.desde[lotes.length] !== r.tripletas.length
      || kappas.length !== lotes.length * FAMILIAS_CATALITICAS) throw new Error('Respuesta material desalineada.');
  const filas: Reaccion[] = [];
  for (let l = 0; l < lotes.length; l++) {
    const desde = r.desde[l]!, hasta = r.desde[l + 1]!;
    if (desde === hasta) continue;
    const lote = lotes[l]!, k = l * FAMILIAS_CATALITICAS;
    if (hasta < desde || (hasta - desde) % 3 || hasta > r.tripletas.length || !c.arena.propio(lote))
      throw new Error('Lote o offsets inválidos al aplicar tripletas GPU.');
    if (r.tripletas[desde] === 0) {
      if (hasta !== desde + 3 || r.tripletas[desde + 1] !== 0 || r.tripletas[desde + 2] !== 0)
        throw new Error('Marca de lote pendiente inválida.');
      continue;
    }
    const nivel = nivelDeLote(medir(c, lote).T, [kappas[k]!, kappas[k + 1]!, kappas[k + 2]!, kappas[k + 3]!]);
    for (let i = desde; i < hasta; i += 3) {
      const a = r.tripletas[i]!, b = r.tripletas[i + 1]!, veces = r.tripletas[i + 2]!;
      const fila = c.quimica.reaccion(a, b, nivel);
      if (!fila || !Number.isSafeInteger(veces) || veces <= 0)
        throw new Error(`Tripleta material (${a}, ${b}, ${veces}) inválida en el nivel ${nivel}.`);
      filas.push(fila);
    }
  }
  let total = 0, fila = 0;
  for (let l = 0; l < lotes.length; l++) {
    const desde = r.desde[l]!, hasta = r.desde[l + 1]!, k = l * FAMILIAS_CATALITICAS;
    if (hasta > desde && r.tripletas[desde] === 0) {
      total += pasoLote(c, lotes[l]!, dt, [kappas[k]!, kappas[k + 1]!, kappas[k + 2]!, kappas[k + 3]!]);
      continue;
    }
    for (let i = desde; i < hasta; i += 3)
      total += c.arena.aplicar(lotes[l]!, filas[fila++]!, r.tripletas[i + 2]!);
  }
  return total;
}

interface EspecieGpu { id: SustanciaId; atomos: number; ebullicion: number; condensado: number; molecula: boolean }
interface CanalLote { a: number; b: number; fila: number }
interface PlantillaLote {
  especies: readonly number[];
  origen: Int32Array;
  canales: Uint32Array;
  pendientes: boolean;
}
interface LoteGpu {
  calor: number; nivel: number; kappa: Kappa; semilla: number;
  cantidades: Float64Array;
  plantilla: PlantillaLote;
}

const PLANTILLA_VACIA: PlantillaLote = { especies: [], origen: new Int32Array(), canales: new Uint32Array(), pendientes: false };

function preparar(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number) {
  if (!Number.isFinite(dt) || dt < 0 || kappas.length !== lotes.length * FAMILIAS_CATALITICAS)
    throw new RangeError('Ventana o catálisis del lote GPU inválida.');
  const especies: EspecieGpu[] = [], porId = new Map<SustanciaId, number>();
  const reacciones: Reaccion[] = [], consultadas = new Map<string, number>();
  const plantillas = new Map<string, PlantillaLote>();
  const q = c.quimica;
  const inmediato = q instanceof ServicioQuimicoImpl && q.modo === 'inmediato' ? q : undefined;
  let ids = new Uint32Array(16);
  const especie = (id: SustanciaId): number => {
    const anterior = porId.get(id);
    if (anterior !== undefined) return anterior;
    const s = c.quimica.sustancia(id), indice = especies.length;
    especies.push({ id, atomos: s.atomos.reduce((a, b) => a + b, 0), ebullicion: s.prop.tEbullicion,
      condensado: s.masa / (s.prop.densidad * MG_POR_KG), molecula: s.clase === ClaseSustancia.Molecula });
    porId.set(id, indice);
    return indice;
  };
  function construirPlantilla(composicion: Uint32Array, nivel: number): PlantillaLote {
    const presentes = new Set(composicion), candidatos = new Set(presentes);
    let nuevos = presentes, pendientes = false;
    const canales: CanalLote[] = [], vistos = new Set<string>();
    const consultar = (x: number, y: number, salidas: Set<SustanciaId>): void => {
      const a = y === 0 ? x : Math.min(x, y), b = y === 0 ? 0 : Math.max(x, y);
      const par = `${a}:${b}`;
      if (vistos.has(par)) return;
      vistos.add(par);
      const clave = `${nivel}:${par}`;
      let fila = consultadas.get(clave);
      if (fila === undefined) {
        // Un producto posible puede que nunca aparezca. Solo se resuelve en CPU si CUDA lo alcanza.
        const r = inmediato && (!presentes.has(a) || b !== 0 && !presentes.has(b))
          ? inmediato.reaccionPublicada(a, b, nivel) : q.reaccion(a, b, nivel);
        if (inmediato && r === undefined) {
          pendientes = true;
          canales.push({ a, b, fila: FILA_PENDIENTE });
          return;
        }
        if (r && (r.a !== a || r.b !== b || r.nivelT !== nivel
            || r.entradas.length !== (b > 0 && b !== a ? 2 : 1)
            || !r.entradas.some(t => t.id === a)
            || (b > 0 && !r.entradas.some(t => t.id === b))
            || r.entradas.some(t => !Number.isSafeInteger(t.nu) || t.nu < 1))) {
          throw new Error(`Reacción material GPU inválida para (${a}, ${b}) en el nivel ${nivel}.`);
        }
        fila = r ? reacciones.push(r) - 1 : -1;
        consultadas.set(clave, fila);
      }
      if (fila < 0) return;
      canales.push({ a, b, fila });
      for (const { id } of reacciones[fila]!.salidas) if (!candidatos.has(id)) salidas.add(id);
    };
    // Cierre por alcance, una generación de productos por ventana. La GPU comprueba qué apareció de verdad.
    for (let p = 0; dt > 0 && p <= PASES_ENCADENADOS && nuevos.size > 0; p++) {
      const salidas = new Set<SustanciaId>();
      for (const a of nuevos) {
        consultar(a, 0, salidas);
        for (const b of candidatos) consultar(a, b, salidas);
      }
      for (const id of salidas) candidatos.add(id);
      nuevos = salidas;
    }
    const orden = [...candidatos].sort((a, b) => a - b);
    const locales = new Map(orden.map((id, i) => [id, i]));
    canales.sort((x, y) => x.a - y.a || x.b - y.b);
    const tabla = new Uint32Array(3 * canales.length);
    for (const [i, { a, b, fila }] of canales.entries()) {
      tabla[3 * i] = locales.get(a)!;
      tabla[3 * i + 1] = b === 0 ? -1 : locales.get(b)!;
      tabla[3 * i + 2] = fila;
    }
    return { especies: orden.map(especie), origen: Int32Array.from(orden, id => composicion.indexOf(id)), canales: tabla, pendientes };
  }
  const preparados: LoteGpu[] = [];
  for (let l = 0; l < lotes.length; l++) {
    const ref = lotes[l]!, inicio = l * FAMILIAS_CATALITICAS;
    const kappa: Kappa = [kappas[inicio]!, kappas[inicio + 1]!, kappas[inicio + 2]!, kappas[inicio + 3]!];
    if (kappa.some(k => !Number.isFinite(k) || k < 0)) throw new RangeError('Catálisis GPU inválida.');
    if (!c.arena.propio(ref)) {
      if (c.arena.vivo(ref)) throw new Error(`Paso material GPU: el lote ${ref} es de otro dueño.`);
      preparados.push({ calor: 0, nivel: 0, kappa, semilla: 0, cantidades: new Float64Array(), plantilla: PLANTILLA_VACIA });
      continue;
    }
    const n = c.arena.especies(ref, ids);
    if (n > ids.length) { ids = new Uint32Array(2 * n); c.arena.especies(ref, ids); }
    const composicion = ids.subarray(0, n).sort(), cantidades = new Float64Array(n);
    let atomos = 0;
    for (let i = 0; i < n; i++) {
      const id = composicion[i]!, cuantos = c.arena.cuantos(ref, id);
      cantidades[i] = cuantos;
      atomos += cuantos * especies[especie(id)]!.atomos;
    }
    const calor = c.arena.calor(ref), T = atomos > 0 ? calor / (CAPACIDAD_ATOMO * atomos) : 0;
    const nivel = nivelDeLote(T, kappa);
    // Cada despacho vuelve a consultar Q: una reacción encolada puede publicarse en la siguiente barrera.
    const clave = `${nivel}:${composicion.join(',')}`;
    let plantilla = plantillas.get(clave);
    if (!plantilla) plantillas.set(clave, plantilla = construirPlantilla(composicion, nivel));
    preparados.push({ calor, nivel, kappa, semilla: plantilla.canales.length ? Math.floor(c.azar() * U32) : 0, cantidades, plantilla });
  }
  return { especies, porId, reacciones, lotes: preparados };
}

/** ABI little endian de materia.cu. Las tablas globales se deduplican por especie y (nivel, a, b). */
export function empaquetarMateriaGpu(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number) {
  const datos = preparar(c, lotes, kappas, dt);
  const n = datos.lotes.length;
  const nCanales = datos.lotes.reduce((s, l) => s + l.plantilla.canales.length / 3, 0);
  const nComposicion = datos.lotes.reduce((s, l) => s + l.plantilla.especies.length, 0);
  const nTerminos = datos.reacciones.reduce((s, r) => s + r.entradas.length + r.salidas.length, 0);
  const tamCab = 72, tamLote = 64, tamEspecie = 32, tamReaccion = 48, tamTermino = 8, tamComposicion = 16, tamCanal = 12;
  const lotesOff = tamCab, especiesOff = lotesOff + n * tamLote;
  const reaccionesOff = especiesOff + datos.especies.length * tamEspecie;
  const terminosOff = reaccionesOff + datos.reacciones.length * tamReaccion;
  const composicionOff = terminosOff + nTerminos * tamTermino;
  const canalesOff = composicionOff + nComposicion * tamComposicion;
  const bytes = canalesOff + nCanales * tamCanal;
  const maxTripletas = (1 + PASES_ENCADENADOS) * nCanales;
  if (bytes >= U32 || maxTripletas * 3 > I32_MAX) throw new RangeError('Lote material fuera del formato GPU.');

  const binario = new ArrayBuffer(bytes);
  const enteros = new Uint32Array(binario), reales = new Float64Array(binario, 0, Math.floor(bytes / 8));
  const u = (off: number, valores: ArrayLike<number>) => enteros.set(valores, off / 4);
  const f = (off: number, valores: readonly number[]) => reales.set(valores, off / 8);
  f(0, [dt, R, CAPACIDAD_ATOMO, NU, S_GAS, EPSILON_G, ATMOSFERA]);
  u(56, [especiesOff, reaccionesOff, terminosOff, PASES_ENCADENADOS]);
  let composicion = composicionOff, canales = canalesOff;
  datos.lotes.forEach((l, i) => {
    const base = lotesOff + i * tamLote;
    const { especies, origen, canales: tabla } = l.plantilla;
    f(base, [l.calor, ...l.kappa]);
    u(base + 40, [composicion, especies.length, canales, tabla.length / 3, l.nivel, l.semilla]);
    for (let j = 0; j < especies.length; j++, composicion += tamComposicion) {
      reales[composicion / 8] = l.cantidades[origen[j]!] ?? 0;
      enteros[(composicion + 8) / 4] = especies[j]!;
    }
    u(canales, tabla);
    canales += tabla.byteLength;
  });
  datos.especies.forEach((s, i) => {
    const base = especiesOff + i * tamEspecie;
    f(base, [s.atomos, s.ebullicion, s.condensado]); u(base + 24, [s.id, Number(s.molecula)]);
  });
  let termino = 0;
  datos.reacciones.forEach((r, i) => {
    const base = reaccionesOff + i * tamReaccion;
    f(base, [r.dH, r.ea]);
    u(base + 16, [r.a, r.b, r.nivelT, r.catalisis, r.paresCatalisis, termino, r.entradas.length, r.salidas.length]);
    for (const t of [...r.entradas, ...r.salidas]) {
      u(terminosOff + termino * tamTermino, [datos.porId.get(t.id)!, t.nu]); termino++;
    }
  });
  return { binario, maxTripletas, nEspecies: nComposicion, nCanales,
    limites: Int32Array.from(datos.lotes, l => l.plantilla.canales.length / 3 * (1 + PASES_ENCADENADOS)),
    pendientes: Uint8Array.from(datos.lotes, l => Number(l.plantilla.pendientes)) };
}

/** Compila el módulo fuera del plazo del primer paso ante un arranque con materiaGpu. */
export function prepararMateriaGpu(canal: CanalGpu, plazoMs: number): void {
  const dispositivo = `gpu${canal.dispositivo}` as const;
  const liberar = reservarCanalGpu(canal);
  if (!liberar) throw new CanalGpuOcupado(canal);
  try {
    if (!canal.bytes) canal.crecer(1);
    enviarOrden(canal, { kind: 'prepararMateria', tick: 0, despacho: 0, subida: 0, bajada: 0, salida: 0, perfil: perfilCuda.hasSubscribers });
    const r = recibirRespuesta<{ ok: boolean; tick: number; despacho: number; msNvrtc?: number; msModulo?: number }>(canal, plazoMs);
    if (!r.ok || r.tick !== 0 || r.despacho !== 0) throw new Error('Eco de preparación material GPU inválido.');
    if (perfilCuda.hasSubscribers) perfilCuda.publish({ dispositivo: canal.dispositivo, msNvrtc: r.msNvrtc, msModulo: r.msModulo });
  } catch (error) {
    try { canal.cerrar(); } catch { /* Se conserva la causa original. */ }
    throw error instanceof ErrorDispositivo ? error : new ErrorDispositivo(dispositivo,
      error instanceof Error ? error.message : String(error));
  } finally { liberar(); }
}

export function crearPasoMateriaGpu(canal: CanalGpu): PasoMateriaGpu {
  let pendiente: { tick: number; despacho: number; salida: number; maxTripletas: number; limites: Int32Array; pendientes: Uint8Array;
    msPreparar: number; msEnviar: number; liberar(): void } | undefined;
  let despacho = 0, fallo: ErrorDispositivo | undefined, cerrado = false;
  const dispositivo = `gpu${canal.dispositivo}` as const;
  const marcarFallo = (error: unknown): ErrorDispositivo => {
    fallo = error instanceof ErrorDispositivo ? error : new ErrorDispositivo(dispositivo,
      error instanceof Error ? error.message : String(error));
    try { canal.cerrar(); } catch { /* Se conserva la causa original. */ }
    return fallo;
  };
  return {
    lanzar(c, lotes, kappas, dt, tick) {
      if (fallo) throw fallo;
      if (cerrado || pendiente) throw new Error('El paso material GPU está cerrado o tiene un lote pendiente.');
      if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('Tick material GPU inválido.');
      const inicio = perfilGpu.hasSubscribers ? performance.now() : 0;
      const { binario, maxTripletas, nEspecies, nCanales, limites, pendientes } = empaquetarMateriaGpu(c, lotes, kappas, dt);
      const preparado = inicio ? performance.now() : 0;
      const n = limites.length, cabecera = Math.ceil((n + 1) / 2) * 8, subida = binario.byteLength;
      const salida = Math.ceil(subida / 8) * 8, bajada = cabecera + maxTripletas * 24;
      const liberar = maxTripletas ? reservarCanalGpu(canal) : () => {};
      if (!liberar) throw new CanalGpuOcupado(canal);
      try {
        if (maxTripletas) {
          if (canal.bytes < salida + bajada) canal.crecer(salida + bajada);
          canal.escribir(0, new Uint8Array(binario));
          enviarOrden(canal, { kind: 'materia', tick, despacho: ++despacho, n, subida, salida, bajada, cabecera,
            nEspecies, nCanales, maxTripletas, perfil: perfilGpu.hasSubscribers });
        }
        pendiente = { tick, despacho, salida, maxTripletas, limites, pendientes, liberar,
          msPreparar: preparado - inicio, msEnviar: preparado ? performance.now() - preparado : 0 };
      } catch (error) { liberar(); throw marcarFallo(error); }
    },
    esperar(plazoMs) {
      if (Number.isNaN(plazoMs) || plazoMs < 0) throw new RangeError('Plazo material GPU inválido.');
      const p = pendiente;
      if (!p) throw fallo ?? new Error('No hay un lote material GPU pendiente.');
      pendiente = undefined;
      const desde = new Int32Array(p.limites.length + 1);
      const inicio = perfilGpu.hasSubscribers ? performance.now() : 0;
      const perf = { dispositivo: canal.dispositivo, tick: p.tick, msPreparar: p.msPreparar, msEnviar: p.msEnviar };
      try {
        if (!p.maxTripletas) return { desde, tripletas: new Float64Array() };
        const r = recibirRespuesta<{ ok: boolean; tick: number; despacho: number; tripletas: number; ms?: number;
          msH2D?: number; msKernel?: number; msD2H?: number; msLanzar?: number; msSincronizar?: number;
          bytesH2D?: number; bytesD2H?: number }>(canal, plazoMs);
        const recibido = inicio ? performance.now() : 0;
        if (r.ok !== true || r.tick !== p.tick || r.despacho !== p.despacho || !Number.isSafeInteger(r.tripletas)
            || r.tripletas < 0 || r.tripletas > p.maxTripletas) throw new Error('Eco o longitud inválida del paso material GPU.');
        canal.leer(p.salida, desde);
        if (desde[0] !== 0) throw new Error('Inicio inválido de las tripletas GPU.');
        for (let i = 0; i < p.limites.length; i++) {
          const cuenta = desde[i + 1]! - desde[i]!;
          if (cuenta < 0 || cuenta % 3 || cuenta > p.limites[i]! * 3) throw new Error('Offsets inválidos de las tripletas GPU.');
        }
        if (desde[desde.length - 1] !== r.tripletas * 3) throw new Error('Final inválido de las tripletas GPU.');
        const tripletas = new Float64Array(r.tripletas * 3);
        if (tripletas.length) canal.leer(p.salida + Math.ceil(desde.length / 2) * 8, tripletas);
        let lotesCpu = 0;
        for (let l = 0; l < p.limites.length; l++) {
          const ini = desde[l]!, fin = desde[l + 1]!;
          if (p.pendientes[l] && fin === ini + 3 && tripletas[ini] === 0 && tripletas[ini + 1] === 0 && tripletas[ini + 2] === 0) {
            lotesCpu++;
            continue;
          }
          for (let i = ini; i < fin; i += 3) {
            const a = tripletas[i]!, b = tripletas[i + 1]!, veces = tripletas[i + 2]!;
            if (!Number.isInteger(a) || a <= 0 || a >= U32 || !Number.isInteger(b) || b < 0 || b >= U32
                || !Number.isSafeInteger(veces) || veces <= 0) throw new Error('Tripleta material GPU inválida.');
          }
        }
        if (inicio) {
          const { ms: msServidor, msH2D, msKernel, msD2H, msLanzar, msSincronizar, bytesH2D, bytesD2H } = r;
          perfilGpu.publish({ ...perf, msEsperar: recibido - inicio, msLeer: performance.now() - recibido,
            msServidor, msH2D, msKernel, msD2H, msLanzar, msSincronizar, bytesH2D, bytesD2H, tripletas: r.tripletas - lotesCpu, lotesCpu });
        }
        return { desde, tripletas, ms: r.ms, lotesCpu };
      } catch (error) {
        if (inicio) perfilGpu.publish({ ...perf, msEsperar: performance.now() - inicio, msLeer: 0, fallo: String(error) });
        throw marcarFallo(error);
      }
      finally { p.liberar(); }
    },
    cerrar() {
      if (cerrado) return;
      cerrado = true;
      // El canal pertenece al puente. Solo se invalida al cancelar una orden que aún lo usa.
      if (pendiente?.maxTripletas) {
        try { canal.cerrar(); } finally { pendiente.liberar(); pendiente = undefined; }
      } else pendiente = undefined;
    },
  };
}
