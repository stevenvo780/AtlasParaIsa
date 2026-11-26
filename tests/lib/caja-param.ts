/**
 * Caja cerrada paramétrica de la validación de los ciclos (Fable, 2026-11-24; portada en la enmienda 3). Solo piezas reales
 * de la rama: la arena de A (`ArenaLotes`), la química de Q (servicio inmediato), `pasoLote` y `fluir` de P, `copiar` y
 * `crearPlantilla`, `desprender` y `quemar` de L. La caja solo decide la geometría (qué lote habla con cuál, con qué
 * capacidades) y mide. El balance se comprueba con un libro propio en bigint, aparte del de A.
 *
 * Lotes: aire, agua, suelo (κ del suelo, con su nivel catalizado), planta (copia sus plantillas con luz), tubo (κ del tubo
 * a T del cuerpo), reserva (quemar) y, opcional, fango. Recambio = la biomasa arrancada iguala a la que hay. Fuego: cada
 * `cadaFuego` recambios arde `fraccionFuego` de la planta con `o2Fuego` veces el O₂ estequiométrico y su N₂, 60 ticks desde
 * 1.100 K sin catálisis; lo gaseoso vuelve al aire y lo demás al suelo.
 *
 * Contrafactuales (no son leyes de la rama; solo los usa la batería del laboratorio para medir alternativas): `rebajaHH`
 * rebaja la barrera de 2 H₂ + O₂, `soloExo` quita la catálisis a las endotérmicas (hoy ya es la ley, enmienda 2),
 * `sinCatFrio` deja sin catálisis el suelo por debajo de 282,85 K, `nivelMin` sube el nivel de toda reacción, y `cinetica`
 * envuelve el servicio químico que ve la cinética (para controles de las pruebas).
 */
import { performance } from 'node:perf_hooks';
import { CAPACIDAD_ATOMO, ELEMENTOS, FRACTURA, KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH, NE } from '../../src/shared/naturaleza.js';
import type { SustanciaId } from '../../src/shared/materia.js';
import { esGasA } from '../../src/world/materia/quimica.js';
import { pasoLote, type CtxPaso, type Kappa } from '../../src/world/materia/paso.js';
import { fluir } from '../../src/world/materia/fluir.js';
import { copiar, crearPlantilla } from '../../src/world/materia/copiar.js';
import { desprender, quemar } from '../../src/world/materia/romper.js';
import {
  Rol, nivelDeT, type ArenaMateria, type Ecuacion, type LoteRef, type Plantilla, type Reaccion, type ServicioQuimico, type Sustancia,
} from '../../src/world/materia/tipos.js';
import type { Registro } from '../../src/world/motor/contratos.js';
import { materiaReal } from './materia-real.js';
import { mesetaSerie } from './caja-cerrada.js';

export type Contenido = Record<string, number>;

export interface CfgCaja {
  nombre: string; recambios: number; semilla: number;
  aire: Contenido; agua: Contenido; suelo: Contenido;
  tAmb: number; tCuerpo: number; kSuelo: number; kTubo: number; kSueloHH: number;
  /** Partes del tejido de la planta (sustancias base) y unidades iniciales. */
  partes: [string, number][]; unidades: number;
  /** Fuentes de N y de P que aceptan las plantillas (base o especiales: HPO3u, P2O5u, P2O5g, HCN); `auto` adopta cada
   * 200 ticks toda sustancia con N o P (sin C) que haya en las fuentes. */
  nitrogenos: string[]; fosfatos: string[]; auto: boolean;
  luz: number; herbivoria: number; fTubo: number; excrecion: number;
  cadaFuego: number; fraccionFuego: number; o2Fuego: number;
  capAire: number; capSuelo: number; capTubo: number; capAgua: number; capAguaSuelo: number; gSuelo: number;
  mezclado: boolean; tFrio: number; periodo: number; rebajaHH: number; soloExo: boolean; sinCatFrio: boolean; nivelMin: number;
  fango: null | { f: number; g: number; cap: number; contenido: Contenido };
  fotoCada: number;
}

export const CFG_DEFECTO: Readonly<CfgCaja> = {
  nombre: 'base', recambios: 40, semilla: 1,
  aire: { N2: 7_800_000, O2: 2_100_000, CO2: 200_000 }, agua: { H2O: 3_000_000 },
  suelo: { H2O: 300_000, NH3: 30_000, H3PO4: 10_000, CaCO3: 100_000, SiO2: 1_000_000, N2: 78_000, O2: 21_000, CO2: 2_000 },
  tAmb: 295, tCuerpo: 310, kSuelo: KAPPA_SUELO, kTubo: KAPPA0, kSueloHH: KAPPA_SUELO_HH,
  partes: [['madera', 20], ['CH2', 2], ['proteina', 2], ['orgP', 1]], unidades: 2000,
  nitrogenos: ['NH3'], fosfatos: ['H3PO4', 'CaHPO4', 'HPO3u', 'P2O5u'], auto: false,
  luz: 40, herbivoria: 0.01, fTubo: 1, excrecion: 0.05,
  cadaFuego: 0, fraccionFuego: 0.3, o2Fuego: 2,
  capAire: 100, capSuelo: 10, capTubo: 0.05, capAgua: 10, capAguaSuelo: 1, gSuelo: 1,
  mezclado: false, fango: null, fotoCada: 1, tFrio: 0, periodo: 0, rebajaHH: 0, soloExo: false, sinCatFrio: false, nivelMin: 0,
};

export interface FotoParam {
  tick: number; recambio: number; biomasa: number;
  /** Cuantos por sustancia (nombre base o fórmula#id) en toda la caja. */
  tot: Record<string, number>;
  exacto: boolean;
  /** H₂ (cuantos) que hicieron y que gastaron las reacciones (todo `aplicar`) desde el arranque: la meseta prevista. */
  h2Hecho: number; h2Gastado: number;
}

export interface FuegoParam { tick: number; recambio: number; quemado: number; tMax: number; antes: Record<string, number>; despues: Record<string, number>; o2Fin: number }

export interface ResultadoCajaParam {
  cfg: CfgCaja;
  estado: string;
  ticks: number;
  recambios: number;
  ms: number;
  plantillas: { txt: string; hechas: number }[];
  /** Nombres que las plantillas aceptan como entrada (y sus subproductos): reservas esperadas, no sumideros. */
  entradasPlantillas: string[];
  /** Sustancias presentes al arrancar (en algún lote o en el tejido). */
  iniciales: string[];
  fotos: FotoParam[];
  fuegos: FuegoParam[];
  /** Por proceso, las 60 ecuaciones más aplicadas con sus veces y el neto de H₂. */
  flujos: Record<string, { txt: string; veces: number; H2: number }[]>;
  /** Átomos por elemento de cada sustancia nombrada. */
  atomos: Record<string, number[]>;
  sustancias: number;
  memo: number;
}

function formula(s: Readonly<Sustancia>): string {
  let out = '';
  for (let e = 0; e < NE; e++) {
    const n = s.atomos[e]!;
    if (n > 0) out += ELEMENTOS[e]! + (n > 1 ? String(n) : '');
  }
  return out;
}

export interface OpcionesCaja extends Partial<CfgCaja> {
  /** Envoltorio de la química que ve la cinética (controles de las pruebas); la arena y las plantillas ven la real. */
  cinetica?: (q: ServicioQuimico) => ServicioQuimico;
}

export async function cajaParam(op: OpcionesCaja = {}): Promise<ResultadoCajaParam> {
  const { cinetica, ...resto } = op;
  const cfg: CfgCaja = { ...CFG_DEFECTO, ...resto };
  const T_IGNICION = 1100, TICKS_FUEGO = 60, ARRANQUE = 3;
  const SIN: Kappa = [0, 0, 0, 0];
  const K_SUELO: Kappa = [cfg.kSuelo, cfg.kSuelo, cfg.kSuelo, cfg.kSueloHH], K_TUBO: Kappa = [cfg.kTubo, cfg.kTubo, cfg.kTubo, cfg.kTubo];

  const inicio = performance.now();
  const m = materiaReal({ capacidad: 256 });
  try {
    const { arena: real, quimica: Q, libro } = m;
    const S = m.S as unknown as Record<string, number>;
    const nombres = new Map<SustanciaId, string>(Object.entries(S).map(([k, v]) => [v, k]));
    const nombre = (id: SustanciaId) => nombres.get(id) ?? `${formula(Q.sustancia(id))}#${id}`;
    const E = (x: string) => ELEMENTOS.indexOf(x as never);

    // ── Libro propio en bigint (átomos por elemento y energía) ──
    const mio = Array<bigint>(NE + 1).fill(0n);
    const asentar = (pares: Float64Array, signo: 1n | -1n) => {
      for (let i = 0; i < pares.length; i += 2) {
        const id = pares[i]!, q = BigInt(pares[i + 1]!);
        if (id === 0) { mio[NE]! += signo * q; continue; }
        const s = Q.sustancia(id);
        for (let e = 0; e < NE; e++) mio[e]! += signo * q * BigInt(s.atomos[e]!);
        mio[NE]! += signo * q * BigInt(s.energia);
      }
    };
    const fuente = (l: LoteRef, pares: number[]) => { const p = Float64Array.from(pares); real.fuente(l, p, libro); asentar(p, 1n); };
    const sumidero = (l: LoteRef, pares: number[]) => { asentar(real.sumidero(l, Float64Array.from(pares), libro), -1n); };
    const totales = (): bigint[] => {
      const t = Array<bigint>(NE + 1).fill(0n);
      for (const x of real.muestras()) for (let i = 0; i < x.pares.length; i += 2) {
        const id = x.pares[i]!, q = BigInt(x.pares[i + 1]!);
        if (id === 0) { t[NE]! += q; continue; }
        const s = Q.sustancia(id);
        for (let e = 0; e < NE; e++) t[e]! += q * BigInt(s.atomos[e]!);
        t[NE]! += q * BigInt(s.energia);
      }
      return t;
    };

    // ── Instrumentación: las leyes ven la arena real; solo se cuenta cada `aplicar` por proceso y ecuación ──
    let proceso = '', h2Hecho = 0, h2Gastado = 0;
    const canales = new Map<string, Map<Ecuacion, number>>();
    const A: ArenaMateria = {
      nuevo: (r, c, f) => real.nuevo(r, c, f), liberar: (l) => real.liberar(l), vivo: (l) => real.vivo(l), propio: (l) => real.propio(l),
      adoptar: (l) => real.adoptar(l), lotes: (c, r, d) => real.lotes(c, r, d), especies: (l, ids, cantidades) => real.especies(l, ids, cantidades),
      cuantos: (l, id) => real.cuantos(l, id), calor: (l) => real.calor(l), vista: (l) => real.vista(l), formar: (l, f) => real.formar(l, f),
      mover: (t) => real.mover(t), moverParte: (de, a, p) => real.moverParte(de, a, p), moverCalor: (de, a, j) => real.moverCalor(de, a, j),
      aplicar: (l, e, veces) => {
        const v = real.aplicar(l, e, veces);
        if (v > 0) {
          let mp = canales.get(proceso); if (!mp) canales.set(proceso, mp = new Map()); mp.set(e, (mp.get(e) ?? 0) + v);
          for (const t of e.salidas) if (t.id === S.H2) h2Hecho += v * t.nu;
          for (const t of e.entradas) if (t.id === S.H2) h2Gastado += v * t.nu;
        }
        return v;
      },
      garantizar: (l, p, lb) => real.garantizar(l, p, lb), abonar: (l, g, lb) => real.abonar(l, g, lb),
      fuente: (l, p, lb) => real.fuente(l, p, lb), sumidero: (l, p, lb) => real.sumidero(l, p, lb),
      saldoPropio: () => real.saldoPropio(),
    };
    const esH2O2 = (a: number, b: number) => (a === S.H2 && b === S.O2) || (a === S.O2 && b === S.H2);
    const contrafactual = cfg.rebajaHH > 0 || cfg.soloExo || cfg.nivelMin > 0;
    const Qbase: ServicioQuimico = contrafactual ? {
      internar: (e: Uint16Array) => Q.internar(e), sustancia: (id: number) => Q.sustancia(id),
      reaccion: (a: number, b: number, n: number) => {
        let r = Q.reaccion(a, b, Math.max(n, cfg.nivelMin));
        if (r && cfg.rebajaHH > 0 && esH2O2(a, b)) r = { ...r, ea: Math.max(r.dH, r.ea - cfg.rebajaHH) };
        if (r && cfg.soloExo && r.dH > 0 && r.catalisis !== -1) r = { ...r, catalisis: -1 as const, paresCatalisis: 0 as const };
        return r;
      },
    } as ServicioQuimico : Q;
    const Qcin = cinetica ? cinetica(Qbase) : Qbase;
    const c: CtxPaso = { arena: A, quimica: Qcin, azar: m.ctx(cfg.semilla).azar };

    const atomosDe = (id: SustanciaId) => Q.sustancia(id).atomos.reduce((s, v) => s + v, 0);
    const especies = (l: LoteRef): SustanciaId[] => {
      let ids = new Uint32Array(64), n = real.especies(l, ids);
      if (n > ids.length) n = real.especies(l, ids = new Uint32Array(n));
      return [...ids.subarray(0, n)].sort((a, b) => a - b);
    };
    const atomosLote = (l: LoteRef) => especies(l).reduce((s, id) => s + real.cuantos(l, id) * atomosDe(id), 0);
    const lote = (cont: Contenido, T: number): LoteRef => {
      const l = real.nuevo(Rol.Objeto, -1, 0);
      const pares: number[] = [];
      let n = 0;
      for (const [k, q] of Object.entries(cont)) {
        if (!q) continue;
        const id = S[k];
        if (!id) throw new Error(`Sustancia base desconocida: ${k}`);
        pares.push(id, q); n += q * atomosDe(id);
      }
      const calor = Math.round(T * CAPACIDAD_ATOMO * n);
      if (calor > 0) pares.push(0, calor);
      if (pares.length) fuente(l, pares);
      return l;
    };
    const termostato = (l: LoteRef, T: number) => {
      const d = Math.round(T * CAPACIDAD_ATOMO * atomosLote(l)) - real.calor(l);
      if (d > 0) fuente(l, [0, d]); else if (d < 0) sumidero(l, [0, -d]);
    };
    const gas = (id: SustanciaId) => esGasA(Q.sustancia(id), cfg.tAmb);
    const cohesion = (l: LoteRef) => especies(l).reduce((s, id) => s + real.cuantos(l, id) * Q.sustancia(id).prop.dMedia, 0);
    const fraccion = (de: LoteRef, a: LoteRef, f: number) => (f > 0 ? desprender(A, Q, de, a, f * FRACTURA * cohesion(de), c.azar) : 0);

    // ── Lotes ──
    let aire: LoteRef, agua: LoteRef, suelo: LoteRef;
    if (cfg.mezclado) {
      const todo: Contenido = {};
      for (const x of [cfg.aire, cfg.agua, cfg.suelo]) for (const [k, v] of Object.entries(x)) todo[k] = (todo[k] ?? 0) + v;
      aire = agua = suelo = lote(todo, cfg.tAmb);
    } else { aire = lote(cfg.aire, cfg.tAmb); agua = lote(cfg.agua, cfg.tAmb); suelo = lote(cfg.suelo, cfg.tAmb); }
    const tejido: Contenido = Object.fromEntries(cfg.partes.map(([k, nu]) => [k, cfg.unidades * nu]));
    const hoja = lote(tejido, cfg.tAmb);
    const tubo = lote({}, 0), reserva = lote({}, 0), fuego = lote({}, 0);
    const fango = cfg.fango ? lote(cfg.fango.contenido, cfg.tAmb) : 0;
    const inicial = totales();
    const iniciales = [...new Set([cfg.aire, cfg.agua, cfg.suelo, tejido, cfg.fango?.contenido ?? {}].flatMap((x) => Object.keys(x).filter((k) => x[k])))];

    // ── Plantillas (crearPlantilla real) ──
    class Reg implements Registro {
      readonly ids = new Map<string, number>();
      insertar(b: Uint8Array) { const k = Buffer.from(b).toString('hex'); if (!this.ids.has(k)) this.ids.set(k, this.ids.size); return this.ids.get(k)!; }
      leer(): Uint8Array | undefined { return undefined; }
      get n() { return this.ids.size; }
    }
    const registro = new Reg();
    const conP = (r: Reaccion | null | undefined) => r?.salidas.find((t) => Q.sustancia(t.id).atomos[E('P')])?.id ?? 0;
    const especiales: Record<string, () => SustanciaId> = {
      HPO3u: () => conP(Q.reaccion(S.orgP!, 0, nivelDeT(295))),
      P2O5u: () => conP(Q.reaccion(S.orgP!, S.H2O!, nivelDeT(295))),
      P2O5g: () => conP(Q.reaccion(S.orgP!, S.O2!, 10)),
      HCN: () => Q.reaccion(S.proteina!, 0, 1)?.salidas.find((t) => Q.sustancia(t.id).atomos[E('N')])?.id ?? 0,
    };
    const idDe = (k: string): SustanciaId => S[k] ?? especiales[k]?.() ?? 0;
    const partes = cfg.partes.map(([k, nu]) => ({ id: S[k]!, nu }));
    const SUBPRODUCTOS = ['O2', 'CaCO3', 'SiO2', 'Fe2O3'];
    const plantas: { p: Plantilla; n: SustanciaId; f: SustanciaId; hechas: number; txt: string }[] = [];
    const describirE = (e: Ecuacion) => {
      const lado = (l: readonly { id: SustanciaId; nu: number }[]) => l.map((t) => `${t.nu > 1 ? `${t.nu} ` : ''}${nombre(t.id)}`).join(' + ');
      return `${lado(e.entradas)} -> ${lado(e.salidas)} [dH ${e.dH}]`;
    };
    const tienePlantilla = (n: SustanciaId, f: SustanciaId) => plantas.some((x) => x.n === n && x.f === f);
    const anadirPlantilla = (n: SustanciaId, f: SustanciaId): boolean => {
      if (!n || !f || tienePlantilla(n, f)) return false;
      const entradas = [...new Set([S.CO2!, S.H2O!, n, f])];
      const sub = SUBPRODUCTOS.map((k) => S[k]!).filter((id) => !entradas.includes(id));
      const p = crearPlantilla(Q, registro, { partes, entradas, subproductos: sub, kappa: SIN, captura: 0.1, masaAdulta: 1, m0: 0.05, linaje: 0 });
      if (!p || !p.sintesis.entradas.some((t) => t.id === n) || !p.sintesis.entradas.some((t) => t.id === f)) return false;
      plantas.push({ p, n, f, hechas: 0, txt: describirE(p.sintesis) });
      return true;
    };
    for (const f of cfg.fosfatos) for (const n of cfg.nitrogenos) anadirPlantilla(idDe(n), idDe(f));
    if (!plantas.length) throw new Error('Ninguna plantilla balancea.');

    // ── Bucle ──
    const respirar = (l: LoteRef, capL: number, g: number, ids?: SustanciaId[]) => {
      if (l === aire) return;
      for (const id of ids ?? [...new Set([...especies(l), ...especies(aire)])].filter(gas)) fluir(c, l, aire, id, g, capL, cfg.capAire, 0, 1);
    };
    const PULMON = [S.O2!, S.CO2!, S.N2!];
    const total = (): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const x of real.muestras()) for (let i = 0; i < x.pares.length; i += 2) { const id = x.pares[i]!; if (id) t[nombre(id)] = (t[nombre(id)] ?? 0) + x.pares[i + 1]!; }
      return t;
    };
    const enLote = (l: LoteRef): Record<string, number> => Object.fromEntries(especies(l).map((id) => [nombre(id), real.cuantos(l, id)]));
    const biomasa = () => especies(hoja).reduce((s, id) => s + real.cuantos(hoja, id), 0);
    const exacto = () => {
      const t = totales(), a = real.saldo(), b = m.esperado();
      return t.every((v, i) => v === mio[i]) && a.every((v, i) => v === b[i]) && a.every((v, i) => v === t[i])
        && t.slice(0, NE).every((v, i) => v === inicial[i]);
    };
    const fotos: FotoParam[] = [];
    const fuegos: FuegoParam[] = [];
    const foto = (tick: number, recambio: number) => fotos.push({ tick, recambio, biomasa: biomasa(), tot: total(), exacto: exacto(), h2Hecho, h2Gastado });

    const energiaUnidad = plantas[0]!.p.sintesis.dH;
    const fuentesPlanta = cfg.mezclado ? [suelo] : fango ? [suelo, agua, aire, fango] : [suelo, agua, aire];
    let arrancado = 0, recambio = -ARRANQUE, tick = 0, siguienteFuego = cfg.cadaFuego, estado = 'completo';
    const maxTicks = (cfg.recambios + ARRANQUE) * Math.ceil(4 / cfg.herbivoria) + 5000;
    foto(0, recambio);
    let ticksSinCrecer = 0;
    while (recambio < cfg.recambios) {
      tick++;
      const tAmb = cfg.periodo > 0 && Math.floor(tick / cfg.periodo) % 2 === 1 ? cfg.tFrio : cfg.tAmb;
      // 1. Luz y crecimiento (copiar real, Liebig sobre las fuentes).
      proceso = 'planta(copiar)';
      const luz = cfg.luz * Math.max(1, energiaUnidad);
      fuente(hoja, [0, luz]);
      let resta = cfg.luz, energia = luz, hechasTick = 0;
      for (const x of plantas) {
        if (resta <= 0) break;
        const n = copiar(A, Q, x.p, hoja, fuentesPlanta, aire, x.p.sintesis.dH > 0 ? energia : Infinity, resta);
        x.hechas += n; hechasTick += n; resta -= n; energia -= n * Math.max(0, x.p.sintesis.dH);
      }
      ticksSinCrecer = hechasTick ? 0 : ticksSinCrecer + 1;
      termostato(hoja, tAmb);
      if (!cfg.mezclado) for (const id of especies(aire)) if (!gas(id)) real.mover({ de: aire, a: suelo, esp: id, cuantos: real.cuantos(aire, id) });
      // 2. Herbivoría (al tubo) y hojarasca (directa al suelo o al fango).
      arrancado += fraccion(hoja, tubo, cfg.herbivoria * cfg.fTubo);
      if (cfg.fTubo < 1) {
        const f = cfg.herbivoria * (1 - cfg.fTubo);
        if (fango) { arrancado += fraccion(hoja, fango, f * cfg.fango!.f); arrancado += fraccion(hoja, suelo, f * (1 - cfg.fango!.f)); }
        else arrancado += fraccion(hoja, suelo, f);
      }
      // 3. Tubo (pasoLote con κ del tubo a T del cuerpo), reserva (quemar real) y heces.
      if (cfg.fTubo > 0) {
        termostato(tubo, cfg.tCuerpo);
        proceso = 'tubo(pasoLote)';
        pasoLote(c, tubo, 1, K_TUBO);
        for (const k of ['madera', 'CH2', 'glicosido']) real.mover({ de: tubo, a: reserva, esp: S[k]!, cuantos: Math.floor(real.cuantos(tubo, S[k]!) / 2) });
        proceso = 'reserva(quemar)';
        for (let r = 0; r < 2; r++) {
          respirar(reserva, cfg.capTubo, 1, PULMON);
          termostato(reserva, cfg.tCuerpo);
          quemar(A, Q, reserva, S.O2!, Infinity);
        }
        respirar(reserva, cfg.capTubo, 1, PULMON);
        for (const id of especies(reserva)) if (!gas(id) && id !== S.madera && id !== S.CH2 && id !== S.glicosido) real.mover({ de: reserva, a: suelo, esp: id, cuantos: real.cuantos(reserva, id) });
        respirar(tubo, cfg.capTubo, 1);
        if (fango) { fraccion(tubo, fango, cfg.excrecion * cfg.fango!.f); fraccion(tubo, suelo, cfg.excrecion * (1 - cfg.fango!.f)); }
        else fraccion(tubo, suelo, cfg.excrecion);
      }
      // 4. Química de cada compartimento (pasoLote real).
      proceso = 'suelo(pasoLote)';
      const kS = cfg.sinCatFrio && real.vista(suelo).T < 282.85 ? SIN : K_SUELO;
      pasoLote(c, suelo, 1, kS);
      if (fango) { proceso = 'fango(pasoLote)'; pasoLote(c, fango, 1, kS); }
      if (!cfg.mezclado) { proceso = 'aire(pasoLote)'; pasoLote(c, aire, 1, SIN); proceso = 'agua(pasoLote)'; pasoLote(c, agua, 1, SIN); }
      proceso = 'planta(pasoLote)'; pasoLote(c, hoja, 1, SIN);
      // 5. Intercambio (fluir real).
      if (!cfg.mezclado) {
        respirar(suelo, cfg.capSuelo, cfg.gSuelo);
        fluir(c, agua, suelo, S.H2O!, 0.1, cfg.capAgua, cfg.capAguaSuelo, 0, 1);
      }
      if (fango) { respirar(fango, cfg.fango!.cap, cfg.fango!.g); fluir(c, agua, fango, S.H2O!, 0.1, cfg.capAgua, cfg.capAguaSuelo, 0, 1); termostato(fango, tAmb); }
      for (const l of new Set([aire, agua, suelo, hoja])) termostato(l, tAmb);
      termostato(tubo, cfg.tCuerpo); termostato(reserva, cfg.tCuerpo);
      // 6. Fuego.
      if (cfg.cadaFuego > 0 && recambio >= siguienteFuego) {
        siguienteFuego += cfg.cadaFuego;
        const quemado = fraccion(hoja, fuego, cfg.fraccionFuego);
        arrancado += quemado;
        const antes = enLote(fuego);
        let o2 = 0;
        for (const id of especies(fuego)) { const a = Q.sustancia(id).atomos; o2 += real.cuantos(fuego, id) * (a[E('C')]! + a[E('H')]! / 4 - a[E('O')]! / 2 + 1.25 * a[E('P')]!); }
        const pedido = Math.ceil(cfg.o2Fuego * Math.max(0, o2));
        real.mover({ de: aire, a: fuego, esp: S.O2!, cuantos: pedido });
        real.mover({ de: aire, a: fuego, esp: S.N2!, cuantos: Math.round(pedido * 78 / 21) });
        termostato(fuego, T_IGNICION);
        let tMax = 0;
        proceso = 'fuego(pasoLote)';
        for (let k = 0; k < TICKS_FUEGO; k++) { pasoLote(c, fuego, 1, SIN); tMax = Math.max(tMax, real.vista(fuego).T); }
        fuegos.push({ tick, recambio, quemado, tMax, antes, despues: enLote(fuego), o2Fin: real.cuantos(fuego, S.O2!) });
        termostato(fuego, tAmb);
        for (const id of especies(fuego)) real.mover({ de: fuego, a: gas(id) ? aire : suelo, esp: id, cuantos: real.cuantos(fuego, id) });
        real.moverCalor(fuego, suelo, real.calor(fuego));
      }
      // 7. Plantillas «auto»: cada 200 ticks, toda sustancia con N o P (sin C) de las fuentes (≥ 20 cuantos) se prueba.
      if (cfg.auto && tick % 200 === 0) {
        const nS = new Set<SustanciaId>(plantas.map((x) => x.n)), pS = new Set<SustanciaId>(plantas.map((x) => x.f));
        const nuevasN: SustanciaId[] = [], nuevasP: SustanciaId[] = [];
        for (const l of new Set(fuentesPlanta)) for (const id of especies(l)) {
          if (real.cuantos(l, id) < 20) continue;
          const a = Q.sustancia(id).atomos;
          if (a[E('N')] && !a[E('P')] && !a[E('C')] && !nS.has(id)) nuevasN.push(id);
          if (a[E('P')] && !a[E('N')] && !a[E('C')] && !pS.has(id)) nuevasP.push(id);
        }
        for (const f of [...pS, ...nuevasP]) for (const n of [...nS, ...nuevasN]) anadirPlantilla(n, f);
      }
      real.barrera();
      if (arrancado >= biomasa()) { arrancado -= biomasa(); recambio++; if (recambio % cfg.fotoCada === 0 || recambio === cfg.recambios) foto(tick, recambio); }
      if (biomasa() < 200) { estado = 'colapso: biomasa < 200 cuantos'; break; }
      if (ticksSinCrecer > 3000) { estado = 'colapso: la planta no crece en 3000 ticks'; break; }
      if (tick > maxTicks) { estado = 'incompleto: tope de ticks'; break; }
    }
    if (fotos[fotos.length - 1]!.tick !== tick) foto(tick, recambio);

    const flujos: ResultadoCajaParam['flujos'] = {};
    const dH2 = (e: Ecuacion) => e.salidas.reduce((s, t) => s + (t.id === S.H2 ? t.nu : 0), 0) - e.entradas.reduce((s, t) => s + (t.id === S.H2 ? t.nu : 0), 0);
    for (const [p, mp] of canales) flujos[p] = [...mp].map(([e, v]) => ({ txt: describirE(e), veces: v, H2: v * dH2(e) })).sort((a, b) => b.veces - a.veces).slice(0, 60);
    const atomos: Record<string, number[]> = {};
    for (let id = 1; id <= Q.totalSustancias(); id++) atomos[nombre(id)] = [...Q.sustancia(id).atomos];
    const entradasPlantillas = [...new Set(plantas.flatMap((x) => [...x.p.sintesis.entradas, ...x.p.sintesis.salidas].map((t) => nombre(t.id))))];
    return {
      cfg, estado, ticks: tick, recambios: recambio, ms: performance.now() - inicio,
      plantillas: plantas.map((x) => ({ txt: x.txt, hechas: x.hechas })), entradasPlantillas, iniciales,
      fotos, fuegos, flujos, atomos, sustancias: Q.totalSustancias(), memo: Q.totalMemo(),
    };
  } finally {
    await m.cerrar();
  }
}

// ── Medida y umbrales (los mismos para el laboratorio y las pruebas) ─────────────────────────────────────

export const UMBRALES_CAJA = {
  /** Agua no perdida, mínima en cualquier foto: 1 − (H que pasó a H₂ o a una sustancia que no estaba al arrancar ni acepta
   * ninguna plantilla) / (H del agua inicial). Es lo que medía «agua ≥ 97 %» en las cajas húmedas de la validación; en
   * una caja seca el H₂O baja porque la planta crece con un depósito pequeño (el H pasa al tejido), y eso no es perderla
   * (`aguaMinBruta` sigue siendo solo el H₂O). */
  aguaMin: 0.97,
  /** H en H₂ como fracción del H total: techo en cualquier foto. */
  h2Techo: 0.005,
  /** «Sigue subiendo»: media del último cuarto > `crece` × la del tercero (y por encima del suelo absoluto `suelo`). */
  crece: 1.15,
  /** C en HCN: techo de la fracción del C total al final. */
  hcnTecho: 0.01,
  /** Biomasa mínima del último décimo de los recambios, fracción del máximo. */
  biomasaMin: 0.5,
  /** Sumidero nuevo: sustancia que no estaba al arrancar ni es entrada de una plantilla, con ≥ `sumideroFraccion` de C, N o
   * P (fracción del total del elemento) al final y creciendo en el último cuarto. */
  sumideroFraccion: 0.02,
} as const;

export interface MedidaCaja {
  nombre: string; estado: string; recambios: number; ticks: number; ms: number;
  /** `aguaMin`: agua no perdida (UMBRALES_CAJA.aguaMin); `aguaMinBruta`: H₂O mínimo / inicial. */
  exacto: boolean; aguaMin: number; aguaMinBruta: number; h2Max: number; h2Final: number; h2Sube: boolean;
  /** Meseta de H₂ prevista (fracción del H): `mesetaSerie` de caja-cerrada.ts sobre la segunda mitad; ∞ si sube sin frenar.
   * Si sube y está por debajo de `h2Discreto`, al menos `h2Discreto`. */
  h2Previsto: number;
  /** Suelo discreto del sumidero de H₂ (fracción del H): 2·capAire/capPoro cuantos de H₂ en el aire (el poro de más
   * capacidad, suelo o fango; 0 si el suelo es el aire). Por debajo de él el suelo no oxida el H₂ del aire: 2 H₂ + O₂ pide
   * dos cuantos a la vez en el poro, y `fluir` (equilibrio discreto de un cuanto) solo mete el segundo cuando el aire
   * pasa de 2·capAire/capPoro + 1 (medido: 1.999 cuantos con 10.000/10, sin bajar desde 1.500). Una fuente de H₂ que va
   * al aire (el tubo, el fuego) lo llena hasta ahí, al ritmo de la fuente. */
  h2Discreto: number;
  /** CO₂ al final, fracción del inicial, y si baja en el último cuarto (`exigeCO2`). */
  co2Final: number; co2Baja: boolean;
  hcnFinal: number; hcnMax: number; hcnSube: boolean;
  /** N fuera del N₂ (fijado) al final, fracción del inicial. */
  nFijado: number;
  /** P en el tejido o en formas que acepta alguna plantilla, fracción del P total al final. */
  pAccesible: number;
  biomasa: [number, number]; biomasaMin: number;
  sumideros: string[];
  /** Fallos frente a `UMBRALES_CAJA` (vacío = cierra). */
  fallos: string[];
}

/** Mide una caja frente a `UMBRALES_CAJA`. `exigeH2Estable`: el H₂ no sube en el último cuarto (con mucho aire por poro
 * tarda más de 40 recambios en llegar a su meseta), salvo que suba por debajo de `h2Discreto`: entonces la meseta
 * prevista es ese suelo, y es él el que debe quedar bajo el techo. `h2Pulso`: el techo de H₂ se mira al final y no en el máximo; es para
 * el fuego pobre en O₂, que hace H₂ de verdad (gas de síntesis, C + H₂O y CH₂ con poco O₂) en un pulso que el suelo
 * oxida después: lo que se mide ahí es que no se acumule. En todas, además, la meseta prevista (`mesetaSerie`) bajo el
 * techo (revisión de la enmienda 3, hallazgo 6: una caja que tarda en llegar a su meseta pasaba secándose).
 * `exigeCO2` (validación de la enmienda 3, hallazgo 8; para el fango): el CO₂ no baja en el último cuarto ni acaba por
 * debajo de la mitad del inicial (con g = 0,001 la caja pasaba la biomasa ≥ 50 % limitada por CO₂). */
export function medirCaja(r: ResultadoCajaParam, { exigeH2Estable = true, h2Pulso = false, exigeCO2 = false } = {}): MedidaCaja {
  const U = UMBRALES_CAJA, f = r.fotos.filter((x) => x.recambio >= 0), fin = r.fotos[r.fotos.length - 1]!, f0 = r.fotos[0]!;
  const iH = ELEMENTOS.indexOf('H' as never), iC = ELEMENTOS.indexOf('C' as never), iN = ELEMENTOS.indexOf('N' as never), iP = ELEMENTOS.indexOf('P' as never);
  const elem = (x: FotoParam, e: number, filtro: (k: string) => boolean = () => true) =>
    Object.entries(x.tot).reduce((s, [k, v]) => s + (filtro(k) ? v * (r.atomos[k]?.[e] ?? 0) : 0), 0);
  const esHCN = (k: string) => k.startsWith('HCN#');
  const parte = (x: FotoParam, e: number, filtro: (k: string) => boolean) => elem(x, e, filtro) / Math.max(1, elem(x, e));
  const n = f.length, q3 = f.slice(Math.floor(n / 2), Math.floor(3 * n / 4)), q4 = f.slice(Math.floor(3 * n / 4));
  const media = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  const sube = (g: (x: FotoParam) => number, suelo: number) => n >= 8 && media(q4.map(g)) > U.crece * media(q3.map(g)) + suelo;
  const h2 = (x: FotoParam) => parte(x, iH, (k) => k === 'H2'), hcn = (x: FotoParam) => parte(x, iC, esHCN);
  const co2 = (x: FotoParam) => x.tot.CO2 ?? 0;
  /** `mesetaSerie` (caja-cerrada.ts) de las fotos, en fracción del H. */
  const previsto = () => {
    const hTotal = Math.max(1, elem(fin, iH));
    return 2 * mesetaSerie(f.map((x) => ({ tick: x.tick, h2: x.tot.H2 ?? 0, hecho: x.h2Hecho, gastado: x.h2Gastado })), 1e-5 * hTotal / 2) / hTotal;
  };
  const fijado = (x: FotoParam) => elem(x, iN, (k) => k !== 'N2');
  const aceptadas = new Set([...r.entradasPlantillas, ...r.cfg.partes.map(([k]) => k)]);
  const biomasas = r.fotos.map((x) => x.biomasa), corte = Math.max(0, r.cfg.recambios - Math.ceil(r.cfg.recambios / 10));
  const tarde = r.fotos.filter((x) => x.recambio > corte).map((x) => x.biomasa);
  const esperadas = new Set([...r.iniciales, ...aceptadas, 'H2']);
  const agua0 = Math.max(1, f0.tot.H2O ?? 0), conocidas = new Set([...r.iniciales, ...aceptadas]);
  const hFuera = (x: FotoParam) => elem(x, iH, (k) => !conocidas.has(k)), hFuera0 = hFuera(f0);
  const aguaEq = (x: FotoParam) => 1 - (hFuera(x) - hFuera0) / (2 * agua0);
  const sumideros: string[] = [];
  for (const k of Object.keys(fin.tot)) {
    if (esperadas.has(k)) continue;
    for (const [e, s] of [[iC, 'C'], [iN, 'N'], [iP, 'P']] as const) {
      if (!(r.atomos[k]?.[e])) continue;
      const g = (x: FotoParam) => parte(x, e, (j) => j === k);
      if (g(fin) >= U.sumideroFraccion && sube(g, 0.002)) sumideros.push(`${k} (${(100 * g(fin)).toFixed(1)} % del ${s}, sube)`);
    }
  }
  const poro = r.cfg.mezclado ? 0 : Math.max(r.cfg.capSuelo, r.cfg.fango?.cap ?? 0);
  const h2Discreto = poro > 0 ? 2 * (2 * r.cfg.capAire / poro) / Math.max(1, elem(fin, iH)) : 0;
  const m: MedidaCaja = {
    nombre: r.cfg.nombre, estado: r.estado, recambios: r.recambios, ticks: r.ticks, ms: r.ms,
    exacto: r.fotos.every((x) => x.exacto),
    aguaMin: Math.min(...r.fotos.map(aguaEq)), aguaMinBruta: Math.min(...r.fotos.map((x) => x.tot.H2O ?? 0)) / agua0,
    h2Max: Math.max(...r.fotos.map(h2)), h2Final: h2(fin), h2Sube: sube(h2, 1e-5), h2Previsto: previsto(), h2Discreto,
    co2Final: (fin.tot.CO2 ?? 0) / Math.max(1, f0.tot.CO2 ?? 0), co2Baja: n >= 8 && media(q4.map(co2)) < media(q3.map(co2)) / U.crece,
    hcnFinal: hcn(fin), hcnMax: Math.max(...r.fotos.map(hcn)), hcnSube: sube(hcn, 1e-4),
    nFijado: fijado(fin) / Math.max(1, fijado(f0)),
    pAccesible: parte(fin, iP, (k) => aceptadas.has(k)),
    biomasa: [f0.biomasa, fin.biomasa], biomasaMin: (tarde.length ? Math.min(...tarde) : 0) / Math.max(1, ...biomasas),
    sumideros, fallos: [],
  };
  if (!m.exacto) m.fallos.push('descuadre');
  if (m.estado !== 'completo') m.fallos.push(m.estado);
  if (m.aguaMin < U.aguaMin) m.fallos.push(`agua mín ${(100 * m.aguaMin).toFixed(1)} %`);
  const h2Mirado = h2Pulso ? m.h2Final : m.h2Max;
  if (h2Mirado >= U.h2Techo) m.fallos.push(`H₂ ${(100 * h2Mirado).toFixed(2)} % del H${h2Pulso ? ' al final' : ''}`);
  // Si sube por debajo del suelo discreto, va hacia él (o hacia su meseta, si es menor): lo que se exige es que ese suelo
  // quede bajo el techo. Si sube por encima, crece sin explicación.
  const haciaSuelo = m.h2Sube && m.h2Max < m.h2Discreto;
  // Por debajo del suelo el poro no oxida el H₂ del aire, así que `mesetaSerie` no ve sumidero (∞): la meseta es el suelo
  // (más lo que cueste quemar la fuente por encima de él, que la serie aún no muestra).
  if (haciaSuelo) m.h2Previsto = Number.isFinite(m.h2Previsto) ? Math.max(m.h2Previsto, m.h2Discreto) : m.h2Discreto;
  if (exigeH2Estable && m.h2Sube && !haciaSuelo) m.fallos.push('H₂ sube');
  if (!(m.h2Previsto < U.h2Techo)) m.fallos.push(`H₂ previsto ${(100 * m.h2Previsto).toFixed(2)} % del H${haciaSuelo ? ' (sube hacia el suelo discreto)' : ''}`);
  if (exigeCO2 && (m.co2Baja || m.co2Final < 0.5)) m.fallos.push(`CO₂ ${(100 * m.co2Final).toFixed(1)} % del inicial${m.co2Baja ? ', baja' : ''}`);
  if (m.hcnFinal >= U.hcnTecho) m.fallos.push(`HCN ${(100 * m.hcnFinal).toFixed(1)} % del C`);
  if (m.hcnSube && m.hcnFinal >= U.hcnTecho / 10) m.fallos.push('HCN sube');
  if (m.biomasaMin < U.biomasaMin || m.estado.startsWith('colapso')) {
    // Causa, para que los controles se comprueben por su modo de fallo: N fijado perdido a N₂ o P fuera de las plantillas.
    const causas = [m.nFijado < 0.5 ? `N fijado ×${m.nFijado.toFixed(3)} (a N₂)` : '', m.pAccesible < 0.5 ? `P accesible ${(100 * m.pAccesible).toFixed(1)} %` : ''].filter(Boolean);
    m.fallos.push(`biomasa mín ${(100 * m.biomasaMin).toFixed(0)} % del máx${causas.length ? ` (${causas.join(', ')})` : ''}`);
  }
  for (const s of sumideros) m.fallos.push(`sumidero ${s}`);
  return m;
}
