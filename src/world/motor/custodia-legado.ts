import type { LegacyRecord } from '../../shared/demography.js';
import { assertLegacyRecord } from '../lineage.js';
import type { World } from '../mundo/tipos.js';
import { bindWorldContext, worldContext, type WorldContext } from '../spatial.js';

export interface TokenLegadoCorte {
  readonly solicitud: bigint;
  readonly epoca: number;
  readonly tick: number;
}

interface CapturaLegado {
  token: TokenLegadoCorte;
  prefijo: LegacyRecord[];
  separado: boolean;
}

/** Cada dueño retiene las referencias de su cola hasta que se resuelva el corte que las contiene. */
export class CustodiaLegado {
  #captura?: CapturaLegado;

  constructor(private readonly mundo: Pick<World, 'retiredLegacy'>) {}

  capturar(token: TokenLegadoCorte): readonly LegacyRecord[] {
    if (this.#captura?.separado) throw new Error('Ya hay una custodia de legado pendiente.');
    const prefijo = this.mundo.retiredLegacy.slice();
    this.#captura = { token, prefijo, separado: false };
    return prefijo;
  }

  separar(token: TokenLegadoCorte): void {
    const captura = this.#comprobar(token), { retiredLegacy } = this.mundo;
    if (captura.separado || captura.prefijo.length !== retiredLegacy.length
      || captura.prefijo.some((registro, i) => registro !== retiredLegacy[i]))
      throw new Error('La cola de legado cambió antes de separar el corte.');
    this.mundo.retiredLegacy = [];
    captura.separado = true;
  }

  resolver(token: TokenLegadoCorte, restituir: boolean): void {
    const captura = this.#comprobar(token);
    if (!captura.separado) throw new Error('La custodia de legado aún no se separó.');
    if (restituir) this.mundo.retiredLegacy = captura.prefijo.concat(this.mundo.retiredLegacy);
    this.#captura = undefined;
  }

  descartarCandidato(): void {
    if (!this.#captura?.separado) this.#captura = undefined;
  }

  #comprobar(token: TokenLegadoCorte): CapturaLegado {
    const captura = this.#captura;
    if (!captura || captura.token.solicitud !== token.solicitud || captura.token.epoca !== token.epoca || captura.token.tick !== token.tick)
      throw new Error('La custodia de legado no pertenece al corte solicitado.');
    return captura;
  }
}

/** Índice del prefijo completo, con copias privadas que ninguna vista puede modificar. */
export function indexarLegadoCorte(listas: readonly (readonly LegacyRecord[])[], tick: number): ReadonlyMap<string, LegacyRecord> {
  const registros = new Map<string, LegacyRecord>();
  for (const lista of listas) for (const registro of lista) {
    assertLegacyRecord(registro, tick);
    if (registros.has(registro.id)) throw new Error('La identidad de legado está repetida en el corte.');
    registros.set(registro.id, structuredClone(registro));
  }
  return registros;
}

/** Las vistas reunidas heredan el mismo lector. Revocarlo también retira el prefijo de las vistas ya construidas. */
export class CapaLegadoCorte {
  #mundo: World | undefined;
  #registros: ReadonlyMap<string, LegacyRecord> | undefined;
  readonly #anterior: WorldContext['loadLegacy'];

  constructor(mundo: World, registros: ReadonlyMap<string, LegacyRecord>) {
    this.#mundo = mundo;
    this.#anterior = worldContext(mundo).loadLegacy;
    this.#registros = registros;
    bindWorldContext(mundo, { loadLegacy: this.#leer });
  }

  readonly #leer = (id: string, atTick: number): LegacyRecord | null => {
    const registro = this.#registros?.get(id);
    return registro && registro.diedAt <= atTick ? structuredClone(registro) : this.#anterior?.(id, atTick) ?? null;
  };

  revocar(): void {
    const mundo = this.#mundo;
    this.#mundo = undefined;
    this.#registros = undefined;
    if (mundo && worldContext(mundo).loadLegacy === this.#leer) bindWorldContext(mundo, { loadLegacy: this.#anterior });
  }
}
