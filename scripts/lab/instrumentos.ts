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
import type { Person, World } from '../../src/world/index.js';
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
  repartoTiempoPorAccion: { personaTicks: number; fracciones: Record<string, number> };
  repartoActividadPorAccion: { incrementos: number; fracciones: Record<string, number> };
  foodShared: number;
}

export class InstrumentosConducta {
  /** Ticks por acción de cada persona viva desde que el laboratorio la ve (tick 0 o su nacimiento). */
  private readonly ticksPorPersona = new Map<string, Record<string, number>>();
  /** Persona-ticks por acción de los vecinos mortales en el día en curso. */
  private readonly tiempoDia = new Map<string, number>();
  private personaTicksDia = 0;
  /** `activity` de cada vecino mortal al empezar el día (copia), para el reparto de activity del día. */
  private actividadInicioDia = new Map<string, Record<string, number>>();
  private comidaCompartida = 0;
  private contadorAntes = 0;
  /** Coste de los instrumentos en ms de reloj (se informa por consola, nunca en el JSON). */
  costeMs = 0;
  pasos = 0;

  constructor(world: World) { this.fotografiarActividad(world); }

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
      if (person.role === 'neighbor') { this.tiempoDia.set(person.action, (this.tiempoDia.get(person.action) ?? 0) + 1); this.personaTicksDia++; }
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
      repartoTiempoPorAccion: { personaTicks: this.personaTicksDia, fracciones: fracciones(this.tiempoDia, this.personaTicksDia) },
      repartoActividadPorAccion: { incrementos: totalIncrementos, fracciones: fracciones(incrementos, totalIncrementos) },
      foodShared: this.comidaCompartida,
    };
    const vivos = new Set(world.people.map(person => person.id));
    for (const id of [...this.ticksPorPersona.keys()]) if (!vivos.has(id)) this.ticksPorPersona.delete(id);
    this.tiempoDia.clear(); this.personaTicksDia = 0;
    this.fotografiarActividad(world);
    this.costeMs += performance.now() - inicio;
    return metricas;
  }
}
