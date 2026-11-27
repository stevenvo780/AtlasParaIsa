/**
 * Panel «Materia» (V23, carril vfichas): dónde están los átomos del mundo, cuánta energía hay en cada compartimento,
 * las cuentas de fuentes y sumideros, las sustancias que han aparecido y una luz que dice si el libro cuadra.
 *
 * La fuente es `WorldView.materia` (`MateriaMundoVisible`, shared/vistas-v23.ts). Las cantidades llegan como texto
 * decimal porque la suma del mundo puede pasar de 2⁵³: aquí se leen como `bigint` y solo se convierten a `number`
 * para las proporciones. Un mundo sin la ley no trae `materia`: el panel dice «sin dato», nunca dibuja un cero.
 */
import type { MateriaMundoVisible, SustanciasVisibles } from '../shared/vistas-v23.js';
import type { SustanciaVista } from '../shared/materia.js';
import { ELEMENTOS, NE } from '../shared/naturaleza.js';
import type { LuzSalud } from './panel-motor.js';
import { sparkline } from './charts.js';
import { fichaReaccion, formulaDe, nombreDerivado, sustanciaPorId } from './inspector-view.js';
import type { ReaccionObservada } from '../shared/reaccion-observada.js';
import { COLOR_ELEMENTO, NOMBRE_ELEMENTO, esc, number } from './ui-catalog.js';

const TICKS_POR_DIA = 2400;
/** Muestras que el navegador guarda del reparto para dibujar el ciclo (memoria del cliente, no física del mundo). */
export const MUESTRAS_CICLO = 120;
/** Paleta de los compartimentos, en el orden en que los manda el servidor; se repite si hay más. */
const COLORES_COMPARTIMENTO = ['#7a6a58', '#8c8a4a', '#5f8fa3', '#c9d6dc', '#486750', '#a5584a', '#b07a3c', '#6f5f8f', '#9a6b7c', '#3f6f8a'];

/** Entero decimal de la vista; null si el texto no lo es. */
export function leerEntero(texto: unknown): bigint | null {
  if (typeof texto !== 'string' || !/^-?\d+$/.test(texto)) return null;
  return BigInt(texto);
}

/** Cantidad grande legible: entera hasta un millón; luego mantisa·10ⁿ con 3 cifras. Nunca pasa por `number` si no cabe. */
export function cantidadCompacta(v: bigint): string {
  const negativo = v < 0n, abs = negativo ? -v : v;
  const signo = negativo ? '−' : '';
  if (abs < 1_000_000n) return `${signo}${number(Number(abs))}`;
  const digitos = abs.toString(), exponente = digitos.length - 1;
  const mantisa = `${digitos[0]},${digitos.slice(1, 3)}`;
  const sup = String(exponente).split('').map(d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('');
  return `${signo}${mantisa}·10${sup}`;
}

/** Proporción a / total en [0, 1] con 4 decimales exactos, sin pasar por `number` los operandos. */
export function proporcion(a: bigint, total: bigint): number {
  if (total <= 0n || a <= 0n) return 0;
  return Math.min(1, Number(a * 10_000n / total) / 10_000);
}

export interface FilaCompartimento {
  nombre: string;
  atomos: bigint[];
  total: bigint;
  energia: bigint | null;
}
export interface CuentaMateria { nombre: string; valor: bigint }
export interface SustanciaAparecida { id: number; masa: number; desde: number }
export interface VistaMateria {
  tick: number;
  filas: FilaCompartimento[];
  /** Total por elemento sobre todos los compartimentos. */
  porElemento: bigint[];
  cuentas: CuentaMateria[];
  sustancias: SustanciaAparecida[];
  conserva: boolean;
}

/** Acepta solo una vista coherente: una fila de NE átomos por compartimento, una energía por compartimento, enteros decimales. */
export function leerMateria(m: MateriaMundoVisible | undefined | null): VistaMateria | null {
  if (!m || typeof m !== 'object' || !Number.isFinite(m.tick)) return null;
  const { compartimentos, atomos, energia } = m;
  if (!Array.isArray(compartimentos) || !Array.isArray(atomos) || atomos.length !== compartimentos.length) return null;
  const filas: FilaCompartimento[] = [];
  const porElemento: bigint[] = Array.from({ length: NE }, () => 0n);
  for (let i = 0; i < compartimentos.length; i++) {
    const fila = atomos[i];
    if (!Array.isArray(fila) || fila.length !== NE) return null;
    const valores: bigint[] = [];
    for (const t of fila) { const v = leerEntero(t); if (v === null) return null; valores.push(v); }
    valores.forEach((v, e) => { porElemento[e]! += v; });
    // La energía puede faltar en un servidor viejo: esa columna dice «sin dato» y el resto sigue.
    const j = Array.isArray(energia) && energia.length === compartimentos.length ? leerEntero(energia[i]) : null;
    filas.push({ nombre: String(compartimentos[i]), atomos: valores, total: valores.reduce((a, b) => a + b, 0n), energia: j });
  }
  const cuentas: CuentaMateria[] = [];
  for (const [nombre, texto] of Object.entries(m.cuentas ?? {})) { const v = leerEntero(texto); if (v !== null) cuentas.push({ nombre, valor: v }); }
  cuentas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  const sustancias = (Array.isArray(m.sustancias) ? m.sustancias : []).filter(s => Number.isFinite(s.id) && Number.isFinite(s.masa) && Number.isFinite(s.desde));
  return { tick: m.tick, filas, porElemento, cuentas, sustancias, conserva: m.conserva === true };
}

/** Parte de cada elemento que está en cada compartimento: `reparto[e][c]` en [0, 1]; suma 1 por elemento si hay átomos. */
export function repartoPorElemento(v: VistaMateria): number[][] {
  return ELEMENTOS.map((_, e) => v.filas.map(f => proporcion(f.atomos[e]!, v.porElemento[e]!)));
}

/** Energía total del mundo (suma de las filas que traen dato) y si falta alguna. */
export function energiaTotal(v: VistaMateria): { total: bigint; completa: boolean } {
  let total = 0n, completa = true;
  for (const f of v.filas) { if (f.energia === null) completa = false; else total += f.energia; }
  return { total, completa };
}

/** Luz del libro: sana si cuadra (I1, I2), grave si no. Sin materia, «sin dato». */
export function luzMateria(v: VistaMateria | null): LuzSalud {
  if (!v) return { estado: 'sin-dato', valor: 'sin dato', motivo: 'Este mundo no trae el libro de la materia.' };
  return v.conserva
    ? { estado: 'sano', valor: 'cuadra', motivo: 'El libro cuadra: los átomos de los lotes y los que van en vuelo suman lo inicial más las fuentes menos los sumideros.' }
    : { estado: 'grave', valor: 'no cuadra', motivo: 'El libro no cuadra: se creó o se perdió materia fuera de una fuente o un sumidero declarados.' };
}

/** Historia del reparto que guarda el navegador: una muestra por tick distinto de la vista, como máximo `MUESTRAS_CICLO`. */
export interface CicloMateria { ticks: number[]; reparto: number[][][] /* muestra → elemento → compartimento */; compartimentos: string[] }
export const cicloVacio = (): CicloMateria => ({ ticks: [], reparto: [], compartimentos: [] });

/** Añade la muestra de `v`; si cambian los compartimentos, la historia empieza de nuevo (las columnas ya no casan). Devuelve el mismo objeto. */
export function anotarCiclo(c: CicloMateria, v: VistaMateria, max = MUESTRAS_CICLO): CicloMateria {
  const nombres = v.filas.map(f => f.nombre);
  if (c.compartimentos.length !== nombres.length || c.compartimentos.some((n, i) => n !== nombres[i])) { c.ticks.length = 0; c.reparto.length = 0; c.compartimentos = nombres; }
  if (c.ticks.length && v.tick <= c.ticks[c.ticks.length - 1]!) {
    if (v.tick < c.ticks[c.ticks.length - 1]!) { c.ticks.length = 0; c.reparto.length = 0; } else return c;
  }
  c.ticks.push(v.tick); c.reparto.push(repartoPorElemento(v));
  while (c.ticks.length > max) { c.ticks.shift(); c.reparto.shift(); }
  return c;
}

/** Del ciclo de un elemento, el compartimento cuya parte más se movió y la serie de esa parte. Null con menos de 2 muestras. */
export function compartimentoQueSeMueve(c: CicloMateria, e: number): { compartimento: string; serie: { tick: number; value: number }[]; rango: number } | null {
  if (c.ticks.length < 2) return null;
  let mejor = -1, mejorRango = -1;
  for (let k = 0; k < c.compartimentos.length; k++) {
    let min = Infinity, max = -Infinity;
    for (const m of c.reparto) { const x = m[e]?.[k]; if (x === undefined) continue; if (x < min) min = x; if (x > max) max = x; }
    if (max - min > mejorRango) { mejorRango = max - min; mejor = k; }
  }
  if (mejor < 0) return null;
  return { compartimento: c.compartimentos[mejor]!, rango: mejorRango, serie: c.ticks.map((tick, i) => ({ tick, value: c.reparto[i]![e]![mejor]! })) };
}

const sinDato = '<em class="sin-dato">sin dato</em>';
const colorDe = (i: number): string => COLORES_COMPARTIMENTO[i % COLORES_COMPARTIMENTO.length]!;
const dias = (pasos: number): string => `${number(pasos / TICKS_POR_DIA, 1)} ${Math.abs(pasos / TICKS_POR_DIA - 1) < .05 ? 'día' : 'días'}`;

function cabecera(v: VistaMateria | null, luz: LuzSalud): string {
  return `<div class="stats-section-heading"><h3>Materia</h3><span>${v ? `libro del paso ${esc(number(v.tick))}` : 'sin libro'}</span></div><p class="materia-luz" data-estado="${luz.estado}" data-materia-luz><i class="materia-led" aria-hidden="true"></i><strong>${esc(luz.valor)}</strong> ${esc(luz.motivo)}</p>`;
}

/** Una barra por elemento, partida entre compartimentos con el color de cada uno. */
function repartoMarkup(v: VistaMateria): string {
  const reparto = repartoPorElemento(v);
  const filas = ELEMENTOS.map((simbolo, e) => {
    if (v.porElemento[e]! <= 0n) return `<li data-elemento="${simbolo}"><span class="materia-elemento"><i style="background:${COLOR_ELEMENTO[e]}" aria-hidden="true"></i>${esc(simbolo)}</span><em class="sin-dato">sin átomos</em></li>`;
    const trozos = v.filas.map((f, c) => reparto[e]![c]! > 0 ? `<span style="flex:${(reparto[e]![c]! * 1000).toFixed(0)} 1 0;background:${colorDe(c)}" title="${esc(`${f.nombre} · ${number(reparto[e]![c]! * 100, 1)} %`)}"></span>` : '').join('');
    const texto = v.filas.map((f, c) => `${f.nombre} ${number(reparto[e]![c]! * 100, 1)} %`).join(' · ');
    return `<li data-elemento="${simbolo}"><span class="materia-elemento" title="${esc(NOMBRE_ELEMENTO[e]!)}"><i style="background:${COLOR_ELEMENTO[e]}" aria-hidden="true"></i>${esc(simbolo)}</span><span class="materia-barra" role="img" aria-label="${esc(`${NOMBRE_ELEMENTO[e]}: ${texto}`)}">${trozos}</span><small>${esc(cantidadCompacta(v.porElemento[e]!))} mmol</small></li>`;
  }).join('');
  const leyenda = v.filas.map((f, c) => `<li><i style="background:${colorDe(c)}" aria-hidden="true"></i>${esc(f.nombre)}</li>`).join('');
  return `<div class="materia-bloque" data-materia-reparto><h4 class="detail-subtitle">Dónde están los átomos</h4><ul class="materia-filas">${filas}</ul><ul class="materia-leyenda">${leyenda}</ul></div>`;
}

/** Tabla compartimento × elemento (mmol) con la energía de cada uno. */
function tablaMarkup(v: VistaMateria): string {
  const cab = `<tr><th scope="col">Compartimento</th>${ELEMENTOS.map(s => `<th scope="col">${esc(s)}</th>`).join('')}<th scope="col">Energía (J)</th></tr>`;
  const cuerpo = v.filas.map((f, c) => `<tr data-compartimento="${esc(f.nombre)}"><th scope="row"><i style="background:${colorDe(c)}" aria-hidden="true"></i>${esc(f.nombre)}</th>${f.atomos.map(a => `<td>${esc(cantidadCompacta(a))}</td>`).join('')}<td>${f.energia === null ? sinDato : esc(cantidadCompacta(f.energia))}</td></tr>`).join('');
  const e = energiaTotal(v);
  const pie = `<tr class="materia-total"><th scope="row">Mundo</th>${v.porElemento.map(a => `<td>${esc(cantidadCompacta(a))}</td>`).join('')}<td>${e.completa ? esc(cantidadCompacta(e.total)) : sinDato}</td></tr>`;
  return `<div class="materia-bloque" data-materia-tabla><h4 class="detail-subtitle">Átomos (mmol) y energía por compartimento</h4><div class="materia-tabla" tabindex="0"><table><thead>${cab}</thead><tbody>${cuerpo}</tbody><tfoot>${pie}</tfoot></table></div><p class="stats-note">La energía es química más calor de cada compartimento; la del mundo se suma solo si todos traen dato.</p></div>`;
}

function cuentasMarkup(v: VistaMateria): string {
  if (!v.cuentas.length) return `<div class="materia-bloque" data-materia-cuentas="0"><h4 class="detail-subtitle">Fuentes y sumideros</h4><p class="stats-note">Este mundo no declaró fuentes ni sumideros todavía.</p></div>`;
  const filas = v.cuentas.map(c => `<span data-cuenta="${esc(c.nombre)}">${esc(c.nombre)}<strong>${esc(cantidadCompacta(c.valor))}</strong></span>`).join('');
  return `<div class="materia-bloque" data-materia-cuentas="${v.cuentas.length}"><h4 class="detail-subtitle">Fuentes y sumideros declarados (acumulado)</h4><div class="stats-facts">${filas}</div><p class="stats-note">Lo que entró o salió del mundo por una fuente o un sumidero con nombre; todo lo demás solo se mueve entre compartimentos.</p></div>`;
}

function sustanciasMarkup(v: VistaMateria, catalogo: SustanciasVisibles | undefined, tick: number): string {
  if (!v.sustancias.length) return `<div class="materia-bloque" data-materia-sustancias="0"><h4 class="detail-subtitle">Sustancias aparecidas</h4><p class="stats-note">Todavía no hay sustancias en ningún lote.</p></div>`;
  const filas = v.sustancias.map(s => {
    const ficha: SustanciaVista | undefined = sustanciaPorId(catalogo, s.id);
    const nombre = ficha ? `${formulaDe(ficha.atomos)} <small>${esc(nombreDerivado(ficha))}</small>` : `sustancia nº ${esc(s.id)} <small>${sinDato} su estructura no viaja en esta vista</small>`;
    return `<li data-sustancia="${esc(s.id)}"><strong>${nombre}</strong><span>${esc(number(s.masa, s.masa < 1 ? 4 : 2))} kg</span><small>${s.desde > tick ? 'recién aparecida' : `desde hace ${esc(dias(tick - s.desde))} · paso ${esc(number(s.desde))}`}</small></li>`;
  }).join('');
  return `<div class="materia-bloque" data-materia-sustancias="${v.sustancias.length}"><h4 class="detail-subtitle">Sustancias aparecidas · ${esc(number(v.sustancias.length))}</h4><ul class="materia-sustancias">${filas}</ul></div>`;
}

function cicloMarkup(c: CicloMateria): string {
  const series = ELEMENTOS.map((s, e) => ({ s, e, m: compartimentoQueSeMueve(c, e) })).filter(x => x.m && x.m.rango > 0);
  if (c.ticks.length < 2) return `<div class="materia-bloque" data-materia-ciclo="0"><h4 class="detail-subtitle">El ciclo</h4><p class="stats-note">El ciclo se dibuja con las lecturas que este navegador va recibiendo: aún hay ${number(c.ticks.length)} de las 2 que hacen falta.</p></div>`;
  if (!series.length) return `<div class="materia-bloque" data-materia-ciclo="0"><h4 class="detail-subtitle">El ciclo</h4><p class="stats-note">En las ${number(c.ticks.length)} lecturas de este navegador el reparto no se movió.</p></div>`;
  const dibujo = series.map(x => sparkline(x.m!.serie, `${NOMBRE_ELEMENTO[x.e]} · parte en ${x.m!.compartimento}`, 'de sus átomos', [0, 1])).join('');
  return `<div class="materia-bloque" data-materia-ciclo="${series.length}"><h4 class="detail-subtitle">El ciclo</h4><div class="materia-ciclo">${dibujo}</div><p class="stats-note">De cada elemento, el compartimento cuya parte más cambió en las lecturas de este navegador.</p></div>`;
}

export function renderPanelMateria(v: VistaMateria | null, ciclo: CicloMateria = cicloVacio(), catalogo?: SustanciasVisibles, tickActual: number = v?.tick ?? 0, observada?: ReaccionObservada): string {
  const luz = luzMateria(v);
  if (!v) {
    const citado = !!catalogo?.length;
    const luzPanel = citado
      ? { estado: 'sin-dato' as const, valor: 'sin libro', motivo: 'El libro agregado no vino en este fotograma. Hay sustancias citadas; no se inventa el reparto.' }
      : luz;
    const texto = citado
      ? 'Este fotograma no trae el libro agregado de la materia. El catálogo de sustancias citado sí llegó: no se rellena el libro con ceros.'
      : 'El servidor sirve este mundo sin la ley de materia: el reparto de los átomos, la energía y las sustancias aparecen cuando se enciende.';
    return `<section class="stats-section materia-panel" data-panel-materia data-estado="${luzPanel.estado}" data-libro="${citado ? 'no-grabado' : 'ausente'}">${cabecera(null, luzPanel)}<p class="stats-empty">${esc(texto)}</p>${fichaReaccion(observada, 'mundo')}</section>`;
  }
  return `<section class="stats-section materia-panel" data-panel-materia data-estado="${luz.estado}">${cabecera(v, luz)}${repartoMarkup(v)}${tablaMarkup(v)}${cuentasMarkup(v)}${sustanciasMarkup(v, catalogo, tickActual)}${cicloMarkup(ciclo)}${fichaReaccion(observada, 'mundo')}</section>`;
}

/** Firma de lo que se ve, redondeada como se dibuja: el ruido de una lectura a otra no rehace el panel. */
export function firmaMateria(v: VistaMateria | null, ciclo: CicloMateria, catalogo?: SustanciasVisibles): string {
  if (!v) return 'sin-materia';
  const reparto = repartoPorElemento(v).map(fila => fila.map(x => Math.round(x * 1000)));
  return JSON.stringify([v.conserva, v.filas.map(f => f.nombre), reparto, v.porElemento.map(a => cantidadCompacta(a)), v.filas.map(f => f.energia === null ? null : cantidadCompacta(f.energia)),
    v.cuentas.map(c => [c.nombre, cantidadCompacta(c.valor)]), v.sustancias.map(s => [s.id, Math.round(s.masa * 1000), s.desde]), Math.floor(v.tick / TICKS_POR_DIA * 10), ciclo.ticks.length, catalogo?.map(s => s.id) ?? null]);
}
