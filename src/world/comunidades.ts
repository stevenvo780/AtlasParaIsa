/**
 * Comunidades como red de vínculos, por lado (V23, carril s; interruptor `v23.comunidades`). Sustituye a los pasos
 * heredados `convivir` y `comunidades`, que siguen en `society.ts` para cuando la ley está apagada.
 *
 * - El vínculo `bonds[j]` de una persona es lo que ELLA sabe de `j`: el promedio móvil, con memoria `TAU_VINCULO` días,
 *   de la fracción de su tiempo pasada a ≤ `RADIO_CONVIVENCIA_CELDAS` de `j`. Cada tick: v ← v·e^(−1/(τ·2400)) y, si
 *   `j` está cerca, + (1 − e^(−1/(τ·2400))). Lo escribe solo el dueño de la persona (F5), leyendo a los demás en el
 *   frente; como los dos extremos leen el mismo frente, la convivencia es simétrica sin mensajes.
 * - El vínculo decae en cada tick (no guarda marca de tiempo): `bonds` sigue siendo `Record<string, number>` y lo
 *   leen tal cual la natalidad, la persistencia y el cliente; con marca `{v, t}` habría que migrar todos esos lectores
 *   a cambio de ahorrar una multiplicación por arista y tick.
 * - Comunidad = componente conexa de los vínculos MUTUOS ≥ `THETA_VINCULO` CERRADOS (ver `componentes`) con al menos
 *   `MORTALES_COMUNIDAD` mortales. Se recalcula en F0 en cada tick; la identidad pasa a la comunidad previa de mayor
 *   solape |C∩P| / máx(|C|, |P|) si llega a `SOLAPE_IDENTIDAD`. Sin tope de comunidades ni umbrales de salida.
 */
import { deserialize, serialize } from 'node:v8';
import { MORTALES_COMUNIDAD, RADIO_CONVIVENCIA_CELDAS, SOLAPE_IDENTIDAD, TAU_VINCULO, THETA_VINCULO, VINCULO_MINIMO } from '../shared/naturaleza.js';
import type { ChronicleEvent, CommunityView } from '../shared/types.js';
import { TICKS_PER_DAY, type Person } from './mundo/tipos.js';
import type { Aplicado, CtxF0, CtxLey, Ley } from './motor/acceso.js';
import { Clase, genDe, REF_NULA, slotDe, type Intento } from './motor/contratos.js';
import { cercanos } from './motor/vecinos.js';
import { afectar, aplicarEfectoSocial, colorDeComunidad, datoAEfecto, nombreDeComunidad } from './society.js';

/** celdas: distancia de convivencia; vive en `shared/naturaleza.ts` (integrador) y se reexporta aquí. */
export { RADIO_CONVIVENCIA_CELDAS };
/** Fracción que queda de un vínculo tras un tick sin contacto: e^(−1/(τ·ticks por día)). Derivada, no constante. */
export const RETENCION_TICK = Math.exp(-1 / (TAU_VINCULO * TICKS_PER_DAY));

type Suceso = Omit<ChronicleEvent, 'id' | 'tick'>;

// ── Un lado ──────────────────────────────────────────────────────────────────────────────────────────────

/** Un tick del lado de una persona: decae todo lo que sabe y suma el tick a quienes tiene cerca (`cerca`, por id).
 * Un vínculo recién empezado vale menos que `VINCULO_MINIMO`: solo se borra el que ya no se refuerza. */
export function actualizarLado(bonds: Record<string, number>, cerca: ReadonlySet<string>): void {
  for (const id in bonds) {
    const v = bonds[id]! * RETENCION_TICK;
    if (v < VINCULO_MINIMO && !cerca.has(id)) delete bonds[id]; else bonds[id] = v;
  }
  const atencion = 1 - RETENCION_TICK;
  for (const id of cerca) bonds[id] = (bonds[id] ?? 0) + atencion;
}

/**
 * Lo que vivió un recién nacido antes de nacer. El vínculo estima la FRACCIÓN de su tiempo que una persona pasó junto a
 * otra; para quien existe desde hace menos que la memoria τ, el estimador sin sesgo es la fracción de su propia vida
 * (como la corrección de sesgo de un promedio móvil que arranca en 0). Durante la gestación el embrión estuvo siempre en
 * la celda de quien lo gestó: su fracción con ella es 1, y con cualquier otro es la de ella (estaban donde estaba ella).
 * Devuelve el lado inicial del recién nacido; quien lo gestó y sus allegados suben el suyo con `copia` (ver
 * `EfectoSocial.copia`): su tiempo con el embrión fue su tiempo con ella. Sin constantes nuevas.
 */
export function ladoDeRecienNacido(gestante: { id: string; bonds: Readonly<Record<string, number>> } | undefined,
  gestanteId: string, propioId: string): Record<string, number> {
  const lado: Record<string, number> = {};
  if (gestante) for (const id in gestante.bonds) {
    const v = gestante.bonds[id]!;
    if (id !== propioId && v >= VINCULO_MINIMO) lado[id] = v;
  }
  lado[gestanteId] = 1;
  return lado;
}

// ── Lo que cada dueño manda a F0 ─────────────────────────────────────────────────────────────────────────

/** Una persona vista por F0: quién es, si es mortal, dónde está, su cultura y los uid hacia los que su lado ≥ θ. */
export interface RegistroPersona {
  uid: number; id: string; nombre: string; mortal: boolean; x: number; y: number;
  cultura: readonly [sharing: number, stewardship: number, openness: number];
  fuertes: readonly number[];
}

/** Cabecera de cada persona en el bloque numérico: uid, mortal, x, y, tres de cultura y el grado. */
const CABECERA = 8;

export function codificarRegistros(registros: readonly RegistroPersona[]): Uint8Array {
  let largo = 0;
  for (const r of registros) largo += CABECERA + r.fuertes.length;
  const f = new Float64Array(largo), s: string[] = [];
  let k = 0;
  for (const r of registros) {
    f[k++] = r.uid; f[k++] = r.mortal ? 1 : 0; f[k++] = r.x; f[k++] = r.y;
    f[k++] = r.cultura[0]; f[k++] = r.cultura[1]; f[k++] = r.cultura[2]; f[k++] = r.fuertes.length;
    for (const u of r.fuertes) f[k++] = u;
    s.push(r.id, r.nombre);
  }
  return serialize({ f, s });
}

export function decodificarRegistros(bytes: Uint8Array): RegistroPersona[] {
  const { f, s } = deserialize(bytes) as { f: Float64Array; s: string[] };
  const salida: RegistroPersona[] = [];
  for (let k = 0, n = 0; k < f.length; n++) {
    const grado = f[k + 7]!;
    salida.push({ uid: f[k]!, mortal: f[k + 1] === 1, x: f[k + 2]!, y: f[k + 3]!, cultura: [f[k + 4]!, f[k + 5]!, f[k + 6]!],
      fuertes: Array.from(f.subarray(k + CABECERA, k + CABECERA + grado)), id: s[2 * n]!, nombre: s[2 * n + 1]! });
    k += CABECERA + grado;
  }
  return salida;
}

// ── Componentes ──────────────────────────────────────────────────────────────────────────────────────────

/** Una componente con sus miembros (posiciones en los registros) y cuántos son mortales. */
export interface Componente { miembros: number[]; mortales: number; }

/**
 * Componentes de la red de vínculos mutuos ≥ θ, contando solo los vínculos CERRADOS: los dos extremos comparten al
 * menos un tercero con quien ambos tienen vínculo mutuo ≥ θ (la tríada de Simmel; en grafos, el 3-truss).
 *
 * Por qué (el freno a las comunidades-cadena dispersas): un vínculo mide el tiempo que dos personas pasaron juntas, y
 * una cadena A–B–C–…–Z de vínculos sueltos solo dice que cada cual convivió con el siguiente, no que A y Z compartan
 * nada: es una red de conocidos, no una comunidad. Lo que hace comunidad es que la gente con la que convives conviva
 * también entre sí; un vínculo sin tercero común es un puente entre grupos (un vínculo débil de Granovetter), que existe y
 * cuenta para la natalidad, pero no funde a los dos grupos. La tríada es además la comunidad mínima que ya define
 * `MORTALES_COMUNIDAD` = 3, así que el freno no añade constantes. Basta una pasada: quitar un vínculo que no está en
 * ningún triángulo no rompe ningún triángulo.
 *
 * Coste: O(P + Σ grados + Σ_aristas mín(grado)). Unión-búsqueda con compresión por mitades.
 */
export function componentes(registros: readonly RegistroPersona[]): Componente[] {
  const n = registros.length, indice = new Map<number, number>();
  for (let i = 0; i < n; i++) indice.set(registros[i]!.uid, i);
  const fuertes = registros.map(r => new Set(r.fuertes));
  const vecinos: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (const u of registros[i]!.fuertes) {
    const j = indice.get(u);
    if (j !== undefined && j > i && fuertes[j]!.has(registros[i]!.uid)) { vecinos[i]!.push(j); vecinos[j]!.push(i); }
  }
  const conjuntos = vecinos.map(v => new Set(v));
  const padre = new Int32Array(n);
  for (let i = 0; i < n; i++) padre[i] = i;
  const raiz = (i: number): number => { while (padre[i] !== i) { padre[i] = padre[padre[i]!]!; i = padre[i]!; } return i; };
  for (let i = 0; i < n; i++) for (const j of vecinos[i]!) {
    if (j <= i) continue;
    const [corta, larga] = vecinos[i]!.length <= vecinos[j]!.length ? [vecinos[i]!, conjuntos[j]!] : [vecinos[j]!, conjuntos[i]!];
    let cerrado = false;
    for (const w of corta) if (w !== i && w !== j && larga.has(w)) { cerrado = true; break; }
    if (!cerrado) continue;
    const ri = raiz(i), rj = raiz(j);
    if (ri !== rj) padre[Math.max(ri, rj)] = Math.min(ri, rj);
  }
  const porRaiz = new Map<number, Componente>();
  for (let i = 0; i < n; i++) {
    const r = raiz(i);
    let c = porRaiz.get(r);
    if (!c) porRaiz.set(r, c = { miembros: [], mortales: 0 });
    c.miembros.push(i);
    if (registros[i]!.mortal) c.mortales++;
  }
  return [...porRaiz.values()].filter(c => c.miembros.length >= MORTALES_COMUNIDAD && c.mortales >= MORTALES_COMUNIDAD);
}

// ── Identidad, sucesos y asignación ──────────────────────────────────────────────────────────────────────

export interface ResultadoComunidades {
  /** Las comunidades de este tick: las previas que conservan identidad (mismo objeto, con su historia) y las nuevas. */
  comunidades: CommunityView[];
  sucesos: Suceso[];
  /** id de persona → id de comunidad, para quien queda en alguna. */
  asignacion: Map<string, string>;
}

/** Lista legible de nombres: los primeros `max` y cuántos más. */
const nombres = (rs: readonly RegistroPersona[], max = 4) =>
  rs.slice(0, max).map(r => r.nombre).join(', ') + (rs.length > max ? ` y ${rs.length - max} más` : '');

/** Actores de un suceso: hasta 4, al menos 2 cuando los hay (el cliente dibuja la red con pares de actores). */
function actores(primero: readonly string[], relleno: readonly string[]): string[] {
  const salida = primero.slice(0, 4);
  for (const id of relleno) { if (salida.length >= 2) break; if (!salida.includes(id)) salida.push(id); }
  return salida;
}

/**
 * Comunidades de este tick a partir de los registros de todos los dueños y de las comunidades previas (la réplica
 * global). Pura salvo que muta las comunidades previas que conservan identidad (miembros, cultura, centro y
 * contadores sumados en una fusión). `nuevoNumero` da el número monótono de cada comunidad nueva.
 */
export function armarComunidades(registros: readonly RegistroPersona[], previas: readonly CommunityView[], tick: number,
  nuevoNumero: () => number): ResultadoComunidades {
  const comps = componentes(registros);
  const previasPorId = new Map<string, CommunityView>();
  const etiquetaPrevia = new Map<string, string>();
  for (const g of previas) { previasPorId.set(g.id, g); for (const m of g.members) etiquetaPrevia.set(m, g.id); }
  const etiqueta = (r: RegistroPersona) => etiquetaPrevia.get(r.id);
  const vivos = new Map<string, number>();
  const vivosDe = new Map<string, RegistroPersona[]>();
  for (const r of registros) {
    const id = etiqueta(r);
    if (id === undefined) continue;
    vivos.set(id, (vivos.get(id) ?? 0) + 1);
    let lista = vivosDe.get(id);
    if (!lista) vivosDe.set(id, lista = []);
    lista.push(r);
  }

  // Cuántos miembros de cada comunidad previa hay en cada componente, y reparto de identidades por solape.
  const procedencia = comps.map(c => {
    const cuenta = new Map<string, number>();
    for (const i of c.miembros) { const id = etiqueta(registros[i]!); if (id !== undefined) cuenta.set(id, (cuenta.get(id) ?? 0) + 1); }
    return cuenta;
  });
  const ofertas: { k: number; previa: CommunityView; solape: number }[] = [];
  procedencia.forEach((cuenta, k) => {
    for (const [id, comunes] of cuenta) {
      const solape = comunes / Math.max(comps[k]!.miembros.length, vivos.get(id)!);
      if (solape >= SOLAPE_IDENTIDAD) ofertas.push({ k, previa: previasPorId.get(id)!, solape });
    }
  });
  ofertas.sort((x, y) => y.solape - x.solape || x.previa.formedAt - y.previa.formedAt || (x.previa.id < y.previa.id ? -1 : 1));
  const heredada = new Map<number, CommunityView>(), conservadas = new Set<string>();
  for (const o of ofertas) {
    if (heredada.has(o.k) || conservadas.has(o.previa.id)) continue;
    heredada.set(o.k, o.previa); conservadas.add(o.previa.id);
  }
  const nuevas: CommunityView[] = [];
  const grupos = comps.map((c, k) => {
    const previa = heredada.get(k);
    if (previa) return previa;
    const numero = nuevoNumero(), id = `community-${numero}`, fundador = registros[c.miembros[0]!]!;
    const group: CommunityView = { id, name: nombreDeComunidad(numero), x: Math.round(fundador.x), y: Math.round(fundador.y), members: [],
      color: colorDeComunidad(numero), culture: { sharing: fundador.cultura[0], stewardship: fundador.cultura[1], openness: fundador.cultura[2] },
      formedAt: tick, cooperation: 0, disputes: 0 };
    nuevas.push(group);
    return group;
  });
  const de = (ids: readonly number[]) => ids.map(i => registros[i]!);

  // Qué le pasó a cada comunidad previa: conserva una componente, se funde en otra que ya tenía la suya, se parte (lo
  // cuentan las componentes nuevas que salen de ella) o se disuelve. Se decide antes de reasignar a nadie.
  const sucesos: Suceso[] = [];
  const separadasDe = new Map<CommunityView, string>();
  for (const group of nuevas) {
    const k = grupos.indexOf(group);
    let madre: string | undefined, comunes = 0;
    for (const [id, m] of procedencia[k]!) if (m > comunes) { madre = id; comunes = m; }
    if (madre !== undefined && comunes * 2 > comps[k]!.miembros.length) separadasDe.set(group, madre);
  }
  const separadas = new Set(separadasDe.values());
  for (const [id, previa] of previasPorId) {
    if (conservadas.has(id)) continue;
    let mejor = -1, comunes = 0;
    procedencia.forEach((cuenta, k) => { const m = cuenta.get(id) ?? 0; if (m > comunes) { comunes = m; mejor = k; } });
    const quedan = vivos.get(id) ?? 0;
    if (quedan > 0 && mejor >= 0 && heredada.has(mejor) && comunes * 2 >= quedan) {
      const destino = grupos[mejor]!;
      destino.cooperation += previa.cooperation; destino.disputes += previa.disputes;
      const aportados = de(comps[mejor]!.miembros.filter(i => etiqueta(registros[i]!) === id));
      const acogen = de(comps[mejor]!.miembros.filter(i => etiqueta(registros[i]!) !== id));
      sucesos.push({ kind: 'community', actors: actores(aportados.map(r => r.id), acogen.map(r => r.id)), x: destino.x, y: destino.y, source: 'simulation',
        text: `${previa.name} se fundió con ${destino.name}.`,
        cause: `Los vínculos de ${nombres(aportados)} con el resto de ${destino.name} llegaron a ${THETA_VINCULO} y se cerraron en tríadas: las dos redes son ahora una sola.` });
    } else if (!separadas.has(id)) {
      const restantes = vivosDe.get(id) ?? [];
      sucesos.push({ kind: 'community', actors: actores(restantes.map(r => r.id), previa.members), x: previa.x, y: previa.y, source: 'simulation',
        text: restantes.length ? `${previa.name} se disolvió; quedan sin comunidad ${nombres(restantes)}.` : `${previa.name} se disolvió.`,
        cause: restantes.length
          ? `Sus vínculos mutuos decayeron por debajo de ${THETA_VINCULO} (memoria de ${TAU_VINCULO} días) y ya no queda una red cerrada con ${MORTALES_COMUNIDAD} mortales.`
          : 'Ya no vive ninguno de sus miembros.' });
    }
  }
  for (const group of nuevas) {
    const c = comps[grupos.indexOf(group)]!, integrantes = de(c.miembros), madre = separadasDe.get(group);
    let causa = `Sus vínculos mutuos ≥ ${THETA_VINCULO}, sostenidos por convivir y cerrados en tríadas, forman una red con ${c.mortales} mortales.`;
    if (madre !== undefined) {
      const dentro = new Set(integrantes.map(r => r.id));
      const resto = (vivosDe.get(madre) ?? []).filter(r => !dentro.has(r.id));
      causa = `Se cortó la red de vínculos entre ${nombres(integrantes, 2)} y ${resto.length ? nombres(resto, 2) : 'el resto de su comunidad'}: ya no los une ningún camino de vínculos mutuos ≥ ${THETA_VINCULO} cerrados.`;
    }
    sucesos.push({ kind: 'community', actors: actores(integrantes.map(r => r.id), []), x: group.x, y: group.y, source: 'simulation',
      text: madre !== undefined ? `${group.name} se separó de ${previasPorId.get(madre)!.name} entre ${nombres(integrantes)}.` : `${group.name} tomó forma entre ${nombres(integrantes)}.`,
      cause: causa });
  }

  const asignacion = new Map<string, string>();
  comps.forEach((c, k) => {
    const group = grupos[k]!, m = c.miembros.length;
    // La lista de miembros solo se rehace si cambió: casi siempre es la misma que en el tick anterior.
    let igual = group.members.length === m;
    let sharing = 0, stewardship = 0, openness = 0, sx = 0, sy = 0;
    for (const i of c.miembros) {
      const r = registros[i]!;
      asignacion.set(r.id, group.id);
      if (igual && etiqueta(r) !== group.id) igual = false;
      sharing += r.cultura[0]; stewardship += r.cultura[1]; openness += r.cultura[2]; sx += r.x; sy += r.y;
    }
    if (!igual) group.members = c.miembros.map(i => registros[i]!.id).sort();
    group.memberCount = m;
    group.culture = { sharing: sharing / m, stewardship: stewardship / m, openness: openness / m };
    group.x = Math.round(sx / m); group.y = Math.round(sy / m);
  });
  return { comunidades: [...previas.filter(g => conservadas.has(g.id)), ...nuevas], sucesos, asignacion };
}

// ── La ley ───────────────────────────────────────────────────────────────────────────────────────────────

/** Persona propia por uid, o `undefined` si no vive o la tiene otro dueño. */
function propia(c: CtxLey, uid: number): Person | undefined {
  if (!(uid > 0)) return undefined;
  const r = c.ref(uid);
  if (r === REF_NULA) return undefined;
  const p = c.personas.get(slotDe(r));
  return p && p.uid === uid ? p : undefined;
}

/** Posición de una persona propia en el frente (la que ven los demás este tick), o la de su objeto si aún no está. */
function posicion(c: CtxLey, p: Person): { x: number; y: number; enFrente: boolean } {
  const r = p.uid === undefined ? REF_NULA : c.ref(p.uid);
  if (r === REF_NULA) return { x: p.x, y: p.y, enFrente: false };
  const s = slotDe(r);
  return { x: c.frente.x[s]!, y: c.frente.y[s]!, enFrente: true };
}

/**
 * Un recién nacido de menos de un día que aún no tiene lado hacia quien lo gestó arranca con lo que vivió en la
 * gestación (`ladoDeRecienNacido`). Quien lo gestó es, de sus dos progenitores vivos, el más cercano a él. Espera a
 * que su fila esté en el frente: sin `Ref` propia sus intentos no tendrían emisor.
 */
function sembrarRecienNacido(c: CtxLey, p: Person, x: number, y: number): void {
  const padres = p.genome.parents;
  if (padres.length !== 2 || c.tick - p.bornAt >= TICKS_PER_DAY || p.uid === undefined) return;
  if (padres.some(id => p.bonds[id] !== undefined && p.bonds[id]! >= THETA_VINCULO)) return;
  let gestanteId: string | undefined, uidGestante = 0, mejor = Infinity;
  for (const id of padres) {
    const uid = c.uidDe(id), r = uid > 0 ? c.ref(uid) : REF_NULA;
    if (r === REF_NULA) continue;
    const s = slotDe(r), d2 = (c.frente.x[s]! - x) ** 2 + (c.frente.y[s]! - y) ** 2;
    if (d2 < mejor) { mejor = d2; gestanteId = id; uidGestante = uid; }
  }
  if (gestanteId === undefined) return;
  const gestante = propia(c, uidGestante);
  Object.assign(p.bonds, ladoDeRecienNacido(gestante, gestanteId, p.id));
  // El otro lado: quien lo gestó estuvo con él siempre; sus allegados, lo que estuvieron con ella.
  afectar(c.mundo, p, gestante, uidGestante, { copia: gestanteId });
  if (gestante) for (const id in gestante.bonds) {
    if (id === p.id || gestante.bonds[id]! < THETA_VINCULO) continue;
    const uid = c.uidDe(id);
    if (uid > 0) afectar(c.mundo, p, propia(c, uid), uid, { copia: gestanteId });
  }
}

/** F5: cada dueño pone al día el lado de sus personas y manda a F0 sus aristas ≥ θ. */
function convivirPorLado(c: CtxLey): void {
  const fr = c.frente, registros: RegistroPersona[] = [], cerca = new Set<string>();
  for (const p of c.mundo.people) {
    const { x, y, enFrente } = posicion(c, p);
    if (enFrente) sembrarRecienNacido(c, p, x, y);
    cerca.clear();
    cercanos(c, x, y, RADIO_CONVIVENCIA_CELDAS, Clase.Persona, slot => {
      const uid = fr.uid[slot]!;
      if (uid === p.uid) return;
      const id = c.idDe(uid);
      if (id !== undefined && id !== p.id) cerca.add(id);
    });
    actualizarLado(p.bonds, cerca);
    if (p.uid === undefined) continue;
    const fuertes: number[] = [];
    for (const id in p.bonds) if (p.bonds[id]! >= THETA_VINCULO) { const uid = c.uidDe(id); if (uid > 0) fuertes.push(uid); }
    registros.push({ uid: p.uid, id: p.id, nombre: p.name, mortal: p.role === 'neighbor', x, y,
      cultura: [p.culture.sharing, p.culture.stewardship, p.culture.openness], fuertes });
  }
  // Se manda aunque esté vacío: F0 distingue «nadie tiene vínculos» de «aún no llegó nada» (primer tick de la ley).
  c.pedirGlobal('comunidad', codificarRegistros(registros));
}

/** F0: junta los registros de todos los dueños, arma las comunidades y las publica. */
function comunidadesGlobales(c: CtxF0): void {
  if (!c.mundo.cooperationEnabled) return;
  const lotes = c.peticiones('comunidad');
  if (!lotes.length) return;
  const registros: RegistroPersona[] = [];
  for (const bytes of lotes) for (const r of decodificarRegistros(bytes)) registros.push(r);
  const mundo = c.mundo;
  // Salta los números que el mundo ya usó. Se compara con el contador de ANTES de pedir: con un dueño, `c.id`
  // incrementa `mundo.communityCounter` en sitio y comparar con el actual no terminaría nunca.
  const nuevoNumero = () => {
    const usado = mundo.communityCounter;
    let n = c.id('comunidad');
    while (n <= usado) n = c.id('comunidad');
    mundo.communityCounter = n;
    return n;
  };
  const r = armarComunidades(registros, [...c.globales.comunidades.values()], c.tick, nuevoNumero);
  for (const e of r.sucesos) c.suceso(e);
  mundo.communities = r.comunidades;
  c.publicarComunidades(r.comunidades);
}

/** Por réplica y versión: si el motor sustituye el mapa o lo cambia en sitio, la versión de `globales` lo delata. */
const asignaciones = new WeakMap<ReadonlyMap<string, CommunityView>, { version: number; asignacion: Map<string, string> }>();

/** F1: cada dueño pone a sus personas la comunidad que F0 publicó. */
function asignarComunidad(c: CtxLey): void {
  if (!c.mundo.cooperationEnabled) return;
  const globales = c.globales.comunidades;
  let cache = asignaciones.get(globales);
  if (!cache || cache.version !== c.globales.version) {
    const asignacion = new Map<string, string>();
    for (const g of globales.values()) for (const m of g.members) asignacion.set(m, g.id);
    asignaciones.set(globales, cache = { version: c.globales.version, asignacion });
  }
  const asignacion = cache.asignacion;
  for (const p of c.mundo.people) p.communityId = asignacion.get(p.id) ?? null;
}

/** Vincular en el dueño del receptor: sube solo SU lado hacia el emisor (y lo demás que trae el acto social). */
function aplicarVincular(c: CtxLey, i: Intento): Aplicado {
  const receptor = c.personas.get(slotDe(i.a));
  if (!receptor || receptor.uid === undefined || c.ref(receptor.uid) !== i.a) return 'paso';
  if (i.de === REF_NULA) return 'hecho';
  const s = slotDe(i.de);
  if (c.frente.gen[s] !== genDe(i.de)) return 'hecho'; // el emisor ya no existe: no hay a quién vincularse
  const emisorId = c.idDe(c.frente.uid[s]!);
  if (emisorId === undefined || emisorId === receptor.id) return 'hecho';
  aplicarEfectoSocial(c.mundo, receptor, emisorId, datoAEfecto(i.dato, i.bytes), c.tick);
  return 'hecho';
}

export const leyComunidades: Ley = {
  id: 's', interruptor: 'comunidades', sustituye: ['convivir', 'comunidades'],
  F0: comunidadesGlobales,
  F1: asignarComunidad,
  F5: convivirPorLado,
  aplicar: { Vincular: aplicarVincular },
};
