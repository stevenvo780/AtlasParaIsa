export interface EventoTerritorial {
  readonly region: string;
  readonly evento: string;
  readonly tick: number;
  readonly generacion: number;
}

export interface CorteAgendaTerritorial {
  readonly version: 1;
  readonly epoca: number;
  readonly tick: number;
  readonly ultimaGeneracion: number;
  readonly pendientes: readonly EventoTerritorial[];
}

interface Nodo {
  readonly clave: string;
  readonly evento: EventoTerritorial;
  posicion: number;
}

const claveDe = (region: string, evento: string): string => JSON.stringify([region, evento]);
const entero = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const claveValida = (s: unknown): s is string => typeof s === 'string' && s.length > 0;
const objeto = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (a: string, b: string): number => a < b ? -1 : Number(a > b);
const comparar = (a: EventoTerritorial, b: EventoTerritorial): number => a.tick - b.tick || texto(a.region, b.region) || texto(a.evento, b.evento);

/** Agenda de un solo escritor. Un par región/evento puede tener un solo vencimiento pendiente.
 * El índice permite retirar o sustituir una entrada sin acumular versiones obsoletas. */
export class AgendaTerritorial {
  #tick: number;
  #ultimaGeneracion = 0;
  readonly #nodos: Nodo[] = [];
  readonly #porClave = new Map<string, Nodo>();

  constructor(tick = 0) {
    if (!entero(tick)) throw new RangeError('Tick inicial inválido');
    this.#tick = tick;
  }

  /** Repetir el vencimiento devuelve el mismo identificador. Cambiarlo crea una generación nueva. */
  programar(region: string, evento: string, tick: number): EventoTerritorial {
    if (!claveValida(region) || !claveValida(evento)) throw new TypeError('Región o evento vacío');
    if (!entero(tick) || tick <= this.#tick) throw new RangeError('El vencimiento debe ser posterior al tick de la agenda');
    const clave = claveDe(region, evento);
    const anterior = this.#porClave.get(clave);
    if (anterior?.evento.tick === tick) return anterior.evento;
    if (this.#ultimaGeneracion === Number.MAX_SAFE_INTEGER) throw new RangeError('Generación de agenda no representable');
    const siguiente = Object.freeze({ region, evento, tick, generacion: ++this.#ultimaGeneracion });
    if (anterior) this.#retirar(anterior);
    this.#agregar(clave, siguiente);
    return siguiente;
  }

  /** Un aviso obsoleto nunca cancela el vencimiento que lo sustituyó. */
  invalidar({ region, evento, generacion }: Pick<EventoTerritorial, 'region' | 'evento' | 'generacion'>): boolean {
    const nodo = this.#porClave.get(claveDe(region, evento));
    if (!nodo || nodo.evento.generacion !== generacion) return false;
    this.#retirar(nodo);
    return true;
  }

  /** Extrae en orden todos los vencimientos hasta este tick. El integrador guarda el corte sólo junto con sus efectos. */
  extraerHasta(tick: number): EventoTerritorial[] {
    if (!entero(tick) || tick < this.#tick) throw new RangeError('La agenda no puede retroceder');
    const vencidos: EventoTerritorial[] = [];
    while (this.#nodos[0] && this.#nodos[0].evento.tick <= tick) {
      const nodo = this.#nodos[0];
      vencidos.push(nodo.evento);
      this.#retirar(nodo);
    }
    this.#tick = tick;
    return vencidos;
  }

  corte(epoca: number): CorteAgendaTerritorial {
    if (!entero(epoca)) throw new RangeError('Época de agenda inválida');
    return { version: 1, epoca, tick: this.#tick, ultimaGeneracion: this.#ultimaGeneracion,
      pendientes: this.#nodos.map(nodo => nodo.evento).sort(comparar) };
  }

  /** Lee sólo cortes que coinciden con la época y el tick del estado durable que los acompaña. */
  static restaurar(corte: unknown, epoca: number, tick: number): AgendaTerritorial {
    if (!entero(epoca) || !entero(tick) || !objeto(corte) || corte.version !== 1 || corte.epoca !== epoca || corte.tick !== tick
      || !entero(corte.ultimaGeneracion) || !Array.isArray(corte.pendientes)) throw new TypeError('Corte de agenda incompatible');
    const agenda = new AgendaTerritorial(tick);
    agenda.#ultimaGeneracion = corte.ultimaGeneracion;
    const generaciones = new Set<number>();
    for (const dato of corte.pendientes as unknown[]) {
      if (!objeto(dato) || !claveValida(dato.region) || !claveValida(dato.evento) || !entero(dato.tick) || dato.tick <= tick
        || !entero(dato.generacion) || dato.generacion === 0 || dato.generacion > agenda.#ultimaGeneracion)
        throw new TypeError('Vencimiento inválido en el corte de agenda');
      const clave = claveDe(dato.region, dato.evento);
      if (agenda.#porClave.has(clave) || generaciones.has(dato.generacion)) throw new TypeError('Vencimiento duplicado en el corte de agenda');
      generaciones.add(dato.generacion);
      agenda.#agregar(clave, Object.freeze({ region: dato.region, evento: dato.evento, tick: dato.tick, generacion: dato.generacion }));
    }
    return agenda;
  }

  #agregar(clave: string, evento: EventoTerritorial): void {
    const nodo = { clave, evento, posicion: this.#nodos.length };
    this.#nodos.push(nodo);
    this.#porClave.set(clave, nodo);
    this.#subir(nodo);
  }

  #retirar(nodo: Nodo): void {
    this.#porClave.delete(nodo.clave);
    const ultimo = this.#nodos.pop()!;
    if (ultimo === nodo) return;
    ultimo.posicion = nodo.posicion;
    this.#nodos[ultimo.posicion] = ultimo;
    if (!this.#subir(ultimo)) this.#bajar(ultimo);
  }

  #subir(nodo: Nodo): boolean {
    const inicial = nodo.posicion;
    while (nodo.posicion > 0) {
      const padre = this.#nodos[Math.floor((nodo.posicion - 1) / 2)]!;
      if (comparar(nodo.evento, padre.evento) >= 0) break;
      this.#intercambiar(nodo, padre);
    }
    return nodo.posicion !== inicial;
  }

  #bajar(nodo: Nodo): void {
    for (;;) {
      const izquierda = 2 * nodo.posicion + 1;
      const primero = this.#nodos[izquierda];
      if (!primero) return;
      const segundo = this.#nodos[izquierda + 1];
      const menor = segundo && comparar(segundo.evento, primero.evento) < 0 ? segundo : primero;
      if (comparar(nodo.evento, menor.evento) <= 0) return;
      this.#intercambiar(nodo, menor);
    }
  }

  #intercambiar(a: Nodo, b: Nodo): void {
    this.#nodos[a.posicion] = b;
    this.#nodos[b.posicion] = a;
    const anterior = a.posicion;
    a.posicion = b.posicion;
    b.posicion = anterior;
  }
}
