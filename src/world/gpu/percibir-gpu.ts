import {
  CEREBRO, COLUMNAS_CEREBRO, COLUMNAS_FIJAS, ErrorDispositivo, RASGOS_ANCHO,
  type CanalGpu, type Col, type Dispositivo, type FrentePublico, type LotePercepcion, type Percepcion,
  type Percibidor, type Plan, type Terreno,
} from '../motor/contratos.js';
import { CanalGpuOcupado, enviarOrden, recibirRespuesta, reservarCanalGpu } from './canal.js';

const RADIO = 7;
const LADO = 2 * RADIO + 1, CENTRO = RADIO * LADO + RADIO;
export const CELDAS_VENTANA_GPU = LADO * LADO;
const CENTRO_FUERA = 253, SIN_RUTA_GPU = 254, FUERA_GPU = 255;
const PESOS_RED = COLUMNAS_CEREBRO.politica;
const PALABRAS_CABECERA = 16, PALABRAS_ACTOR = 9, PALABRAS_PLAN = 8;
const PALABRAS_CELDA = 7, PALABRAS_ORGANISMO = 6;
const BYTES_CELDA_CSR = 24, BYTES_FIJO_ORG = 24, CSR_VACIA = 0xffffffff;
const ANCHO_DINAMICA = CEREBRO.entradas + CEREBRO.acciones + RASGOS_ANCHO;
const BYTES_CEREBRO = (PESOS_RED + ANCHO_DINAMICA) * 4;
interface Filtro { indice: number; minimo: number; maximo: number }
interface Termino { campo: number; peso: number }
interface ConsultaCelda {
  terminos: readonly Termino[]; filtros: readonly Filtro[]; pesoDist: number; pesoPasos: number; alcanzable: boolean;
}
interface ConsultaVecino {
  radio: number; clase: number; criterio: number; columna: number; filtros: readonly Filtro[];
}
interface PlanPreparado {
  transitable: readonly Filtro[]; celdas: readonly ConsultaCelda[]; organismos: readonly ConsultaVecino[];
  acciones: number; w: Float32Array | null;
}
interface Componente { columna: Col; ancho: number; componente: number; clave: string }
interface SesionPercepcion {
  planes: readonly PlanPreparado[];
  campos: readonly Col[];
  indicesCampos: readonly number[];
  columnas: readonly Componente[];
  q: number; v: number; a: number;
}
interface CerebroFrente { observacion: Col; politica: Col; sesgo: Col; rasgos: Col }
function columna(frente: FrentePublico, nombre: string): Col {
  const fija = COLUMNAS_FIJAS.find(c => c[0] === nombre);
  return fija ? frente[fija[0]] : frente.col(nombre);
}

function filtros(datos: Float32Array, ancho: number, indice: (datos: Float32Array, i: number) => number): Filtro[] {
  if (datos.length % ancho) throw new RangeError('Filtros de percepción incompletos');
  const salida: Filtro[] = [];
  for (let i = 0; i < datos.length; i += ancho) {
    const minimo = datos[i + ancho - 2], maximo = datos[i + ancho - 1];
    if (Number.isNaN(minimo) || Number.isNaN(maximo)) throw new RangeError('Límite de percepción inválido');
    salida.push({ indice: indice(datos, i), minimo, maximo });
  }
  return salida;
}

function preparar(lote: LotePercepcion, planes: readonly Plan[], frente: FrentePublico, terreno: Terreno): SesionPercepcion {
  if (lote.slots.length !== lote.plan.length) throw new RangeError('Lote de percepción desalineado');
  for (let i = 0; i < lote.slots.length; i++) {
    const slot = lote.slots[i];
    if (lote.plan[i] >= planes.length || slot < 0 || slot >= frente.alta || frente.vivo[slot] !== 1
      || !Number.isSafeInteger(Math.floor(frente.x[slot])) || !Number.isSafeInteger(Math.floor(frente.y[slot]))) {
      throw new RangeError(`Actor inválido en el lote de percepción (${slot})`);
    }
  }
  const indicesCampos: number[] = [], campos: Col[] = [], columnas: Componente[] = [];
  const porCampo = new Map<number, number>(), porComponente = new Map<string, number>();
  const campo = (i: number): number => {
    const anterior = porCampo.get(i);
    if (anterior !== undefined) return anterior;
    if (!Number.isInteger(i) || i < 0 || i >= terreno.campos.length) throw new RangeError(`Campo de percepción inválido (${i})`);
    const k = campos.length;
    indicesCampos.push(i);
    campos.push(terreno.campo(terreno.campos[i]));
    porCampo.set(i, k);
    return k;
  };
  const componente = (indice: number, i: number): number => {
    const clave = `${indice}:${i}`;
    const anterior = porComponente.get(clave);
    if (anterior !== undefined) return anterior;
    if (!Number.isInteger(indice) || indice < 0 || indice >= frente.columnas.length) {
      throw new RangeError(`Columna de percepción inválida (${indice})`);
    }
    const nombre = frente.columnas[indice];
    const col = columna(frente, nombre);
    const fija = COLUMNAS_FIJAS.find(c => c[0] === nombre);
    const ancho = fija?.[2] ?? COLUMNAS_CEREBRO[nombre as keyof typeof COLUMNAS_CEREBRO]
      ?? (frente.alta === 0 ? i + 1 : col.length / frente.vivo.length);
    if (!Number.isInteger(ancho) || !Number.isInteger(i) || i < 0 || i >= ancho) {
      throw new RangeError(`Componente de percepción inválido (${nombre}, ${i})`);
    }
    const k = columnas.length;
    columnas.push({ columna: col, ancho, componente: i, clave: `${nombre}:${i}` });
    porComponente.set(clave, k);
    return k;
  };
  const filtrosCelda = (datos: Float32Array) => filtros(datos, 3, (d, i) => campo(d[i]));
  let q = 0, v = 0, a = 0;
  const preparados = planes.map((p, i): PlanPreparado => {
    if (p.id !== i || (p.acciones !== 0 && p.acciones !== CEREBRO.acciones)
      || (p.w !== null && (!p.acciones || p.w.length !== p.acciones * RASGOS_ANCHO))) {
      throw new RangeError(`Plan de percepción inválido (${i})`);
    }
    q = Math.max(q, p.celdas.length); v = Math.max(v, p.organismos.length); a = Math.max(a, p.acciones);
    return {
      transitable: filtrosCelda(p.transitable), acciones: p.acciones, w: p.w,
      celdas: p.celdas.map(c => {
        if (c.campos.length !== c.pesos.length || !Number.isFinite(c.pesoDist) || !Number.isFinite(c.pesoPasos)) {
          throw new RangeError('Ponderaciones de consulta inválidas');
        }
        return { terminos: Array.from(c.campos, (f, j) => ({ campo: campo(f), peso: c.pesos[j] })),
          filtros: filtrosCelda(c.filtros), pesoDist: Math.fround(c.pesoDist), pesoPasos: Math.fround(c.pesoPasos), alcanzable: c.alcanzable };
      }),
      organismos: p.organismos.map(c => {
        if (c.radio < 0 || !Number.isFinite(c.radio) || !Number.isFinite(Math.fround(c.radio)) || (c.criterio !== 0 && c.criterio !== 1)) {
          throw new RangeError('Consulta de organismo inválida');
        }
        return { radio: Math.fround(c.radio), clase: c.clase, criterio: c.criterio,
          columna: c.criterio ? componente(c.columna, c.componente) : 0,
          filtros: filtros(c.filtros, 4, (d, j) => componente(d[j], d[j + 1])) };
      }),
    };
  });
  return { planes: preparados, campos, indicesCampos, columnas, q, v, a };
}

function cerebroDe(frente: FrentePublico): CerebroFrente {
  return { observacion: frente.col('observacion'), politica: frente.col('politica'), sesgo: frente.col('sesgo'), rasgos: frente.rasgos };
}

function ventanasEn(x: number, y: number, terreno: Terreno, paginas: Int32Array): void {
  const ox = x - RADIO, oy = y - RADIO;
  const px = Math.floor(ox / 16) * 16, py = Math.floor(oy / 16) * 16;
  paginas.fill(-1);
  for (let dy = 0; dy <= Number(y + RADIO >= py + 16); dy++) {
    for (let dx = 0; dx <= Number(x + RADIO >= px + 16); dx++) {
      const celda = terreno.celda(px + 16 * dx + (x - Math.floor(x)), py + 16 * dy + (y - Math.floor(y)));
      if (celda >= 0) paginas[dy * 2 + dx] = terreno.chunkDe(celda);
    }
  }
}

const claveCelda = (x: number, y: number) => `${x},${y}`;

const alinear = (bytes: number, multiplo: number): number => Math.ceil(bytes / multiplo) * multiplo;

function tamanoResultado(n: number, q: number, v: number, a: number): number {
  return alinear(n * q * 10, 8) + n * (v * 8 + a * 4);
}

export interface PercepcionConVentanas extends Percepcion {
  readonly ventana: Int16Array;
  readonly ventanaCelda: Int32Array;
}

export function tieneVentanas(p: Percepcion): p is PercepcionConVentanas {
  return 'ventana' in p && p.ventana instanceof Int16Array && 'ventanaCelda' in p && p.ventanaCelda instanceof Int32Array;
}

/** Una ventana por fila. CUDA envía rutas BFS y transitabilidad; las celdas se reponen por sus cuatro páginas. */
function ventanasResultado(datos: Uint8Array, paginas: Int32Array): Pick<PercepcionConVentanas, 'ventana' | 'ventanaCelda'> {
  const n = paginas.length / 5;
  const ventana = new Int16Array(n * CELDAS_VENTANA_GPU), ventanaCelda = new Int32Array(ventana.length);
  for (let i = 0; i < n; i++) {
    const off = 5 * i, origen = paginas[off + 4];
    for (let y = 0, k = 0; y < LADO; y++) for (let x = 0; x < LADO; x++, k++) {
      const pos = i * CELDAS_VENTANA_GPU + k, ruta = datos[pos];
      if (ruta >= CENTRO_FUERA && ruta !== SIN_RUTA_GPU) {
        if ((ruta === CENTRO_FUERA) !== (k === CENTRO)) throw new Error('Centro de ventana GPU inválido.');
        ventana[pos] = ruta === CENTRO_FUERA ? 0 : -2;
        ventanaCelda[pos] = -1;
        continue;
      }
      if ((ruta >= CELDAS_VENTANA_GPU && ruta !== SIN_RUTA_GPU) || (ruta === 0) !== (k === CENTRO))
        throw new Error('Ruta de ventana GPU inválida.');
      const px = (origen & 15) + x, py = (origen >>> 4) + y;
      const pagina = paginas[off + 2 * (py >>> 4) + (px >>> 4)];
      if (pagina < 0) throw new Error('Ruta GPU en una página ausente.');
      ventana[pos] = ruta === SIN_RUTA_GPU ? -1 : ruta;
      ventanaCelda[pos] = pagina * 256 + (py & 15) * 16 + (px & 15);
    }
  }
  return { ventana, ventanaCelda };
}

function vistaResultado({ n, q, v, a, tick, despacho, paginasVentana }: PendienteGpu, buffer: ArrayBuffer): Percepcion {
  const nv = n * q, inicioOrganismos = alinear(nv * 10, 8);
  const p: Percepcion = { q, v, a, tick, despacho, celda: new Int32Array(buffer, 0, nv), valor: new Float32Array(buffer, nv * 4, nv),
    pasos: new Int16Array(buffer, nv * 8, nv), organismo: new Float64Array(buffer, inicioOrganismos, n * v),
    utilidad: new Float32Array(buffer, inicioOrganismos + n * v * 8, n * a) };
  if (!paginasVentana) return p;
  return { ...p, ...ventanasResultado(new Uint8Array(buffer, tamanoResultado(n, q, v, a)), paginasVentana) } satisfies PercepcionConVentanas;
}

// El formato es little endian y se escribe con vistas tipadas, que usan el orden de la máquina.
if (new Uint8Array(Uint16Array.of(1).buffer)[0] !== 1) throw new Error('La percepción GPU requiere una CPU little endian');

/** Carga binaria de una sola transferencia. Todos los offsets internos son bytes absolutos; u32 y f32 van
 * alineados a 4 y f64 a 8. */
class Empaquetador {
  private datos = new Uint8Array(65536);
  enteros = new Uint32Array(this.datos.buffer);
  flotantes = new Float32Array(this.datos.buffer);
  dobles = new Float64Array(this.datos.buffer);
  bytes = 0;

  reservar(bytes: number, alineacion = 4): number {
    const inicio = alinear(this.bytes, alineacion), fin = inicio + bytes;
    if (fin > 0xffffffff) throw new RangeError('El lote excede el formato de percepción');
    if (fin > this.datos.length) {
      const siguiente = new Uint8Array(alinear(Math.max(fin, this.datos.length * 2), 8));
      siguiente.set(this.datos.subarray(0, this.bytes));
      this.datos = siguiente;
      this.enteros = new Uint32Array(siguiente.buffer);
      this.flotantes = new Float32Array(siguiente.buffer);
      this.dobles = new Float64Array(siguiente.buffer);
    }
    this.bytes = fin;
    return inicio;
  }

  u32(i: number, valor: number): void { this.enteros[i >>> 2] = valor; }
  f32(i: number, valor: number): void { this.flotantes[i >>> 2] = valor; }
  palabras(i: number, valores: readonly number[]): void { for (const valor of valores) { this.u32(i, valor); i += 4; } }
  copiar(datos: Uint8Array): number {
    const inicio = this.reservar(datos.byteLength, 8);
    this.datos.set(datos, inicio);
    return inicio;
  }
  vistaActiva(): Uint8Array { return this.datos.subarray(0, this.bytes); }
  reiniciar(): void { this.bytes = 0; }
}

function empaquetarFiltros(b: Empaquetador, filtros: readonly Filtro[]): number {
  const inicio = b.reservar(filtros.length * 12);
  let i = inicio;
  for (const f of filtros) { b.u32(i, f.indice); b.f32(i + 4, f.minimo); b.f32(i + 8, f.maximo); i += 12; }
  return inicio;
}

function empaquetarPlanes(b: Empaquetador, planes: readonly PlanPreparado[]): number {
  const inicio = b.reservar(planes.length * PALABRAS_PLAN * 4);
  let ip = inicio;
  for (const p of planes) {
    const transitable = empaquetarFiltros(b, p.transitable);
    const celdas = b.reservar(p.celdas.length * PALABRAS_CELDA * 4);
    let ic = celdas;
    for (const c of p.celdas) {
      const terminos = b.reservar(c.terminos.length * 8);
      let it = terminos;
      for (const t of c.terminos) { b.u32(it, t.campo); b.f32(it + 4, t.peso); it += 8; }
      const filtros = empaquetarFiltros(b, c.filtros);
      b.palabras(ic, [terminos, c.terminos.length, filtros, c.filtros.length]);
      b.f32(ic + 16, c.pesoDist); b.f32(ic + 20, c.pesoPasos); b.u32(ic + 24, Number(c.alcanzable));
      ic += PALABRAS_CELDA * 4;
    }
    const organismos = b.reservar(p.organismos.length * PALABRAS_ORGANISMO * 4);
    let io = organismos;
    for (const c of p.organismos) {
      const filtros = empaquetarFiltros(b, c.filtros);
      b.f32(io, c.radio);
      b.palabras(io + 4, [c.clase, filtros, c.filtros.length, c.criterio, c.columna]);
      io += PALABRAS_ORGANISMO * 4;
    }
    const w = p.w ? b.reservar(p.w.byteLength) : 0;
    if (p.w) for (let j = 0; j < p.w.length; j++) b.f32(w + j * 4, p.w[j]);
    b.palabras(ip, [transitable, p.transitable.length, celdas, p.celdas.length, organismos, p.organismos.length, p.acciones, w]);
    ip += PALABRAS_PLAN * 4;
  }
  return inicio;
}

function hashCelda(x: number, y: number): number {
  const h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  return (h ^ (h >>> 16)) >>> 0;
}

interface CeldaResidente {
  x: number; y: number; slots: Set<number>; cubeta: number; inicio: number; capacidad: number;
}
interface CsrGpu { indices: number; n: number; rejilla: number; mascara: number; anchoFila: number; bytes: number }

const potenciaDeDos = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const bytesDe = (vista: Uint32Array): Uint8Array => new Uint8Array(vista.buffer, vista.byteOffset, vista.byteLength);

/** Copia en la fila de cada organismo vivo la componente de columna que piden las consultas, y marca la fila si cambió. */
function compararColumna(c: Componente, dobles: Float64Array, primero: number, doblesFila: number,
  enteros: Uint32Array, palabras: number, filas: number, cambiadas: Uint8Array): void {
  const { columna, ancho, componente } = c;
  for (let slot = 0, j = primero, i = 4; slot < filas; slot++, j += doblesFila, i += palabras) {
    if (enteros[i] === 0) continue;
    const valor = columna[slot * ancho + componente], antes = dobles[j];
    // NaN se compara consigo mismo para no reenviar la fila en cada tick.
    if (valor !== antes && (valor === valor || antes === antes)) { dobles[j] = valor; cambiadas[slot] = 1; }
  }
}

/** Los organismos conservan su fila por slot. Mover uno modifica su fila y dos spans de la rejilla CSR. */
class EspejoOrganismos {
  private filas = new Uint8Array();
  private cambiadas = new Uint8Array();
  private alcance = 0;
  private anchoFila = 0;
  private claveColumnas = '';
  private rejilla = new Uint32Array();
  private indices = new Uint32Array();
  private usados = 0;
  private readonly celdas = new Map<string, CeldaResidente>();
  private readonly libres = new Map<number, number[]>();

  actualizar(frente: FrentePublico, columnas: readonly Componente[], claveColumnas: string,
    parche: (offset: number, datos: Uint8Array) => void): CsrGpu {
    const anchoFila = BYTES_FIJO_ORG + columnas.length * 8;
    const antesFilas = this.filas.byteLength, antesRejilla = this.rejilla.byteLength;
    const cambioColumnas = claveColumnas !== this.claveColumnas;
    if (cambioColumnas) {
      this.celdas.clear(); this.libres.clear(); this.usados = 0; this.alcance = 0;
      this.filas = new Uint8Array(); this.rejilla = new Uint32Array();
    }
    const filasMinimas = frente.alta * anchoFila;
    if (this.filas.byteLength < filasMinimas || this.anchoFila !== anchoFila) {
      const nuevas = new Uint8Array(potenciaDeDos(frente.alta) * anchoFila);
      nuevas.set(this.filas);
      this.filas = nuevas;
    }
    this.claveColumnas = claveColumnas;
    this.anchoFila = anchoFila;
    const { vivo, x, y, gen, clase, alta } = frente;
    const { buffer } = this.filas;
    const enteros = new Uint32Array(buffer), flotantes = new Float32Array(buffer), dobles = new Float64Array(buffer);
    const sucias = new Set<CeldaResidente>();
    const filasNuevas = cambioColumnas || antesFilas !== this.filas.byteLength;
    const filasPrevias = this.alcance, filasARevisar = Math.max(alta, filasPrevias);
    const palabras = anchoFila >> 2;
    if (this.cambiadas.length < filasARevisar) this.cambiadas = new Uint8Array(potenciaDeDos(filasARevisar));
    else this.cambiadas.fill(0, 0, filasARevisar);
    const cambiadas = this.cambiadas;
    for (let slot = 0, i = 0; slot < filasARevisar; slot++, i += palabras) {
      const tipo = slot < alta && vivo[slot] === 1 ? clase[slot] : 0;
      const tipoAntes = enteros[i + 4];
      if (tipo === 0 && tipoAntes === 0) continue;
      const nx = tipo ? x[slot] : 0, ny = tipo ? y[slot] : 0, generacion = tipo ? gen[slot] : 0;
      const ax = flotantes[i + 2], ay = flotantes[i + 3];
      if (tipo === tipoAntes && nx === ax && ny === ay && enteros[i + 1] === generacion) continue;
      const rx = Math.floor(nx), ry = Math.floor(ny), bx = Math.floor(ax), by = Math.floor(ay);
      if (rx !== bx || ry !== by || (tipo === 0) !== (tipoAntes === 0)) {
        if (tipoAntes) {
          const anterior = this.celdas.get(claveCelda(bx, by))!;
          anterior.slots.delete(slot); sucias.add(anterior);
        }
        if (tipo) {
          const clave = claveCelda(rx, ry);
          let celda = this.celdas.get(clave);
          if (!celda) {
            celda = { x: rx, y: ry, slots: new Set(), cubeta: -1, inicio: 0, capacidad: 0 };
            this.celdas.set(clave, celda);
          }
          celda.slots.add(slot); sucias.add(celda);
        }
      }
      enteros[i] = slot; enteros[i + 1] = generacion;
      flotantes[i + 2] = nx; flotantes[i + 3] = ny; enteros[i + 4] = tipo;
      cambiadas[slot] = 1;
    }
    for (let k = 0; k < columnas.length; k++) {
      compararColumna(columnas[k], dobles, (BYTES_FIJO_ORG >> 3) + k, anchoFila >> 3, enteros, palabras, filasARevisar, cambiadas);
    }
    // Las filas contiguas que cambiaron viajan en un solo parche.
    if (!filasNuevas) for (let slot = 0; slot < filasPrevias; slot++) {
      if (!cambiadas[slot]) continue;
      let fin = slot + 1;
      while (fin < filasPrevias && cambiadas[fin]) fin++;
      parche(slot * anchoFila, this.filas.subarray(slot * anchoFila, fin * anchoFila));
      slot = fin;
    }
    this.alcance = alta;
    const nuevasDesde = filasNuevas ? 0 : filasPrevias * anchoFila;
    if (filasMinimas > nuevasDesde) parche(nuevasDesde, this.filas.subarray(nuevasDesde, filasMinimas));

    const cubetas = this.rejilla.byteLength / BYTES_CELDA_CSR;
    const rehash = cubetas === 0 || this.celdas.size * 2 > cubetas;
    if (rehash) {
      for (const [clave, c] of this.celdas) {
        if (!c.slots.size) { this.liberar(c); this.celdas.delete(clave); sucias.delete(c); }
        else c.cubeta = -1;
      }
      this.rejilla = new Uint32Array(Math.max(2, potenciaDeDos(this.celdas.size * 2), cubetas) * (BYTES_CELDA_CSR / 4)).fill(CSR_VACIA);
    }
    const inicioRejilla = this.filas.byteLength, inicioIndices = inicioRejilla + this.rejilla.byteLength;
    const rejillaEntera = rehash || inicioRejilla !== antesFilas;
    const indicesEnteros = inicioIndices !== antesFilas + antesRejilla;
    const mascara = this.rejilla.byteLength / BYTES_CELDA_CSR - 1;
    for (const c of sucias) {
      if (!c.slots.size || c.slots.size > c.capacidad) {
        this.liberar(c);
        if (c.slots.size) this.reservar(c);
      }
      let i = c.inicio;
      for (const slot of c.slots) this.indices[i++] = slot;
      if (c.slots.size && !indicesEnteros) parche(inicioIndices + c.inicio * 4, bytesDe(this.indices.subarray(c.inicio, i)));
    }
    const mapa = new DataView(this.rejilla.buffer);
    for (const c of rehash ? this.celdas.values() : sucias) {
      let cubeta = c.cubeta;
      if (cubeta < 0) {
        cubeta = hashCelda(c.x, c.y) & mascara;
        while (mapa.getUint32(cubeta * BYTES_CELDA_CSR + 16, true) !== CSR_VACIA) cubeta = (cubeta + 1) & mascara;
        c.cubeta = cubeta;
      }
      const off = cubeta * BYTES_CELDA_CSR;
      mapa.setFloat64(off, c.x, true); mapa.setFloat64(off + 8, c.y, true);
      mapa.setUint32(off + 16, c.inicio, true); mapa.setUint32(off + 20, c.slots.size, true);
      if (!rejillaEntera) parche(inicioRejilla + off, bytesDe(this.rejilla.subarray(off / 4, (off + BYTES_CELDA_CSR) / 4)));
    }
    if (rejillaEntera) parche(inicioRejilla, bytesDe(this.rejilla));
    if (indicesEnteros && this.usados) parche(inicioIndices, bytesDe(this.indices.subarray(0, this.usados)));
    return { indices: inicioIndices, n: frente.alta, rejilla: inicioRejilla, mascara, anchoFila, bytes: inicioIndices + this.usados * 4 };
  }

  completo(csr: CsrGpu, parche: (offset: number, datos: Uint8Array) => void): void {
    if (csr.n) parche(0, this.filas.subarray(0, csr.n * csr.anchoFila));
    parche(csr.rejilla, bytesDe(this.rejilla));
    if (this.usados) parche(csr.indices, bytesDe(this.indices.subarray(0, this.usados)));
  }

  private liberar(c: CeldaResidente): void {
    if (!c.capacidad) return;
    const lista = this.libres.get(c.capacidad) ?? [];
    lista.push(c.inicio); this.libres.set(c.capacidad, lista);
    c.inicio = 0; c.capacidad = 0;
  }

  private reservar(c: CeldaResidente): void {
    c.capacidad = potenciaDeDos(c.slots.size);
    const disponible = this.libres.get(c.capacidad)?.pop();
    if (disponible !== undefined) { c.inicio = disponible; return; }
    c.inicio = this.usados;
    this.usados += c.capacidad;
    if (this.indices.length < this.usados) {
      const siguiente = new Uint32Array(potenciaDeDos(this.usados));
      siguiente.set(this.indices);
      this.indices = siguiente;
    }
  }
}

interface RevisionCsr {
  origen: CsrCompartido; frente: FrentePublico; tick: number; clave: string; numero: number; csr: CsrGpu;
  cambios: readonly { offset: number; datos: Uint8Array }[];
}

/** Las tarjetas del mismo terreno pueden preparar un único delta, aunque cada espejo confirme por separado. */
class CsrCompartido {
  private espejo = new EspejoOrganismos();
  private actual?: RevisionCsr;
  private numero = 0;

  lote(frente: FrentePublico, columnas: readonly Componente[], aplicada: RevisionCsr | undefined,
    parche: (offset: number, datos: Uint8Array) => void): RevisionCsr {
    const anterior = this.actual, clave = columnas.map(c => c.clave).join(',');
    if (anterior?.frente !== frente || anterior.tick !== frente.tick || anterior.clave !== clave) {
      if (anterior && frente.tick < anterior.tick) this.espejo = new EspejoOrganismos();
      const cambios: { offset: number; datos: Uint8Array }[] = [];
      const numero = ++this.numero;
      try {
        const csr = this.espejo.actualizar(frente, columnas, clave, (offset, datos) => cambios.push({ offset, datos }));
        this.actual = { origen: this, frente, tick: frente.tick, clave, numero, csr, cambios };
      } catch (error) {
        this.espejo = new EspejoOrganismos();
        this.actual = undefined;
        throw error;
      }
    }
    const actual = this.actual!;
    if (aplicada === actual) return actual;
    if (actual.numero === 1 || (aplicada?.origen === this && aplicada.numero + 1 === actual.numero)) {
      for (const { offset, datos } of actual.cambios) parche(offset, datos);
    } else {
      this.espejo.completo(actual.csr, parche);
    }
    return actual;
  }
}

const csrTerreno = new WeakMap<Terreno, CsrCompartido>();

function obtenerCsr(terreno: Terreno): CsrCompartido {
  let cache = csrTerreno.get(terreno);
  if (!cache) { cache = new CsrCompartido(); csrTerreno.set(terreno, cache); }
  return cache;
}

interface Parche { destino: number; offset: number; fuente: number; bytes: number }
interface PendienteGpu {
  n: number; q: number; v: number; a: number; tick: number; despacho: number; salida: number; bajada: number;
  paginasVentana?: Int32Array;
  confirmar: () => void;
  liberar: () => void;
}
interface FilaCerebro { gen: number; dinamica: Float32Array }

interface CampoPagina {
  version: number; x: number; y: number; datos: Float64Array;
}
const columnasPorTerreno = new WeakMap<Terreno, Map<number, Map<number, CampoPagina>>>();

function muestraCampo(terreno: Terreno, pagina: number, campo: number, columna: Col): Float64Array {
  let paginas = columnasPorTerreno.get(terreno);
  if (!paginas) { paginas = new Map(); columnasPorTerreno.set(terreno, paginas); }
  let campos = paginas.get(pagina);
  if (!campos) { campos = new Map(); paginas.set(pagina, campos); }
  const version = terreno.versionPagina[pagina], x = terreno.paginaX[pagina], y = terreno.paginaY[pagina];
  const anterior = campos.get(campo);
  if (anterior?.version === version && anterior.x === x && anterior.y === y) return anterior.datos;
  const offset = pagina * 256;
  let iguales = anterior !== undefined;
  for (let i = 0; iguales && i < 256; i++) iguales = Object.is(columna[offset + i], anterior!.datos[i]);
  const datos = iguales ? anterior!.datos : new Float64Array(256);
  if (!iguales) for (let i = 0; i < datos.length; i++) datos[i] = columna[offset + i];
  campos.set(campo, { version, x, y, datos });
  return datos;
}

function copiarDistinta(origen: Col, desde: number, destino: Float32Array, hasta: number, ancho: number): boolean {
  let cambio = false;
  for (let i = 0; i < ancho; i++) {
    // Las columnas del cerebro son f64 y la tarjeta las lee en f32: se compara lo que se subiría.
    const valor = Math.fround(origen[desde + i]), antes = destino[hasta + i];
    if (valor !== antes && (valor === valor || antes === antes)) { destino[hasta + i] = valor; cambio = true; }
  }
  return cambio;
}

export class PercibidorGpu implements Percibidor {
  readonly dispositivo: Dispositivo;
  private readonly binario = new Empaquetador();
  private readonly paginas = new Map<number, number>();
  private readonly columnasResidentes = new Map<number, readonly Float64Array[]>();
  private readonly cerebros = new Map<number, FilaCerebro>();
  private csr?: RevisionCsr;
  private campos = '';
  private pendiente?: PendienteGpu;
  private fallo?: ErrorDispositivo;
  private transferencia = { subidos: 0, bajados: 0, ms: 0 };

  constructor(private readonly canal: CanalGpu, private frente: FrentePublico, private terreno: Terreno, private readonly v23 = false) {
    this.dispositivo = `gpu${canal.dispositivo}`;
  }

  get ultimasTransferencias(): Readonly<{ subidos: number; bajados: number; ms: number }> { return this.transferencia; }

  fuentes(frente: FrentePublico, terreno: Terreno): void {
    if (this.pendiente) throw new Error('El lote GPU pendiente todavía usa sus fuentes');
    if (terreno !== this.terreno || frente.tick < this.frente.tick) {
      this.paginas.clear(); this.columnasResidentes.clear(); this.csr = undefined;
      if (frente.tick < this.frente.tick) columnasPorTerreno.delete(terreno);
    }
    // Otro terreno es otro mundo (un clon, una carga): su tabla da las mismas gen a otros ocupantes de los mismos slots.
    if (terreno !== this.terreno || frente.tick < this.frente.tick) this.cerebros.clear();
    this.frente = frente; this.terreno = terreno;
  }

  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    if (this.fallo) throw this.fallo;
    if (this.pendiente) throw new Error('Ya hay un lote GPU de percepción pendiente');
    const { frente, terreno, binario: b } = this;
    const sesion = preparar(lote, planes, frente, terreno);
    const { campos, q, v, a } = sesion, n = lote.slots.length;
    const columnasTerreno = sesion.indicesCampos.join(',');
    const bajada = tamanoResultado(n, q, v, a) + (this.v23 ? n * CELDAS_VENTANA_GPU : 0);
    if (n === 0) {
      this.transferencia = { subidos: 0, bajados: 0, ms: 0 };
      this.pendiente = { n, q, v, a, tick: lote.tick, despacho: lote.despacho, salida: 0, bajada,
        paginasVentana: this.v23 ? new Int32Array() : undefined, confirmar: () => {}, liberar: () => {} };
      return;
    }
    const liberar = reservarCanalGpu(this.canal);
    if (!liberar) throw new CanalGpuOcupado(this.canal);
    const parches: Parche[] = [], paginasNuevas = new Map<number, number>();
    try {
      const cerebro = lote.plan.some(i => sesion.planes[i].acciones > 0) ? cerebroDe(frente) : undefined;
      if (columnasTerreno !== this.campos) { this.paginas.clear(); this.columnasResidentes.clear(); }
      b.reiniciar();
      b.reservar(PALABRAS_CABECERA * 4);
      const plan = empaquetarPlanes(b, sesion.planes), actores = b.reservar(n * PALABRAS_ACTOR * 4);
      const parcheOrganismo = (offset: number, datos: Uint8Array) => {
        parches.push({ destino: 2, offset, fuente: b.copiar(datos), bytes: datos.byteLength });
      };
      const csr = v ? obtenerCsr(terreno).lote(frente, sesion.columnas, this.csr, parcheOrganismo) : undefined;
      this.enviarLote(lote, sesion, terreno, frente, cerebro, plan, actores, csr, parches, paginasNuevas, columnasTerreno, bajada, liberar);
    } catch (error) { liberar(); throw this.marcarFallo(error); }
  }

  private enviarLote(lote: LotePercepcion, sesion: SesionPercepcion, terreno: Terreno, frente: FrentePublico,
    cerebro: CerebroFrente | undefined, plan: number, actores: number, revisionCsr: RevisionCsr | undefined,
    parches: Parche[], paginasNuevas: Map<number, number>, columnasTerreno: string, bajada: number, liberar: () => void): void {
    const { binario: b } = this;
    const { campos, q, v, a } = sesion, n = lote.slots.length;
    const paginas = new Int32Array(4);
    const paginasVentana = this.v23 ? new Int32Array(n * 5) : undefined;
    const columnasNuevas = new Map<number, readonly Float64Array[]>();
    const bytesPagina = campos.length * 256 * 8;
    let terrenoBytes = 0, cerebroBytes = 0;
    for (let i = 0; i < n; i++) {
      const slot = lote.slots[i], x = frente.x[slot], y = frente.y[slot], p = sesion.planes[lote.plan[i]];
      const off = actores + i * PALABRAS_ACTOR * 4;
      b.u32(off, slot); b.u32(off + 4, lote.plan[i]); b.f32(off + 8, x); b.f32(off + 12, y);
      if (this.v23) ventanasEn(x, y, terreno, paginas);
      else if (p.celdas.length) ventanasEn(Math.floor(x), Math.floor(y), terreno, paginas);
      else paginas.fill(-1);
      const origen = ((Math.floor(y) - RADIO) & 15) * 16 + ((Math.floor(x) - RADIO) & 15);
      if (paginasVentana) {
        paginasVentana.set(paginas, 5 * i);
        paginasVentana[5 * i + 4] = origen;
      }
      for (let j = 0; j < paginas.length; j++) {
        const pagina = paginas[j];
        b.u32(off + 16 + j * 4, pagina);
        if (pagina < 0 || !bytesPagina) continue;
        terrenoBytes = Math.max(terrenoBytes, (pagina + 1) * bytesPagina);
        if (this.v23) {
          if (columnasNuevas.has(pagina)) continue;
          const anterior = this.columnasResidentes.get(pagina);
          const columnas = campos.map((campo, k) => {
            const datos = muestraCampo(terreno, pagina, sesion.indicesCampos[k]!, campo);
            if (datos !== anterior?.[k]) {
              const fuente = b.reservar(datos.byteLength, 8);
              b.dobles.set(datos, fuente / 8);
              parches.push({ destino: 0, offset: pagina * bytesPagina + k * datos.byteLength, fuente, bytes: datos.byteLength });
            }
            return datos;
          });
          columnasNuevas.set(pagina, columnas);
          continue;
        }
        const version = terreno.versionPagina[pagina];
        if (this.paginas.get(pagina) === version || paginasNuevas.has(pagina)) continue;
        const fuente = b.reservar(bytesPagina, 8), dobles = b.dobles;
        for (let k = 0, d = fuente >>> 3; k < campos.length; k++, d += 256) {
          const campo = campos[k];
          for (let c = 0, desde = pagina * 256; c < 256; c++) dobles[d + c] = campo[desde + c];
        }
        paginasNuevas.set(pagina, version);
        parches.push({ destino: 0, offset: pagina * bytesPagina, fuente, bytes: bytesPagina });
      }
      if (p.acciones) {
        cerebroBytes = Math.max(cerebroBytes, (slot + 1) * BYTES_CEREBRO);
        this.parcheCerebro(slot, frente.gen[slot], cerebro!, parches);
      }
      b.u32(off + 32, origen);
    }
    const csr = revisionCsr?.csr, organismosBytes = csr?.bytes ?? 0;
    if (Math.max(terrenoBytes, cerebroBytes, organismosBytes) > 0xffffffff) {
      throw new ErrorDispositivo(this.dispositivo, 'Espejo GPU fuera del rango del formato');
    }
    const ptrParches = b.reservar(parches.length * 16);
    for (let i = 0; i < parches.length; i++) {
      const p = parches[i];
      b.palabras(ptrParches + i * 16, [p.destino, p.offset, p.fuente, p.bytes / 4]);
    }
    b.palabras(0, [n, q, v, a, actores, plan, csr?.indices ?? 0, csr?.n ?? 0, csr?.rejilla ?? 0, csr?.mascara ?? 0, csr?.anchoFila ?? 0, campos.length,
      ptrParches, parches.length, Number(this.v23), 0]);
    const subida = b.bytes, salida = alinear(subida, 8);
    if (this.canal.bytes < salida + bajada) this.canal.crecer(salida + bajada);
    this.canal.escribir(0, b.vistaActiva());
    const { tick, despacho } = lote;
    enviarOrden(this.canal, { kind: 'percibir', tick, despacho, n, subida, bajada, salida, terrenoBytes, cerebroBytes, organismosBytes, parches: parches.length });
    this.transferencia = { subidos: subida, bajados: bajada, ms: 0 };
    this.pendiente = { n, q, v, a, tick, despacho, salida, bajada, paginasVentana, liberar, confirmar: () => {
      this.campos = columnasTerreno;
      if (revisionCsr) this.csr = revisionCsr;
      for (const [pagina, version] of paginasNuevas) this.paginas.set(pagina, version);
      for (const [pagina, columnas] of columnasNuevas) this.columnasResidentes.set(pagina, columnas);
    } };
  }

  private parcheCerebro(slot: number, gen: number, cerebro: CerebroFrente, parches: Parche[]): void {
    const anterior = this.cerebros.get(slot);
    const nueva = anterior?.gen !== gen;
    const dinamica = anterior?.dinamica ?? new Float32Array(ANCHO_DINAMICA);
    const { entradas, acciones } = CEREBRO;
    const observacion = copiarDistinta(cerebro.observacion, slot * entradas, dinamica, 0, entradas);
    const sesgo = copiarDistinta(cerebro.sesgo, slot * acciones, dinamica, entradas, acciones);
    const rasgos = copiarDistinta(cerebro.rasgos, slot * RASGOS_ANCHO, dinamica, entradas + acciones, RASGOS_ANCHO);
    const modificada = nueva || observacion || sesgo || rasgos;
    if (!modificada) return;
    const inicio = nueva ? 0 : PESOS_RED * 4;
    const bytes = BYTES_CEREBRO - inicio, fuente = this.binario.reservar(bytes, 8);
    const flotantes = this.binario.flotantes;
    let pos = fuente >>> 2;
    if (nueva) {
      for (let k = 0, desde = slot * PESOS_RED; k < PESOS_RED; k++) flotantes[pos++] = cerebro.politica[desde + k];
      this.cerebros.set(slot, { gen, dinamica });
    }
    flotantes.set(dinamica, pos);
    parches.push({ destino: 1, offset: slot * BYTES_CEREBRO + inicio, fuente, bytes });
  }

  esperar(plazoMs: number): Percepcion {
    const p = this.pendiente;
    if (!p) throw this.fallo ?? new Error('No hay un lote GPU de percepción pendiente');
    this.pendiente = undefined;
    const buffer = new ArrayBuffer(p.bajada);
    try {
      if (p.n !== 0) {
        const respuesta = recibirRespuesta<{ ok: boolean; ms: number; tick: number; despacho: number }>(this.canal, plazoMs);
        if (respuesta.ok !== true || !Number.isFinite(respuesta.ms) || respuesta.ms < 0) throw new Error('Respuesta de percepción GPU inválida');
        // El eco del contrato: una respuesta de otro despacho no se lee como la de este.
        if (respuesta.tick !== p.tick || respuesta.despacho !== p.despacho)
          throw new Error(`Respuesta del despacho ${respuesta.despacho} (tick ${respuesta.tick}) en el ${p.despacho} (tick ${p.tick})`);
        if (p.bajada !== 0) this.canal.leer(p.salida, new Uint8Array(buffer));
        this.transferencia = { ...this.transferencia, ms: respuesta.ms };
      }
      const resultado = vistaResultado(p, buffer);
      p.confirmar();
      return resultado;
    } catch (error) { throw this.marcarFallo(error); }
    finally { p.liberar(); }
  }

  private marcarFallo(error: unknown): ErrorDispositivo {
    this.fallo = error instanceof ErrorDispositivo ? error : new ErrorDispositivo(this.dispositivo,
      error instanceof Error ? error.message : String(error));
    try { this.canal.cerrar(); } catch { /* El primer error explica la caída. */ }
    return this.fallo;
  }
}
