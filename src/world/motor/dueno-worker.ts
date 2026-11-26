/**
 * Un dueño en su hilo (carril m4a; ARQ-motor §3.1). `crearDueno` es el cuerpo de cálculo que la `Piscina` carga en
 * cada worker: arma la parte del mundo de ese dueño sobre la memoria compartida y devuelve la función que corre cada
 * tramo del tick entre dos barreras. El coordinador (dueño 0) corre la misma `faseDueno` sobre su parte.
 *
 * Tramos de un tick (las barreras las pone el coordinador, que fija entre ellas la fase de los buzones):
 *   percibir = F1 (adoptar, cola B, Ley.F1) · eco · F2      ── B2
 *   actuar   = F3 · F4                                       ── B3
 *   aplicar  = F5 (cola A, Ley.F5, admisión de cruces)
 *   publicar = F6 (cruces admitidos, filas, Ley.F6, páginas, fotograma, emigrar, parte del tick)
 * Con dueños están encendidas todas las leyes. La demografía base sigue evaluando edad, daño y muerte en cada heap.
 */
import { deserialize } from 'node:v8';
import type { MessagePort } from 'node:worker_threads';
import type { DescriptorEnlace } from '../../shared/fotograma.js';
import { conRejillaFauna } from '../animals.js';
import { PercepcionDelPaso, PercibidorCpu, registrarPercepcion } from '../decision/percepcion.js';
import { TerrenoPercepcion } from '../decision/terreno-percepcion.js';
import { PercibidorBroker, type EpocaBrokerPercepcion } from '../gpu/broker-percepcion.js';
import { transferEstate } from '../demografia/morir.js';
import { advancePopulation } from '../lineage.js';
import { cerrarMateriaGpu } from '../materia/ley-mundo.js';
import { crearServicioQuimico } from '../materia/servicio.js';
import type { Libro } from '../materia/tipos.js';
import { deathContext } from '../mundo/crear.js';
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
import { enviarParteCorte, type SolicitudCorte } from './mensajes-corte.js';
import { RegistroContenido, type MemoriaRegistro } from './registro.js';

/** Tramos que el coordinador pide a la piscina (`Piscina.ejecutar`). */
export const TRAMO = { cargar: 1, percibir: 2, actuar: 3, aplicar: 4, reunir: 5, cerrar: 6, publicar: 7, confirmarGuardado: 8 } as const;

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
  contenido?: ArenaCompartida;
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
  solicitudCorte?: SolicitudCorte;
  brokersGpuPorDueno: (EpocaBrokerPercepcion | undefined)[];
  /** La época se abre desde un punto de control con materia: cada dueño adopta los lotes de sus organismos. */
  conMateriaCargada: boolean;
  /** Solo en el perfil de laboratorio. Una duración por dueño entre el inicio de actuación y F4. */
  perfilActuar?: Float64Array<SharedArrayBuffer>;
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

/** Cada dueño prepara su captura F2 y conserva el percibidor CPU para cuando el corredor no admite el lote. */
export function ligarCompartido(mundo: World, tabla: TablaOrganismosSoA, terreno: TerrenoPercepcion, contadores: Contadores,
  brokerGpu?: EpocaBrokerPercepcion, hilo = 0): PercibidorBroker | undefined {
  registrarOrganismos(mundo, new OrganismosMundo(tabla.verificar, () => contadores.id('uid'), tabla));
  const percepcion = new PercepcionDelPaso(mundo, terreno);
  const remoto = brokerGpu && new PercibidorBroker(percepcion.vista, brokerGpu, hilo);
  percepcion.percibidor = remoto ?? new PercibidorCpu(percepcion.vista);
  registrarPercepcion(mundo, percepcion);
  return remoto;
}

/** Cuerpo de cálculo de la `Piscina`: el dueño `hilo` (≥ 1) sobre su parte del mundo. */
export function crearDueno(hilo: Hilo, datos: DatosDueno, puertoCorte?: MessagePort): (tramo: number) => void {
  const solicitud = datos.solicitudCorte;
  if ((solicitud === undefined) !== (puertoCorte === undefined)) throw new Error('Canal de corte incompleto al abrir el dueño.');
  const mundo = deserialize(datos.cabecera) as World;
  setParams(mundo, datos.params);
  const azar = azarDeHilo(datos.semilla, hilo), contadores = new Contadores(datos.contadores);
  ligarCompartido(mundo, TablaOrganismosSoA.conectar(datos.tabla, hilo), TerrenoPercepcion.conectarDueno(datos.terreno, hilo), contadores,
    datos.brokersGpuPorDueno[hilo], hilo);
  const piezas: PiezasDueno = {
    hilo, hilos: datos.hilos, buzones: null, buzon: conectarBuzon(datos.buzones, hilo, azar), libros: datos.libros, contadores,
    registro: new RegistroContenido(datos.registro), azar, control: new Float64Array(datos.control), enlace: datos.enlace,
    materia: datos.sustancias && datos.lotes && datos.desborde ? {
      lotes: PageArena.conectar(datos.lotes), desborde: PageArena.conectar(datos.desborde),
      ...(datos.contenido && { contenido: PageArena.conectar(datos.contenido) }),
      quimica: crearServicioQuimico({ modo: 'inmediato', registroSustancias: new RegistroContenido(datos.sustancias) }),
    } : null,
  };
  const dueno = new Dueno(mundo, piezas);
  dueno.epoca = datos.epoca;
  const control = piezas.control!;
  const publicarCorte = puertoCorte && solicitud ? () => enviarParteCorte(puertoCorte, solicitud, dueno.epoca, hilo, mundo) : undefined;
  return tramo => faseDueno(dueno, tramo, control, datos.conMateriaCargada, datos.perfilActuar, publicarCorte);
}

/** Un tramo del tick (o de la apertura de época) de un dueño, entre dos barreras. Corre dentro del ámbito de rejilla
 * del mundo, como el tick de un dueño (`stepWorld`), por si una ley usa una consulta espacial de las de siempre. */
export function faseDueno(d: Dueno, tramo: number, control: Float64Array, conMateriaCargada = false,
  perfilActuar?: Float64Array<SharedArrayBuffer>, publicarCorte?: () => void): void {
  conRejilla(d.mundo, () => tramoDueno(d, tramo, control, conMateriaCargada, perfilActuar, publicarCorte));
}

function tramoDueno(d: Dueno, tramo: number, control: Float64Array, conMateriaCargada: boolean,
  perfilActuar?: Float64Array<SharedArrayBuffer>, publicarCorte?: () => void): void {
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
        m.weather = control[CTL.lluvia] === 1 ? 'rain' : 'clear';
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
      // En F3 la fauna aún no se ha movido. F4 escribe sus coordenadas directamente.
      conRejillaFauna(m, () => d.gancho('F3'));
      if (perfilActuar) perfilActuar[d.hilo] = performance.now() - inicio;
      d.gancho('F4');
      const ms = performance.now() - inicio;
      control[celda(CTL_DUENO.msActuar)] = ms;
      control[celda(CTL_DUENO.msTick)]! += ms;
      break;
    }
    case TRAMO.aplicar: {
      d.aplicar('A');
      if (d.params.v23.intentos) advancePopulation(m, {
        emit: evento => { d.suceso(deathContext(m, evento)); },
        beforeDeath: (mundo, persona) => transferEstate(mundo, persona, evento => { d.suceso(evento); }),
        comunidadesGlobales: true,
      });
      d.gancho('F5');
      const ms = performance.now() - inicio;
      control[celda(CTL_DUENO.msAplicar)] = ms;
      control[celda(CTL_DUENO.msTick)]! += ms;
      break;
    }
    case TRAMO.publicar: {
      d.aplicar('C');
      d.publicarFilas();
      d.gancho('F6');
      d.publicarTerreno();
      d.escribirFoto();
      d.emigrar();
      if (d.hilo !== 0) d.enviarParte();
      const ms = performance.now() - inicio;
      control[celda(CTL_DUENO.msAplicar)]! += ms;
      control[celda(CTL_DUENO.msTick)]! += ms;
      break;
    }
    case TRAMO.reunir:
      // El coordinador reúne todas las partes tras esta barrera, por el canal elegido al abrir.
      if (publicarCorte) publicarCorte();
      else if (d.hilo !== 0) d.avisarCoordinador([AVISO.parte, d.hilo], m);
      break;
    case TRAMO.confirmarGuardado:
      // Guardado rutinario en dueños vivos: limpia las bajas ya archivadas sin tocar buzones ni garantías en vuelo.
      if (d.hilo !== 0) {
        m.retiredLegacy.length = 0;
        if (control[CTL.falloConfirmar] === d.hilo) {
          control[CTL.falloConfirmar] = 0;
          throw new Error(`Fallo inyectado al confirmar guardado en el dueño ${d.hilo}.`);
        }
      }
      break;
    case TRAMO.cerrar:
      cerrarMateriaGpu(m);
      break;
    default: throw new Error(`Tramo de dueño desconocido: ${tramo}.`);
  }
}
