/**
 * Instrumentos de MEDIDA del laboratorio (ronda INSTR, noche 2026-09-22). No cambian el mundo:
 * solo LEEN `World`/`Person` y acumulan en memoria del laboratorio (nunca en `World` ni `Person`).
 * `tests/instrumentos-lab.test.ts` lo comprueba con el digesto canónico del mundo y los
 * `dia-NNN.json` con y sin instrumentos.
 *
 * 1. Conducta por TIEMPO. `src/world/diversidad.ts` lee `person.activity`, y `move()` suma +1 a
 *    `activity.explore` por CADA celda nueva mientras los demás oficios suman 1 por trabajo
 *    terminado: explorar pesa el 45-61 % de la activity con el 10-21 % del tiempo (ronda EXPL). Este
 *    instrumento registra, tras CADA paso, la acción (`person.action`) de cada persona viva y
 *    acumula ticks por acción; `diversidadConductaTiempo` es EL MISMO índice
 *    (`indiceDiversidad`, misma fórmula y mismos componentes) sobre vistas de las personas cuya
 *    `activity` se sustituye por esos ticks. Solo cambia la entrada de actividad.
 *    `diversidadConductaActiva` (preregistro del orquestador, noche 2026-09-22): el MISMO índice con
 *    esos ticks SIN `rest` (`sinDescanso`). Descansar es inactividad, no conducta, y domina el tiempo
 *    (20-39 %) y el «oficio dominante» por tiempo de casi todos. Quien solo ha descansado queda con la
 *    actividad vacía, como alguien que aún no actuó. Es la serie que decide C8 en
 *    `criterio-terminado.mts` (modo auto); ver scripts/lab/README.md §«Preregistro del criterio C8».
 * 2. Comida compartida. Cuenta los actos de `share()` (src/world/index.ts): cada uno emite
 *    exactamente un suceso `kind: 'care'` (el único emisor de ese tipo en src/world) cuando una
 *    persona entrega 0,025 de su reserva (`inventory`) a otra con hambre > 0,27 a ≤ 2 celdas, junto
 *    a un lugar. Se leen los sucesos nuevos del paso en `world.chronicleJournal.pending`, que el mundo
 *    ya emite; no cuentan la herencia al morir (`transferEstate`, suceso 'ecology') ni el depósito o
 *    la toma de comida en estructuras (almacén común, no una entrega entre personas).
 */
import type { Action } from '../../src/shared/types.js';
import { OFICIOS_DE_LINAJE, TICKS_PER_DAY, type Person, type World } from '../../src/world/index.js';
import { indiceDiversidad } from '../../src/world/diversidad.js';

/** Las 18 acciones de `Action`, en el orden de `ACTIONS` de src/world/diversidad.ts (no exportado):
 * fija el orden de las claves de las fracciones en el JSON. */
export const ACCIONES: readonly Action[] = ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft'];

export interface Indice { conducta: number; oficios: number; total: number }

/**
 * `indiceDiversidad(world)` de src/world/diversidad.ts con la entrada de actividad sustituida. Cada
 * persona se sustituye por una vista (`Object.create(person)`) que solo redefine `activity`; el
 * mundo, por una vista que solo redefine `people`. Nada se escribe en el mundo ni en las personas.
 * Con `actividad = p => p.activity` da exactamente `worldStatistics(world).diversidad` (test).
 */
export function indiceDiversidadConActividad(world: World, actividad: (person: Person) => Readonly<Record<string, number>>): Indice {
  const vistas = world.people.map(person => {
    const vista = Object.create(person) as Person;
    Object.defineProperty(vista, 'activity', { value: actividad(person), enumerable: true });
    return vista;
  });
  const mundo = Object.create(world) as World;
  Object.defineProperty(mundo, 'people', { value: vistas, enumerable: true });
  return indiceDiversidad(mundo);
}

/** El mismo índice sobre un subconjunto de personas (vista del mundo con `people` = `personas`). */
export function indiceDiversidadDe(world: World, personas: readonly Person[], actividad: (person: Person) => Readonly<Record<string, number>>): Indice {
  const mundo = Object.create(world) as World;
  Object.defineProperty(mundo, 'people', { value: personas, enumerable: true });
  return indiceDiversidadConActividad(mundo, actividad);
}

/** Acción excluida de la conducta ACTIVA: descansar es inactividad, no conducta. */
export const ACCION_INACTIVA: Action = 'rest';

/**
 * Ticks por acción sin `rest` (copia; solo las acciones con ticks > 0). Si solo hay descanso devuelve
 * `{}`: el vector de actividad queda vacío, igual que el de alguien que aún no actuó (`activity: {}`
 * de un recién nacido), y su «oficio dominante» es «sin oficio aún» (`dominantAction` = null).
 */
export function sinDescanso(ticks: Readonly<Record<string, number>>): Record<string, number> {
  const activa: Record<string, number> = {};
  for (const [accion, n] of Object.entries(ticks)) if (accion !== ACCION_INACTIVA && n > 0) activa[accion] = n;
  return activa;
}

/** Media de la distancia de Jensen-Shannon entre perfiles activos; es la raíz de la
 * divergencia JS en base 2, NO la divergencia. Los perfiles sin ticks activos no forman pares. */
export function diversidadPerfilesJS(perfiles: readonly Readonly<Record<string, number>>[]): number | null {
  const accionesActivas = ACCIONES.filter(accion => accion !== ACCION_INACTIVA);
  const proporciones = perfiles.map(ticks => {
    const total = accionesActivas.reduce((suma, accion) => suma + (ticks[accion] ?? 0), 0);
    return total > 0 ? accionesActivas.map(accion => (ticks[accion] ?? 0) / total) : null;
  }).filter((perfil): perfil is number[] => perfil !== null);
  if (proporciones.length < 2) return null;
  let suma = 0, pares = 0;
  for (let i = 0; i < proporciones.length; i++) for (let j = i + 1; j < proporciones.length; j++) {
    const a = proporciones[i]!, b = proporciones[j]!;
    let divergencia = 0;
    for (let k = 0; k < a.length; k++) {
      const p = a[k]!, q = b[k]!, mezcla = (p + q) / 2;
      if (p > 0) divergencia += p * Math.log2(p / mezcla) / 2;
      if (q > 0) divergencia += q * Math.log2(q / mezcla) / 2;
    }
    suma += Math.sqrt(Math.max(0, Math.min(1, divergencia)));
    pares++;
  }
  return suma / pares;
}

function fracciones(conteo: ReadonlyMap<string, number>, total: number): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const accion of ACCIONES) { const n = conteo.get(accion) ?? 0; if (n > 0) salida[accion] = n / total; }
  return salida;
}

/** Campos nuevos de `dia-NNN.json` (ver README del laboratorio, «Instrumentos de medida»). */
export interface MetricasInstrumentos {
  diversidadConductaTiempo: number;
  diversidadConductaTiempoComponentes: { conducta: number; oficios: number };
  /** El mismo índice con los ticks por acción SIN `rest` (conducta activa). */
  diversidadConductaActiva: number;
  diversidadConductaActivaComponentes: { conducta: number; oficios: number };
  diversidadConductaComponentes: { conducta: number; oficios: number };
  /**
   * C8 v3: el índice sobre perfiles de VENTANA FIJA — ticks por acción de cada mortal durante ESE día, sin
   * `rest`, solo de quienes vivieron el día completo. Con perfiles acumulados desde el nacimiento el índice
   * baja al envejecer la población aunque nadie cambie de conducta (modelo nulo en el README); con una
   * ventana de longitud fija el ruido de fondo es el mismo cada día. `null` con menos de 2 personas.
   */
  diversidadConductaVentana: number | null;
  diversidadConductaVentanaComponentes: { conducta: number; oficios: number } | null;
  personasVentana: number;
  repartoTiempoPorAccion: { personaTicks: number; fracciones: Record<string, number> };
  repartoActividadPorAccion: { incrementos: number; fracciones: Record<string, number> };
  foodShared: number;
  vocacionVarianza: number | null;
  vocacionEntropiaArgmax: number | null;
  vocacionCoincidencia: number | null;
  diversidadConductaVentanaGen1: number | null;
  /** `approach` cuyo motivo empieza con el texto de `settlementOpportunity`. */
  approachHogar: number | null;
  maderaMediaAdultos: number | null;
  piedraMediaAdultos: number | null;
  muertesMenores8Dias: number;
  cambiosHogar: { adopta: number; pierde: number };
  diversidadPerfilesJS: number | null;
  linajesVivos: number;
  linajesHerfindahl: number | null;
}

function mortalesVivos(world: World): Set<string> {
  return new Set(world.people.filter(person => person.role === 'neighbor').map(person => person.id));
}

export class InstrumentosConducta {
  /** Ticks por acción de cada persona viva desde que el laboratorio la ve (tick 0 o su nacimiento). */
  private readonly ticksPorPersona = new Map<string, Record<string, number>>();
  /** Ticks por acción de cada persona en el día en curso (ventana fija de C8 v3). */
  private readonly ticksDiaPorPersona = new Map<string, Record<string, number>>();
  /** Mortales vivos al empezar el día: solo ellos, si siguen vivos al acabarlo, entran en la ventana. */
  private vivosInicioDia = new Set<string>();
  /** Persona-ticks por acción de los vecinos mortales en el día en curso. */
  private readonly tiempoDia = new Map<string, number>();
  private personaTicksDia = 0;
  /** `activity` de cada vecino mortal al empezar el día (copia), para el reparto de activity del día. */
  private actividadInicioDia = new Map<string, Record<string, number>>();
  private comidaCompartida = 0;
  private approachHogarTicks = 0;
  private readonly muertesConocidas = new Set<string>();
  private muertesMenores8Dias = 0;
  /** Solo posiciones, nunca referencias a `home` mutables del mundo. */
  private readonly hogarAnterior = new Map<string, string | null>();
  private cambiosHogar = { adopta: 0, pierde: 0 };
  /** Raíz estable aun cuando el registro del antepasado salga de `world.legacy`. */
  private readonly raizPorId = new Map<string, string>();
  private contadorAntes = 0;
  /** Coste de los instrumentos en ms de reloj (se informa por consola, nunca en el JSON). */
  costeMs = 0;
  pasos = 0;

  constructor(world: World) {
    this.fotografiarActividad(world); this.vivosInicioDia = mortalesVivos(world);
    const identidades = new Map([...world.legacy, ...world.retiredLegacy, ...world.people]
      .filter(person => person.role === 'neighbor').map(person => [person.id, person] as const));
    const raiz = (id: string): string => {
      const conocida = this.raizPorId.get(id);
      if (conocida) return conocida;
      const persona = identidades.get(id);
      if (!persona) throw new Error(`Instrumentos: falta el progenitor transmisor ${id}.`);
      // reproduce() clona a `a` e inheritGenome([a,b]) conserva ese orden: parents[0] es `a`.
      const transmisor = persona.genome.parents[0];
      const resultado = transmisor === undefined ? id : raiz(transmisor);
      this.raizPorId.set(id, resultado);
      return resultado;
    };
    for (const person of world.people) if (person.role === 'neighbor') {
      raiz(person.id);
      this.hogarAnterior.set(person.id, person.home ? `${person.home.x},${person.home.y}` : null);
    }
    for (const record of [...world.legacy, ...world.retiredLegacy]) {
      if (this.muertesConocidas.has(record.id)) continue;
      this.muertesConocidas.add(record.id);
      if (record.role === 'neighbor' && record.diedAt - record.bornAt < 8 * TICKS_PER_DAY) this.muertesMenores8Dias++;
    }
  }

  private fotografiarActividad(world: World): void {
    this.actividadInicioDia = new Map(world.people.filter(p => p.role === 'neighbor').map(p => [p.id, { ...p.activity }]));
  }

  antesDelPaso(world: World): void { this.contadorAntes = world.eventCounter; }

  /** Ticks por acción observados de una persona viva (copia; para tests y diagnóstico). */
  ticksDe(id: string): Record<string, number> | undefined {
    const ticks = this.ticksPorPersona.get(id);
    return ticks ? { ...ticks } : undefined;
  }

  /** Llamar tras `stepWorld` y ANTES de `store.save` (que vacía `chronicleJournal.pending`). */
  despuesDelPaso(world: World): void {
    const inicio = performance.now();
    for (const person of world.people) {
      let ticks = this.ticksPorPersona.get(person.id);
      if (!ticks) { ticks = {}; this.ticksPorPersona.set(person.id, ticks); }
      ticks[person.action] = (ticks[person.action] ?? 0) + 1;
      let dia = this.ticksDiaPorPersona.get(person.id);
      if (!dia) { dia = {}; this.ticksDiaPorPersona.set(person.id, dia); }
      dia[person.action] = (dia[person.action] ?? 0) + 1;
      if (person.role === 'neighbor') {
        if (!this.raizPorId.has(person.id)) {
          const transmisor = person.genome.parents[0];
          if (!transmisor || !this.raizPorId.has(transmisor))
            throw new Error(`Instrumentos: falta la raíz del progenitor transmisor de ${person.id}.`);
          this.raizPorId.set(person.id, this.raizPorId.get(transmisor)!);
        }
        const hogar = person.home ? `${person.home.x},${person.home.y}` : null;
        const anterior = this.hogarAnterior.get(person.id) ?? null;
        if (hogar !== anterior) {
          if (hogar === null) this.cambiosHogar.pierde++;
          else this.cambiosHogar.adopta++;
        }
        this.hogarAnterior.set(person.id, hogar);
        this.tiempoDia.set(person.action, (this.tiempoDia.get(person.action) ?? 0) + 1); this.personaTicksDia++;
        // El motivo exacto lo emite sólo `settlementOpportunity`, antes de cualquier recuerdo añadido.
        if (person.action === 'approach' && person.reason.startsWith('Vuelve a un lugar conocido con agua, alimento, techo o cooperación;')) this.approachHogarTicks++;
      }
    }
    const vivos = new Set(world.people.filter(person => person.role === 'neighbor').map(person => person.id));
    for (const id of this.hogarAnterior.keys()) if (!vivos.has(id)) this.hogarAnterior.delete(id);
    for (const record of world.retiredLegacy) if (!this.muertesConocidas.has(record.id)) {
      this.muertesConocidas.add(record.id);
      if (record.role === 'neighbor' && record.diedAt - record.bornAt < 8 * TICKS_PER_DAY) this.muertesMenores8Dias++;
    }
    const nuevos = world.eventCounter - this.contadorAntes;
    if (nuevos > 0) {
      const pendientes = world.chronicleJournal?.pending ?? [];
      const desde = pendientes.length - nuevos;
      // Los sucesos del paso son la cola de `pending` (serie contigua e<antes+1>..e<después>). Si no
      // están todos, el recuento sería incompleto: se falla en voz alta, nunca se cuenta de menos.
      if (desde < 0 || pendientes[desde]!.id !== `e${this.contadorAntes + 1}`)
        throw new Error(`Instrumentos: los ${nuevos} sucesos del paso ${world.tick} no están en chronicleJournal.pending (¿guardado antes de observar?).`);
      for (let i = desde; i < pendientes.length; i++) if (pendientes[i]!.kind === 'care') this.comidaCompartida++;
    }
    this.pasos++;
    this.costeMs += performance.now() - inicio;
  }

  /** Métricas del día que acaba en `world.tick`; reinicia los acumuladores del día. */
  metricasDia(world: World): MetricasInstrumentos {
    const inicio = performance.now();
    const vacio: Record<string, number> = {};
    const tiempo = indiceDiversidadConActividad(world, person => this.ticksPorPersona.get(person.id) ?? vacio);
    const activa = indiceDiversidadConActividad(world, person => sinDescanso(this.ticksPorPersona.get(person.id) ?? vacio));
    const actividad = indiceDiversidadConActividad(world, person => person.activity);
    const enVentana = world.people.filter(person => person.role === 'neighbor' && this.vivosInicioDia.has(person.id));
    const ventana = enVentana.length >= 2
      ? indiceDiversidadDe(world, enVentana, person => sinDescanso(this.ticksDiaPorPersona.get(person.id) ?? vacio))
      : null;
    const gen1 = enVentana.filter(person => person.genome.generation >= 1);
    const ventanaGen1 = gen1.length >= 2
      ? indiceDiversidadDe(world, gen1, person => sinDescanso(this.ticksDiaPorPersona.get(person.id) ?? vacio))
      : null;
    const conVocacion = world.people.filter(person => person.role === 'neighbor' && person.vocacion !== undefined);
    const argmax = (person: Person): string => OFICIOS_DE_LINAJE.reduce((mejor, oficio) =>
      (person.vocacion?.[oficio] ?? 0) > (person.vocacion?.[mejor] ?? 0) ? oficio : mejor, OFICIOS_DE_LINAJE[0]!);
    let vocacionVarianza: number | null = null;
    if (conVocacion.length >= 2) vocacionVarianza = OFICIOS_DE_LINAJE.reduce((total, oficio) => {
      const media = conVocacion.reduce((suma, person) => suma + (person.vocacion?.[oficio] ?? 0), 0) / conVocacion.length;
      return total + conVocacion.reduce((suma, person) => suma + ((person.vocacion?.[oficio] ?? 0) - media) ** 2, 0) / conVocacion.length;
    }, 0) / OFICIOS_DE_LINAJE.length;
    const cuentas = new Map<string, number>();
    for (const person of conVocacion) cuentas.set(argmax(person), (cuentas.get(argmax(person)) ?? 0) + 1);
    const vocacionEntropiaArgmax = conVocacion.length ? -[...cuentas.values()].reduce((suma, n) => {
      const p = n / conVocacion.length; return suma + p * Math.log(p);
    }, 0) / Math.log(OFICIOS_DE_LINAJE.length) : null;
    const enVentanaConVocacion = enVentana.filter(person => person.vocacion !== undefined);
    const vocacionCoincidencia = enVentanaConVocacion.length ? enVentanaConVocacion.filter(person => {
      const ticks = this.ticksDiaPorPersona.get(person.id) ?? vacio;
      const dominante = OFICIOS_DE_LINAJE.reduce((mejor, oficio) => (ticks[oficio] ?? 0) > (ticks[mejor] ?? 0) ? oficio : mejor, OFICIOS_DE_LINAJE[0]!);
      return (ticks[dominante] ?? 0) > 0 && dominante === argmax(person);
    }).length / enVentanaConVocacion.length : null;
    const adultos = world.people.filter(person => person.role === 'neighbor' && world.tick - person.bornAt >= 5 * TICKS_PER_DAY);
    const mediaAdultos = (material: 'wood' | 'stone'): number | null => adultos.length
      ? adultos.reduce((suma, person) => suma + person.materials[material], 0) / adultos.length : null;
    const linajes = new Map<string, number>();
    for (const person of world.people) if (person.role === 'neighbor') {
      const raiz = this.raizPorId.get(person.id);
      if (!raiz) throw new Error(`Instrumentos: falta la raíz de ${person.id}.`);
      linajes.set(raiz, (linajes.get(raiz) ?? 0) + 1);
    }
    const mortales = [...linajes.values()].reduce((suma, n) => suma + n, 0);
    const ticksActivos = this.personaTicksDia - (this.tiempoDia.get('rest') ?? 0);
    const incrementos = new Map<string, number>();
    let totalIncrementos = 0;
    for (const person of world.people) {
      if (person.role !== 'neighbor') continue;
      const previa = this.actividadInicioDia.get(person.id);
      for (const accion of ACCIONES) {
        const n = (person.activity[accion] ?? 0) - (previa?.[accion] ?? 0);
        if (n > 0) { incrementos.set(accion, (incrementos.get(accion) ?? 0) + n); totalIncrementos += n; }
      }
    }
    const metricas: MetricasInstrumentos = {
      diversidadConductaTiempo: tiempo.total,
      diversidadConductaTiempoComponentes: { conducta: tiempo.conducta, oficios: tiempo.oficios },
      diversidadConductaActiva: activa.total,
      diversidadConductaActivaComponentes: { conducta: activa.conducta, oficios: activa.oficios },
      diversidadConductaComponentes: { conducta: actividad.conducta, oficios: actividad.oficios },
      diversidadConductaVentana: ventana ? ventana.total : null,
      diversidadConductaVentanaComponentes: ventana ? { conducta: ventana.conducta, oficios: ventana.oficios } : null,
      personasVentana: enVentana.length,
      repartoTiempoPorAccion: { personaTicks: this.personaTicksDia, fracciones: fracciones(this.tiempoDia, this.personaTicksDia) },
      repartoActividadPorAccion: { incrementos: totalIncrementos, fracciones: fracciones(incrementos, totalIncrementos) },
      foodShared: this.comidaCompartida,
      vocacionVarianza,
      vocacionEntropiaArgmax,
      vocacionCoincidencia,
      diversidadConductaVentanaGen1: ventanaGen1?.total ?? null,
      approachHogar: ticksActivos ? this.approachHogarTicks / ticksActivos : null,
      maderaMediaAdultos: mediaAdultos('wood'),
      piedraMediaAdultos: mediaAdultos('stone'),
      muertesMenores8Dias: this.muertesMenores8Dias,
      cambiosHogar: { ...this.cambiosHogar },
      diversidadPerfilesJS: diversidadPerfilesJS(enVentana.map(person => this.ticksDiaPorPersona.get(person.id) ?? vacio)),
      linajesVivos: linajes.size,
      linajesHerfindahl: mortales ? [...linajes.values()].reduce((suma, n) => suma + (n / mortales) ** 2, 0) : null,
    };
    const vivos = new Set(world.people.map(person => person.id));
    for (const id of [...this.ticksPorPersona.keys()]) if (!vivos.has(id)) this.ticksPorPersona.delete(id);
    this.tiempoDia.clear(); this.personaTicksDia = 0; this.approachHogarTicks = 0;
    this.cambiosHogar = { adopta: 0, pierde: 0 };
    this.ticksDiaPorPersona.clear(); this.vivosInicioDia = mortalesVivos(world);
    this.fotografiarActividad(world);
    this.costeMs += performance.now() - inicio;
    return metricas;
  }
}
