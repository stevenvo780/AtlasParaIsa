/**
 * Caja cerrada de materia (enmienda 1, «ciclos cerrados»): un mundo mínimo hecho solo de piezas reales —arena de A,
 * química de Q, `pasoLote` y `fluir` de P, `copiar`, `desprender` y `quemar` de L— para ver si los ciclos del agua, el
 * hidrógeno, el carbono, el nitrógeno y el fósforo se cierran sin reguladores. Nada se añade ni se quita salvo la luz y
 * el calor, ambos declarados en el libro (fuentes y sumideros): el saldo de la arena debe ser, al entero, fuentes −
 * sumideros en todo momento.
 *
 * Compartimentos (lotes reales, sin celda): aire (N₂, O₂, CO₂), agua, suelo (minerales, poros de aire, catálisis
 * microbiana [KAPPA_SUELO ×3, KAPPA_SUELO_HH], enmienda 2), planta (tejido de una plantilla de Q que crece con `copiar` y luz),
 * tubo digestivo (KAPPA0 a 310 K), reserva del cuerpo (absorbe azúcares y grasas del tubo y los quema con `quemar` y
 * el O₂ que respira) y, con fuego, una hoguera. Cada tick: la planta crece con la luz (fuente) y lo que hay en suelo,
 * agua y aire (Liebig, `copiar`); el herbívoro arranca una fracción de la planta (`desprender`); el tubo digiere
 * (`pasoLote`), el cuerpo quema lo absorbido y el tubo excreta al suelo; el suelo descompone; los gases y el agua se
 * reparten por `fluir`; los termostatos devuelven cada lote a su T (fuentes o sumideros de calor declarados); la
 * barrera F0 recicla el desborde. Un recambio es haber arrancado (comido o quemado) tanta biomasa como la que hay en pie.
 *
 * Lo que la caja enseñó sobre el reparto entre leyes (para W y B): `quemar` quema todo lo que en su lote arde con O₂,
 * así que la reserva no debe tener NH₃ ni proteína (2 NH₃ + O₂ → H₂ + 2 H₂O + N₂ y 2 proteína + 3 O₂ → H₂ + … + N₂, por
 * el tope de 16 átomos): con ellos el cuerpo perdía el N fijado a N₂ y soltaba H₂.
 *
 * Opciones de la validación de los ciclos (enmienda 2): la geometría (aire y capacidades de `fluir` del aire y de los
 * poros), la hojarasca (la parte de lo arrancado que cae al suelo sin pasar por el tubo), las formas de N y de P que
 * aceptan las plantillas (N₂ y el P₂O₅ gaseoso que deja el fuego) y la temperatura (fija o por estaciones).
 */
import { CAPACIDAD_ATOMO, ELEMENTOS, FRACTURA, KAPPA0, KAPPA_SUELO, KAPPA_SUELO_HH, NE, NU, R } from '../../src/shared/naturaleza.js';
import type { SustanciaId } from '../../src/shared/materia.js';
import type { Registro } from '../../src/world/motor/contratos.js';
import { esGasA } from '../../src/world/materia/quimica.js';
import { medir, pasoLote, type CtxPaso, type Kappa } from '../../src/world/materia/paso.js';
import { fluir } from '../../src/world/materia/fluir.js';
import { copiar, crearPlantilla } from '../../src/world/materia/copiar.js';
import { desprender, quemar } from '../../src/world/materia/romper.js';
import { barreraEfectiva, nivelDeLote, nivelDeT, type LoteRef, type Plantilla, type Reaccion, type ServicioQuimico } from '../../src/world/materia/tipos.js';
import { materiaReal, type Base, type Contenido, type MateriaReal } from './materia-real.js';

/** Registro de plantillas de M1 (doble): un id por contenido. */
class RegistroCaja implements Registro {
  readonly ids = new Map<string, number>();
  insertar(c: Uint8Array) {
    const k = Buffer.from(c).toString('hex');
    if (!this.ids.has(k)) this.ids.set(k, this.ids.size);
    return this.ids.get(k)!;
  }
  leer(): Uint8Array | undefined { return undefined; }
  get n() { return this.ids.size; }
}

export interface OpcionesCaja {
  /** Recambios de biomasa a simular tras el arranque (≥ 40 en la prueba). */
  recambios?: number;
  /** Una hoguera cada `cadaFuego` recambios que quema `fraccionFuego` de la planta en pie (0: sin fuego). */
  cadaFuego?: number;
  fraccionFuego?: number;
  semilla?: number;
  /** Control: la química que ve la cinética (P), p. ej. sin la catálisis H–H. */
  cinetica?: (q: ServicioQuimico) => ServicioQuimico;
  /** Geometría: contenido del aire y capacidades de `fluir` del aire y de los poros del suelo (de ellas solo cuenta la
   * razón; la meseta de H₂ crecía como 1 + capAire/capSuelo antes de la enmienda 2). */
  aire?: Contenido;
  capAire?: number;
  capSuelo?: number;
  /** Fracción de lo que se arranca que pasa por el tubo del herbívoro; el resto cae al suelo como hojarasca (0: sin
   * herbívoro). Por defecto 1. */
  fTubo?: number;
  /** Formas de N que aceptan las plantillas (una plantilla por forma de N y de P), por defecto solo NH₃. */
  nitrogenos?: ('NH3' | 'N2')[];
  /** Añade el P₂O₅ molecular (gas) que deja el fuego a las formas de P que aceptan las plantillas. */
  fosfatoGas?: boolean;
  /** T de aire, agua, suelo y planta (por defecto 295 K); con `periodo` > 0 alterna `periodo` ticks a `tAmbiente` y
   * `periodo` a `tFrio`. */
  tAmbiente?: number;
  tFrio?: number;
  periodo?: number;
}

/** Totales de la caja en un instante: cuantos por sustancia (nombre de la base o fórmula) y átomos por elemento y sitio. */
export interface FotoCaja {
  tick: number;
  recambio: number;
  /** Cuantos en pie de la planta. */
  biomasa: number;
  agua: number;
  h2: number;
  /** Átomos de H en H₂O / en H₂ / en el resto, y de N y P por sustancia (top), sobre toda la caja. */
  hAgua: number; hH2: number; hTotal: number;
  n: Record<string, number>;
  p: Record<string, number>;
  /** Saldo de la arena = fuentes − sumideros, al entero (bigint). */
  exacto: boolean;
}

export interface InformeFuego {
  tick: number;
  quemado: number;
  tMax: number;
  /** Átomos de N y P por sustancia en la hoguera antes y después de arder. */
  nAntes: Record<string, number>; nDespues: Record<string, number>;
  pAntes: Record<string, number>; pDespues: Record<string, number>;
  /** Cuantos de H₂ que salen de la hoguera al aire. */
  h2: number;
}

export interface ResultadoCaja {
  fotos: FotoCaja[];
  fuegos: InformeFuego[];
  plantilla: string;
  ticks: number;
  ms: number;
  /** Cuantos de cada sustancia al final (toda la caja). */
  final: Record<string, number>;
  /** Por proceso (química del tubo, del suelo, quemar, fuego…): H₂, N₂ y H₂O netos que produjo en toda la corrida. */
  flujos: Record<string, { H2: number; N2: number; H2O: number; NH3: number }>;
  /** Composición final de cada compartimento y, en el suelo y el tubo, los canales que más H₂ producen (veces/tick). */
  lotes: Record<string, Record<string, number>>;
  canalesH2: { lote: string; reaccion: string; veces: number }[];
}

const T_AMBIENTE = 295, T_CUERPO = 310, T_IGNICION = 1100;
/** Nivel en que Q da el P₂O₅ molecular de la combustión del fósforo orgánico (orgP + O₂ a ~1.250 K, como en un fuego). */
const NIVEL_FUEGO = 10;
const KAPPA_SUELO_4: Kappa = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
const KAPPA_TUBO: Kappa = [KAPPA0, KAPPA0, KAPPA0, KAPPA0];
const SIN: Kappa = [0, 0, 0, 0];
/** Capacidades de `fluir` (de gas o de agua de cada compartimento; solo cuentan sus razones). Los poros del suelo tienen
 * el 10 % del aire, que se renueva en ~1 tick: el aire libre no cataliza nada, así que el H₂ que llega a él solo vuelve a
 * oxidarse cuando pasa por el suelo (bacterias del hidrógeno, familia H–H propia de la enmienda 2, sin barrera). */
const CAP_AIRE = 100, CAP_SUELO = 10, CAP_TUBO = 0.05, CAP_AGUA = 10, CAP_AGUA_SUELO = 1;
/** Por tick: unidades de plantilla que paga la luz, fracción de la planta que se come y fracción del tubo que se excreta. */
const LUZ_UNIDADES = 40, HERBIVORIA = 0.01, EXCRECION = 0.05;
const TICKS_FUEGO = 60, ARRANQUE = 3;

export function cajaCerrada(op: OpcionesCaja = {}): ResultadoCaja {
  const inicio = performance.now();
  const recambios = op.recambios ?? 40, cadaFuego = op.cadaFuego ?? 0, fraccionFuego = op.fraccionFuego ?? 0.3;
  const capAire = op.capAire ?? CAP_AIRE, capSuelo = op.capSuelo ?? CAP_SUELO, fTubo = op.fTubo ?? 1;
  const tAmb = op.tAmbiente ?? T_AMBIENTE, periodo = op.periodo ?? 0, tFrio = op.tFrio ?? tAmb;
  /** T del entorno en el tick t: fija, o `periodo` ticks templados y `periodo` fríos. */
  const tEntorno = (t: number) => (periodo > 0 && Math.floor(t / periodo) % 2 === 1 ? tFrio : tAmb);
  const m = materiaReal({ capacidad: 256 });
  const { arena, quimica: Q, S, libro } = m;
  const c: CtxPaso = m.ctx(op.semilla ?? 1, op.cinetica ? op.cinetica(m.quimica) : m.quimica);
  const nombres = new Map<SustanciaId, string>(Object.entries(S).map(([k, v]) => [v, k]));
  const nombre = (id: SustanciaId) => nombres.get(id) ?? `${formula(m, id)}#${id}`;
  const gas = (id: SustanciaId) => esGasA(Q.sustancia(id), tAmb);

  // Tejido de la planta: celulosa, grasa, proteína y fósforo orgánico, desde CO₂, agua, N y fosfato; sale O₂. Varias
  // plantillas con las mismas partes, una por forma del N (NH₃ y, si se pide, N₂) y del fosfato en el suelo: H₃PO₄;
  // CaHPO₄, como las raíces que disuelven el fosfato cálcico (el Ca vuelve como caliza; la caliza precipita el H₃PO₄ así,
  // química real de Q); y HPO₃ y P₂O₅, que en Q son el mismo fosfato salvo agua (HPO₃ + H₂O ⇌ H₃PO₄ y 2 HPO₃ ⇌ P₂O₅ + H₂O
  // tienen dH = 0 exacto: el mismo vector de enlaces), así que nada los hidrata y sin esto el suelo acumularía el P como
  // P₂O₅; con `fosfatoGas`, también el P₂O₅ molecular que deja el fuego. En el orden de esas listas (NH₃ antes que N₂).
  const registro = new RegistroCaja();
  const nitrogenos = (op.nitrogenos ?? ['NH3']).map((k) => S[k]);
  const datosPlanta = (n: SustanciaId, fosfato: SustanciaId, subproductos: SustanciaId[]) => crearPlantilla(Q, registro, {
    partes: [{ id: S.madera, nu: 20 }, { id: S.CH2, nu: 2 }, { id: S.proteina, nu: 2 }, { id: S.orgP, nu: 1 }],
    entradas: [S.CO2, S.H2O, n, fosfato], subproductos,
    kappa: SIN, captura: 0.1, masaAdulta: 1, m0: 0.05, linaje: 0,
  });
  const ambiente = nivelDeT(T_AMBIENTE);
  const fosforo = (r: Reaccion | null | undefined) => r?.salidas.find((t) => Q.sustancia(t.id).atomos[ELEMENTOS.indexOf('P' as never)])?.id ?? 0;
  const fosfatos: [SustanciaId, SustanciaId[]][] = [[S.H3PO4, [S.O2]], [S.CaHPO4, [S.O2, S.CaCO3]],
    [fosforo(Q.reaccion(S.orgP, 0, ambiente)), [S.O2]], [fosforo(Q.reaccion(S.orgP, S.H2O, ambiente)), [S.O2]]];
  if (op.fosfatoGas) fosfatos.push([fosforo(Q.reaccion(S.orgP, S.O2, NIVEL_FUEGO)), [S.O2]]);
  const plantas: Plantilla[] = [];
  for (const [f, sub] of fosfatos) for (const n of nitrogenos) {
    const p = f ? datosPlanta(n, f, sub) : null;
    if (!p || !p.sintesis.entradas.some((t) => t.id === n) || !p.sintesis.entradas.some((t) => t.id === f)) {
      throw new Error(`La plantilla de N ${n} y P ${f} no balancea.`);
    }
    plantas.push(p);
  }
  const planta = plantas[0]!;

  const aire = m.lote(op.aire ?? { N2: 7_800_000, O2: 2_100_000, CO2: 200_000 }, tAmb);
  const agua = m.lote({ H2O: 3_000_000 }, tAmb);
  const suelo = m.lote({ H2O: 300_000, NH3: 30_000, H3PO4: 10_000, CaCO3: 100_000, SiO2: 1_000_000, N2: 78_000, O2: 21_000, CO2: 2_000 }, tAmb);
  const tejido = Object.fromEntries(planta.partes.map((t) => [nombres.get(t.id)!, 2000 * t.nu])) as Contenido;
  const hoja = m.lote(tejido, tAmb);
  const tubo = m.lote({}, 0), reserva = m.lote({}, 0), fuego = m.lote({}, 0);
  const flujos: ResultadoCaja['flujos'] = {};
  /** Corre `f` y anota lo que cambió en H₂, N₂, H₂O y NH₃ de `l` bajo `proceso`. */
  const anotar = <T>(proceso: string, l: LoteRef, f: () => T): T => {
    const ids = [S.H2, S.N2, S.H2O, S.NH3] as const, antes = ids.map((id) => arena.cuantos(l, id));
    const r = f();
    const d = (flujos[proceso] ??= { H2: 0, N2: 0, H2O: 0, NH3: 0 });
    ids.forEach((id, i) => { d[(['H2', 'N2', 'H2O', 'NH3'] as const)[i]!] += arena.cuantos(l, id) - antes[i]!; });
    return r;
  };

  const atomosLote = (l: LoteRef) => m.atomos(l);
  /** Devuelve `l` a la temperatura T con un asiento de calor declarado (fuente o sumidero). */
  const termostato = (l: LoteRef, T: number) => {
    const objetivo = Math.round(T * CAPACIDAD_ATOMO * atomosLote(l)), d = objetivo - arena.calor(l);
    if (d > 0) arena.fuente(l, Float64Array.from([0, d]), libro);
    else if (d < 0) arena.sumidero(l, Float64Array.from([0, -d]), libro);
  };
  const especies = (l: LoteRef): SustanciaId[] => {
    let ids = new Uint32Array(32), n = arena.especies(l, ids);
    if (n > ids.length) n = arena.especies(l, ids = new Uint32Array(n));
    return [...ids.subarray(0, n)].sort((a, b) => a - b);
  };
  const cohesion = (l: LoteRef) => especies(l).reduce((s, id) => s + arena.cuantos(l, id) * Q.sustancia(id).prop.dMedia, 0);
  /** Lleva la fracción f de `de` a `a` con `desprender` (FRACTURA·D̄ por cuanto). */
  const fraccion = (de: LoteRef, a: LoteRef, f: number) => desprender(arena, Q, de, a, f * FRACTURA * cohesion(de), c.azar);
  const respirar = (l: LoteRef, capL: number, ids: Iterable<SustanciaId> = new Set([...especies(l), ...especies(aire)].filter(gas))) => {
    for (const id of ids) fluir(c, l, aire, id, 1, capL, capAire, 0, 1);
  };
  /** El cuerpo solo intercambia O₂, CO₂ y N₂ con el aire (los pulmones no toman NH₃ para quemarlo). */
  const PULMON = [S.O2, S.CO2, S.N2];
  const porElemento = (e: number): Record<string, number> => {
    const t: Record<string, number> = {};
    for (const x of arena.muestras()) for (let i = 0; i < x.pares.length; i += 2) {
      const id = x.pares[i]!, q = x.pares[i + 1]!;
      if (id === 0) continue;
      const a = Q.sustancia(id).atomos[e]!;
      if (a) t[nombre(id)] = (t[nombre(id)] ?? 0) + a * q;
    }
    return t;
  };
  const enLote = (l: LoteRef, e: number): Record<string, number> => {
    const t: Record<string, number> = {};
    for (const id of especies(l)) { const a = Q.sustancia(id).atomos[e]!; if (a) t[nombre(id)] = a * arena.cuantos(l, id); }
    return t;
  };
  const total = (id: SustanciaId) => { let s = 0; for (const x of arena.muestras()) for (let i = 0; i < x.pares.length; i += 2) if (x.pares[i] === id) s += x.pares[i + 1]!; return s; };
  const exacto = () => { const a = arena.saldo(), b = m.esperado(); return a.every((v, i) => v === b[i]); };
  const H = ELEMENTOS.indexOf('H' as never), N = ELEMENTOS.indexOf('N' as never), P = ELEMENTOS.indexOf('P' as never);
  const biomasa = () => especies(hoja).reduce((s, id) => s + arena.cuantos(hoja, id), 0);
  const foto = (tick: number, recambio: number): FotoCaja => {
    const h = porElemento(H);
    const hTotal = Object.values(h).reduce((s, v) => s + v, 0);
    return { tick, recambio, biomasa: biomasa(), agua: total(S.H2O), h2: total(S.H2), hAgua: h.H2O ?? 0, hH2: h.H2 ?? 0, hTotal,
      n: porElemento(N), p: porElemento(P), exacto: exacto() };
  };

  const fotos: FotoCaja[] = [], fuegos: InformeFuego[] = [];
  const energiaUnidad = planta.sintesis.dH;
  let arrancado = 0, recambio = -ARRANQUE, tick = 0, siguienteFuego = cadaFuego;
  fotos.push(foto(0, recambio));
  while (recambio < recambios) {
    tick++;
    const T = tEntorno(tick);
    // 1. Luz y crecimiento (Liebig sobre suelo, agua y aire); el O₂ y la caliza van a su sitio.
    const luz = LUZ_UNIDADES * energiaUnidad;
    arena.fuente(hoja, Float64Array.from([0, luz]), libro);
    let resta = LUZ_UNIDADES, energia = luz;
    for (const p of plantas) {
      const n = copiar(arena, Q, p, hoja, [suelo, agua, aire], aire, energia, resta);
      resta -= n; energia -= n * p.sintesis.dH;
    }
    termostato(hoja, T); // la luz que no fijó se va (sumidero): no calienta la hoja
    for (const id of especies(aire)) if (!gas(id)) arena.mover({ de: aire, a: suelo, esp: id, cuantos: arena.cuantos(aire, id) });
    // 2. Herbivoría: el tubo arranca una fracción de la planta en pie (con `fTubo` < 1, el resto cae como hojarasca).
    if (fTubo > 0) arrancado += fraccion(hoja, tubo, HERBIVORIA * fTubo);
    if (fTubo < 1) arrancado += fraccion(hoja, suelo, HERBIVORIA * (1 - fTubo));
    // 3. Química de cada compartimento a su temperatura. El tubo digiere con KAPPA0; el cuerpo absorbe la mitad de los
    // azúcares y grasas que hay en él a su reserva y quema allí su trabajo con el O₂ que respira (la proteína y el NH₃
    // no son combustible del cuerpo: salen con las heces).
    termostato(tubo, T_CUERPO);
    anotar('tubo (pasoLote, KAPPA0)', tubo, () => pasoLote(c, tubo, 1, KAPPA_TUBO));
    for (const id of [S.madera, S.CH2]) arena.mover({ de: tubo, a: reserva, esp: id, cuantos: Math.floor(arena.cuantos(tubo, id) / 2) });
    // Metaboliza todo lo absorbido (trabajo sin tope), con el O₂ que le llega en dos respiraciones.
    for (let r = 0; r < 2; r++) {
      respirar(reserva, CAP_TUBO, PULMON);
      termostato(reserva, T_CUERPO);
      anotar('reserva (quemar)', reserva, () => quemar(arena, Q, reserva, S.O2, Infinity));
    }
    respirar(reserva, CAP_TUBO, PULMON);
    for (const id of especies(reserva)) if (!gas(id) && id !== S.madera && id !== S.CH2) {
      arena.mover({ de: reserva, a: suelo, esp: id, cuantos: arena.cuantos(reserva, id) }); // orina y agua al suelo
    }
    respirar(tubo, CAP_TUBO);
    fraccion(tubo, suelo, EXCRECION);
    anotar('suelo (pasoLote, KAPPA_SUELO)', suelo, () => pasoLote(c, suelo, 1, KAPPA_SUELO_4));
    for (const [nom, l] of [['aire', aire], ['agua', agua], ['planta', hoja]] as const) anotar(nom, l, () => pasoLote(c, l, 1, SIN));
    // 4. Intercambio: poros del suelo con el aire, agua con el suelo.
    respirar(suelo, capSuelo);
    fluir(c, agua, suelo, S.H2O, 0.1, CAP_AGUA, CAP_AGUA_SUELO, 0, 1);
    for (const l of [aire, agua, suelo, hoja]) termostato(l, T);
    termostato(tubo, T_CUERPO);
    termostato(reserva, T_CUERPO);
    // 5. Fuego: una fracción de la planta arde con aire en una hoguera aislada y sus restos vuelven.
    if (cadaFuego > 0 && recambio >= siguienteFuego) {
      siguienteFuego += cadaFuego;
      const quemado = fraccion(hoja, fuego, fraccionFuego);
      arrancado += quemado;
      const nAntes = enLote(fuego, N), pAntes = enLote(fuego, P);
      // Aire con el doble del O₂ que pide quemarlo todo (C + H/4 − O/2 por átomo), y su N₂.
      let o2 = 0;
      for (const id of especies(fuego)) {
        const a = Q.sustancia(id).atomos, q = arena.cuantos(fuego, id);
        o2 += q * (a[ELEMENTOS.indexOf('C' as never)]! + a[H]! / 4 - a[ELEMENTOS.indexOf('O' as never)]! / 2);
      }
      const pedido = Math.ceil(2 * Math.max(0, o2));
      arena.mover({ de: aire, a: fuego, esp: S.O2, cuantos: pedido });
      arena.mover({ de: aire, a: fuego, esp: S.N2, cuantos: Math.round(pedido * 78 / 21) });
      termostato(fuego, T_IGNICION); // la chispa: calor declarado
      let tMax = 0;
      anotar('fuego (pasoLote)', fuego, () => {
        for (let k = 0; k < TICKS_FUEGO; k++) { pasoLote(c, fuego, 1, SIN); tMax = Math.max(tMax, arena.vista(fuego).T); }
      });
      const h2 = arena.cuantos(fuego, S.H2);
      fuegos.push({ tick, quemado, tMax, nAntes, nDespues: enLote(fuego, N), pAntes, pDespues: enLote(fuego, P), h2 });
      termostato(fuego, T); // se enfría: calor al sumidero
      for (const id of especies(fuego)) arena.mover({ de: fuego, a: gas(id) ? aire : suelo, esp: id, cuantos: arena.cuantos(fuego, id) });
      arena.moverCalor(fuego, suelo, arena.calor(fuego));
    }
    arena.barrera(); // F0: devuelve el desborde que soltaron las composiciones
    // Recambio: lo arrancado alcanza la biomasa en pie.
    if (arrancado >= biomasa()) {
      arrancado -= biomasa();
      recambio++;
      fotos.push(foto(tick, recambio));
    }
    if (tick > 200_000) throw new Error('La caja no completa los recambios: la planta no crece.');
  }
  const final: Record<string, number> = {};
  for (const x of arena.muestras()) for (let i = 0; i < x.pares.length; i += 2) {
    const id = x.pares[i]!;
    if (id) final[nombre(id)] = (final[nombre(id)] ?? 0) + x.pares[i + 1]!;
  }
  const lotes: ResultadoCaja['lotes'] = {};
  for (const [nom, l] of [['aire', aire], ['agua', agua], ['suelo', suelo], ['planta', hoja], ['tubo', tubo], ['reserva', reserva]] as const) {
    lotes[nom] = Object.fromEntries(especies(l).map((id) => [nombre(id), arena.cuantos(l, id)]));
  }
  const canalesH2: ResultadoCaja['canalesH2'] = [];
  for (const [nom, l, kappa] of [['suelo', suelo, KAPPA_SUELO_4], ['tubo', tubo, KAPPA_TUBO], ['aire', aire, SIN]] as const) {
    const { T, V } = medir(c, l), ids = especies(l), nivel = nivelDeLote(T, kappa);
    for (let i = 0; i < ids.length; i++) for (let j = i - 1; j < ids.length; j++) {
      const a = ids[i]!, b = j < i ? 0 : ids[j]!;
      const r = Q.reaccion(a, b, nivel);
      if (!r) continue;
      const h2 = r.salidas.reduce((s, t) => s + (t.id === S.H2 ? t.nu : 0), 0) - r.entradas.reduce((s, t) => s + (t.id === S.H2 ? t.nu : 0), 0);
      if (h2 === 0) continue;
      const barrera = barreraEfectiva(r, kappa), k = barrera === 0 ? NU : NU * Math.exp(-barrera / (R * T));
      const na = arena.cuantos(l, a), nb = b ? arena.cuantos(l, b) : 0;
      const veces = b === 0 ? k * na : a === b ? k * na * na / V : k * na * nb / V;
      canalesH2.push({ lote: nom, reaccion: describirR(m, r, nombre), veces: veces * h2 });
    }
  }
  canalesH2.sort((x, y) => Math.abs(y.veces) - Math.abs(x.veces));
  void m.cerrar();
  return { fotos, fuegos, plantilla: plantas.map((p) => describir(m, p)).join('; '), ticks: tick,
    ms: performance.now() - inicio, final, flujos, lotes, canalesH2: canalesH2.slice(0, 12) };
}

function describirR(m: MateriaReal, r: Reaccion, nombre: (id: SustanciaId) => string): string {
  const lado = (l: readonly { id: SustanciaId; nu: number }[]) => l.map((t) => `${t.nu > 1 ? `${t.nu} ` : ''}${nombre(t.id)}`).join(' + ');
  void m;
  return `${lado(r.entradas)} → ${lado(r.salidas)} (dH ${r.dH}, ea ${r.ea.toFixed(1)}, cat ${r.catalisis})`;
}

function formula(m: MateriaReal, id: SustanciaId): string {
  const a = m.quimica.sustancia(id).atomos;
  let s = '';
  for (let e = 0; e < NE; e++) if (a[e]) s += ELEMENTOS[e] + (a[e]! > 1 ? String(a[e]) : '');
  return s;
}

function describir(m: MateriaReal, p: Plantilla): string {
  const nombres = new Map<SustanciaId, string>(Object.entries(m.S as Base).map(([k, v]) => [v, k]));
  const lado = (l: readonly { id: SustanciaId; nu: number }[]) => l.map((t) => `${t.nu} ${nombres.get(t.id) ?? formula(m, t.id)}`).join(' + ');
  return `${lado(p.sintesis.entradas)} → ${lado(p.sintesis.salidas)} (dH ${p.sintesis.dH})`;
}
