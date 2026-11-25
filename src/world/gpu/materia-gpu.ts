import { ClaseSustancia, type SustanciaId } from '../../shared/materia.js';
import { CAPACIDAD_ATOMO, EPSILON_G, NU, R, S_GAS } from '../../shared/naturaleza.js';
import { PASES_ENCADENADOS, type CtxPaso } from '../materia/paso.js';
import { FAMILIAS_CATALITICAS, nivelDeLote, type Kappa, type LoteRef, type Reaccion } from '../materia/tipos.js';
import { ErrorDispositivo, type CanalGpu } from '../motor/contratos.js';
import { enviarOrden, recibirRespuesta, reservarCanalGpu } from './canal.js';

// kPa y mg/kg, respectivamente. Son las mismas conversiones que usa paso.ts.
const ATMOSFERA = 101.325, MG_POR_KG = 1e6;
const U32 = 2 ** 32, I32_MAX = 2 ** 31 - 1;

/** `desde` lleva n + 1 offsets en elementos de `tripletas` (no en bytes), incluido el final.
 * Las tripletas (a, b, veces) están en orden de aplicación. W relee la reacción con el nivel inicial del lote. */
export interface VecesGpu { desde: Int32Array; tripletas: Float64Array }

export interface PasoMateriaGpu {
  lanzar(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number, tick: number): void;
  esperar(plazoMs: number): VecesGpu;
  cerrar(): void;
}

interface EspecieGpu { id: SustanciaId; atomos: number; ebullicion: number; condensado: number; molecula: boolean }
interface CanalLote { a: number; b: number; fila: number }
interface LoteGpu {
  calor: number; nivel: number; kappa: Kappa; semilla: number;
  especies: readonly { indice: number; cuantos: number }[];
  canales: readonly CanalLote[];
}

function preparar(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number) {
  if (!Number.isFinite(dt) || dt < 0 || kappas.length !== lotes.length * FAMILIAS_CATALITICAS)
    throw new RangeError('Ventana o catálisis del lote GPU inválida.');
  const especies: EspecieGpu[] = [], porId = new Map<SustanciaId, number>();
  const reacciones: Reaccion[] = [], consultadas = new Map<string, number>();
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
  const preparados: LoteGpu[] = [];
  for (let l = 0; l < lotes.length; l++) {
    const ref = lotes[l]!, inicio = l * FAMILIAS_CATALITICAS;
    const kappa: Kappa = [kappas[inicio]!, kappas[inicio + 1]!, kappas[inicio + 2]!, kappas[inicio + 3]!];
    if (kappa.some(k => !Number.isFinite(k) || k < 0)) throw new RangeError('Catálisis GPU inválida.');
    if (!c.arena.propio(ref)) {
      if (c.arena.vivo(ref)) throw new Error(`Paso material GPU: el lote ${ref} es de otro dueño.`);
      preparados.push({ calor: 0, nivel: 0, kappa, semilla: 0, especies: [], canales: [] });
      continue;
    }
    const n = c.arena.especies(ref, ids);
    if (n > ids.length) { ids = new Uint32Array(2 * n); c.arena.especies(ref, ids); }
    const cantidades = new Map<SustanciaId, number>();
    let atomos = 0;
    for (const id of ids.subarray(0, n).sort()) {
      const cuantos = c.arena.cuantos(ref, id);
      cantidades.set(id, cuantos);
      atomos += cuantos * especies[especie(id)]!.atomos;
    }
    const calor = c.arena.calor(ref), T = atomos > 0 ? calor / (CAPACIDAD_ATOMO * atomos) : 0;
    const nivel = nivelDeLote(T, kappa);
    const candidatos = new Set(cantidades.keys());
    let nuevos = new Set(candidatos);
    const canales: CanalLote[] = [], vistos = new Set<string>();
    const consultar = (x: number, y: number, salidas: Set<SustanciaId>): void => {
      const a = y === 0 ? x : Math.min(x, y), b = y === 0 ? 0 : Math.max(x, y);
      const par = `${a}:${b}`;
      if (vistos.has(par)) return;
      vistos.add(par);
      const clave = `${nivel}:${par}`;
      let fila = consultadas.get(clave);
      if (fila === undefined) {
        const r = c.quimica.reaccion(a, b, nivel);
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
    preparados.push({ calor, nivel, kappa, semilla: canales.length ? Math.floor(c.azar() * U32) : 0,
      especies: orden.map(id => ({ indice: especie(id), cuantos: cantidades.get(id) ?? 0 })),
      canales: canales.map(({ a, b, fila }) => ({ a: locales.get(a)!, b: b === 0 ? -1 : locales.get(b)!, fila })) });
  }
  return { especies, porId, reacciones, lotes: preparados };
}

/** ABI little endian de materia.cu. Las tablas globales se deduplican por especie y (nivel, a, b). */
export function empaquetarMateriaGpu(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number) {
  const datos = preparar(c, lotes, kappas, dt);
  const n = datos.lotes.length;
  const nCanales = datos.lotes.reduce((s, l) => s + l.canales.length, 0);
  const nComposicion = datos.lotes.reduce((s, l) => s + l.especies.length, 0);
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

  const binario = new ArrayBuffer(bytes), d = new DataView(binario);
  const u = (off: number, valores: readonly number[]) => valores.forEach((v, i) => d.setUint32(off + 4 * i, v, true));
  const f = (off: number, valores: readonly number[]) => valores.forEach((v, i) => d.setFloat64(off + 8 * i, v, true));
  f(0, [dt, R, CAPACIDAD_ATOMO, NU, S_GAS, EPSILON_G, ATMOSFERA]);
  u(56, [especiesOff, reaccionesOff, terminosOff, PASES_ENCADENADOS]);
  let composicion = composicionOff, canales = canalesOff;
  datos.lotes.forEach((l, i) => {
    const base = lotesOff + i * tamLote;
    f(base, [l.calor, ...l.kappa]);
    u(base + 40, [composicion, l.especies.length, canales, l.canales.length, l.nivel, l.semilla]);
    for (const s of l.especies) {
      f(composicion, [s.cuantos]); u(composicion + 8, [s.indice]); composicion += tamComposicion;
    }
    for (const c of l.canales) {
      u(canales, [c.a, c.b, c.fila]); canales += tamCanal;
    }
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
    limites: Int32Array.from(datos.lotes, l => l.canales.length * (1 + PASES_ENCADENADOS)) };
}

/** Compila el módulo fuera del plazo del primer paso ante un arranque con materiaGpu. */
export function prepararMateriaGpu(canal: CanalGpu, plazoMs: number): void {
  const dispositivo = `gpu${canal.dispositivo}` as const;
  const liberar = reservarCanalGpu(canal);
  if (!liberar) throw new ErrorDispositivo(dispositivo, 'El canal GPU está ocupado.');
  try {
    if (!canal.bytes) canal.crecer(1);
    enviarOrden(canal, { kind: 'prepararMateria', tick: 0, despacho: 0, subida: 0, bajada: 0, salida: 0 });
    const r = recibirRespuesta<{ ok: boolean; tick: number; despacho: number }>(canal, plazoMs);
    if (!r.ok || r.tick !== 0 || r.despacho !== 0) throw new Error('Eco de preparación material GPU inválido.');
  } catch (error) {
    try { canal.cerrar(); } catch { /* Se conserva la causa original. */ }
    throw error instanceof ErrorDispositivo ? error : new ErrorDispositivo(dispositivo,
      error instanceof Error ? error.message : String(error));
  } finally { liberar(); }
}

export function crearPasoMateriaGpu(canal: CanalGpu): PasoMateriaGpu {
  let pendiente: { tick: number; despacho: number; salida: number; maxTripletas: number; limites: Int32Array; liberar(): void } | undefined;
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
      const { binario, maxTripletas, nEspecies, nCanales, limites } = empaquetarMateriaGpu(c, lotes, kappas, dt);
      const n = limites.length, cabecera = Math.ceil((n + 1) / 2) * 8, subida = binario.byteLength;
      const salida = Math.ceil(subida / 8) * 8, bajada = cabecera + maxTripletas * 24;
      const liberar = maxTripletas ? reservarCanalGpu(canal) : () => {};
      if (!liberar) throw new ErrorDispositivo(dispositivo, 'El canal GPU está ocupado; el lote material sigue en CPU.');
      try {
        if (maxTripletas) {
          if (canal.bytes < salida + bajada) canal.crecer(salida + bajada);
          canal.escribir(0, new Uint8Array(binario));
          enviarOrden(canal, { kind: 'materia', tick, despacho: ++despacho, n, subida, salida, bajada, cabecera,
            nEspecies, nCanales, maxTripletas });
        }
        pendiente = { tick, despacho, salida, maxTripletas, limites, liberar };
      } catch (error) { liberar(); throw marcarFallo(error); }
    },
    esperar(plazoMs) {
      if (Number.isNaN(plazoMs) || plazoMs < 0) throw new RangeError('Plazo material GPU inválido.');
      const p = pendiente;
      if (!p) throw fallo ?? new Error('No hay un lote material GPU pendiente.');
      pendiente = undefined;
      const desde = new Int32Array(p.limites.length + 1);
      try {
        if (!p.maxTripletas) return { desde, tripletas: new Float64Array() };
        const r = recibirRespuesta<{ ok: boolean; tick: number; despacho: number; tripletas: number }>(canal, plazoMs);
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
        for (let i = 0; i < tripletas.length; i += 3) {
          const a = tripletas[i]!, b = tripletas[i + 1]!, veces = tripletas[i + 2]!;
          if (!Number.isInteger(a) || a <= 0 || a >= U32 || !Number.isInteger(b) || b < 0 || b >= U32
              || !Number.isSafeInteger(veces) || veces <= 0) throw new Error('Tripleta material GPU inválida.');
        }
        return { desde, tripletas };
      } catch (error) { throw marcarFallo(error); }
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
