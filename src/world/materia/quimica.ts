/**
 * Química por valencias y mínimo global de energía libre (V23, carril Q; ARQ-materia §2–§3.1).
 *
 * Sin catálogo de materiales ni lista de reacciones: toda sustancia es un vector canónico de enlaces
 * saturados de ≤ 8 átomos (`ATOMOS_POR_UNIDAD`), y toda reacción sale de minimizar
 *   G(P, T) = Σ_s [ E(s) − T·S_GAS·1_{esGas(s, T)} ]
 * sobre todas las particiones válidas de los átomos de p·a + q·b (≤ `ATOMOS_POR_REACCION` = 16 átomos), con los
 * coeficientes enteros p, q que elige `productos` (enmienda 1). Las constantes elegidas a mano están en naturaleza.ts.
 */
import {
  ANCHO_RIGIDEZ, DCHI_IONICO, E_CAT_IONICO, E_HID_IONICO, E_RES_IONICO, EBULLICION_MASA, EBULLICION_POLAR,
  EMPAQUETADO_BASE, EMPAQUETADO_POR_R, EPSILON_G, FUSION_MOLECULA, FUSION_RED, GAMMA, NE, R_RIGIDEZ, S_GAS, TABLA,
  TENACIDAD_ANCHO, TENACIDAD_METAL, TENACIDAD_RED, VOLUMEN_ATOMO,
} from '../../shared/naturaleza.js';
import {
  ATOMOS_POR_REACCION, ATOMOS_POR_UNIDAD, ClaseSustancia, TIPOS,
  type Propiedades, type SustanciaId,
} from '../../shared/materia.js';
import { NIVELES_T, T_NIVEL_MAX, tDeNivel, type FamiliaCatalitica, type Sustancia } from './tipos.js';

// ── Tablas derivadas de TABLA y TIPOS (sin números mágicos duplicados) ──────────────────────────────────

const NT = TIPOS.length;
const VAL = Int8Array.from(TABLA, t => t.valencia);
const CHI = Float64Array.from(TABLA, t => t.chi);
const MASA = Float64Array.from(TABLA, t => t.masa);
const PI = Float64Array.from(TABLA, t => t.pi);
const T_E = Int8Array.from(TIPOS, t => t.e);
const T_F = Int8Array.from(TIPOS, t => t.f);
const T_K = Int8Array.from(TIPOS, t => t.k);
const T_D = Int32Array.from(TIPOS, t => t.d);
const D_PER_K = Float64Array.from(TIPOS, t => t.d / t.k);
const D_MAX = Math.max(...TIPOS.map(t => t.d));
const ES_IONICO = Uint8Array.from(TIPOS, t => (Math.abs(TABLA[t.e]!.chi - TABLA[t.f]!.chi) >= DCHI_IONICO ? 1 : 0));
const T_CORE = Uint8Array.from(TIPOS, t => (TABLA[t.e]!.valencia > 1 && TABLA[t.f]!.valencia > 1 ? 1 : 0));
const T_POLAR = Float64Array.from(TIPOS, t =>
  (TABLA[t.e]!.valencia === 1 && TABLA[t.f]!.valencia > 1)
    ? EBULLICION_POLAR * (TABLA[t.f]!.chi - TABLA[t.e]!.chi) ** 2
    : 0);
const T_DCHI = Float64Array.from(TIPOS, t => Math.abs(TABLA[t.e]!.chi - TABLA[t.f]!.chi));

const T_NIVEL = Float64Array.from({ length: NIVELES_T }, (_, l) => tDeNivel(l));
const TS_NIVEL = Float64Array.from({ length: NIVELES_T }, (_, l) => tDeNivel(l) * S_GAS);

/** Índice de tipo de enlace por (e, f, k), −1 si no existe. */
const INDICE_ENLACE = new Int16Array(NE * NE * 4).fill(-1);
for (let i = 0; i < NT; i++) {
  const e = T_E[i]!, f = T_F[i]!, k = T_K[i]!;
  INDICE_ENLACE[(e * NE + f) * 4 + k] = i;
  INDICE_ENLACE[(f * NE + e) * 4 + k] = i;
}

/** Busca el índice en `TIPOS` del enlace entre los elementos `e` y `f` de orden `k` (−1 si no existe). */
export function indiceTipoEnlace(e: number, f: number, k: 1 | 2 | 3 = 1): number {
  if (e < 0 || e >= NE || f < 0 || f >= NE || k < 1 || k > 3) return -1;
  return INDICE_ENLACE[(e * NE + f) * 4 + k]!;
}

/** Tipos de enlace incidentes a cada elemento, ordenados por D/k descendente (priorizando iónicos). */
const ENLACES_DE: readonly number[][] = (() => {
  const listas: number[][] = Array.from({ length: NE }, () => []);
  for (let i = 0; i < NT; i++) {
    listas[T_E[i]!]!.push(i);
    if (T_F[i]! !== T_E[i]!) listas[T_F[i]!]!.push(i);
  }
  for (let e = 0; e < NE; e++) {
    listas[e]!.sort((a, b) =>
      (D_PER_K[b]! + (ES_IONICO[b] ? E_RES_IONICO : 0)) - (D_PER_K[a]! + (ES_IONICO[a] ? E_RES_IONICO : 0)));
  }
  return listas;
})();

// Referencia de oxidación completa por átomo para qOxidacion (Hess exacta):
// H → ½ H₂O, C → CO₂, N → ½ N₂, P → ½ P₂O₅ (5×O–P), Si → SiO₂, Ca → CaO, Fe → ½ Fe₂O₃.
const D_OO2 = T_D[indiceTipoEnlace(3, 3, 2)]!;
const O_REQ_POR_ATOMO = Float64Array.from([0.5, 2, 0, 0, 2.5, 2, 1, 1.5]);
const E_OX_POR_ATOMO = Float64Array.from([
  -T_D[indiceTipoEnlace(0, 3, 1)]!,           // H: −D(H–O)
  -2 * T_D[indiceTipoEnlace(1, 3, 2)]!,       // C: −2·D(C=O)
  -0.5 * T_D[indiceTipoEnlace(2, 2, 3)]!,     // N: −½·D(N≡N)
  0,                                          // O: contabilizado en ν_O2
  -5 * T_D[indiceTipoEnlace(3, 4, 1)]!,       // P: −5·D(O–P) (red ortofosfato/P₂O₅)
  -4 * T_D[indiceTipoEnlace(3, 5, 1)]!,       // Si: −4·D(O–Si)
  -2 * T_D[indiceTipoEnlace(3, 6, 1)]!,       // Ca: −2·D(O–Ca)
  -3 * T_D[indiceTipoEnlace(3, 7, 1)]!,       // Fe: −3·D(O–Fe)
]);

// Colores base por elemento (RGB en [0, 255]) para mezclar el color emergente de cada sustancia.
const RGB_ELEM: readonly [number, number, number][] = [
  [210, 232, 248], // H: claro/agua
  [48, 44, 40],    // C: carbón/orgánico oscuro
  [110, 155, 205], // N: azulado
  [215, 224, 232], // O: claro
  [212, 186, 118], // P: ocre/hueso
  [172, 162, 146], // Si: piedra/arena
  [235, 232, 222], // Ca: caliza/hueso blanco
  [162, 128, 116], // Fe: metal/óxido
];

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

// ── Claves canónicas y validación de saturación ─────────────────────────────────────────────────────────

/** Normaliza pares [tipo, cuenta] a forma canónica: tipos únicos en orden estrictamente creciente y cuentas > 0. */
export function normalizarEnlaces(enlaces: Uint16Array): Uint16Array {
  if ((enlaces.length & 1) !== 0) throw new RangeError('Vector de enlaces con longitud impar.');
  const cuentas = new Int32Array(NT);
  let distintos = 0;
  for (let i = 0; i < enlaces.length; i += 2) {
    const tipo = enlaces[i]!;
    const cuenta = enlaces[i + 1]!;
    if (tipo >= NT) throw new RangeError(`Tipo de enlace fuera de rango: ${tipo}`);
    if (cuenta === 0) continue;
    if (cuentas[tipo] === 0) distintos++;
    cuentas[tipo]! += cuenta;
  }
  const out = new Uint16Array(distintos * 2);
  let w = 0;
  for (let ti = 0; ti < NT; ti++) {
    const c = cuentas[ti]!;
    if (c > 0) {
      if (c > 0xffff) throw new RangeError(`Cuenta de enlace desborda u16: ${c}`);
      out[w++] = ti;
      out[w++] = c;
    }
  }
  return out;
}

/** Comprueba si `enlaces` ya está en forma canónica (longitud par no vacía, tipos crecientes válidos, cuentas > 0). */
export function esEnlaceCanonico(enlaces: Uint16Array): boolean {
  if (enlaces.length === 0 || (enlaces.length & 1) !== 0) return false;
  let prev = -1;
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    if (ti <= prev || ti >= NT || c === 0) return false;
    prev = ti;
  }
  return true;
}

/** Clave de texto determinista y biyectiva para un vector canónico de enlaces. */
export function claveEnlaces(enlaces: Uint16Array): string {
  let s = '';
  for (let i = 0; i < enlaces.length; i += 2) {
    if (i > 0) s += ',';
    s += `${enlaces[i]}:${enlaces[i + 1]}`;
  }
  return s;
}

/** Orden lexicográfico total sobre vectores canónicos de enlaces (desempate determinista). */
export function compararEnlaces(a: Uint16Array, b: Uint16Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * Calcula los átomos por elemento desde `enlaces`. Devuelve `null` si no satura exactamente todas las valencias
 * (`usos[e] % valencia[e] === 0`), si está vacío o si supera `ATOMOS_POR_UNIDAD` (8 átomos).
 */
export function atomosDeEnlaces(enlaces: Uint16Array): Uint8Array | null {
  if (enlaces.length === 0 || (enlaces.length & 1) !== 0) return null;
  const usos = new Int32Array(NE);
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    if (ti >= NT || c === 0) return null;
    const k = T_K[ti]!;
    usos[T_E[ti]!]! += k * c;
    usos[T_F[ti]!]! += k * c;
  }
  const atomos = new Uint8Array(NE);
  let total = 0;
  for (let e = 0; e < NE; e++) {
    const u = usos[e]!;
    if (u % VAL[e]! !== 0) return null;
    const n = u / VAL[e]!;
    if (n > ATOMOS_POR_UNIDAD) return null;
    atomos[e] = n;
    total += n;
  }
  return total >= 1 && total <= ATOMOS_POR_UNIDAD ? atomos : null;
}

/** Comprueba que el grafo de elementos presentes conectados por enlaces sea conexo (evita mezclas mecánicas). */
export function grafoElementosConexo(enlaces: Uint16Array, atomos: Uint8Array): boolean {
  let presentes = 0;
  let primero = -1;
  for (let e = 0; e < NE; e++) {
    if (atomos[e]! > 0) {
      presentes |= 1 << e;
      if (primero < 0) primero = e;
    }
  }
  if (presentes === 0) return false;
  const adj = new Uint8Array(NE);
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!;
    adj[T_E[ti]!]! |= 1 << T_F[ti]!;
    adj[T_F[ti]!]! |= 1 << T_E[ti]!;
  }
  let visitados = 1 << primero;
  let cola = 1 << primero;
  while (cola !== 0) {
    const bit = cola & -cola;
    const u = Math.clz32(bit) ^ 31;
    cola ^= bit;
    const nuevos = adj[u]! & ~visitados;
    visitados |= nuevos;
    cola |= nuevos;
  }
  return visitados === presentes;
}

// ── Realizabilidad exacta como molécula conexa simple (N ≤ 8) ───────────────────────────────────────────

/**
 * Decide si un vector saturado de enlaces puede existir como molécula aislada (`ClaseSustancia.Molecula`).
 *
 * Es un teorema de grafos más dos reglas físicas (la auditoría lo comprobó en los 4.038.407 vectores de ≤ 8 átomos):
 * - Teorema: existe un grafo simple conexo con esas valencias exactas. Un enlace que agota a sus dos átomos (H–H, O=O,
 *   N≡N) es una componente aislada, así que solo vale como dímero; todo H es una hoja, y basta buscar el grafo del
 *   núcleo (átomos de valencia > 1, ≤ 8 vértices) con valencia residual ≥ 0.
 * - Regla de ARQ-materia §2: Ca, Fe y los enlaces iónicos (Δχ ≥ DCHI_IONICO) forman red. Con la TABLA de hoy el
 *   único enlace iónico es el de Ca, así que el corte por Δχ no decide nada; queda por si se recalibra χ.
 * - Regla de Q: coordinación media del núcleo r < R_RIGIDEZ. Sin ella las jaulas K₅ (C₅), K₂,₄ (Si₂O₄) o K₂,₅ (P₂O₅)
 *   serían gas con la misma energía de enlace que su red (falla la fila de roca estable de la tabla de cordura). Es
 *   un sustituto de la energía de tensión de las jaulas, que el modelo no tiene.
 * - Regla del átomo lineal (enmienda 3): un átomo con solo dos vecinos σ y valencia ≥ 4 tiene dos o más enlaces π y
 *   ningún par libre (el C de un aleno, de un alquino o del CO₂): es lineal (VSEPR, 180°) y no puede estar en un anillo.
 *   Un anillo de n átomos le impone 180°·(n − 2)/n; el menor aislable con un átomo así es el ciclooctino (8 C + 12 H) y
 *   el ciclo[n]carbono solo existe desde n ≈ 10, todos con más de ATOMOS_POR_UNIDAD átomos. El P con dos vecinos y sin H
 *   tiene tres π y tampoco par libre: también es lineal. En los demás elementos de la TABLA dos vecinos implican un par
 *   libre (N, O: angulares, en anillo sin problema) o no hay π (Si; Ca y Fe nunca forman moléculas). Sin la regla,
 *   C₃{C=C:3} (tres C sp en un triángulo, sin tensión en el modelo) sublimaba del carbón en el horno (fila 8 de la tabla
 *   de cordura); con ella ningún C_n de ≤ 8 átomos es molécula y el carbón no se volatiliza.
 *
 * Contraejemplos que descarta respecto a la condición relajada E ≥ N − 1 + cotas por par:
 * - {C=C:3, O=O:1} (N=5, E=4): grafo de elementos disconexo.
 * - {N≡N:1, N–N:3, N–H:3} (N=8, E=7): N≡N agota ambas valencias de N y queda aislado.
 * - {C≡C:1, C=C:1, C–H:2} (N=5, E=4): unir un triple y un doble en 3 C exige valencia ≥ 5 > 4.
 * - {C=O:2, C≡C:1, C–C:1} (N=5, E=4): C≡C deja valencia 1 en sus dos C, forzando ambos C=O al tercer C (aislado).
 */
export function realizable(enlaces: Uint16Array, atomosPre?: Uint8Array): boolean {
  const atomos = atomosPre ?? atomosDeEnlaces(enlaces);
  if (!atomos) return false;
  if (atomos[6]! > 0 || atomos[7]! > 0) return false;

  let N = 0;
  let nCore = 0;
  for (let e = 0; e < NE; e++) {
    const ne = atomos[e]!;
    N += ne;
    if (VAL[e]! > 1) nCore += ne;
  }
  if (N < 2 || N > ATOMOS_POR_UNIDAD) return false;

  let E = 0;
  let eCore = 0;
  const parE = new Uint8Array(NE * NE);
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    if (ES_IONICO[ti]) return false;
    const e = T_E[ti]!, f = T_F[ti]!, k = T_K[ti]!;
    E += c;
    parE[e * NE + f]! += c;
    if (T_CORE[ti]) eCore += c;
    if (k === VAL[e]! && k === VAL[f]!) return N === 2 && c === 1; // H–H, O=O o N≡N: solo el dímero
  }
  if (E < N - 1) return false;

  for (let e = 0; e < NE; e++) {
    const ne = atomos[e]!;
    if (ne === 0) continue;
    if (parE[e * NE + e]! > (ne * (ne - 1)) / 2) return false;
    for (let f = e + 1; f < NE; f++) {
      if (parE[e * NE + f]! > ne * atomos[f]!) return false;
    }
  }

  if (nCore === 0) return false;
  if ((2 * eCore) / nCore >= R_RIGIDEZ) return false;
  if (nCore === 1) return eCore === 0;
  if (eCore < nCore - 1) return false;
  if (!grafoElementosConexo(enlaces, atomos)) return false;
  if (nCore === 2) return eCore === 1;

  // Búsqueda exacta sobre los vértices del núcleo (3 ≤ nCore ≤ 8, eCore ≤ 9).
  const remVal = new Int8Array(nCore);
  const valV = new Int8Array(nCore);
  const inicioElem = new Int8Array(NE).fill(-1);
  const finElem = new Int8Array(NE).fill(-1);
  let cursor = 0;
  for (let e = 1; e < NE; e++) {
    const ne = atomos[e]!;
    if (ne === 0) continue;
    inicioElem[e] = cursor;
    for (let j = 0; j < ne; j++) { valV[cursor] = VAL[e]!; remVal[cursor++] = VAL[e]!; }
    finElem[e] = cursor;
  }

  const coreBonds: { e: number; f: number; k: number }[] = [];
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    if (!T_CORE[ti]) continue;
    const e = T_E[ti]!, f = T_F[ti]!, k = T_K[ti]!;
    for (let j = 0; j < c; j++) coreBonds.push({ e, f, k });
  }
  coreBonds.sort((a, b) => b.k - a.k || a.e - b.e || a.f - b.f);

  const adjMask = new Uint8Array(nCore);
  const m = coreBonds.length;
  const fullMask = (1 << nCore) - 1;

  /** Alcanzables desde `desde` sin pasar por los vértices de `prohibidos` (máscara de bits). */
  const alcanzables = (desde: number, prohibidos: number): number => {
    let vis = (1 << desde) | prohibidos;
    let pila = 1 << desde;
    while (pila !== 0) {
      const bit = pila & -pila;
      const u = Math.clz32(bit) ^ 31;
      pila ^= bit;
      const nb = adjMask[u]! & ~vis;
      vis |= nb;
      pila |= nb;
    }
    return vis & ~prohibidos;
  };

  /** Regla del átomo lineal: ningún átomo con dos vecinos σ (ambos del núcleo: sin H) y valencia ≥ 4 en un ciclo, es
   * decir, sus dos vecinos no se alcanzan sin pasar por él. */
  const sinLinealEnAnillo = (): boolean => {
    for (let u = 0; u < nCore; u++) {
      const vec = adjMask[u]!, sinPrimero = vec & (vec - 1);
      // Dos vecinos del núcleo exactos (sinPrimero tiene un solo bit) y ninguna valencia libre para un H.
      if (valV[u]! < 4 || remVal[u]! !== 0 || sinPrimero === 0 || (sinPrimero & (sinPrimero - 1)) !== 0) continue;
      const a = Math.clz32(vec & -vec) ^ 31, b = Math.clz32(sinPrimero) ^ 31;
      if (alcanzables(a, 1 << u) & (1 << b)) return false;
    }
    return true;
  };

  function dfs(bi: number, parPrevio: number): boolean {
    if (bi === m) return alcanzables(0, 0) === fullMask && sinLinealEnAnillo();
    const bond = coreBonds[bi]!;
    const mismoTipo = bi > 0
      && coreBonds[bi - 1]!.e === bond.e
      && coreBonds[bi - 1]!.f === bond.f
      && coreBonds[bi - 1]!.k === bond.k;
    const minPar = mismoTipo ? parPrevio + 1 : 0;
    const sE = inicioElem[bond.e]!, eE = finElem[bond.e]!;
    const sF = inicioElem[bond.f]!, eF = finElem[bond.f]!;
    const mismoElem = bond.e === bond.f;

    for (let u = sE; u < eE; u++) {
      if (remVal[u]! < bond.k) continue;
      for (let v = mismoElem ? u + 1 : sF; v < eF; v++) {
        const codPar = u * nCore + v;
        if (codPar < minPar || remVal[v]! < bond.k || (adjMask[u]! & (1 << v)) !== 0) continue;
        remVal[u]! -= bond.k;
        remVal[v]! -= bond.k;
        adjMask[u]! |= 1 << v;
        adjMask[v]! |= 1 << u;
        if (dfs(bi + 1, codPar)) return true;
        remVal[u]! += bond.k;
        remVal[v]! += bond.k;
        adjMask[u]! &= ~(1 << v);
        adjMask[v]! &= ~(1 << u);
      }
    }
    return false;
  }

  return dfs(0, -1);
}

// ── Energía, propiedades y construcción de Sustancia ────────────────────────────────────────────────────

/**
 * Estabilización reticular entera (≥ 0) para sólidos iónicos mixtos (oxoaniones resonantes e hidróxidos).
 * Homogénea de grado 1 (`energiaRed(m·b) = m·energiaRed(b)`) y nula si no hay enlaces iónicos (Δχ ≥ DCHI_IONICO).
 */
export function energiaRed(enlaces: Uint16Array): number {
  const ionicoEn = new Int32Array(NE);
  const simpleXY = new Int32Array(NE * NE);
  const piXY = new Int32Array(NE * NE);
  const hEn = new Int32Array(NE);
  let hayIonico = false;

  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    const e = T_E[ti]!, f = T_F[ti]!, k = T_K[ti]!;
    if (ES_IONICO[ti]) {
      hayIonico = true;
      const anion = CHI[e]! > CHI[f]! ? e : f;
      ionicoEn[anion]! += c;
    } else if (VAL[e] === 1 && VAL[f]! > 1) {
      hEn[f]! += c;
    } else if (e !== f) {
      if (k === 1) {
        simpleXY[e * NE + f]! += c;
        simpleXY[f * NE + e]! += c;
      } else {
        const aporte = 2 * (k - 1) * c;
        piXY[e * NE + f]! += aporte;
        piXY[f * NE + e]! += aporte;
      }
    }
  }
  if (!hayIonico) return 0;

  let bono = 0;
  for (let x = 0; x < NE; x++) {
    const ix = ionicoEn[x]!;
    if (ix === 0) continue;
    let cx = 0;
    for (let y = 1; y < NE; y++) {
      if (y === x) continue;
      const s = simpleXY[x * NE + y]!, p = piXY[x * NE + y]!;
      if (s > 0 && p > 0) cx += Math.min(s, p);
    }
    const rx = Math.min(ix, cx);
    const hx = Math.min(ix - rx, hEn[x]!);
    bono += E_RES_IONICO * rx + E_HID_IONICO * hx;
  }
  return bono;
}

/** Energía química entera (J/cuanto): −(Σ d·b + energiaRed(b)). */
export function energiaSustancia(enlaces: Uint16Array, clase: ClaseSustancia): number {
  let sumaD = 0;
  for (let i = 0; i < enlaces.length; i += 2) sumaD += T_D[enlaces[i]!]! * enlaces[i + 1]!;
  return -(sumaD + (clase === ClaseSustancia.Unidad ? energiaRed(enlaces) : 0));
}

/** Calcula todas las propiedades físicas de una sustancia únicamente desde su estructura. */
export function propiedadesSustancia(
  enlaces: Uint16Array,
  atomos: Uint8Array,
  clase: ClaseSustancia,
  energia: number,
): Propiedades {
  let nTot = 0, nCore = 0, masa = 0, volMolar = 0;
  let oReq = 0, eOx = 0;
  for (let e = 0; e < NE; e++) {
    const ne = atomos[e]!;
    if (ne === 0) continue;
    nTot += ne;
    if (VAL[e]! > 1) nCore += ne;
    masa += ne * MASA[e]!;
    volMolar += ne * VOLUMEN_ATOMO[e]!;
    oReq += ne * O_REQ_POR_ATOMO[e]!;
    eOx += ne * E_OX_POR_ATOMO[e]!;
  }

  let eTot = 0, eCore = 0, sumaD = 0, sumaPolarH = 0, sumaDchi = 0, eMetal = 0;
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    eTot += c;
    if (T_CORE[ti]) eCore += c;
    sumaD += T_D[ti]! * c;
    sumaPolarH += T_POLAR[ti]! * c;
    sumaDchi += T_DCHI[ti]! * c;
    const e = T_E[ti]!, f = T_F[ti]!;
    if ((e === 6 || e === 7) && (f === 6 || f === 7)) eMetal += c;
  }

  const r = nCore > 0 ? (2 * eCore) / nCore : 0;
  const dMedia = eTot > 0 ? sumaD / eTot : 0;

  let tFusion: number;
  let tEbullicion: number;
  if (clase === ClaseSustancia.Molecula) {
    tEbullicion = EBULLICION_MASA * Math.sqrt(masa) + sumaPolarH;
    tFusion = FUSION_MOLECULA * tEbullicion;
  } else {
    tFusion = FUSION_RED * Math.max(0.25, r - 1) * dMedia;
    // Una red nunca es gas (`esGasA`): su ebullición solo se informa, fuera del rango de niveles.
    tEbullicion = Math.max(tFusion * 1.8, T_NIVEL_MAX * 2);
  }

  // Oxidación completa (ley de Hess exacta).
  const nuO2 = (oReq - atomos[3]!) * 0.5;
  const qRaw = (energia - nuO2 * D_OO2) - eOx;
  const qOxidacion = qRaw > 1e-9 ? qRaw : 0;

  const dureza = clase === ClaseSustancia.Unidad
    ? clamp01((dMedia / D_MAX) * clamp01((r - R_RIGIDEZ) / ANCHO_RIGIDEZ))
    : 0;

  const fMetal = eTot > 0 ? eMetal / eTot : 0;
  const tenacidad = clase === ClaseSustancia.Unidad
    ? clamp01(TENACIDAD_RED * Math.exp(-(((r - R_RIGIDEZ) / TENACIDAD_ANCHO) ** 2)) + TENACIDAD_METAL * fMetal)
    : 0;

  const flexibilidad = clamp01(1 - Math.max(0, r - 1) / (R_RIGIDEZ - 1));
  const polaridad = eTot > 0 ? clamp01(sumaDchi / (eTot * DCHI_IONICO)) : 0;

  const empaquetado = clase === ClaseSustancia.Unidad ? EMPAQUETADO_BASE + EMPAQUETADO_POR_R * Math.min(4, r) : 1;
  const densidad = volMolar > 0 ? (masa * empaquetado) / volMolar : 1;

  let cr = 0, cg = 0, cb = 0;
  for (let e = 0; e < NE; e++) {
    const peso = atomos[e]! / Math.max(1, nTot);
    if (peso === 0) continue;
    const rgb = RGB_ELEM[e]!;
    cr += peso * rgb[0];
    cg += peso * rgb[1];
    cb += peso * rgb[2];
  }
  // Distinción visual entre hierro metálico (gris acero) y óxido de hierro (rojizo).
  if (atomos[7]! > 0) {
    if (fMetal > 0.3) { cr = cr * 0.4 + 108; cg = cg * 0.4 + 114; cb = cb * 0.4 + 122; }
    else if (atomos[3]! > 0) { cr = Math.min(255, cr * 0.85 + 48); cg *= 0.65; cb *= 0.52; }
  }
  const color = (Math.round(Math.max(0, Math.min(255, cr))) << 16)
    | (Math.round(Math.max(0, Math.min(255, cg))) << 8)
    | Math.round(Math.max(0, Math.min(255, cb)));

  return { r, dMedia, tFusion, tEbullicion, qOxidacion, dureza, tenacidad, flexibilidad, polaridad, densidad, color };
}

/** Construye una `Sustancia` inmutable validada a partir de un vector de enlaces. */
export function construirSustancia(id: SustanciaId, enlacesEntrada: Uint16Array): Sustancia {
  if (!Number.isInteger(id) || id <= 0) throw new RangeError(`SustanciaId inválido: ${id}`);
  const enlaces = normalizarEnlaces(enlacesEntrada);
  const atomos = atomosDeEnlaces(enlaces);
  if (!atomos) throw new RangeError(`Enlaces no saturados o > ${ATOMOS_POR_UNIDAD} átomos: ${claveEnlaces(enlaces)}`);
  if (!grafoElementosConexo(enlaces, atomos)) {
    throw new RangeError(`Sustancia con grafo de elementos disconexo: ${claveEnlaces(enlaces)}`);
  }
  const clase = realizable(enlaces, atomos) ? ClaseSustancia.Molecula : ClaseSustancia.Unidad;
  const energia = energiaSustancia(enlaces, clase);
  let masa = 0;
  for (let e = 0; e < NE; e++) masa += atomos[e]! * MASA[e]!;
  const prop = propiedadesSustancia(enlaces, atomos, clase, energia);
  return Object.freeze({ id, clase, enlaces, atomos, masa, energia, prop: Object.freeze(prop) });
}

/** Cierto si `s` es fase gas a temperatura `T` (K). Solo las moléculas pueden ser gas. */
export function esGasA(s: Pick<Sustancia, 'clase' | 'prop'>, T: number): boolean {
  return s.clase === ClaseSustancia.Molecula && T > s.prop.tEbullicion;
}

// ── Cinética (ea, familia catalítica y Arrhenius) ───────────────────────────────────────────────────────

/** Familia catalítica de un tipo de enlace (`Kappa`): 0 = C–O, 1 = C–N, 2 = C–C/C–H, 3 = H–H, −1 = no catalizable.
 * H–H es catalizable desde la enmienda 1 (el suelo oxida el H₂ con O₂ en frío: bacterias del hidrógeno) y tiene familia
 * propia desde la 2, para que el suelo pueda oxidarlo al paso sin acelerar la carbonización ni la respiración del resto. */
export function familiaCatalitica(tipo: number): FamiliaCatalitica {
  const e = T_E[tipo]!, f = T_F[tipo]!;
  if (e === 1 && f === 3) return 0; // C–O, C=O
  if (e === 1 && f === 2) return 1; // C–N, C=N, C≡N
  if ((e === 1 && f === 1) || (e === 0 && f === 1)) return 2; // C–C..C≡C, H–C
  if (e === 0 && f === 0) return 3; // H–H
  return -1;
}

export interface EntradaSalidaEnlaces { enlaces: Uint16Array; nu: number }

/**
 * Barrera `ea` (J por cuanto de reacción) y familia `catalisis` de una reacción balanceada. La barrera es GAMMA por la
 * energía del enlace que hay que cortar, y nunca menor que dH: si lo fuera, la reacción inversa tendría barrera negativa.
 * - Si algún tipo disminuye, cuenta el más fuerte. Si solo baja de orden (k → k′ < k sin que su par pierda enlaces),
 *   se corta su parte π, D_k − D_k′; con un sólido iónico entre las entradas y ningún σ perdido se rebaja E_CAT_IONICO.
 * - Si el vector de enlaces se conserva y sale una sola especie, es una asociación (CaO + H₂O → Ca(OH)₂): no se corta
 *   nada. Con dos o más productos alguna entrada se parte, así que se corta y se rehace al menos un enlace suyo: cuenta
 *   el más débil de las entradas, como cota inferior (arcilla → SiO₂ + H₂O, 2 CH₂ → CH₄ + C, arcilla + CaO).
 * `catalisis` es la familia del enlace catalizable que disminuye con el par de electrones más débil (contrato de
 * `Reaccion`), −1 si no hay; `paresCatalisis` son los pares que el catalizador abre de ese enlace (enmienda 3; 0 sin
 * familia): k si se corta (y su par vale D/k), k − k′ si solo baja a orden k′ (y su par vale (D_k − D_k′)/(k − k′)). En
 * los enlaces simples coincide con el «más débil» de la enmienda 1; un C≡N (891, 297 por par) decide frente a un H–C
 * (403) con 3 pares, y el C=O del CO₂ que fragua en CaCO₃ (pasa a C–O) abre uno (`barreraEfectiva`).
 */
export function calcularCinetica(
  entradas: readonly EntradaSalidaEnlaces[],
  salidas: readonly EntradaSalidaEnlaces[],
  dH: number,
): { ea: number; catalisis: FamiliaCatalitica; paresCatalisis: 0 | 1 | 2 | 3 } {
  const bIn = new Int32Array(NT);
  const bOut = new Int32Array(NT);
  const parIn = new Int32Array(NE * NE);
  const parOut = new Int32Array(NE * NE);
  let hayIonicoEntrada = false;

  for (const { enlaces, nu } of entradas) {
    for (let i = 0; i < enlaces.length; i += 2) {
      const ti = enlaces[i]!, c = enlaces[i + 1]! * nu;
      bIn[ti]! += c;
      parIn[T_E[ti]! * NE + T_F[ti]!]! += c;
      if (ES_IONICO[ti]) hayIonicoEntrada = true;
    }
  }
  for (const { enlaces, nu } of salidas) {
    for (let i = 0; i < enlaces.length; i += 2) {
      const ti = enlaces[i]!, c = enlaces[i + 1]! * nu;
      bOut[ti]! += c;
      parOut[T_E[ti]! * NE + T_F[ti]!]! += c;
    }
  }

  let sigmaRoto = false;
  for (let p = 0; p < NE * NE; p++) {
    if (parIn[p]! > parOut[p]!) { sigmaRoto = true; break; }
  }

  let maxD = 0;
  let minCatD = Infinity;
  let catalisis: FamiliaCatalitica = -1;
  let paresCatalisis: 0 | 1 | 2 | 3 = 0;
  let huboDescenso = false;

  for (let ti = 0; ti < NT; ti++) {
    const ci = bIn[ti]!, co = bOut[ti]!;
    if (ci <= co) continue;
    huboDescenso = true;
    const e = T_E[ti]!, f = T_F[ti]!, k = T_K[ti]!;
    const par = e * NE + f;
    let dRoto = T_D[ti]!;
    let abiertos = k; // pares que se abren: todos si se corta, k − k′ si solo baja a orden k′ (su parte π)
    if (k > 1 && parOut[par]! >= parIn[par]!) {
      for (let kMenor = k - 1; kMenor >= 1; kMenor--) {
        const tiMenor = indiceTipoEnlace(e, f, kMenor as 1 | 2);
        if (bOut[tiMenor]! > bIn[tiMenor]!) { dRoto = T_D[ti]! - T_D[tiMenor]!; abiertos = k - kMenor; break; }
      }
    }
    if (dRoto > maxD) maxD = dRoto;
    const fam = familiaCatalitica(ti);
    const porPar = dRoto / abiertos; // = D/k (D_PER_K) si se corta entero
    if (fam !== -1 && porPar < minCatD) {
      minCatD = porPar;
      catalisis = fam;
      paresCatalisis = abiertos as 1 | 2 | 3;
    }
  }

  let ea = 0;
  if (huboDescenso) {
    ea = GAMMA * maxD;
    if (!sigmaRoto && hayIonicoEntrada) ea = Math.max(0, ea - E_CAT_IONICO);
  } else if (salidas.length > 1 || salidas[0]!.nu > 1) {
    let minD = Infinity;
    for (let ti = 0; ti < NT; ti++) if (bIn[ti]! > 0 && T_D[ti]! < minD) minD = T_D[ti]!;
    ea = GAMMA * minD;
  }
  return { ea: Math.max(ea, dH), catalisis, paresCatalisis };
}

// ── Mínimo global exacto de energía libre: productos(A, B, nivelT) ──────────────────────────────────────

interface EspecieOpt {
  enlaces: Uint16Array;
  atomos: Uint8Array;
  clase: ClaseSustancia;
  energia: number;
  tEb: number;
  gasDesde: number;
}

function nivelGasDesde(clase: ClaseSustancia, tEb: number): number {
  if (clase !== ClaseSustancia.Molecula) return NIVELES_T;
  for (let l = 0; l < NIVELES_T; l++) if (T_NIVEL[l]! > tEb) return l;
  return NIVELES_T;
}

function evaluarEspecieOpt(enlaces: Uint16Array, atomos: Uint8Array): EspecieOpt {
  let eBond = 0;
  let polarSum = 0;
  for (let i = 0; i < enlaces.length; i += 2) {
    const ti = enlaces[i]!, c = enlaces[i + 1]!;
    eBond += T_D[ti]! * c;
    polarSum += T_POLAR[ti]! * c;
  }
  const esMol = realizable(enlaces, atomos);
  const clase = esMol ? ClaseSustancia.Molecula : ClaseSustancia.Unidad;
  const energia = -(eBond + (esMol ? 0 : energiaRed(enlaces)));
  let tEb = Infinity;
  if (esMol) {
    let masa = 0;
    for (let e = 0; e < NE; e++) masa += atomos[e]! * MASA[e]!;
    tEb = EBULLICION_MASA * Math.sqrt(masa) + polarSum;
  }
  return { enlaces, atomos, clase, energia, tEb, gasDesde: nivelGasDesde(clase, tEb) };
}

/** Empaqueta un vector de átomos (cada elemento ≤ 8) en un u32 exacto (4 bits × 8 elementos). */
function empaquetarAtomos(atomos: Uint8Array): number {
  let k = 0;
  for (let e = 0; e < NE; e++) k |= atomos[e]! << (e * 4);
  return k >>> 0;
}

/**
 * Cota superior demostrable de `energiaRed(b)` para cualquier red saturada con átomos `atomos`.
 * Cada sitio resonante consume ≥ 1 (iónico) + 1 (simple) + 0,75 (π) = 2,75 valencias del anión X
 * y ≥ 1,75 valencias de socios Y ≠ X con π_Y > 0; cada hidróxido consume ≥ 2 valencias de X y 1 de H.
 */
function cotaSuperiorEnergiaRed(atomos: Uint8Array): number {
  let valCationes = 0;
  let valAniones = 0;
  let maxRes = 0;
  let hayIonico = false;
  const capAnion = new Int32Array(NE);
  const cationVisto = new Uint8Array(NE);

  for (let i = 0; i < NT; i++) {
    if (!ES_IONICO[i]) continue;
    const e = T_E[i]!, f = T_F[i]!;
    if (atomos[e]! === 0 || atomos[f]! === 0) continue;
    hayIonico = true;
    const cat = CHI[e]! < CHI[f]! ? e : f;
    const ani = cat === e ? f : e;
    if (!cationVisto[cat]) { cationVisto[cat] = 1; valCationes += atomos[cat]! * VAL[cat]!; }
    capAnion[ani]! += atomos[cat]! * VAL[cat]!;
  }
  if (!hayIonico) return 0;

  const valH = atomos[0]! * VAL[0]!;
  for (let x = 0; x < NE; x++) {
    if (capAnion[x] === 0) continue;
    const vx = atomos[x]! * VAL[x]!;
    valAniones += vx;
    const iMaxX = Math.min(vx, capAnion[x]!);
    if (PI[x]! > 0) {
      let valSocios = 0;
      for (let y = 1; y < NE; y++) {
        if (y !== x && atomos[y]! > 0 && PI[y]! > 0) valSocios += atomos[y]! * VAL[y]!;
      }
      if (valSocios > 0) {
        maxRes += Math.min(iMaxX, Math.floor(vx / 2.75 + 1e-9), Math.floor(valSocios / 1.75 + 1e-9));
      }
    }
  }
  const iCap = Math.min(valCationes, valAniones);
  const rCap = Math.min(iCap, maxRes);
  const hCap = Math.min(iCap - rCap, valH, Math.floor(valAniones / 2));
  return E_RES_IONICO * rCap + E_HID_IONICO * hCap;
}

/**
 * Caché reutilizable del solver por hilo (no comparte estado mutable entre instancias).
 * Almacena el óptimo global exacto por (estequiometría ≤ 8 átomos, nivelT).
 */
export class ContextoSolver {
  readonly cacheEstequiometria = new Map<number, EspecieOpt | null>();
  /** Negativos con cota: ninguna especie de esa estequiometría mejora (cg, cgas, cmol, ccnt) (`mejoraDescomposicion`).
   * Con los coeficientes de la enmienda 1 cada pareja resuelve hasta ~40 particiones que comparten sub-estequiometrías,
   * y sin esto cada una repetía la búsqueda (C + N₂: 0,5 s en frío). */
  readonly cotaNula = new Map<number, readonly [number, number, number, number]>();
  readonly pi = new Float64Array(NE);
  readonly piTry = new Float64Array(NE);
  readonly availIdx = new Int32Array(NT);
}

/**
 * Cota superior dual de relajación lineal para Σ D_i·c_i sujeta a capacidades de valencia `rem`:
 * cualquier vector π ≥ 0 con π[e_i] + π[f_i] ≥ D_i/k_i en todos los enlaces disponibles satisface
 *   Σ D_i·c_i = Σ k_i·c_i·(D_i/k_i) ≤ Σ k_i·c_i·(π[e_i] + π[f_i]) = Σ_e rem[e]·π[e].
 * Parte de π[e] = máx D/(2k) de sus enlaces; con `refinar`, baja precios por descenso de coordenadas sin perder la
 * factibilidad (aprieta elementos escasos como Ca). Devuelve −1 si a un elemento con rem > 0 no le cabe ningún enlace.
 */
function cotaDual(ctx: ContextoSolver, rem: Int32Array, activos: readonly number[], enlaces: readonly number[], refinar: boolean): number {
  const pi = ctx.pi;
  const piTry = ctx.piTry;
  const avail = ctx.availIdx;
  const np = activos.length;
  let na = 0;
  for (let j = 0; j < np; j++) pi[activos[j]!] = 0;

  for (let i = 0; i < enlaces.length; i++) {
    const ti = enlaces[i]!, e = T_E[ti]!, f = T_F[ti]!, k = T_K[ti]!;
    if (e === f) {
      if (rem[e]! < 2 * k) continue;
      avail[na++] = ti;
      const mitad = D_PER_K[ti]! * 0.5;
      if (mitad > pi[e]!) pi[e] = mitad;
    } else {
      if (rem[e]! < k || rem[f]! < k) continue;
      avail[na++] = ti;
      const mitad = D_PER_K[ti]! * 0.5;
      if (mitad > pi[e]!) pi[e] = mitad;
      if (mitad > pi[f]!) pi[f] = mitad;
    }
  }

  let mejor = 0;
  for (let j = 0; j < np; j++) {
    const e = activos[j]!, r = rem[e]!;
    if (r > 0) {
      if (pi[e]! === 0) return -1;
      mejor += r * pi[e]!;
    }
  }
  if (!refinar || na <= 1 || np <= 1) return mejor;

  for (let paso = 0; paso < 3; paso++) {
    let mejoro = false;
    for (let j = 0; j < np; j++) {
      const u = activos[j]!, ru = rem[u]!;
      if (ru === 0) continue;
      let minReq = 0;
      for (let a = 0; a < na; a++) {
        const ti = avail[a]!, e = T_E[ti]!, f = T_F[ti]!;
        if (e === u && f === u) { const req = D_PER_K[ti]! * 0.5; if (req > minReq) minReq = req; }
        else if (e === u) { const req = D_PER_K[ti]! - pi[f]!; if (req > minReq) minReq = req; }
        else if (f === u) { const req = D_PER_K[ti]! - pi[e]!; if (req > minReq) minReq = req; }
      }
      if (minReq < pi[u]! - 1e-9) {
        mejor -= ru * (pi[u]! - minReq);
        pi[u] = minReq;
        mejoro = true;
      }
    }
    for (let j = 0; j < np; j++) {
      const u = activos[j]!, ru = rem[u]!;
      if (ru === 0) continue;
      let pisoPropio = 0;
      for (let a = 0; a < na; a++) {
        const ti = avail[a]!;
        if (T_E[ti] === u && T_F[ti] === u) { const r = D_PER_K[ti]! * 0.5; if (r > pisoPropio) pisoPropio = r; }
      }
      for (let intento = 0; intento < 2; intento++) {
        const objetivo = intento === 0 ? pisoPropio : (pi[u]! + pisoPropio) * 0.5;
        if (objetivo >= pi[u]! - 0.1) continue;
        for (let k = 0; k < np; k++) piTry[activos[k]!] = pi[activos[k]!];
        piTry[u] = objetivo;
        for (let a = 0; a < na; a++) {
          const ti = avail[a]!, e = T_E[ti]!, f = T_F[ti]!;
          if (e === u && f !== u) { const req = D_PER_K[ti]! - objetivo; if (req > piTry[f]!) piTry[f] = req; }
          else if (f === u && e !== u) { const req = D_PER_K[ti]! - objetivo; if (req > piTry[e]!) piTry[e] = req; }
        }
        let val = 0;
        for (let k = 0; k < np; k++) val += rem[activos[k]!]! * piTry[activos[k]!]!;
        if (val < mejor - 1e-6) {
          for (let k = 0; k < np; k++) pi[activos[k]!] = piTry[activos[k]!];
          mejor = val;
          mejoro = true;
        }
      }
    }
    if (!mejoro) break;
  }
  return mejor;
}

/**
 * Criterio de mejora frente a una descomposición ya conocida de los mismos átomos:
 * 1) Menor energía libre G (estricto > 1e-9).
 * 2) En empate de G: una `Unidad` nunca pega especies sin ganar energía (evita aductos ficticios C₂, Si₂O₄, CaCO₃·H₂O).
 *    Una `Molecula` sí puede empatar si aporta más gases, más moléculas o menos especies (p. ej. C₂H₆ frente a CH₄+CH₂).
 */
function mejoraDescomposicion(
  g: number, esGas: boolean, esMol: boolean,
  cg: number, cgas: number, cmol: number, ccnt: number,
): boolean {
  if (g < cg - 1e-9) return true;
  if (g > cg + 1e-9) return false;
  if (!esMol) return false;
  const gas = esGas ? 1 : 0;
  if (gas !== cgas) return gas > cgas;
  if (1 !== cmol) return 1 > cmol;
  return 1 < ccnt;
}

/**
 * Resuelve el mínimo exacto de energía libre para una única especie de estequiometría `atomos` (|atomos| ≤ 8)
 * al nivel `nivelT`, podando ramas que no puedan mejorar `(cg, cgas, cmol, ccnt)`.
 * Elimina elementos en orden MRV (menor valencia pendiente primero) con cota dual LP exacta.
 */
function resolverEstequiometria(
  atomos: Uint8Array,
  nivelT: number,
  cg: number,
  cgas: number,
  cmol: number,
  ccnt: number,
  ctx: ContextoSolver,
): { spec: EspecieOpt; g: number; esGas: boolean } | null {
  const clave = empaquetarAtomos(atomos) * NIVELES_T + nivelT;
  const memo = ctx.cacheEstequiometria.get(clave);
  if (memo !== undefined) {
    if (!memo) return null;
    const esGas = memo.gasDesde <= nivelT;
    const esMol = memo.clase === ClaseSustancia.Molecula;
    const g = memo.energia - (esGas ? TS_NIVEL[nivelT]! : 0);
    return mejoraDescomposicion(g, esGas, esMol, cg, cgas, cmol, ccnt) ? { spec: memo, g, esGas } : null;
  }

  // Ya se probó que nada mejora la misma cota o una más laxa. Margen 2·10⁻⁶: lo que mejora cg (g ≤ cg + 10⁻⁹) queda
  // por debajo de cota − 10⁻⁶, que la poda de la raíz y la de la búsqueda no habrían descartado.
  const nula = ctx.cotaNula.get(clave);
  if (nula && (cg < nula[0] - 2e-6 || (cg === nula[0] && cgas === nula[1] && cmol === nula[2] && ccnt === nula[3]))) return null;
  const negativo = (): null => {
    const previa = ctx.cotaNula.get(clave);
    if (cg !== Infinity && (!previa || cg > previa[0])) ctx.cotaNula.set(clave, [cg, cgas, cmol, ccnt]);
    return null;
  };

  const T = T_NIVEL[nivelT]!;
  const Ts = TS_NIVEL[nivelT]!;
  const puedeSerMol = atomos[6]! === 0 && atomos[7]! === 0;
  let totalAtomos = 0, totalVal = 0, nCore = 0, masa = 0;
  const rem = new Int32Array(NE);
  const presentes: number[] = [];
  for (let e = 0; e < NE; e++) {
    const ne = atomos[e]!;
    if (ne === 0) continue;
    presentes.push(e);
    totalAtomos += ne;
    const v = ne * VAL[e]!;
    rem[e] = v;
    totalVal += v;
    if (VAL[e]! > 1) nCore += ne;
    masa += ne * MASA[e]!;
  }
  if (totalAtomos === 0 || totalAtomos > ATOMOS_POR_UNIDAD || (totalVal & 1) !== 0) {
    ctx.cacheEstequiometria.set(clave, null);
    return null;
  }

  // Orden MRV: menor valencia pendiente primero (desempate: menos enlaces incidentes).
  presentes.sort((a, b) => rem[a]! - rem[b]! || ENLACES_DE[a]!.length - ENLACES_DE[b]!.length);
  const np = presentes.length;
  const rango = new Int8Array(NE).fill(-1);
  for (let s = 0; s < np; s++) rango[presentes[s]!] = s;

  const relTypes: number[] = [];
  const inicioEtapa = new Int32Array(np + 1);
  for (let s = 0; s < np; s++) {
    inicioEtapa[s] = relTypes.length;
    const u = presentes[s]!;
    for (const ti of ENLACES_DE[u]!) {
      const e = T_E[ti]!, f = T_F[ti]!, k = T_K[ti]!;
      const otro = e === u ? f : e;
      if (rango[otro]! < s) continue;
      if (e === f ? 2 * k > rem[e]! : (k > rem[e]! || k > rem[f]!)) continue;
      relTypes.push(ti);
    }
  }
  inicioEtapa[np] = relTypes.length;
  const m = relTypes.length;

  const maxEred = puedeSerMol ? 0 : cotaSuperiorEnergiaRed(atomos);
  const baseTeb = EBULLICION_MASA * Math.sqrt(masa);
  const puedeSerGas = puedeSerMol && T > baseTeb;
  const creditoGas = puedeSerGas ? Ts : 0;

  const puedeGanarEmpate = puedeSerMol && (
    (puedeSerGas ? 1 : 0) > cgas
    || ((puedeSerGas ? 1 : 0) === cgas && (1 > cmol || (1 === cmol && 1 < ccnt)))
  );
  const umbralRaiz = puedeGanarEmpate ? cg + 1e-9 : cg - 1e-6;

  const dualRaiz = cotaDual(ctx, rem, presentes, relTypes, true);
  if (dualRaiz < 0) {
    ctx.cacheEstequiometria.set(clave, null);
    return null;
  }
  const minERaiz = -(Math.floor(dualRaiz + 1e-9) + maxEred);
  if (minERaiz - creditoGas > umbralRaiz) return negativo();

  const tramoEtapa: number[][] = [];
  const activosEtapa: number[][] = [];
  for (let s = 0; s <= np; s++) {
    tramoEtapa.push(relTypes.slice(inicioEtapa[s]!));
    activosEtapa.push(presentes.slice(s));
  }

  const rtE = new Int8Array(m), rtF = new Int8Array(m), rtK = new Int8Array(m), rtD = new Int32Array(m);
  const rtCore = new Uint8Array(m), rtIon = new Uint8Array(m), rtPolar = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const ti = relTypes[i]!;
    rtE[i] = T_E[ti]!; rtF[i] = T_F[ti]!; rtK[i] = T_K[ti]!; rtD[i] = T_D[ti]!;
    rtCore[i] = T_CORE[ti]!; rtIon[i] = ES_IONICO[ti]!; rtPolar[i] = T_POLAR[ti]!;
  }
  const etapaTieneIon = new Uint8Array(np + 1);
  for (let s = np - 1; s >= 0; s--) {
    let hi = etapaTieneIon[s + 1]!;
    for (let i = inicioEtapa[s]!; i < inicioEtapa[s + 1]!; i++) hi |= rtIon[i]!;
    etapaTieneIon[s] = hi;
  }

  let mejorSpec: EspecieOpt | null = null;
  let mejorG = cg;
  let mejorEsGas = false;
  let mejorEsMol = false;
  let hallado = false;
  const counts = new Int32Array(m);

  function dfs(s: number, pos: number, curBondE: number, curECore: number, curPolar: number, curIon: number): void {
    while (s < np && rem[presentes[s]!] === 0) {
      s++;
      pos = inicioEtapa[s]!;
      if (s < np) {
        const ub = cotaDual(ctx, rem, activosEtapa[s]!, tramoEtapa[s]!, s <= 2);
        if (ub < 0) return;
        const subMaxEred = (curIon > 0 || etapaTieneIon[s]!) ? maxEred : 0;
        const subCanMol = puedeSerMol && curIon === 0 && (nCore === 0 || (2 * curECore) / nCore < R_RIGIDEZ);
        const subCanGas = subCanMol && puedeSerGas && baseTeb + curPolar < T;
        const minG = -(curBondE + Math.floor(ub + 1e-9) + subMaxEred) - (subCanGas ? Ts : 0);
        if (hallado) {
          if (minG > mejorG + 1e-9) return;
        } else {
          const umbral = (subCanMol && puedeGanarEmpate) ? cg + 1e-9 : cg - 1e-6;
          if (minG > umbral) return;
        }
      }
    }

    if (s === np) {
      // Sin enlaces iónicos la energía no depende de la clase (E_red = 0): solo el crédito de gas, que exige molécula. Si
      // ni con él mejora, la hoja no cuenta y se ahorra `realizable`, que es lo caro (con la enmienda 1 cada pareja
      // explora muchas más sub-estequiometrías ricas en C: el 80 % del tiempo en frío era esa búsqueda).
      if (curIon === 0) {
        const gOpt = -curBondE - (puedeSerGas && baseTeb + curPolar < T ? Ts : 0);
        if (gOpt > (hallado ? mejorG : cg) + 1e-9) return;
      }
      let pares = 0;
      for (let i = 0; i < m; i++) if (counts[i]! > 0) pares++;
      const bruto = new Uint16Array(pares * 2);
      let w = 0;
      for (let i = 0; i < m; i++) {
        if (counts[i]! > 0) { bruto[w++] = relTypes[i]!; bruto[w++] = counts[i]!; }
      }
      const enlaces = normalizarEnlaces(bruto);
      if (!grafoElementosConexo(enlaces, atomos)) return;
      const spec = evaluarEspecieOpt(enlaces, atomos);
      const esGas = spec.gasDesde <= nivelT;
      const esMol = spec.clase === ClaseSustancia.Molecula;
      const g = spec.energia - (esGas ? Ts : 0);
      if (!hallado) {
        if (mejoraDescomposicion(g, esGas, esMol, cg, cgas, cmol, ccnt)) {
          mejorSpec = spec; mejorG = g; mejorEsGas = esGas; mejorEsMol = esMol; hallado = true;
        }
      } else if (
        g < mejorG - 1e-9
        || (Math.abs(g - mejorG) <= 1e-9 && (
          (esGas && !mejorEsGas)
          || (esGas === mejorEsGas && (
            (esMol && !mejorEsMol)
            || (esMol === mejorEsMol && compararEnlaces(spec.enlaces, mejorSpec!.enlaces) < 0)
          ))
        ))
      ) {
        mejorSpec = spec; mejorG = g; mejorEsGas = esGas; mejorEsMol = esMol;
      }
      return;
    }

    const u = presentes[s]!;
    const finPos = inicioEtapa[s + 1]!;
    if (pos >= finPos) return;

    const e = rtE[pos]!, f = rtF[pos]!, k = rtK[pos]!;
    const d = rtD[pos]!, isCore = rtCore[pos]!, isIon = rtIon[pos]!, pol = rtPolar[pos]!;
    const maxC = e === f
      ? Math.floor(rem[e]! / (2 * k))
      : Math.min(Math.floor(rem[e]! / k), Math.floor(rem[f]! / k));

    // Último enlace de la etapa: la cuenta queda forzada para saturar exactamente rem[u].
    if (pos === finPos - 1) {
      const pasoU = e === f ? 2 * k : k;
      if (rem[u]! % pasoU !== 0) return;
      const c = rem[u]! / pasoU;
      if (c > maxC) return;
      counts[pos] = c;
      if (c > 0) { rem[e]! -= k * c; rem[f]! -= k * c; }
      dfs(s, pos + 1, curBondE + c * d, curECore + c * isCore, curPolar + c * pol, curIon + c * isIon);
      if (c > 0) { rem[e]! += k * c; rem[f]! += k * c; }
      counts[pos] = 0;
      return;
    }

    for (let c = maxC; c >= 0; c--) {
      counts[pos] = c;
      if (c > 0) { rem[e]! -= k * c; rem[f]! -= k * c; }
      dfs(s, pos + 1, curBondE + c * d, curECore + c * isCore, curPolar + c * pol, curIon + c * isIon);
      if (c > 0) { rem[e]! += k * c; rem[f]! += k * c; }
    }
    counts[pos] = 0;
  }

  dfs(0, 0, 0, 0, 0, 0);

  if (hallado && mejorSpec) {
    // Si mejoró estrictamente la cota cg (o no había cota), es el mínimo global sin restricciones de (atomos, nivelT).
    if (mejorG < cg - 1e-9 || cg === Infinity) ctx.cacheEstequiometria.set(clave, mejorSpec);
    return { spec: mejorSpec, g: mejorG, esGas: mejorEsGas };
  }
  if (cg === Infinity) ctx.cacheEstequiometria.set(clave, null);
  return negativo();
}

interface ParticionOptima {
  especies: EspecieOpt[];
  g: number;
  gases: number;
  energia: number;
}

/**
 * Mínimo global exacto sobre todas las particiones del vector de átomos `objetivo` (Σ ≤ 16)
 * en sustancias saturadas válidas de ≤ 8 átomos al nivel de temperatura `nivelT`.
 *
 * Teorema de descomposición exacta: como G(P, T) = Σ_j g(s_j, T) es estrictamente aditivo sobre las especies,
 * minimizar sobre todos los repartos de enlaces saturados equivale biyectivamente a minimizar Σ_j g*(u_j, T)
 * sobre todas las particiones de átomos u_1 + … + u_m = objetivo con 1 ≤ |u_j| ≤ 8.
 */
function minimizarParticion(objetivo: Uint8Array, nivelT: number, ctx: ContextoSolver): ParticionOptima | null {
  const strides = new Int32Array(NE);
  let totalEstados = 1;
  let totalAtomos = 0;
  for (let e = 0; e < NE; e++) {
    strides[e] = totalEstados;
    totalEstados *= objetivo[e]! + 1;
    totalAtomos += objetivo[e]!;
  }

  const dpG = new Float64Array(totalEstados).fill(Infinity);
  const dpGas = new Int32Array(totalEstados);
  const dpMol = new Int32Array(totalEstados);
  const dpCnt = new Int32Array(totalEstados);
  const dpPrev = new Int32Array(totalEstados).fill(-1);
  const dpSpec: (EspecieOpt | null)[] = new Array(totalEstados).fill(null);
  dpG[0] = 0;

  const activos: number[] = [];
  for (let e = 0; e < NE; e++) if (objetivo[e]! > 0) activos.push(e);
  const kA = activos.length;

  const porTamano: { idx: number; u: Uint8Array }[][] = Array.from({ length: ATOMOS_POR_UNIDAD + 1 }, () => []);
  const cur = new Uint8Array(NE);
  function enumerarSub(e: number, sumA: number, sumV: number, idxV: number): void {
    if (e === NE) {
      if (sumA > 0 && (sumV & 1) === 0) porTamano[sumA]!.push({ idx: idxV, u: new Uint8Array(cur) });
      return;
    }
    const maxA = Math.min(objetivo[e]!, ATOMOS_POR_UNIDAD - sumA);
    for (let c = 0; c <= maxA; c++) {
      cur[e] = c;
      enumerarSub(e + 1, sumA + c, sumV + c * VAL[e]!, idxV + c * strides[e]!);
    }
    cur[e] = 0;
  }
  enumerarSub(0, 0, 0, 0);

  const meta = totalEstados - 1;
  for (let tam = 1; tam <= ATOMOS_POR_UNIDAD; tam++) {
    for (const { idx: du, u } of porTamano[tam]!) {
      let cg = dpG[du]!, cgas = dpGas[du]!, cmol = dpMol[du]!, ccnt = dpCnt[du]!;
      // Para tam > totalAtomos/2, el complemento objetivo − u tiene tamaño < tam (ya definitivo y exacto en la DP).
      if (tam * 2 > totalAtomos && dpG[meta]! < Infinity) {
        const comp = meta - du;
        if (dpG[comp]! < Infinity) {
          const cotaComp = dpG[meta]! - dpG[comp]!;
          if (cotaComp < cg - 1e-9) {
            cg = cotaComp;
            cgas = dpGas[meta]! - dpGas[comp]!;
            cmol = dpMol[meta]! - dpMol[comp]!;
            ccnt = dpCnt[meta]! - dpCnt[comp]!;
          }
        }
      }

      const res = resolverEstequiometria(u, nivelT, cg, cgas, cmol, ccnt, ctx);
      if (!res) continue;
      const { spec, g: ig, esGas } = res;
      const igas = esGas ? 1 : 0;
      const imol = spec.clase === ClaseSustancia.Molecula ? 1 : 0;

      function relajar(pos: number, baseIdx: number): void {
        if (pos === kA) {
          const g0 = dpG[baseIdx]!;
          if (g0 === Infinity) return;
          const ni = baseIdx + du;
          const ng = g0 + ig;
          const ngas = dpGas[baseIdx]! + igas;
          const nmol = dpMol[baseIdx]! + imol;
          const ncnt = dpCnt[baseIdx]! + 1;
          const cg2 = dpG[ni]!;
          let mejor = false;
          if (ng < cg2 - 1e-9) mejor = true;
          else if (Math.abs(ng - cg2) <= 1e-9) {
            if (ngas !== dpGas[ni]!) mejor = ngas > dpGas[ni]!;
            else if (nmol !== dpMol[ni]!) mejor = nmol > dpMol[ni]!;
            else mejor = ncnt < dpCnt[ni]!;
          }
          if (mejor) {
            dpG[ni] = ng; dpGas[ni] = ngas; dpMol[ni] = nmol; dpCnt[ni] = ncnt;
            dpPrev[ni] = baseIdx; dpSpec[ni] = spec;
          }
          return;
        }
        const e = activos[pos]!, lim = objetivo[e]! - u[e]!, st = strides[e]!;
        for (let v = 0; v <= lim; v++) relajar(pos + 1, baseIdx + v * st);
      }
      relajar(0, 0);
    }
  }

  if (dpG[meta] === Infinity) return null;
  const especies: EspecieOpt[] = [];
  let energia = 0;
  let s = meta;
  while (s > 0) {
    const sp = dpSpec[s]!;
    especies.push(sp);
    energia += sp.energia;
    s = dpPrev[s]!;
  }
  return { especies, g: dpG[meta]!, gases: dpGas[meta]!, energia };
}

export interface ResultadoProductos {
  /** Coeficientes enteros de las entradas que eligió Q: [1, 0] para a sola, [p, 0] para a + a (p ≥ 2) y [p, q] para
   * a + b (p, q ≥ 1), siempre con p·|a| + q·|b| ≤ ATOMOS_POR_REACCION. */
  nu: readonly [number, number];
  productos: readonly { enlaces: Uint16Array; nu: number }[];
  dH: number;
  ea: number;
  catalisis: FamiliaCatalitica;
  /** Pares que el catalizador abre del enlace que decide `catalisis` (0 sin familia), enmienda 3. */
  paresCatalisis: 0 | 1 | 2 | 3;
}

const CONTEXTO_DEFECTO = new ContextoSolver();

/** G(E₁, gases₁) − G(E₂, gases₂) con Ts = T·S_GAS: resta de enteros más un solo producto. */
const difG = (e1: number, gas1: number, e2: number, gas2: number, Ts: number): number => (e1 - e2) - Ts * (gas1 - gas2);

const sumaAtomos = (atomos: Uint8Array): number => {
  let n = 0;
  for (let e = 0; e < NE; e++) n += atomos[e]!;
  return n;
};

/**
 * Mínimos G*(p·a + q·b) de una pareja para todos los múltiplos que caben en ATOMOS_POR_REACCION, calculados una vez y
 * compartidos por los candidatos (p, q) y por sus referencias. Las sub-estequiometrías de ≤ 8 átomos van a `ctx`.
 */
class MultiplosPareja {
  private readonly tabla = new Map<number, ParticionOptima | null>();
  constructor(
    private readonly a: Readonly<Sustancia>, private readonly b: Readonly<Sustancia> | null,
    private readonly nivelT: number, private readonly ctx: ContextoSolver,
  ) {}
  optimo(p: number, q: number): ParticionOptima | null {
    const k = p * 32 + q;
    let r = this.tabla.get(k);
    if (r === undefined) {
      const objetivo = new Uint8Array(NE);
      for (let e = 0; e < NE; e++) objetivo[e] = p * this.a.atomos[e]! + (this.b ? q * this.b.atomos[e]! : 0);
      r = minimizarParticion(objetivo, this.nivelT, this.ctx);
      this.tabla.set(k, r);
    }
    return r;
  }
}

/**
 * Productos de p·a + q·b (q = 0: p copias de a) si la reacción es irreducible: su mínimo de G gana en más de ε a todo
 * reparto en dos grupos de reactivos que reaccionen por separado, G*(p₁, q₁) + G*(p − p₁, q − q₁), incluido el de
 * cada reactivo solo (p·a y q·b; con p = 1, la unaria). Así ningún reactivo sobra como espectador y la reacción no es la
 * unión de dos más pequeñas que ya cubren otros canales. Devuelve también ΔG frente a los reactivos tal cual.
 */
function candidato(
  a: Readonly<Sustancia>, b: Readonly<Sustancia> | null, p: number, q: number, nivelT: number, m: MultiplosPareja,
): { res: ResultadoProductos; dE: number; dGas: number; atomos: number } | null {
  const T = T_NIVEL[nivelT]!, Ts = TS_NIVEL[nivelT]!;
  const opt = m.optimo(p, q);
  if (!opt) return null;
  const gasA = esGasA(a, T) ? 1 : 0, gasB = b && esGasA(b, T) ? 1 : 0;
  const eReac = p * a.energia + (b ? q * b.energia : 0), gasReac = p * gasA + q * gasB;
  // La decisión se toma con energías y cuentas de gases enteras: G = E − T·s·#gas, así que con los mismos gases la
  // comparación con ε es exacta y no la decide el redondeo de sumas de T·s.
  let eRef = eReac, gasRef = gasReac;
  for (let p1 = 0; p1 <= p; p1++) for (let q1 = 0; q1 <= q; q1++) {
    const p2 = p - p1, q2 = q - q1;
    if ((p1 === 0 && q1 === 0) || (p2 === 0 && q2 === 0)) continue;
    if (p1 * 32 + q1 > p2 * 32 + q2) continue; // cada reparto una vez
    const x = m.optimo(p1, q1), y = m.optimo(p2, q2);
    if (x && y && difG(x.energia + y.energia, x.gases + y.gases, eRef, gasRef, Ts) < 0) {
      eRef = x.energia + y.energia; gasRef = x.gases + y.gases;
    }
  }
  if (!(difG(opt.energia, opt.gases, eRef, gasRef, Ts) < -EPSILON_G)) return null;

  // Agrupar productos idénticos en orden canónico por enlaces; ninguno puede ser un reactivo (sobraría).
  const mapa = new Map<string, { enlaces: Uint16Array; nu: number }>();
  for (const sp of opt.especies) {
    const k = claveEnlaces(sp.enlaces);
    const actual = mapa.get(k);
    if (actual) actual.nu++;
    else mapa.set(k, { enlaces: sp.enlaces, nu: 1 });
  }
  const salidas = [...mapa.values()].sort((x, y) => compararEnlaces(x.enlaces, y.enlaces));
  if (salidas.some(s => compararEnlaces(s.enlaces, a.enlaces) === 0 || (b && compararEnlaces(s.enlaces, b.enlaces) === 0))) {
    return null; // no ocurre con la irreducibilidad (un reactivo intacto es el reparto (1, 0) + el resto); se comprueba igual
  }
  const entradas: EntradaSalidaEnlaces[] = b === null || q === 0
    ? [{ enlaces: a.enlaces, nu: p }]
    : [{ enlaces: a.enlaces, nu: p }, { enlaces: b.enlaces, nu: q }];
  const dH = opt.energia - eReac;
  const { ea, catalisis, paresCatalisis } = calcularCinetica(entradas, salidas, dH);
  const atomos = p * sumaAtomos(a.atomos) + (b ? q * sumaAtomos(b.atomos) : 0);
  return { res: { nu: [p, q], productos: salidas, dH, ea, catalisis, paresCatalisis }, dE: dH, dGas: opt.gases - gasReac, atomos };
}

/** ¿Baja más G por átomo `x` que `y`? Producto cruzado: entero exacto si los gases no deciden, un solo redondeo si deciden. */
function masPorAtomo(
  x: { dE: number; dGas: number; atomos: number }, y: { dE: number; dGas: number; atomos: number }, Ts: number,
): number {
  const e = x.dE * y.atomos - y.dE * x.atomos, g = x.dGas * y.atomos - y.dGas * x.atomos;
  return g === 0 ? -e : -(e - Ts * g); // > 0: x baja más G por átomo
}

/**
 * Calcula los productos de menor energía libre de `a` (si `b === null`), de `a + a` o de `a + b` al nivel de
 * temperatura `nivelT`, con los coeficientes enteros que elige Q (contrato de `Reaccion`, enmienda 1):
 * - a sola: nu 1; es reacción si su mínimo G* baja más de ε de G(a).
 * - a + a: p ≥ 2 copias; a + b: p, q ≥ 1; siempre p·|a| + q·|b| ≤ ATOMOS_POR_REACCION.
 * - De los (p, q) irreducibles (`candidato`), el de mayor −ΔG por átomo, ΔG = G*(p·a + q·b) − p·G(a) − q·G(b); a
 *   igualdad, el de menos átomos y después el de menor p. Así 2 H₂ + O₂ → 2 H₂O y CH₄ + 2 O₂ → CO₂ + 2 H₂O, y no el
 *   H₂O₂ que da 1:1 o la oxidación a medias que suelta H₂.
 */
export function productos(
  a: Readonly<Sustancia>,
  b: Readonly<Sustancia> | null,
  nivelT: number,
  ctx: ContextoSolver = CONTEXTO_DEFECTO,
): ResultadoProductos | null {
  if (!Number.isInteger(nivelT) || nivelT < 0 || nivelT >= NIVELES_T) {
    throw new RangeError(`nivelT fuera de rango [0, ${NIVELES_T}): ${nivelT}`);
  }
  const Ts = TS_NIVEL[nivelT]!;
  const misma = b !== null && compararEnlaces(a.enlaces, b.enlaces) === 0;
  const sola = b === null ? null : misma ? null : b;
  const m = new MultiplosPareja(a, sola, nivelT, ctx);
  if (b === null) return candidato(a, null, 1, 0, nivelT, m)?.res ?? null;
  const nA = sumaAtomos(a.atomos), nB = sumaAtomos(b.atomos);
  let mejor: ReturnType<typeof candidato> = null;
  const probar = (p: number, q: number) => {
    const c = candidato(a, sola, p, q, nivelT, m);
    if (!c) return;
    if (!mejor) { mejor = c; return; }
    const d = masPorAtomo(c, mejor, Ts);
    if (d > 0 || (d === 0 && c.atomos < mejor.atomos)) mejor = c; // a igualdad de átomos gana el primero: menor p
  };
  if (misma) for (let p = 2; p * nA <= ATOMOS_POR_REACCION; p++) probar(p, 0);
  else for (let p = 1; p * nA + nB <= ATOMOS_POR_REACCION; p++) {
    for (let q = 1; p * nA + q * nB <= ATOMOS_POR_REACCION; q++) probar(p, q);
  }
  return (mejor as ReturnType<typeof candidato>)?.res ?? null;
}

/** Los productos de p·a + q·b con coeficientes fijos (q = 0 con b = a o b = null: p copias de a), o null si esa
 * multiplicidad no es una reacción irreducible. Solo para pruebas y para el laboratorio: `productos` elige (p, q). */
export function productosCon(
  a: Readonly<Sustancia>, b: Readonly<Sustancia> | null, p: number, q: number, nivelT: number,
  ctx: ContextoSolver = CONTEXTO_DEFECTO,
): ResultadoProductos | null {
  const misma = b !== null && compararEnlaces(a.enlaces, b.enlaces) === 0;
  const sola = b === null || misma ? null : b;
  return candidato(a, sola, p, sola ? q : 0, nivelT, new MultiplosPareja(a, sola, nivelT, ctx))?.res ?? null;
}
