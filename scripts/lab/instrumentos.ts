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
import type { DatabaseSync } from 'node:sqlite';
import type { Capability, TechnologyExecution } from '../../src/shared/technology.js';
import { TICKS_PER_DAY, type Person, type World } from '../../src/world/index.js';
import { indiceDiversidad } from '../../src/world/diversidad.js';
import { appendFileSync, closeSync, openSync, readSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beginObservationAttempt, bindObservation, bindObservationAttempt, coverageStatus, createObservationSession,
  drainObservation, endObservationAttempt, markObservationAttempt } from '../../src/world/observation.js';


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

const CAPACIDADES: readonly Capability[] = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
export interface UsoUtil { recipeId: string; capacities: Readonly<Record<Capability, number>> }
export interface RepertorioAbierto { usos: number; clasesR100: number; recetasR100: number; clasesHill2: number }

/** B: cada uso exitoso con benefit>0 pesa uno. Clase = máscara de las seis capacidades en
 * CAPACIDADES cuyo valor es >=0,2. R100 = Σ_i [1-C(N-N_i,100)/C(N,100)] (sin reemplazo);
 * el producto de 100 razones evita factoriales y overflow. Hill-2 = 1/Σ_i(N_i/N)^2.
 * Los cuatro campos son null en conjunto si N<100; no hay muestreo ni azar. */
export function repertorioAbierto(usos: readonly UsoUtil[]): RepertorioAbierto | null {
  const N = usos.length, n = 100;
  if (N < n) return null;
  const recetas = new Map<string, number>(), clases = new Map<number, number>();
  for (const uso of usos) {
    recetas.set(uso.recipeId, (recetas.get(uso.recipeId) ?? 0) + 1);
    let clase = 0;
    for (let i = 0; i < CAPACIDADES.length; i++) if ((uso.capacities[CAPACIDADES[i]!] ?? 0) >= 0.2) clase |= 1 << i;
    clases.set(clase, (clases.get(clase) ?? 0) + 1);
  }
  const rareza = (cuentas: ReadonlyMap<unknown, number>): number => {
    let suma = 0;
    for (const Ni of cuentas.values()) {
      let ausente = 1;
      for (let k = 0; k < n; k++) { ausente *= (N - Ni - k) / (N - k); if (ausente <= 0) break; }
      suma += 1 - Math.max(0, ausente);
    }
    return suma;
  };
  return { usos: N, clasesR100: rareza(clases), recetasR100: rareza(recetas),
    clasesHill2: 1 / [...clases.values()].reduce((s, Ni) => s + (Ni / N) ** 2, 0) };
}

/** Lee exactamente el intervalo y el predicado de usosUtiles en metrics.ts, después de save().
 * JOIN con la definición archivada: la receta puede haber salido de la ventana LRU del mundo.
 * Una definición ausente invalida la medida; nunca se agrupa silenciosamente como clase cero. */
export function repertorioAbiertoDurable(db: DatabaseSync, desdeTickExclusivo: number, hastaTickInclusivo: number): RepertorioAbierto | null {
  const usos: UsoUtil[] = [];
  const rows = db.prepare(`SELECT e.body AS execution, d.body AS recipe FROM technology_executions e
    LEFT JOIN technology_definitions d ON d.id=json_extract(e.body,'$.recipeId')
    WHERE e.tick>? AND e.tick<=? ORDER BY e.serial`);
  for (const row of rows.iterate(desdeTickExclusivo, hastaTickInclusivo)) {
    const execution = JSON.parse(row.execution as string) as TechnologyExecution;
    if (!execution.success || !execution.recipeId || execution.kind !== 'use' || execution.benefit <= 0) continue;
    if (row.recipe === null) throw new Error(`Instrumentos: falta la definición de ${execution.recipeId}.`);
    const recipe = JSON.parse(row.recipe as string) as { capacities: Record<Capability, number> };
    usos.push({ recipeId: execution.recipeId, capacities: recipe.capacities });
  }
  return repertorioAbierto(usos);
}

export interface PerfilGrupo { ticks: Readonly<Record<string, number>>; grupo: string | null }
/** Cuenta cada comunidad registrada al cierre, incluso si hoy no tiene mortales vivos. */
export function censoComunidades(comunidades: readonly { id: string }[], personas: readonly Pick<Person, 'role' | 'communityId'>[]): { n: number; tamanos: number[]; sinComunidad: number } {
  const cuentas = new Map<string, number>(comunidades.map(comunidad => [comunidad.id, 0]));
  let sinComunidad = 0;
  for (const person of personas) if (person.role === 'neighbor') {
    if (person.communityId === null) sinComunidad++;
    else if (cuentas.has(person.communityId)) cuentas.set(person.communityId, cuentas.get(person.communityId)! + 1);
  }
  return { n: comunidades.length, tamanos: [...cuentas.values()].sort((a, b) => b - a), sinComunidad };
}
/** C: W(d) = mortales vivos tanto al comienzo como al cierre. Perfil = ticks de acciones
 * del día sin rest, normalizados a suma 1; un perfil sin actividad es el vector cero.
 * Distancia declarada: L1/2. SS_total=Σ_{i<j}d(i,j)^2/N y
 * SS_intra=Σ_g Σ_{i<j∈g}d(i,j)^2/n_g; F=1-SS_intra/SS_total (0 si SS_total=0).
 * Se excluyen etiquetas null. Se exige >=2 grupos con >=2 personas. El resultado resta la media
 * de 20 F tras barajar etiquetas entre personas, preservando tamaños, con xorshift32 local
 * sembrado por semilla del mundo, día y canal. Nunca usa ni escribe world.rng. */
export function diversidadEntreGrupos(perfiles: readonly PerfilGrupo[], seed: number, dia: number, canal = 0): number | null {
  const validos = perfiles.filter(p => p.grupo !== null);
  const N = validos.length, etiquetas = validos.map(p => p.grupo!);
  const tamanos = new Map<string, number>();
  for (const g of etiquetas) tamanos.set(g, (tamanos.get(g) ?? 0) + 1);
  if ([...tamanos.values()].filter(n => n >= 2).length < 2) return null;
  const acciones = ACCIONES.filter(a => a !== 'rest');
  const vectores = validos.map(({ ticks }) => {
    const total = acciones.reduce((s, a) => s + (ticks[a] ?? 0), 0);
    return acciones.map(a => total ? (ticks[a] ?? 0) / total : 0);
  });
  const pares: { i: number; j: number; d2: number }[] = [];
  let totalDistancia = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    let d = 0;
    for (let k = 0; k < acciones.length; k++) d += Math.abs(vectores[i]![k]! - vectores[j]![k]!);
    const d2 = (d / 2) ** 2;
    pares.push({ i, j, d2 }); totalDistancia += d2;
  }
  if (totalDistancia === 0) return 0;
  const fraccion = (labels: readonly string[]): number => {
    let intra = 0;
    for (const { i, j, d2 } of pares) if (labels[i] === labels[j]) intra += d2 / tamanos.get(labels[i]!)!;
    return 1 - N * intra / totalDistancia;
  };
  const observado = fraccion(etiquetas);
  let estado = (seed ^ Math.imul(dia, 0x9e3779b9) ^ Math.imul(canal + 1, 0x85ebca6b)) >>> 0;
  if (estado === 0) estado = 0x6d2b79f5;
  const azar = (): number => { estado ^= estado << 13; estado ^= estado >>> 17; estado ^= estado << 5; return estado >>> 0; };
  let nulo = 0;
  for (let r = 0; r < 20; r++) {
    const perm = [...etiquetas];
    for (let i = N - 1; i > 0; i--) { const j = azar() % (i + 1); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
    nulo += fraccion(perm);
  }
  return observado - nulo / 20;
}

function fracciones(conteo: ReadonlyMap<string, number>, total: number): Record<string, number> {
  const salida: Record<string, number> = {};
  for (const accion of ACCIONES) { const n = conteo.get(accion) ?? 0; if (n > 0) salida[accion] = n / total; }
  return salida;
}

/** Campos nuevos de `dia-NNN.json` (ver README del laboratorio, «Instrumentos de medida»).
 * La poda de leyes refutadas (ola 1, 2026-09-27) retiró las claves `natalidadLocal`,
 * `vocacionVarianza`, `vocacionEntropiaArgmax` y `vocacionCoincidencia`; los JSON antiguos
 * las conservan y los evaluadores congelados las siguen leyendo de esos ficheros. */
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
  /** Comunidades registradas al cierre; el tamaño de una comunidad sin mortales es cero. */
  censoComunidades: { n: number; tamanos: number[]; sinComunidad: number };
  /** Alternativa B, null si hubo menos de 100 usos útiles en el día. */
  repertorioAbierto: RepertorioAbierto | null;
  /** Alternativa C; cada canal es null si no hay dos grupos de al menos dos personas. */
  diversidadEntreGrupos: { comunidades: number | null; linajes: number | null };
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

  constructor(world: World, db?: DatabaseSync) {
    this.fotografiarActividad(world); this.vivosInicioDia = mortalesVivos(world);
    const identidades = new Map([...world.legacy, ...world.retiredLegacy, ...world.people]
      .filter(person => person.role === 'neighbor').map(person => [person.id, person] as const));
    const legadoArchivado = db?.prepare('SELECT body FROM legacy WHERE id=?');
    const raiz = (id: string): string => {
      const conocida = this.raizPorId.get(id);
      if (conocida) return conocida;
      let persona = identidades.get(id);
      if (!persona && legadoArchivado) {
        const fila = legadoArchivado.get(id) as { body: string } | undefined;
        if (fila) { persona = JSON.parse(fila.body) as Person; identidades.set(id, persona); }
      }
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

  antesDelPaso(world: World): void {
    this.contadorAntes = world.eventCounter;
  }

  /** Sin observadores que retirar: los instrumentos solo leen (la poda ola 1 retiró el observador NAT-L). */
  cerrar(): void { /* sin estado externo */ }

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
  metricasDia(world: World, db?: DatabaseSync): MetricasInstrumentos {
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
    const comunidades = censoComunidades(world.communities, world.people);
    const comunidadPerfiles = enVentana.map(person => ({ ticks: this.ticksDiaPorPersona.get(person.id) ?? vacio, grupo: person.communityId }));
    const linajePerfiles = enVentana.map(person => ({ ticks: this.ticksDiaPorPersona.get(person.id) ?? vacio, grupo: this.raizPorId.get(person.id) ?? null }));
    const dia = Math.ceil(world.tick / TICKS_PER_DAY);
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
      diversidadConductaVentanaGen1: ventanaGen1?.total ?? null,
      approachHogar: ticksActivos ? this.approachHogarTicks / ticksActivos : null,
      maderaMediaAdultos: mediaAdultos('wood'),
      piedraMediaAdultos: mediaAdultos('stone'),
      muertesMenores8Dias: this.muertesMenores8Dias,
      cambiosHogar: { ...this.cambiosHogar },
      diversidadPerfilesJS: diversidadPerfilesJS(enVentana.map(person => this.ticksDiaPorPersona.get(person.id) ?? vacio)),
      linajesVivos: linajes.size,
      linajesHerfindahl: mortales ? [...linajes.values()].reduce((suma, n) => suma + (n / mortales) ** 2, 0) : null,
      censoComunidades: comunidades,
      repertorioAbierto: db ? repertorioAbiertoDurable(db, world.tick - TICKS_PER_DAY, world.tick) : null,
      diversidadEntreGrupos: {
        comunidades: diversidadEntreGrupos(comunidadPerfiles, world.seed, dia, 0),
        linajes: diversidadEntreGrupos(linajePerfiles, world.seed, dia, 1),
      },
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

/** R2 technical observer adapter. It is separate from the C8 instruments and off by default. */
export type RealismoSourceManifest = Readonly<{
  identityKind: 'composite-source-runtime-v1'; sourceSHA: string; sourceTreeDigest: string;
  sourceSHAAlgorithm: 'sha1-of-descriptor-v1'; sourceTreeDigestAlgorithm: 'sha256-of-descriptor-v1';
  baseCommit: string; runtime: Readonly<{ node: string; v8: string; modules: string; platform: string; arch: string }>;
  files: readonly Readonly<{ path: string; sha256: string }>[];
}>;
export function makeRealismoSourceManifest(input: Pick<RealismoSourceManifest, 'baseCommit' | 'runtime' | 'files'>): RealismoSourceManifest {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const descriptor = JSON.stringify({ identityKind: 'composite-source-runtime-v1', baseCommit: input.baseCommit,
    runtime: input.runtime, files });
  return { identityKind: 'composite-source-runtime-v1',
    sourceSHA: createHash('sha1').update(descriptor).digest('hex'),
    sourceTreeDigest: createHash('sha256').update(descriptor).digest('hex'),
    sourceSHAAlgorithm: 'sha1-of-descriptor-v1', sourceTreeDigestAlgorithm: 'sha256-of-descriptor-v1',
    baseCommit: input.baseCommit, runtime: input.runtime, files };
}
export class InstrumentosRealismo {
  readonly session: import('../../src/world/observation.js').ObservationSession;
  private readonly sidecar: string;
  private readonly manifest: string;
  private readonly sourceManifest: RealismoSourceManifest;
  private readonly sourceManifestSha256: string;
  private readonly intendedSidecarHash = createHash('sha256');
  private intendedSidecarBytes = 0;
  private writtenEvents = 0;
  costeMs = 0;
  constructor(world: World, runId: string, epochId: string, sourceManifest: RealismoSourceManifest, outputDir: string) {
    this.sourceManifest = sourceManifest;
    const sourceManifestBody = JSON.stringify(sourceManifest, null, 2) + '\n';
    this.sourceManifestSha256 = createHash('sha256').update(sourceManifestBody).digest('hex');
    this.session = createObservationSession({ runId, epochId, sourceSHA: sourceManifest.sourceSHA, capacity: 65536 });
    bindObservation(world, this.session);
    this.sidecar = join(outputDir, 'realismo-source-events.ndjson');
    this.manifest = join(outputDir, 'realismo-observer.json');
    writeFileSync(join(outputDir, 'realismo-source-manifest.json'), sourceManifestBody, { mode: 0o600 });
    writeFileSync(this.sidecar, '', { mode: 0o600 });
  }
  beginOpening(world: World): string { return beginObservationAttempt(world, world.tick); }
  begin(world: World): string { return beginObservationAttempt(world, world.tick + 1); }
  clone(from: World, draft: World): void { bindObservationAttempt(from, draft); }
  state(world: World, status: 'adopted' | 'discarded' | 'restored' | 'partial' | 'durable'): void { markObservationAttempt(world, status); }
  end(world: World): void { endObservationAttempt(world); }
  async drain(): Promise<void> {
    const start = performance.now();
    await drainObservation(this.session, event => {
      const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
      appendFileSync(this.sidecar, line, { mode: 0o600 });
      this.intendedSidecarHash.update(line);
      this.intendedSidecarBytes += line.length;
      this.writtenEvents++;
    });
    this.costeMs += performance.now() - start;
  }
  private gap(reason: string, siteId = 'sidecar'): void {
    const lastAttempt = [...this.session.attemptHistory.keys()].at(-1) ?? null;
    if (this.session.gaps.length < this.session.capacity)
      this.session.gaps.push(Object.freeze({ attemptId: lastAttempt, tick: null, siteId, reason }));
    else this.session.lostGaps++;
  }
  /** Seal actual on-disk bytes, including any partial write, with bounded memory. */
  private sealSidecar(): { sha256: string; bytes: number; lines: number; completeLines: boolean } {
    const fd = openSync(this.sidecar, 'r'), buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = createHash('sha256');
    let bytes = 0, lines = 0, lastByte = 10;
    try {
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count)); bytes += count; lastByte = buffer[count - 1]!;
        for (let i = 0; i < count; i++) if (buffer[i] === 10) lines++;
      }
    } finally { closeSync(fd); }
    return { sha256: hash.digest('hex'), bytes, lines, completeLines: bytes === 0 || lastByte === 10 };
  }
  abort(): void {
    const latest = [...this.session.attemptHistory.entries()].at(-1);
    if (latest && !latest[1].some(transition => transition.state === 'discarded' || transition.state === 'restored' || transition.state === 'partial')
      && latest[1].at(-1)?.state !== 'durable') {
      latest[1].push(Object.freeze({ state: 'partial' as const }));
      if (this.session.gaps.length < this.session.capacity)
        this.session.gaps.push(Object.freeze({ attemptId: latest[0], tick: null, siteId: 'attempt', reason: 'run-aborted' }));
      else this.session.lostGaps++;
    }
  }
  finish(currentSourceManifest?: RealismoSourceManifest): void {
    if (!currentSourceManifest || currentSourceManifest.sourceTreeDigest !== this.sourceManifest.sourceTreeDigest) {
      this.gap('source-drift', 'source');
    }
    let sidecarSeal: ReturnType<InstrumentosRealismo['sealSidecar']> | null = null;
    try { sidecarSeal = this.sealSidecar(); }
    catch { this.gap('sidecar-seal-failed'); }
    const intendedSha256 = this.intendedSidecarHash.copy().digest('hex');
    const matchesWriter = sidecarSeal !== null && sidecarSeal.sha256 === intendedSha256
      && sidecarSeal.bytes === this.intendedSidecarBytes;
    if (!matchesWriter) this.gap('sidecar-content-mismatch');
    if (sidecarSeal && (!sidecarSeal.completeLines || sidecarSeal.lines !== this.writtenEvents || this.session.queue.length > 0))
      this.gap('sidecar-count-or-line-boundary-mismatch');
    const coverage = coverageStatus(this.session);
    writeFileSync(this.manifest, JSON.stringify({ runId: this.session.runId, epochId: this.session.epochId,
      sourceSHA: this.session.sourceSHA, sourceIdentityKind: this.sourceManifest.identityKind,
      sourceSHAAlgorithm: this.sourceManifest.sourceSHAAlgorithm,
      baseCommit: this.sourceManifest.baseCommit, sourceTreeDigest: this.sourceManifest.sourceTreeDigest,
      sourceManifestSha256: this.sourceManifestSha256, finalSourceTreeDigest: currentSourceManifest?.sourceTreeDigest ?? null,
      sourceEventsSha256: sidecarSeal?.sha256 ?? null, sourceEventsBytes: sidecarSeal?.bytes ?? null,
      sourceEventsIntendedSha256: intendedSha256, sourceEventsIntendedBytes: this.intendedSidecarBytes,
      sourceEventsSealMatchesWriter: matchesWriter,
      sourceEventsLines: sidecarSeal?.lines ?? null, sourceEventsWritten: this.writtenEvents,
      sourceEventsCompleteLines: sidecarSeal?.completeLines ?? null,
      quality: coverage.quality, lostEvents: coverage.lostEvents, lostGaps: coverage.lostGaps,
      gaps: coverage.gaps, attemptHistory: [...this.session.attemptHistory] }, null, 2) + '\n', { mode: 0o600 });
  }
}
