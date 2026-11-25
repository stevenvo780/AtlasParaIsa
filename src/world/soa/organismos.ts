import { crc32 } from 'node:zlib';
import {
  COLUMNAS_FIJAS, genDe, refDe, slotDe,
  type Clase, type Col, type FrenteEscritura, type FrentePublico, type Hilo, type Ref, type Slot,
  type TablaOrganismos, type TipoColumna,
} from '../motor/contratos.js';

const MAX_GENERACION = 2 ** 21 - 1;
const RANURAS_REF = 2 ** 32;
const RESERVA_INICIAL = 16_384;
type Vectores = {
  f32: Float32Array<SharedArrayBuffer>; f64: Float64Array<SharedArrayBuffer>;
  i32: Int32Array<SharedArrayBuffer>; u16: Uint16Array<SharedArrayBuffer>; u8: Uint8Array<SharedArrayBuffer>;
};
type Vector<T extends TipoColumna = TipoColumna> = Vectores[T];
const VECTORES: { [T in TipoColumna]: {
  new (buffer: SharedArrayBuffer): Vector<T>; readonly BYTES_PER_ELEMENT: number;
} } = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u16: Uint16Array, u8: Uint8Array };
interface SABCrece extends SharedArrayBuffer { readonly maxByteLength: number; grow(bytes: number): void }
const SAB = SharedArrayBuffer as unknown as new (bytes: number, opciones: { maxByteLength: number }) => SABCrece;

function reservarColumna<T extends TipoColumna>(tipo: T, ancho: number, filas = 0): Vector<T> {
  const Vector = VECTORES[tipo];
  const longitud = Math.min(RANURAS_REF, Math.max(RESERVA_INICIAL, filas * 2)) * ancho;
  return new Vector(new SAB(filas * ancho * Vector.BYTES_PER_ELEMENT, { maxByteLength: longitud * Vector.BYTES_PER_ELEMENT }));
}

function crecerColumna<T extends TipoColumna>(columna: Vector<T>, tipo: T, ancho: number, filas: number): Vector<T> {
  const buffer = columna.buffer as SABCrece, bytes = filas * ancho * columna.BYTES_PER_ELEMENT;
  if (buffer.byteLength >= bytes) return columna;
  if (bytes <= buffer.maxByteLength) { buffer.grow(bytes); return columna; }
  // Si se agotó la reserva virtual, se amplía el lado que ya tiene el escritor.
  const nueva = reservarColumna(tipo, ancho, filas);
  nueva.set(columna);
  return nueva;
}

type Lado = 0 | 1;
interface Campo { ancho: number; tipo: TipoColumna; lados: [Vector, Vector] }

/** El coordinador intercambia los frentes en F6, tras publicar todos sus dueños. */
export class TablaOrganismosSoA implements TablaOrganismos {
  private readonly campos = new Map<string, Campo>();
  private lado: Lado = 0;
  private altas = 0;
  private capacidad: [number, number] = [0, 0];
  private lecturaActual: FrentePublico;
  private iniciado = false;
  private crc = 0;
  private readonly bajas: Slot[] = [];
  private readonly cuarentena: { tick: number; slot: Slot }[] = [];
  private primerRetiro = 0;
  private readonly libres: Slot[] = [];
  private escritoPor = new Int32Array(0);

  constructor(private readonly verificar = false) {
    for (const [nombre, tipo, ancho] of COLUMNAS_FIJAS) this.declarar(nombre, tipo, ancho);
    this.lecturaActual = this.frente(0, 0);
  }

  columna(nombre: string, tipo: TipoColumna, ancho: number): void {
    if (this.iniciado || this.altas) throw new Error('Las columnas se declaran antes de arrancar la tabla de organismos.');
    this.declarar(nombre, tipo, ancho);
    this.lecturaActual = this.frente(this.lecturaActual.tick, 0);
  }

  lectura(): FrentePublico { return this.lecturaActual; }

  escritura(hilo: Hilo): FrenteEscritura {
    const lectura = this.lecturaActual, lado = this.siguiente;
    const vigente = (): void => {
      if (this.lecturaActual !== lectura) throw new Error('Escritura de otro tick del frente de organismos.');
    };
    const vector = <T extends TipoColumna>(nombre: string, tipo: T): Vector<T> => {
      vigente();
      return this.vector(nombre, lado, tipo);
    };
    return {
      fila: slot => {
        vigente();
        this.validarDueño(hilo, slot);
        if (this.verificar) this.escritoPor[slot] = hilo;
      },
      f32: nombre => vector(nombre, 'f32'),
      f64: nombre => vector(nombre, 'f64'),
      i32: nombre => vector(nombre, 'i32'),
      u16: nombre => vector(nombre, 'u16'),
      u8: nombre => vector(nombre, 'u8'),
    };
  }

  alta(hilo: Hilo, clase: Clase): Ref {
    if (!Number.isInteger(hilo) || hilo < 0 || hilo > 0x7fffffff) throw new RangeError('Hilo de alta inválido.');
    this.liberarCuarentena();
    const slot = this.libres.pop() ?? this.altas;
    const lado = this.siguiente;
    if (slot === this.altas) {
      if (slot === RANURAS_REF) throw new RangeError('No quedan ranuras representables por Ref.');
      this.crecer(lado, slot + 1);
      this.altas++;
      if (this.verificar && slot === this.escritoPor.length) {
        const sellos = new Int32Array(this.capacidad[lado]).fill(-1);
        sellos.set(this.escritoPor);
        this.escritoPor = sellos;
      }
    }
    const gen = this.vector('gen', lado, 'i32');
    const generacion = gen[slot] || 1;
    for (const { ancho, lados } of this.campos.values()) lados[lado].fill(0, slot * ancho, (slot + 1) * ancho);
    gen[slot] = generacion;
    this.vector('vivo', lado, 'u8')[slot] = 1;
    this.vector('clase', lado, 'u8')[slot] = clase;
    this.vector('dueno', lado, 'i32')[slot] = hilo;
    this.vector('chunk', lado, 'i32')[slot] = -1;
    this.vector('objetivo', lado, 'i32')[slot] = -1;
    this.vector('pareja', lado, 'f64')[slot] = -1;
    return refDe(slot, generacion);
  }

  baja(hilo: Hilo, ref: Ref): void {
    const slot = slotDe(ref), lado = this.siguiente;
    this.validarDueño(hilo, slot);
    const gen = this.vector('gen', lado, 'i32'), vivo = this.vector('vivo', lado, 'u8');
    if (vivo[slot] !== 1 || gen[slot] !== genDe(ref)) throw new Error('Ref caducada al dar de baja un organismo.');
    vivo[slot] = 0;
    gen[slot] = Math.min(MAX_GENERACION, gen[slot]! + 1);
    this.bajas.push(slot);
    if (this.verificar) this.escritoPor[slot] = hilo;
  }

  verificarFrente(): void {
    if (this.verificar && this.crc !== this.sello(this.lecturaActual)) {
      throw new Error('CRC32 del frente público de organismos cambió durante el tick.');
    }
  }

  publicar(tick: number): FrentePublico {
    if (!Number.isSafeInteger(tick) || tick < this.lecturaActual.tick) throw new RangeError('Tick de frente inválido.');
    this.verificarFrente();
    if (this.verificar) {
      const vivo = this.vector('vivo', this.siguiente, 'u8');
      for (let slot = 0; slot < this.altas; slot++) {
        if (vivo[slot] && this.escritoPor[slot] !== this.dueñoVigente(slot)) {
          throw new Error(`El dueño no selló la fila ${slot} al publicar el frente.`);
        }
      }
    }
    this.iniciado = true;
    this.lado = this.siguiente;
    const publicado = this.lecturaActual = this.frente(tick, this.altas);
    if (this.verificar) {
      this.crc = this.sello(publicado);
      this.escritoPor.fill(-1);
    }
    for (const slot of this.bajas) this.cuarentena.push({ tick: tick + 2, slot });
    this.bajas.length = 0;
    this.crecer(this.siguiente, this.altas);
    for (const { ancho, lados } of this.campos.values()) {
      lados[this.siguiente].set(lados[this.lado].subarray(0, this.altas * ancho));
    }
    return publicado;
  }

  private get siguiente(): Lado { return this.lado === 0 ? 1 : 0; }

  private dueñoVigente(slot: Slot): Hilo {
    return this.lecturaActual.vivo[slot]
      ? this.lecturaActual.dueno[slot]! : this.vector('dueno', this.siguiente, 'i32')[slot]!;
  }

  private validarDueño(hilo: Hilo, slot: Slot): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.altas || this.dueñoVigente(slot) !== hilo) {
      throw new Error(`El hilo ${hilo} no es dueño de la fila ${slot}.`);
    }
  }

  private liberarCuarentena(): void {
    const gen = this.lecturaActual.gen, bajas = this.cuarentena;
    while (this.primerRetiro < bajas.length && bajas[this.primerRetiro]!.tick <= this.lecturaActual.tick) {
      const { slot } = bajas[this.primerRetiro++]!;
      if (gen[slot]! < MAX_GENERACION) this.libres.push(slot);
    }
    if (this.primerRetiro === bajas.length) {
      bajas.length = 0;
      this.primerRetiro = 0;
    } else if (this.primerRetiro > bajas.length / 2) {
      bajas.splice(0, this.primerRetiro);
      this.primerRetiro = 0;
    }
  }

  private declarar(nombre: string, tipo: TipoColumna, ancho: number): void {
    if (this.campos.has(nombre) || !Number.isSafeInteger(ancho) || ancho < 1) {
      throw new Error(`Columna de organismos inválida o duplicada: ${nombre}.`);
    }
    this.campos.set(nombre, { ancho, tipo, lados: [reservarColumna(tipo, ancho), reservarColumna(tipo, ancho)] });
  }

  private crecer(lado: Lado, filas: number): void {
    const anterior = this.capacidad[lado];
    if (filas <= anterior) return;
    const capacidad = Math.min(RANURAS_REF, Math.max(filas, Math.ceil(anterior * 1.25)));
    for (const { ancho, lados, tipo } of this.campos.values()) {
      lados[lado] = crecerColumna(lados[lado], tipo, ancho, capacidad);
    }
    this.capacidad[lado] = capacidad;
  }

  private campo(nombre: string): Campo {
    const campo = this.campos.get(nombre);
    if (!campo) throw new Error(`Columna de organismos desconocida: ${nombre}.`);
    return campo;
  }

  private vector<T extends TipoColumna>(nombre: string, lado: Lado, tipo: T): Vector<T> {
    const campo = this.campo(nombre);
    if (campo.tipo !== tipo) throw new TypeError(`La columna ${nombre} es de tipo ${campo.tipo} y no de tipo ${tipo}.`);
    return campo.lados[lado] as Vector<T>;
  }

  private frente(tick: number, alta: number): FrentePublico {
    const lado = this.lado, col = (nombre: string): Col => this.campo(nombre).lados[lado];
    return Object.freeze({
      tick, alta, columnas: Object.freeze([...this.campos.keys()]), col,
      gen: col('gen'), vivo: col('vivo'), clase: col('clase'), uid: col('uid'), dueno: col('dueno'),
      x: col('x'), y: col('y'), chunk: col('chunk'), accion: col('accion'), objetivo: col('objetivo'),
      decideEn: col('decideEn'), cuerpo: col('cuerpo'), rasgos: col('rasgos'), genoma: col('genoma'), pareja: col('pareja'),
    });
  }

  private sello(frente: FrentePublico): number {
    let crc = 0;
    for (const [nombre, { ancho }] of this.campos) {
      const col = frente.col(nombre);
      crc = crc32(new Uint8Array(col.buffer, col.byteOffset, frente.alta * ancho * col.BYTES_PER_ELEMENT), crc);
    }
    return crc;
  }
}
