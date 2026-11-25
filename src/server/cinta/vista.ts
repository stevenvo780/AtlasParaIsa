import { deserialize } from 'node:v8';
import type { Corte, Hito } from '../../shared/cinta.js';
import {
  disposicion, ESQUEMA_CELDA, ESQUEMA_ORGANISMO, fotogramaDe, SERIE_CAMPOS,
  type EnlaceCinta, type Fotograma, type Suceso, type SucesoVista, type VistasLentas,
} from '../../shared/fotograma.js';
import type { MatTesela } from '../../shared/materia.js';
import { PROTOCOL_VERSION, type AnimalView, type ChronicleEvent, type PersonView, type Tile, type WorldView } from '../../shared/types.js';
import { ACTIONS as ACCIONES_FAUNA } from '../../world/animals.js';
import { ACCIONES_PERSONA_FOTOGRAMA, type SucesoFotograma, type SucesoVistaAdicional, type VistaAnimalFotograma, type VistaMundoFotograma,
  type VistaPaginaFotograma, type VistaPersonaFotograma } from '../../world/motor/fotograma.js';
import { Clase } from '../../world/motor/contratos.js';
import { phaseAt } from '../../world/mundo/crear.js';
import { TICKS_PER_DAY } from '../../world/mundo/tipos.js';
import { VIEW_EVENTS } from '../../world/proyeccion.js';
import { PAGE_CELLS, PAGE_SIDE } from '../../world/soa/region.js';

const { ancho: anchoOrganismo, desde: campoO } = disposicion(ESQUEMA_ORGANISMO);
const { ancho: anchoCelda, desde: campoC } = disposicion(ESQUEMA_CELDA);
const escalaU8 = 255;
const q2 = (n: number): number => Math.round(n * 100) / 100;
const importantes = new Set<ChronicleEvent['kind']>(['birth', 'death', 'community', 'settlement', 'discovery', 'invention']);

type TipoLento = Exclude<keyof VistasLentas, SucesoVistaAdicional['tipo']>;
type Lentas = { [K in TipoLento]: Map<string, VistasLentas[K]> };
const lentas = (): Lentas => ({
  lugar: new Map(), comunidad: new Map(), estructura: new Map(), plano: new Map(), recuerdo: new Map(),
  tecnologia: new Map(), organizacion: new Map(), clima: new Map(), susurro: new Map(),
});

/** Lo que el hilo de la cinta recuerda entre fotogramas. Uno por época. */
export interface EstadoVista { readonly epoca: number }

class CacheVista implements EstadoVista {
  lentas = lentas();
  readonly personas = new Map<string, VistaPersonaFotograma>();
  readonly animales = new Map<string, VistaAnimalFotograma>();
  readonly paginas = new Map<string, VistaPaginaFotograma>();
  readonly textos = new Map<number, Map<string, string>>();
  readonly catalogo = new Set<number>();
  eventos: ChronicleEvent[] = [];
  mundo: VistaMundoFotograma | undefined;
  reparto: WorldView['reparto'];
  primero = true;

  constructor(readonly epoca: number) {}

  reiniciarVista(): void {
    this.lentas = lentas();
    this.personas.clear();
    this.animales.clear();
    this.paginas.clear();
    this.textos.clear();
    this.mundo = undefined;
    this.reparto = undefined;
  }
}

export function estadoVista(epoca: number): EstadoVista { return new CacheVista(epoca); }

function guardar<K, V>(mapa: Map<K, V>, id: K, vista: V | null): void {
  if (vista === null) mapa.delete(id);
  else mapa.set(id, vista);
}
function guardarVista<K extends TipoLento>(vistas: Lentas,
  s: { tipo: K; id: string; vista: VistasLentas[K] | null }): void {
  guardar(vistas[s.tipo], s.id, s.vista);
}

function aplicarSucesos(e: CacheVista, sucesos: readonly SucesoFotograma[], t: number) {
  const hitos: Hito[] = [], catalogo: Corte['catalogo'] = [];
  for (const s of sucesos) switch (s.tipo) {
    case 'cronica':
      hitos.push({ tipo: 'suceso', t: s.evento.tick, importancia: Number(importantes.has(s.evento.kind)), suceso: s.evento });
      e.eventos.push(s.evento);
      if (e.eventos.length > VIEW_EVENTS) e.eventos.shift();
      break;
    case 'cronicaVista': e.eventos = s.vista?.slice(-VIEW_EVENTS) ?? []; break;
    case 'sustancia': {
      if (!e.catalogo.has(s.sustancia.id)) {
        e.catalogo.add(s.sustancia.id);
        catalogo.push({ t, sustancia: s.sustancia });
      }
      break;
    }
    case 'texto': {
      let campos = e.textos.get(s.uid);
      if (!campos) e.textos.set(s.uid, campos = new Map());
      guardar(campos, s.campo, s.valor);
      break;
    }
    case 'mundo': e.mundo = s.vista ?? undefined; break;
    case 'persona': guardar(e.personas, s.id, s.vista); break;
    case 'animal': guardar(e.animales, s.id, s.vista); break;
    case 'pagina': guardar(e.paginas, s.id, s.vista); break;
    default: guardarVista(e.lentas, s satisfies SucesoVista); break;
  }
  return { hitos, catalogo };
}

function organismos(e: CacheVista, f: Fotograma): { people: PersonView[]; animals: AnimalView[] } {
  const people: PersonView[] = [], animals: AnimalView[] = [];
  const vistos = new Set<number>();
  const bin = new DataView(f.organismos.buffer, f.organismos.byteOffset, f.organismos.byteLength);
  for (let i = 0; i < f.n; i++) {
    const b = i * anchoOrganismo;
    const uid = bin.getFloat64(b + campoO.uid, true), clave = String(uid);
    if (!Number.isSafeInteger(uid) || uid <= 0 || vistos.has(uid)) throw new Error(`Uid de fila inválido o repetido: ${uid}.`);
    vistos.add(uid);
    const clase = bin.getUint8(b + campoO.clase), accion = bin.getUint8(b + campoO.accion);
    const textos = e.textos.get(uid), reason = textos?.get('reason');
    const telemetria = {
      x: bin.getFloat32(b + campoO.x, true), y: bin.getFloat32(b + campoO.y, true),
      hunger: q2(bin.getUint8(b + campoO.hambre) / escalaU8), thirst: q2(bin.getUint8(b + campoO.sed) / escalaU8),
      energy: q2(bin.getUint8(b + campoO.energia) / escalaU8), health: q2(bin.getUint8(b + campoO.salud) / escalaU8),
    };
    const masa = bin.getFloat32(b + campoO.masa, true), principal = bin.getUint32(b + campoO.principal, true);
    const fatiga = campoO.fatiga === undefined ? NaN : bin.getFloat32(b + campoO.fatiga, true);
    const cuerpo = {
      masa, principal,
      ...(campoO.carga === undefined ? {} : { carga: bin.getFloat32(b + campoO.carga, true) }),
      ...(campoO.T === undefined ? {} : { T: bin.getFloat32(b + campoO.T, true) }),
    };
    if (clase === Clase.Persona) {
      const base = e.personas.get(clave), action = ACCIONES_PERSONA_FOTOGRAMA[accion];
      const name = textos?.get('name'), color = textos?.get('color'), need = textos?.get('need');
      if (!base || action === undefined || name === undefined || color === undefined || need === undefined || reason === undefined) {
        throw new Error(`La fila de persona ${uid} no tiene vista, texto o acción válidos.`);
      }
      const specialty = textos?.get('specialty'), craftTint = textos?.get('craftTint'), craftFocus = textos?.get('craftFocus');
      people.push({ ...base, ...telemetria, name, color, need, reason, action, fatigue: q2(Number.isNaN(fatiga) ? base.fatigue : fatiga),
        recentMemory: textos?.get('recentMemory') ?? null,
        ...(specialty === undefined ? {} : { specialty }), ...(craftTint === undefined ? {} : { craftTint }),
        ...(craftFocus === undefined ? {} : { craftFocus }),
        ...(base.foodReserve === undefined ? {} : { foodReserve: q2(base.foodReserve) }),
        ...(base.vitality === undefined ? {} : { vitality: q2(base.vitality) }),
        ...(campoO.escucha === undefined ? {} : { escucha: bin.getUint8(b + campoO.escucha) / escalaU8 }),
        ...(base.cuerpoVisto ? { cuerpoVisto: { ...base.cuerpoVisto, ...cuerpo } } : {}),
      });
    } else if (clase === Clase.Animal) {
      const base = e.animales.get(clave), action = ACCIONES_FAUNA[accion];
      if (!base || reason === undefined || action === undefined) throw new Error(`La fila de fauna ${uid} no tiene vista, texto o acción válidos.`);
      animals.push({ ...base, ...telemetria, reason, action, fatigue: q2(Number.isNaN(fatiga) ? base.fatigue : fatiga), age: Math.floor(base.age / 20) * 20,
        ...(base.reproReserve === undefined ? {} : { reproReserve: q2(base.reproReserve) }),
        ...(base.cuerpoVisto ? { cuerpoVisto: { ...base.cuerpoVisto, ...cuerpo } } : {}),
      });
    } else throw new Error(`Clase de organismo inválida en la fila ${uid}.`);
  }
  for (const uid of e.textos.keys()) if (!vistos.has(uid)) e.textos.delete(uid);
  for (const id of e.personas.keys()) if (!vistos.has(Number(id))) e.personas.delete(id);
  for (const id of e.animales.keys()) if (!vistos.has(Number(id))) e.animales.delete(id);
  return { people, animals };
}

function teselas(e: CacheVista, f: Fotograma): Tile[] {
  const tiles: Tile[] = [];
  const bin = new DataView(f.celdas.buffer, f.celdas.byteOffset, f.celdas.byteLength);
  for (let p = 0; p < f.paginas.length / 2; p++) {
    const px = f.paginas[2 * p], py = f.paginas[2 * p + 1], clave = `${px},${py}`;
    const pagina = e.paginas.get(clave);
    if (!pagina || pagina.length !== PAGE_CELLS) throw new Error(`La página ${clave} no tiene vista de sus celdas.`);
    for (let i = 0; i < PAGE_CELLS; i++) {
      const b = (p * PAGE_CELLS + i) * anchoCelda;
      const x = px * PAGE_SIDE + i % PAGE_SIDE, y = py * PAGE_SIDE + Math.floor(i / PAGE_SIDE);
      const T = bin.getFloat32(b + campoC.T, true);
      if (Number.isNaN(T)) { tiles.push({ ...pagina[i], x, y }); continue; }
      const mat: MatTesela = [];
      for (let j = 0; j < 3; j++) {
        const id = bin.getUint32(b + campoC[`mat${j}`], true);
        if (id !== 0) mat.push([id, bin.getUint8(b + campoC[`fr${j}`]) / escalaU8]);
      }
      tiles.push({ ...pagina[i], x, y, mat, T });
    }
  }
  return tiles;
}

/** Aplica los sucesos anteriores al fotograma y produce el corte de su tick exacto. */
export function fotogramaAVista(estado: EstadoVista, f: Fotograma, sucesos: readonly Suceso[], seq: number): Corte {
  if (!(estado instanceof CacheVista) || estado.epoca !== f.epoca || (estado.primero && !f.completo)) {
    throw new Error('La vista de cinta necesita el fotograma completo inicial de su época.');
  }
  if (f.completo) estado.reiniciarVista();
  const { hitos, catalogo } = aplicarSucesos(estado, sucesos, f.tick);
  const lento = estado.lentas, mundo = estado.mundo, weather = lento.clima.get('');
  if (!mundo || weather === undefined) throw new Error('El fotograma no tiene cabecera de mundo o clima.');
  const { people, animals } = organismos(estado, f);
  const cambiadas = teselas(estado, f);
  if (f.reparto) {
    const paginas = Array.from(f.reparto, (dueno, i): [number, number, number] => [f.paginas[2 * i], f.paginas[2 * i + 1], dueno]);
    estado.reparto = { paginas, msPorHilo: mundo.reparto?.msPorHilo ?? [] };
  }
  const reparto = mundo.reparto ?? estado.reparto;
  const serie = Object.fromEntries(SERIE_CAMPOS.map((k, i) => [k, f.serie[i]])) as Corte['serie'];
  const vista: WorldView = {
    ...mundo, version: PROTOCOL_VERSION, sequence: f.tick, tick: f.tick, day: Math.floor(f.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(f.tick), weather, tiles: f.completo ? cambiadas : [], people, animals,
    places: [...lento.lugar.values()], events: estado.eventos.slice(), memories: [...lento.recuerdo.values()],
    communities: [...lento.comunidad.values()], structures: [...lento.estructura.values()], blueprints: [...lento.plano.values()],
    technology: lento.tecnologia.get(''), organization: lento.organizacion.get(''),
    ...(lento.susurro.size ? { whispers: [...lento.susurro.values()] } : {}), ...(reparto ? { reparto } : {}),
  };
  const tilesCambiadas = estado.primero ? 'todas' : cambiadas;
  estado.primero = false;
  return { seq, epoca: f.epoca, t: f.tick, vista, tilesCambiadas, hitos, catalogo, serie, hz: serie.hz };
}

function leerSucesos(enlace: EnlaceCinta, f: Fotograma): SucesoFotograma[] {
  const [desde, hasta] = f.sucesos;
  if (!Number.isSafeInteger(desde) || desde < 0 || !Number.isSafeInteger(hasta) || hasta < desde
    || BigInt(desde) !== Atomics.load(enlace.sucesosLeidos, 0) || BigInt(hasta) > Atomics.load(enlace.sucesosEscritos, 0)) {
    throw new Error('Rango de sucesos de cinta inválido o leído fuera de orden.');
  }
  const sucesos: SucesoFotograma[] = [];
  if (desde === hasta) return sucesos;
  const anillo = enlace.sucesos;
  if (!anillo || hasta - desde > anillo.length) throw new Error('El rango de sucesos no cabe en el anillo de cinta.');

  let cursor = desde;
  function leer(bytes: number): Buffer {
    if (cursor + bytes > hasta) throw new Error('Registro de sucesos truncado.');
    const datos = Buffer.allocUnsafe(bytes), posicion = cursor % anillo!.length;
    const primera = Math.min(bytes, anillo!.length - posicion);
    datos.set(anillo!.subarray(posicion, posicion + primera));
    if (primera < bytes) datos.set(anillo!.subarray(0, bytes - primera), primera);
    cursor += bytes;
    return datos;
  }
  while (cursor < hasta) {
    const bytes = leer(4).readUInt32LE();
    if (!bytes) throw new Error('Registro de sucesos vacío.');
    sucesos.push(deserialize(leer(bytes)));
  }
  return sucesos;
}

/** Lee los sucesos antes de prestar las vistas de la ranura a la cinta. */
export function leerFotograma(enlace: EnlaceCinta, leidos: bigint, usar: (f: Fotograma, sucesos: readonly Suceso[]) => void): boolean {
  if (leidos >= Atomics.load(enlace.entregados, 0)) return false;
  if (leidos < 0n || !enlace.ranuras.length) throw new Error('No hay ranura válida para el fotograma entregado.');
  const f = fotogramaDe(enlace.ranuras[Number(leidos % BigInt(enlace.ranuras.length))]);
  const sucesos = leerSucesos(enlace, f);
  Atomics.store(enlace.sucesosLeidos, 0, BigInt(f.sucesos[1]));
  Atomics.notify(enlace.sucesosLeidos, 0);
  try {
    usar(f, sucesos as readonly Suceso[]);
  } finally {
    Atomics.add(enlace.creditos, 0, 1);
  }
  return true;
}
