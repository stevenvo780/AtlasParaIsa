/**
 * Un dueño en su hilo (carril m4a; ARQ-motor §3.1). `crearDueno` es el cuerpo de cálculo que la `Piscina` carga en
 * cada worker: arma la parte del mundo de ese dueño sobre la memoria compartida y devuelve la función que corre cada
 * tramo del tick entre dos barreras. El coordinador (dueño 0) corre la misma `faseDueno` sobre su parte.
 *
 * Tramos de un tick (las barreras las pone el coordinador, que fija entre ellas la fase de los buzones):
 *   percibir = F1 (adoptar, cola B, Ley.F1) · eco · F2      ── B2
 *   actuar   = F3 · F4                                       ── B3
 *   aplicar  = F5 (cola A, Ley.F5) · F6 (filas, Ley.F6, páginas, fotograma, emigrar, parte del tick)   ── B4
 * Con dueños no hay pasos heredados: `REQUIERE` garantiza que todas las leyes están encendidas.
 */
import { deserialize } from 'node:v8';
import type { DescriptorEnlace } from '../../shared/fotograma.js';
import { PercepcionDelPaso, PercibidorCpu, registrarPercepcion } from '../decision/percepcion.js';
import { TerrenoPercepcion } from '../decision/terreno-percepcion.js';
import { crearServicioQuimico } from '../materia/servicio.js';
import type { Libro } from '../materia/tipos.js';
import type { World } from '../mundo/tipos.js';
import { setParams, type WorldParams } from '../params.js';
import { conRejilla } from '../rejilla.js';
import { PageArena, type ArenaCompartida } from '../soa/arena.js';
import { OrganismosMundo, registrarOrganismos } from '../soa/organismos-mundo.js';
import { TablaOrganismosSoA, type TablaCompartida } from '../soa/organismos.js';
import type { TerrenoCompartido } from '../soa/terreno.js';
import { conectarBuzon, type MemoriaBuzones } from './buzon.js';
import { Contadores } from './contadores.js';
import { AVISO, CTL, CTL_DUENO, Dueno, celdaDueno, type PiezasDueno } from './contexto.js';
import type { Hilo } from './contratos.js';
import { RegistroContenido, type MemoriaRegistro } from './registro.js';

/** Tramos que el coordinador pide a la piscina (`Piscina.ejecutar`). */
export const TRAMO = { cargar: 1, percibir: 2, actuar: 3, aplicar: 4, reunir: 5 } as const;

/** Lo que cada worker recibe al nacer (por `workerData`: los SAB se comparten, lo demás se copia). */
export interface DatosDueno {
  hilos: number;
  tabla: TablaCompartida;
  terreno: TerrenoCompartido;
  buzones: MemoriaBuzones;
  contadores: BigUint64Array;
  registro: MemoriaRegistro;
  libros: Libro[];
  lotes: ArenaCompartida | null;
  desborde: ArenaCompartida | null;
  /** Identidad de sustancias compartida durante la época (null sin `v23.materia`). */
  sustancias: MemoriaRegistro | null;
  control: SharedArrayBuffer;
  enlace: DescriptorEnlace | null;
  /** null: entropía real. Con semilla, cada dueño siembra la suya de (semilla, hilo). */
  semilla: number | null;
  /** `cabeceraDe(mundo)` serializada: el mundo de cada dueño antes de recibir sus chunks. */
  cabecera: Uint8Array;
  params: WorldParams;
  epoca: number;
  /** La época se abre desde un punto de control con materia: cada dueño adopta los lotes de sus organismos. */
  conMateriaCargada: boolean;
}

/** Azar del hilo: mulberry32 sembrado de (semilla, hilo), o de entropía real si no hay semilla. */
export function azarDeHilo(semilla: number | null, hilo: Hilo): () => number {
  let a = semilla === null ? crypto.getRandomValues(new Uint32Array(1))[0]! : (Math.imul(semilla | 0, 0x9e3779b1) ^ Math.imul(hilo + 1, 0x85ebca6b)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Liga a `mundo` (la parte de un dueño) la tabla, el terreno y la percepción compartidos, vistos con su hilo. La
 * percepción de un dueño corre en su propio hilo: no usa la piscina ni las tarjetas del proceso. */
export function ligarCompartido(mundo: World, tabla: TablaOrganismosSoA, terreno: TerrenoPercepcion, contadores: Contadores): void {
  registrarOrganismos(mundo, new OrganismosMundo(tabla.verificar, () => contadores.id('uid'), tabla));
  const percepcion = new PercepcionDelPaso(mundo, terreno);
  percepcion.percibidor = new PercibidorCpu(percepcion.vista);
  registrarPercepcion(mundo, percepcion);
}

/** Cuerpo de cálculo de la `Piscina`: el dueño `hilo` (≥ 1) sobre su parte del mundo. */
export function crearDueno(hilo: Hilo, datos: DatosDueno): (tramo: number) => void {
  const mundo = deserialize(datos.cabecera) as World;
  setParams(mundo, datos.params);
  const azar = azarDeHilo(datos.semilla, hilo), contadores = new Contadores(datos.contadores);
  ligarCompartido(mundo, TablaOrganismosSoA.conectar(datos.tabla, hilo), TerrenoPercepcion.conectarDueno(datos.terreno, hilo), contadores);
  const piezas: PiezasDueno = {
    hilo, hilos: datos.hilos, buzones: null, buzon: conectarBuzon(datos.buzones, hilo, azar), libros: datos.libros, contadores,
    registro: new RegistroContenido(datos.registro), azar, control: new Float64Array(datos.control), enlace: datos.enlace,
    materia: datos.sustancias && datos.lotes && datos.desborde ? {
      lotes: PageArena.conectar(datos.lotes), desborde: PageArena.conectar(datos.desborde),
      quimica: crearServicioQuimico({ modo: 'inmediato', registroSustancias: new RegistroContenido(datos.sustancias) }),
    } : null,
  };
  const dueno = new Dueno(mundo, piezas);
  dueno.epoca = datos.epoca;
  const control = piezas.control!;
  return tramo => faseDueno(dueno, tramo, control, datos.conMateriaCargada);
}

/** Un tramo del tick (o de la apertura de época) de un dueño, entre dos barreras. Corre dentro del ámbito de rejilla
 * del mundo, como el tick de un dueño (`stepWorld`), por si una ley usa una consulta espacial de las de siempre. */
export function faseDueno(d: Dueno, tramo: number, control: Float64Array, conMateriaCargada = false): void {
  conRejilla(d.mundo, () => tramoDueno(d, tramo, control, conMateriaCargada));
}

function tramoDueno(d: Dueno, tramo: number, control: Float64Array, conMateriaCargada: boolean): void {
  const m = d.mundo, celda = (campo: number): number => celdaDueno(d.hilo, campo), inicio = performance.now();
  switch (tramo) {
    case TRAMO.cargar:
      // Abrir la época: leyes y materia, los chunks propios (reparto inicial), los lotes de los organismos propios si se
      // viene de un guardado, `Ley.iniciar` y las filas del primer frente (lo publica el coordinador tras la barrera).
      m.tick = control[CTL.tick]!;
      d.prepararEpoca();
      d.adoptarMigrantes();
      if (conMateriaCargada) d.adoptarPropios();
      d.iniciarLeyes();
      d.publicarFilas();
      if (d.hilo !== 0) d.enviarParte();
      break;
    case TRAMO.percibir: {
      if (d.hilo !== 0) {
        m.tick = control[CTL.tick]!;
        m.invitations = m.invitations.filter(invitacion => invitacion.until > m.tick);
        m.reminders = m.reminders.filter(aviso => aviso.until > m.tick);
        d.abrirTick();
      }
      d.adoptarMigrantes();
      d.aplicar('M'); d.aplicar('B');
      d.gancho('F1');
      const eco = performance.now();
      d.gancho('eco');
      const f2 = performance.now();
      d.gancho('F2');
      const fin = performance.now();
      control[celda(CTL_DUENO.msEco)] = f2 - eco;
      control[celda(CTL_DUENO.msF1)] = eco - inicio;
      control[celda(CTL_DUENO.msPercibir)] = fin - f2;
      control[celda(CTL_DUENO.msTick)] = fin - inicio;
      break;
    }
    case TRAMO.actuar: {
      d.gancho('F3');
      d.gancho('F4');
      const ms = performance.now() - inicio;
      control[celda(CTL_DUENO.msActuar)] = ms;
      control[celda(CTL_DUENO.msTick)]! += ms;
      break;
    }
    case TRAMO.aplicar: {
      d.aplicar('A');
      d.gancho('F5');
      d.publicarFilas();
      d.gancho('F6');
      d.publicarTerreno();
      d.escribirFoto();
      d.emigrar();
      if (d.hilo !== 0) d.enviarParte();
      const ms = performance.now() - inicio;
      control[celda(CTL_DUENO.msAplicar)] = ms;
      control[celda(CTL_DUENO.msTick)]! += ms;
      break;
    }
    case TRAMO.reunir:
      // Instantánea: cada dueño manda su parte del mundo; el coordinador la arma tras la barrera.
      if (d.hilo !== 0) d.avisarCoordinador([AVISO.parte, d.hilo], m);
      break;
    default: throw new Error(`Tramo de dueño desconocido: ${tramo}.`);
  }
}
