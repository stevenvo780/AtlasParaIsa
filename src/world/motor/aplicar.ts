/**
 * INTERFAZ PUENTE del aplicador de intentos (carril m5; ARQ-motor §3.2). El esqueleto lo fijó la preparación de la
 * oleada: m5 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las consume m4a).
 *
 * El dueño destino aplica cada intento contra su estado actual. Orden de resolución de un intento: los `Ley.aplicar`
 * de las leyes encendidas, en el orden de `LEYES`, hasta que una devuelva 'hecho' o 'rechazo'; si todas pasan, el
 * aplicador genérico de la materia (Tomar, Depositar, Dar, Concedido y Devuelto sobre lotes, con recorte a existencias).
 * Toda garantía termina en ≤ 2 ticks: abonada, devuelta al emisor o depositada en el Suelo (I-B). Un (nonce, tipo) ya
 * aplicado no se repite.
 */
import { leyInteracciones } from '../actuar/interacciones.js';
import { abonar as abonarCuerpo } from '../materia/cuerpo.js';
import { kappaDeRol } from '../materia/ley-mundo.js';
import { Parte, Rol, type Cuerpo, type LoteRef, type Pedido } from '../materia/tipos.js';
import type { CtxLey, CtxLeyMateria } from './acceso.js';
import {
  Clase, DATO_MATERIA, DATO_TOMAR, REF_NULA, TipoIntento, genDe, slotDe,
  type Cola, type Hilo, type Intento, type Ref, type Slot,
} from './contratos.js';
import { leyesActivas } from './leyes.js';

export { leyInteracciones };

// Incluye el tick del primer intento y los dos ticks en los que puede seguir en tránsito.
const VENTANA_NONCE_TICKS = 3;
const VACIO = new Float64Array(0);
const AL_DIGESTIVO = new Float64Array([Rol.Digestivo, 0]);
const A_LA_RESERVA = new Float64Array([Rol.Reserva, 0]);
let lotesCelda = new Float64Array(1);

export interface BalanceAplicador {
  enviados: number;
  aplicados: number;
  devueltos: number;
  depositados: number;
  reenviados: number;
  duplicados: number;
}

type Resultado = 'aplicados' | 'devueltos' | 'depositados' | 'reenviados';
type Nonces = Map<number, number>;
interface Estado {
  tick: number;
  vistos: Nonces[];
  reenviados: Nonces;
  balance: BalanceAplicador;
}
const estados = new WeakMap<CtxLey, Estado>();
const balanceVacio = (): BalanceAplicador =>
  ({ enviados: 0, aplicados: 0, devueltos: 0, depositados: 0, reenviados: 0, duplicados: 0 });

function estadoDe(c: CtxLey): Estado {
  let e = estados.get(c);
  if (!e) {
    e = { tick: c.tick, vistos: Array.from({ length: VENTANA_NONCE_TICKS }, () => new Map()),
      reenviados: new Map(), balance: balanceVacio() };
    estados.set(c, e);
  } else if (e.tick !== c.tick) {
    const desde = Math.max(e.tick + 1, c.tick - VENTANA_NONCE_TICKS + 1);
    for (let tick = desde; tick <= c.tick; tick++) e.vistos[tick % VENTANA_NONCE_TICKS].clear();
    e.tick = c.tick;
    e.reenviados.clear();
    e.balance = balanceVacio();
  }
  return e;
}

/** El motor lo llama una vez después de cada envío efectivo de su buzón. */
export function contarEnvioIntento(c: CtxLey): void {
  estadoDe(c).balance.enviados++;
}

/** Totales de este dueño en el tick actual. El coordinador los reúne al cerrar el tick. */
export function balanceAplicador(c: CtxLey): BalanceAplicador {
  return { ...estadoDe(c).balance };
}

function slotVivo(c: CtxLey, r: Ref): Slot {
  if (r === REF_NULA) return REF_NULA;
  const s = slotDe(r), f = c.frente;
  if (s >= f.alta || f.vivo[s] !== 1 || f.gen[s] !== genDe(r)) return REF_NULA;
  if (f.dueno[s] === c.hilo && c.ref(f.uid[s]) !== r) return REF_NULA;
  return s;
}

function celdaDe(c: CtxLey, r: Ref, reserva: number): number {
  if (r === REF_NULA) return reserva;
  const s = slotDe(r), f = c.frente;
  const gen = genDe(r);
  if (s >= f.alta || (f.gen[s] !== gen && !(f.vivo[s] === 0 && f.gen[s] === gen + 1))) return reserva;
  const celda = c.terreno.celda(f.x[s], f.y[s]);
  return celda < 0 ? reserva : celda;
}

function duenoDeCelda(c: CtxLey, celda: number): Hilo {
  if (celda < 0) return REF_NULA;
  return c.terreno.duenoChunk[c.terreno.chunkDe(celda)] ?? REF_NULA;
}

function loteEnCelda(c: CtxLeyMateria, celda: number, rol: Rol, forma?: number): LoteRef {
  const n = c.materia.lotes(celda, rol, lotesCelda);
  if (!n) return REF_NULA;
  if (forma === undefined || rol <= Rol.Aire) return lotesCelda[0];
  if (n > lotesCelda.length) {
    lotesCelda = new Float64Array(n);
    c.materia.lotes(celda, rol, lotesCelda);
  }
  for (let j = 0; j < n; j++) {
    if (c.materia.vista(lotesCelda[j]).forma === forma) return lotesCelda[j];
  }
  return REF_NULA;
}

function cuerpoEn(c: CtxLey, s: Slot): Cuerpo | undefined {
  if (s === REF_NULA) return undefined;
  if (c.frente.clase[s] === Clase.Persona) return c.personas.get(s)?.cuerpo;
  const uid = c.frente.uid[s];
  return c.mundo.animals.find(a => a.uid === uid)?.cuerpo;
}

function loteDelCuerpo(cuerpo: Cuerpo | undefined, rol: Rol): LoteRef {
  if (!cuerpo) return REF_NULA;
  switch (rol) {
    case Rol.Tejido: return cuerpo.tejido;
    case Rol.Reserva: return cuerpo.reserva;
    case Rol.Digestivo: return cuerpo.digestivo;
    case Rol.Embrion: return cuerpo.gestacion?.embrion ?? REF_NULA;
    default: return REF_NULA;
  }
}

function responder(c: CtxLey, i: Intento, nuevo: Intento): void {
  const s = slotVivo(c, nuevo.a);
  const dueno = s === REF_NULA ? duenoDeCelda(c, nuevo.celda) : c.frente.dueno[s];
  if (dueno < 0) throw new Error(`Intento ${i.nonce} sin ruta de retorno.`);
  c.buzon.enviar(dueno, nuevo);
}

function conceder(c: CtxLey, i: Intento, materia: Float64Array): void {
  responder(c, i, {
    tipo: TipoIntento.Concedido, de: i.a, a: i.de, nonce: i.nonce,
    lote: i.dato?.[DATO_TOMAR.loteDestino] ?? REF_NULA,
    celda: celdaDe(c, i.de, i.celda), dato: AL_DIGESTIVO, bytes: null, materia,
  });
}

function tomar(c: CtxLeyMateria, i: Intento, s: Slot): Resultado {
  let garantia: Float64Array = VACIO;
  const dato = i.dato;
  if (dato && (i.a === REF_NULA || s !== REF_NULA)) {
    const rol = dato[DATO_TOMAR.rol] as Rol;
    const loteDeCuerpo = loteDelCuerpo(cuerpoEn(c, s), rol);
    const celda = celdaDe(c, i.a, i.celda);
    const lote = i.lote !== REF_NULA ? i.lote : loteDeCuerpo !== REF_NULA ? loteDeCuerpo
      : duenoDeCelda(c, celda) === c.hilo ? loteEnCelda(c, celda, rol) : REF_NULA;
    if (c.materia.propio(lote)) {
      const parte = dato[DATO_TOMAR.parte] as Parte;
      const k = DATO_TOMAR.kappa;
      const pedido: Pedido = {
        parte, esp: dato[DATO_TOMAR.esp], cuantos: dato[DATO_TOMAR.cuantos],
        kappa: parte !== Parte.Digerible ? null
          : dato.length >= k + 4 ? [dato[k], dato[k + 1], dato[k + 2], dato[k + 3]] : kappaDeRol(rol),
      };
      garantia = c.materia.garantizar(lote, pedido, c.libro);
    }
  }
  conceder(c, i, garantia);
  return 'aplicados';
}

function alSuelo(c: CtxLeyMateria, i: Intento, celda: number, garantia: Float64Array): Resultado {
  const dueno = duenoDeCelda(c, celda);
  if (dueno < 0) throw new Error(`Garantía ${i.nonce} sin celda residente para abonar en el Suelo.`);
  if (dueno !== c.hilo) {
    c.buzon.enviar(dueno, {
      ...i, tipo: TipoIntento.Depositar, a: REF_NULA, lote: REF_NULA, celda, dato: null, bytes: null,
    });
    return 'reenviados';
  }
  const suelo = loteEnCelda(c, celda, Rol.Suelo, 0);
  c.materia.abonar(suelo === REF_NULA ? c.materia.nuevo(Rol.Suelo, celda, 0) : suelo, garantia, c.libro);
  return 'depositados';
}

function recibir(c: CtxLeyMateria, i: Intento, s: Slot): Resultado {
  const garantia = i.materia;
  if (!garantia?.length) return 'aplicados';
  const celda = celdaDe(c, i.a, i.celda);
  if ((i.a !== REF_NULA && s === REF_NULA) || (i.lote !== REF_NULA && !c.materia.vivo(i.lote))) {
    return alSuelo(c, i, celda, garantia);
  }

  const rol = (i.dato?.[DATO_MATERIA.rol] ?? Rol.Suelo) as Rol;
  const forma = i.dato?.[DATO_MATERIA.forma] ?? 0;
  const cuerpo = cuerpoEn(c, s);
  const ligado = loteDelCuerpo(cuerpo, rol);
  let lote = i.lote !== REF_NULA ? i.lote : ligado;
  if (lote !== REF_NULA && !c.materia.vivo(lote)) return alSuelo(c, i, celda, garantia);
  if (cuerpo && lote === cuerpo.digestivo && c.materia.propio(lote)) {
    abonarCuerpo(c, cuerpo, garantia);
    return 'aplicados';
  }
  if (lote === REF_NULA && rol === Rol.Objeto && s !== REF_NULA) {
    const carga = c.personas.get(s)?.carga;
    if (carga) {
      lote = carga.find(l => c.materia.propio(l) && c.materia.vista(l).forma === forma) ?? REF_NULA;
      if (lote === REF_NULA) {
        lote = c.materia.nuevo(rol, REF_NULA, forma);
        carga.push(lote);
      }
    }
  }
  if (lote === REF_NULA) {
    const dueno = duenoDeCelda(c, celda);
    if (dueno >= 0 && dueno !== c.hilo) {
      c.buzon.enviar(dueno, { ...i, tipo: TipoIntento.Depositar, a: REF_NULA, celda });
      return 'reenviados';
    }
    if (dueno < 0) throw new Error(`Garantía ${i.nonce} sin destino residente.`);
    if (rol === Rol.Suelo) return alSuelo(c, i, celda, garantia);
    lote = loteEnCelda(c, celda, rol, forma);
    if (lote === REF_NULA) lote = c.materia.nuevo(rol, celda, forma);
  }
  if (!c.materia.propio(lote)) throw new Error(`El lote vivo ${lote} del intento ${i.nonce} no pertenece al destinatario.`);
  c.materia.abonar(lote, garantia, c.libro);
  return 'aplicados';
}

function rechazar(c: CtxLey, i: Intento): Resultado {
  if (i.tipo === TipoIntento.Tomar) {
    conceder(c, i, VACIO);
  } else if (i.materia?.length) {
    const cm = c as CtxLeyMateria;
    if (i.tipo === TipoIntento.Devuelto || i.de === REF_NULA) {
      return alSuelo(cm, i, celdaDe(c, i.a, i.celda), i.materia);
    }
    responder(c, i, {
      tipo: TipoIntento.Devuelto, de: i.a, a: i.de, nonce: i.nonce, lote: REF_NULA,
      celda: celdaDe(c, i.de, i.celda), materia: i.materia,
      dato: i.dato?.[DATO_MATERIA.rol] === Rol.Objeto ? i.dato : A_LA_RESERVA, bytes: null,
    });
  }
  return 'devueltos';
}

function resolver(c: CtxLey, i: Intento, leyes: ReturnType<typeof leyesActivas>): Resultado {
  const s = slotVivo(c, i.a);
  const dueno = s !== REF_NULA ? c.frente.dueno[s]
    : i.a === REF_NULA ? duenoDeCelda(c, i.celda) : REF_NULA;
  if (dueno >= 0 && dueno !== c.hilo) {
    c.buzon.enviar(dueno, i);
    return 'reenviados';
  }
  // Ni una ley puede abonar un lote caducado ni tocar un organismo que ya no vive.
  const cm = c as CtxLeyMateria;
  const recibe = i.tipo === TipoIntento.Dar || i.tipo === TipoIntento.Depositar
    || i.tipo === TipoIntento.Concedido || i.tipo === TipoIntento.Devuelto;
  if ((i.a !== REF_NULA && s === REF_NULA) || (i.lote !== REF_NULA && cm.materia && !cm.materia.vivo(i.lote))) {
    if (recibe) return recibir(cm, i, s);
    return rechazar(c, i);
  }
  const tipo = NOMBRE_INTENTO[i.tipo];
  for (const l of leyes) {
    const r = l.aplicar?.[tipo]?.(c, i);
    if (r === 'hecho') return 'aplicados';
    if (r === 'rechazo') return rechazar(c, i);
  }
  if (i.tipo === TipoIntento.Tomar) return tomar(cm, i, s);
  if (recibe) return recibir(cm, i, s);
  return rechazar(c, i);
}

const NOMBRE_INTENTO = Object.fromEntries(Object.entries(TipoIntento).map(([nombre, tipo]) => [tipo, nombre])) as
  Record<TipoIntento, keyof typeof TipoIntento>;

/** Vacía una cola de este dueño ('M' y 'B' en F1, 'A' en F5) y aplica cada intento. Devuelve cuántos aplicó. */
export function aplicarCola(c: CtxLey, cola: Cola): number {
  if (!c.params.v23.intentos) return 0;
  const e = estadoDe(c);
  const leyes = leyesActivas(c.params.v23);
  let aplicados = 0;
  c.buzon.vaciar(cola, i => {
    const bit = 1 << i.tipo;
    if (e.vistos.some(v => ((v.get(i.nonce) ?? 0) & bit) !== 0) || ((e.reenviados.get(i.nonce) ?? 0) & bit) !== 0) {
      e.balance.duplicados++;
      return;
    }
    const resultado = resolver(c, i, leyes);
    const vistos = resultado === 'reenviados' ? e.reenviados : e.vistos[c.tick % VENTANA_NONCE_TICKS];
    vistos.set(i.nonce, (vistos.get(i.nonce) ?? 0) | bit);
    e.balance[resultado]++;
    if (resultado === 'aplicados' || resultado === 'depositados') aplicados++;
  });
  return aplicados;
}
