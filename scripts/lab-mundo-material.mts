/**
 * Laboratorio del mundo material en sombra (carril W, etapa 1). Corre un mundo normal de L × L (sin gente ni fauna:
 * solo sus leyes de ecología y de agua) y su sombra material a la vez, y mide los puntos de aceptación:
 *   a) conservación exacta (bigint) con las fuentes y sumideros declarados;   b) vistas en el instante inicial;
 *   c) equivalencia de flujos (rebrote de alimento y recarga de agua);       c2) charcas con el tiempo de hoy (en a);
 *   d) ciclos y régimen de la biomasa en 40 recambios, sin gente;
 *   e) fenómenos (rebrote tras el fuego, agua que se evapora y vuelve, suelo frío sobre una masa marcada); f) coste.
 * Uso: npx tsx scripts/lab-mundo-material.mts [--puntos a,b,c,e,f] [--lado 64] [--ticks 5000] [--cada 10]
 *      [--recambios 40] [--cada-d 240] [--hilos 1,8] [--semilla 1] [--salida dir] [--fisica clave=valor,…]
 * `--fisica` cambia parámetros físicos de FISICA (mundo.ts) para barrerlos, p. ej. --fisica alturaCapaLimite=500.
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import { ELEMENTOS, NE } from '../src/shared/naturaleza.js';
import type { Tile } from '../src/shared/types.js';
import { createWorld, phaseAt } from '../src/world/mundo/crear.js';
import { activate } from '../src/world/spatial.js';
import { ecology } from '../src/world/mundo/ecologia.js';
import { closeEcosystemWorkers, stepEcosystem } from '../src/world/ecosystem.js';
import type { World } from '../src/world/mundo/tipos.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { fluir } from '../src/world/materia/fluir.js';
import { pasoLote } from '../src/world/materia/paso.js';
import { Rol } from '../src/world/materia/tipos.js';
import { KAPPA_SUELO, KAPPA_SUELO_HH } from '../src/shared/naturaleza.js';
import { LUZ_CREPSCULO } from '../src/world/ecologia-constantes.js';
import { MundoMaterial, intercambioBruto, totalesVacios, CUENTA, type DescriptorMundo, type Fisica, type Forzamiento } from '../src/world/materia/mundo.js';
import { serializarSustancias, type ServicioQuimicoImpl } from '../src/world/materia/servicio.js';
import { unidadesVacias, vistaVacia, type VistaTesela } from '../src/world/materia/vistas.js';

function args() {
  const a = process.argv.slice(2), v = (k: string, d: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1]! : d; };
  return {
    puntos: new Set(v('puntos', 'a,b,c,e,f').split(',')), lado: +v('lado', '64'), ticks: +v('ticks', '5000'), cada: +v('cada', '10'),
    recambios: +v('recambios', '40'), cadaD: +v('cada-d', '240'), hilos: v('hilos', '1,8').split(',').map(Number),
    semilla: +v('semilla', '1'), salida: v('salida', '/tmp/atlas-v23-w/lab'),
    fisica: Object.fromEntries(v('fisica', '').split(',').filter(Boolean).map((x) => { const [k, n] = x.split('='); return [k!, +n!]; })) as Partial<Fisica>,
  };
}

const veredicto = (ok: boolean) => ok ? 'PASA' : 'FALLA';
const entre = (x: number, a: number, b: number) => x >= a && x <= b;

/** Agua con el exterior: entra y sale de la atmósfera libre y se va por el desagüe (cuantos). */
function exteriorAgua(c: bigint[]): string {
  return `atmósfera libre +${c[CUENTA.CIELO_ENTRA]} −${c[CUENTA.CIELO_SALE]}, desagüe −${c[CUENTA.DESAGUE]} cuantos de H₂O (saldo ${c[CUENTA.CIELO_ENTRA]! - c[CUENTA.CIELO_SALE]! - c[CUENTA.DESAGUE]!})`;
}

/** Un paso material con un hilo. */
function paso(m: MundoMaterial, f: Forzamiento, tot: ReturnType<typeof totalesVacios>): void { m.prepararPaso(); m.pasar(f); m.plegar(tot); }

const carga = () => `carga ${loadavg().map((x) => x.toFixed(1)).join(' ')} (${hostname()}, ${cpus().length} hilos)`;
const f3 = (x: number) => x.toFixed(3), pc = (x: number) => `${(100 * x).toFixed(2)} %`;

/** Luz media del reloj de hoy (phaseAt: amanecer y anochecer a 0,4) entre t y t + dt. */
function luzMedia(t: number, dt: number): number {
  let s = 0;
  for (let k = 0; k < dt; k++) { const f = phaseAt(t + k); s += f === 'day' ? 1 : f === 'night' ? 0 : LUZ_CREPSCULO; }
  return s / dt;
}

/** Tiempo sin mundo escalar: lluvia con PROB 0,4 cada 600 ticks, como ecology(). */
function tiempo(semilla: number) {
  let a = semilla >>> 0, lluvia = false;
  const azar = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (t: number, dt: number): Forzamiento => {
    if (Math.floor(t / 600) !== Math.floor((t - dt) / 600) || t === 0) lluvia = azar() < 0.4;
    return { dt, luz: luzMedia(t, dt), lluvia };
  };
}

function mundoNormal(semilla: number, lado: number): { w: World; tiles: Tile[] } {
  const w = createWorld(semilla);
  for (let cy = 0; cy < lado / 16; cy++) for (let cx = 0; cx < lado / 16; cx++) activate(w, cx * 16, cy * 16);
  w.people = []; w.animals = [];
  return { w, tiles: w.tiles.filter((t) => t.x >= 0 && t.y >= 0 && t.x < lado && t.y < lado) };
}

/** Un tick del mundo escalar: sus leyes de ecología (comida, vegetación, humedad, tiempo) y de agua (kernel). */
function tickEscalar(w: World): void {
  ecology(w);
  stepEcosystem(w.tiles, w.tick, w.weather, phaseAt(w.tick), false);
  w.tick++;
}

const CAMPOS = ['drinkingWater', 'moisture', 'vegetation', 'food', 'wood', 'stone'] as const;

function exacto(m: MundoMaterial, tot: ReturnType<typeof totalesVacios>): boolean {
  const s = m.saldo();
  return s.every((x, k) => x === tot.esperado[k]);
}

async function principal(): Promise<void> {
  const A = args();
  mkdirSync(A.salida, { recursive: true });
  const informe: Record<string, unknown> = { carga: carga(), args: { ...A, puntos: [...A.puntos] } };
  console.log(`# Mundo material en sombra — ${new Date().toISOString()} — ${carga()}`);
  if (A.puntos.has('a') || A.puntos.has('b')) informe.ab = puntoAB(A);
  if (A.puntos.has('h')) informe.h = puntoH2();
  if (A.puntos.has('c')) informe.c = puntoC(A);
  if (A.puntos.has('e')) informe.e = puntoE(A);
  if (A.puntos.has('d')) informe.d = puntoD(A);
  if (A.puntos.has('f')) informe.f = await puntoF(A);
  writeFileSync(`${A.salida}/informe.json`, JSON.stringify(informe, (_, v) => typeof v === 'bigint' ? String(v) : v, 1));
  await closeEcosystemWorkers();
  console.log(`informe: ${A.salida}/informe.json`);
}

// ── a) y b) ──

function puntoAB(A: ReturnType<typeof args>) {
  const { w, tiles } = mundoNormal(A.semilla, A.lado);
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(tiles, q, { fisica: A.fisica, semilla: A.semilla, luz: luzMedia(0, A.cada) });
  const tot = totalesVacios(); m.plegar(tot);
  const e = m.params.escalas;
  console.log(`\nEscalas (cuantos o unidades por unidad de escalar): ${JSON.stringify(e)}`);
  for (const [k, v] of Object.entries(m.params.porque)) console.log(`  ${k}: ${v}`);
  console.log(`  tasas: crecimiento ${JSON.stringify(m.params.crecimiento)}; caída ${JSON.stringify(m.params.caida)}`);
  // b) Vistas en t = 0.
  const porTesela = new Map(tiles.map((t) => [t.x * 65536 + t.y, t]));
  const cuanto: Record<(typeof CAMPOS)[number], number> = {
    drinkingWater: 1 / e.agua, moisture: 1 / e.humedad, vegetation: 1 / e.vegetacion, food: 1 / e.alimento, wood: 1 / e.madera, stone: 1 / e.piedra,
  };
  const peor: Record<string, number> = {}, v = vistaVacia();
  for (let i = 0; i < m.n; i++) {
    m.vista(i, v);
    const t = porTesela.get(m.x[i]! * 65536 + m.y[i]!)!;
    for (const k of CAMPOS) peor[k] = Math.max(peor[k] ?? 0, Math.abs(v[k] - (t[k] ?? 0)) / cuanto[k]);
  }
  const bOk = Object.values(peor).every((x) => x <= 1);
  console.log(`\n(b) Vistas en t=0, peor diferencia en cuantos de la escala (≤ 1 pasa): ${Object.entries(peor).map(([k, x]) => `${k} ${x.toFixed(3)}`).join(', ')} → ${bOk ? 'PASA' : 'FALLA'}`);
  if (!A.puntos.has('a')) return { peor, bOk };
  // a) Conservación con el mundo escalar al lado.
  const s0 = m.saldo();
  console.log(`\n(a) ${A.ticks} ticks de ${A.lado}×${A.lado} (${m.n} teselas, ${m.np} páginas), paso material cada ${A.cada} ticks; libro exacto en cada paso`);
  console.log(`  t=0 átomos: ${ELEMENTOS.map((x, k) => `${x} ${s0[k]}`).join(', ')}; energía ${s0[NE]} J`);
  let fallos = 0, pasos = 0, ms = 0;
  const comparar: string[] = [];
  const media = () => {
    const sm: Record<string, number> = {}, se: Record<string, number> = {};
    for (let i = 0; i < m.n; i++) { m.vista(i, v); const t = porTesela.get(m.x[i]! * 65536 + m.y[i]!)!; for (const k of CAMPOS) { sm[k] = (sm[k] ?? 0) + v[k] / m.n; se[k] = (se[k] ?? 0) + (t[k] ?? 0) / m.n; } }
    return CAMPOS.map((k) => `${k} ${f3(se[k]!)}/${f3(sm[k]!)}`).join(' ');
  };
  comparar.push(`t=0: ${media()}`);
  const charcas = tiles.filter((t) => (t.drinkingWater ?? 0) > 0.15).map((t) => ({ clave: t.x * 65536 + t.y, agua0: t.drinkingWater! }));
  const idxClave = new Map<number, number>(); for (let i = 0; i < m.n; i++) idxClave.set(m.x[i]! * 65536 + m.y[i]!, i);
  while (w.tick < A.ticks) {
    const f: Forzamiento = { dt: A.cada, luz: luzMedia(w.tick, A.cada), lluvia: w.weather === 'rain' };
    const t0 = performance.now();
    paso(m, f, tot);
    ms += performance.now() - t0; pasos++;
    if (!exacto(m, tot)) fallos++;
    for (let k = 0; k < A.cada; k++) tickEscalar(w);
    if (w.tick % 1000 === 0) comparar.push(`t=${w.tick}: ${media()}`);
  }
  const s1 = m.saldo();
  const dAtomos = ELEMENTOS.map((x, k) => `${x} ${s1[k]! - s0[k]!}`).join(', ');
  const c = tot.cuentas, energia = s1[NE]! - s0[NE]!;
  const declarada = c[CUENTA.SOL]! + c[CUENTA.RAD_ENTRA]! - c[CUENTA.RAD_SALE]! + c[CUENTA.IGNICION]! + c[CUENTA.EXTERIOR_J]!;
  // Los átomos cambian solo por el agua declarada con el exterior: H 2 y O 1 por cuanto de H₂O.
  const aguaNeta = c[CUENTA.CIELO_ENTRA]! - c[CUENTA.CIELO_SALE]! - c[CUENTA.DESAGUE]!;
  const esperadoAt = ELEMENTOS.map((x) => x === 'H' ? 2n * aguaNeta : x === 'O' ? aguaNeta : 0n);
  const atomosOk = s1.slice(0, NE).every((x, k) => x - s0[k]! === esperadoAt[k]);
  console.log(`  Δ átomos: ${dAtomos}; agua con el exterior: ${exteriorAgua(c)} → Δ átomos − agua declarada = ${ELEMENTOS.map((x, k) => `${x} ${s1[k]! - s0[k]! - esperadoAt[k]!}`).join(', ')} (debe ser 0)`);
  console.log(`  Δ energía ${energia} J = sol ${c[CUENTA.SOL]} + radiación entrante ${c[CUENTA.RAD_ENTRA]} − saliente ${c[CUENTA.RAD_SALE]} + ignición ${c[CUENTA.IGNICION]} + exterior ${c[CUENTA.EXTERIOR_J]} = ${declarada} J → ${energia === declarada ? 'cuadra' : 'NO cuadra'}`);
  console.log(`  pasos con Σ lotes ≠ libro: ${fallos} de ${pasos} → ${veredicto(fallos === 0 && energia === declarada && atomosOk)}`);
  console.log(`  ${(ms / pasos).toFixed(0)} ms por paso (${(1000 * ms / pasos / m.n / A.cada).toFixed(2)} µs por tesela y tick, 1 hilo, con el libro bigint aparte), ${carga()}`);
  console.log('  medias escalar/sombra (nadie come ni bebe en ninguno de los dos; el escalar tiene topes y lluvia sin origen):');
  for (const x of comparar) console.log(`    ${x}`);
  // c2) Nadie bebe en ninguno de los dos: el agua de las charcas a los A.ticks es la que deja el tiempo de hoy.
  const media0 = charcas.reduce((a, c) => a + c.agua0, 0) / Math.max(1, charcas.length);
  const mediaE = charcas.reduce((a, c) => a + (porTesela.get(c.clave)!.drinkingWater ?? 0), 0) / Math.max(1, charcas.length);
  const mediaS = charcas.reduce((a, c) => a + m.vista(idxClave.get(c.clave)!, v).drinkingWater, 0) / Math.max(1, charcas.length);
  const retencion = { escalar: mediaE / media0, sombra: mediaS / media0 }, c2 = mediaS / mediaE;
  console.log(`\n(c2) Agua de las ${charcas.length} charcas (agua potable inicial > 0,15, media ${f3(media0)}) a los ${A.ticks} ticks con el tiempo de hoy, sin que nadie beba: escalar ${f3(mediaE)} (${pc(retencion.escalar)}), sombra ${f3(mediaS)} (${pc(retencion.sombra)}); sombra/escalar ${f3(c2)} (0,75–1,25) → ${veredicto(entre(c2, 0.75, 1.25))}`);
  return { peor, bOk, fallos, pasos, dAtomos, energia, declarada, atomosOk, comparar, retencion, c2, msPaso: ms / pasos, exterior: exteriorAgua(c) };
}

// ── H₂: el suelo discreto, dos lotes (aire 10.000 / poro 10, como materia.cierre2) ──

function puntoH2() {
  const fila = (bruto: boolean) => {
    const q = crearServicioQuimico({ modo: 'inmediato' });
    const tiles: Tile[] = [{ x: 0, y: 0, terrain: 'grass', moisture: 0.5, vegetation: 0, food: 0 } as unknown as Tile];
    const m = MundoMaterial.levantar(tiles, q, { semilla: 3 });
    const S = m.S, c = m.ctx, A = m.arena;
    const aire = A.nuevo(Rol.Objeto, -1, 0), poro = A.nuevo(Rol.Objeto, -1, 0);
    A.fuente(aire, Float64Array.of(S.H2, 5000, S.N2, 7_800_000, S.O2, 2_100_000, 0, Math.round(295 * 0.025 * 2 * 9_905_000)), m.libro);
    A.fuente(poro, Float64Array.of(S.O2, 2100, S.N2, 7800, 0, Math.round(295 * 0.025 * 2 * 9900)), m.libro);
    const k: [number, number, number, number] = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
    for (let t = 0; t < 20000; t++) {
      for (const id of [S.H2, S.O2, S.N2]) bruto ? intercambioBruto(c, poro, aire, id, 1, 10, 10000, 1) : fluir(c, poro, aire, id, 1, 10, 10000, 0, 1);
      pasoLote(c, poro, 1, k);
      m.termostato(poro, 295); m.termostato(aire, 295);
    }
    return A.cuantos(aire, S.H2) + A.cuantos(poro, S.H2);
  };
  const discreto = fila(false), bruto = fila(true);
  console.log(`\n(H₂) Suelo discreto, aire 10.000 / poro 10, 5.000 H₂ en el aire, 20.000 ticks: con fluir quedan ${discreto} H₂; con flujos brutos, ${bruto}`);
  return { discreto, bruto };
}

// ── c) Equivalencia de flujos ──

/** Teselas de pradera (las de la equivalencia): sin charca, sin árboles; y teselas con charca. */
function seleccion(tiles: Tile[]) {
  const pradera = tiles.filter((t) => t.biome === 'grassland' && t.terrain !== 'water' && !(t.drinkingWater! > 0) && !(t.wood! > 0) && t.food > 0.05);
  const charca = tiles.filter((t) => t.terrain !== 'water' && (t.drinkingWater ?? 0) > 0.15);
  return { pradera, charca };
}

function puntoC(A: ReturnType<typeof args>) {
  const { w, tiles } = mundoNormal(A.semilla, A.lado);
  const { pradera, charca } = seleccion(tiles);
  // Escalar: alimento a K/2 y un trago grande (0,1) en la mitad de cada grupo; la otra mitad es el control.
  const K = 0.7, DIA = 2400, delta = 0.1;
  // Los dos se asientan 10 días antes de tratar, para que el control esté en su equilibrio y no en el transitorio de su
  // estado inicial (el escalar arranca con alimento 0,21 y lo sube a 0,75).
  for (let k = 0; k < 10 * DIA; k++) tickEscalar(w);
  const tratar = <T,>(xs: T[]) => xs.filter((_, k) => k % 2 === 0), control = <T,>(xs: T[]) => xs.filter((_, k) => k % 2 === 1);
  const antesE = { comida: tratar(pradera).map((t) => { t.food = K / 2; return t.food; }), agua: tratar(charca).map((t) => { t.drinkingWater = Math.max(0, t.drinkingWater! - delta); return t.drinkingWater!; }) };
  const ctlE0 = { comida: control(pradera).map((t) => t.food), agua: control(charca).map((t) => t.drinkingWater!) };
  const dias = 3;
  for (let k = 0; k < dias * DIA; k++) tickEscalar(w);
  const media = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const rebroteE = (media(tratar(pradera).map((t) => t.food)) - media(antesE.comida) - (media(control(pradera).map((t) => t.food)) - media(ctlE0.comida))) / dias;
  const recargaE = (media(tratar(charca).map((t) => t.drinkingWater!)) - media(antesE.agua) - (media(control(charca).map((t) => t.drinkingWater!)) - media(ctlE0.agua))) / dias;
  // Sombra: las mismas teselas (de su estado inicial), asentada 10 días hasta su equilibrio; después a la mitad de su
  // propio alimento y el mismo trago, y la misma resta con el control.
  const sub = [...pradera, ...charca];
  const { w: w2, tiles: t2 } = mundoNormal(A.semilla, A.lado);
  void w2;
  const sel = new Set(sub.map((t) => t.x * 65536 + t.y));
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(t2.filter((t) => sel.has(t.x * 65536 + t.y)), q, { fisica: A.fisica, semilla: A.semilla });
  const idx = new Map<number, number>(); for (let i = 0; i < m.n; i++) idx.set(m.x[i]! * 65536 + m.y[i]!, i);
  const iP = pradera.map((t) => idx.get(t.x * 65536 + t.y)!), iC = charca.map((t) => idx.get(t.x * 65536 + t.y)!);
  const clima = tiempo(A.semilla), cada = 60, tot = totalesVacios();
  let t = 0;
  const correr = (ticks: number) => { for (const fin = t + ticks; t < fin; t += cada) paso(m, clima(t, cada), tot); };
  const v = vistaVacia(), u = unidadesVacias();
  const leer = (is: number[], k: keyof VistaTesela) => is.map((i) => m.vista(i, v)[k]);
  const serie: string[] = [];
  for (let dia = 0; dia < 10; dia++) { correr(DIA); serie.push(`día ${dia + 1}: alimento ${f3(media(leer(iP, 'food')))}, vegetación ${f3(media(leer(iP, 'vegetation')))}, humedad ${f3(media(leer(iP, 'moisture')))}, agua ${f3(media(leer(iC, 'drinkingWater')))}`); }
  const equilibrio = media(leer(iP, 'food'));
  const antesM = { comida: tratar(iP).map((i) => { const fr = m.unidades(i, u).fruto; m.extraer(i, 'fruto', Math.round(fr / 2)); return m.vista(i, v).food; }),
    agua: tratar(iC).map((i) => { m.beber(i, Math.round(delta * m.params.escalas.agua)); return m.vista(i, v).drinkingWater; }) };
  const ctlM0 = { comida: leer(control(iP), 'food'), agua: leer(control(iC), 'drinkingWater') };
  correr(dias * DIA);
  const rebroteM = (media(leer(tratar(iP), 'food')) - media(antesM.comida) - (media(leer(control(iP), 'food')) - media(ctlM0.comida))) / dias;
  const recargaM = (media(leer(tratar(iC), 'drinkingWater')) - media(antesM.agua) - (media(leer(control(iC), 'drinkingWater')) - media(ctlM0.agua))) / dias;
  // Relativo a la capacidad de cada uno (el escalar a K/2 de K = 0,7; la sombra a la mitad de su equilibrio).
  const relE = rebroteE / (K / 2), relM = rebroteM / (equilibrio / 2);
  console.log(`\n(c) Equivalencia de flujos (${pradera.length} praderas y ${charca.length} charcas, mitad tratadas y mitad control, ${dias} días; sombra asentada 10 días, paso cada ${cada} ticks):`);
  for (const x of serie) console.log(`    sombra ${x}`);
  console.log('  | flujo | escalar | sombra | sombra/escalar |');
  const okR = entre(rebroteM / rebroteE, 0.8, 1.2), okA = entre(recargaM / recargaE, 0.8, 1.2);
  console.log(`  | rebrote de alimento a media capacidad (u/día) | ${rebroteE.toFixed(4)} | ${rebroteM.toFixed(4)} | ${(rebroteM / rebroteE).toFixed(2)} | ${veredicto(okR)}`);
  console.log(`  | rebrote relativo a su capacidad (1/día) | ${relE.toFixed(4)} | ${relM.toFixed(4)} | ${(relM / relE).toFixed(2)} |`);
  console.log(`  | recarga tras un trago de ${delta} (u/día) | ${recargaE.toFixed(4)} | ${recargaM.toFixed(4)} | ${(recargaM / recargaE).toFixed(2)} | ${veredicto(okA)}`);
  console.log(`  (c) rebrote y recarga entre 0,8 y 1,2 de los de hoy → ${veredicto(okR && okA)}`);
  console.log(`  equilibrio del alimento en la sombra: ${f3(equilibrio)} (capacidad escalar de la pradera ${K}); libro exacto: ${exacto(m, tot)}`);
  return { rebroteE, rebroteM, relE, relM, recargaE, recargaM, equilibrio, serie, ok: okR && okA };
}

// ── e) Fenómenos ──

function puntoE(A: ReturnType<typeof args>) {
  const { tiles } = mundoNormal(A.semilla, A.lado);
  const dos = tiles.filter((t) => t.y < 16 && t.x < 32);
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(dos, q, { fisica: A.fisica, semilla: A.semilla });
  const S = m.S, A_ = m.arena, clima = tiempo(A.semilla + 1), cada = 60, tot = totalesVacios(), DIA = 2400, DIAS = 40;
  let t = 0;
  const correr = (ticks: number) => { for (const fin = t + ticks; t < fin; t += cada) paso(m, clima(t, cada), tot); };
  correr(2 * DIA);
  // Fuego: 6 teselas con hoja en la página templada, al 90 %.
  const v = vistaVacia(), u = unidadesVacias();
  const quemadas: number[] = [];
  for (let i = m.inicio[0]!; i < m.inicio[1]! && quemadas.length < 6; i++) if (m.unidades(i, u).hoja > 1000) quemadas.push(i);
  const veg = () => quemadas.map((i) => m.vista(i, v).vegetation).reduce((s, x) => s + x, 0) / quemadas.length;
  const antes = veg();
  m.prepararPaso();
  let unidades = 0; for (const i of quemadas) unidades += m.quemar(i, 0.9);
  const despues = veg();
  const agua = { aire: [] as number[], superficie: [] as number[] };
  const H2O = S.H2O, sup = () => { let s = 0; for (let i = 0; i < m.n; i++) { s += A_.cuantos(m.suelo[i]!, H2O); if (m.agua[i]! >= 0) s += A_.cuantos(m.agua[i]!, H2O); } return s; };
  const serie: string[] = [];
  for (let dia = 1; dia <= DIAS; dia++) {
    for (let k = 0; k < DIA / cada; k++) {
      correr(cada);
      if (dia === 1) { agua.aire.push(A_.cuantos(m.aire[0]!, H2O) + A_.cuantos(m.aire[1]!, H2O)); agua.superficie.push(sup()); }
    }
    if (dia % 10 === 0 || dia === 1) serie.push(`día ${dia}: vegetación quemada ${f3(veg())}`);
  }
  const rango = (xs: number[]) => `${Math.min(...xs)}–${Math.max(...xs)}`;
  const rebrota = veg() > 2 * despues;
  console.log(`\n(e) Fenómenos (2 páginas de 16×16):`);
  console.log(`  fuego: ${quemadas.length} teselas al 90 % (${unidades} unidades): vegetación ${f3(antes)} → ${f3(despues)} → ${f3(veg())} a los ${DIAS} días (debe al menos doblarse) → ${veredicto(despues < 0.2 * antes && rebrota)}`);
  for (const x of serie) console.log(`    ${x}`);
  console.log(`  agua en un día: vapor del aire ${rango(agua.aire)} cuantos, agua de suelos y charcas ${rango(agua.superficie)} (sube de noche: rocío; baja de día: evaporación)`);
  console.log(`  libro exacto: ${exacto(m, tot)}`);
  const frio = descomposicionMarcada(q, m, [m.temperatura(0, 0.6), m.temperatura(0, 0.6) - 20]);
  for (const x of frio.lineas) console.log(`  ${x}`);
  return { antes, despues, final: veg(), agua: { aire: rango(agua.aire), superficie: rango(agua.superficie) }, serie, frio: frio.r, ok: despues < 0.2 * antes && rebrota && frio.ok };
}

/**
 * Suelo frío sobre una masa marcada: un suelo mineral sin C orgánico (el de una tesela de referencia, con su aire de poro
 * y un aire grande que le repone el O₂, como intercambia en el mundo) recibe una hojarasca conocida; todo el C orgánico
 * que queda es de esa masa, sin la hojarasca natural de la planta. Se mide tick a tick la vida media a cada temperatura.
 */
function descomposicionMarcada(q: ServicioQuimicoImpl, m: MundoMaterial, Ts: number[]) {
  const S = m.S, A = m.arena, c = m.ctx, cajas = m.params.suelo, k: [number, number, number, number] = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
  // C orgánico: todo el C del lote salvo el del CO₂ y el del carbonato (incluye lo que la descomposición deja a medias).
  const iC = ELEMENTOS.indexOf('C');
  const orgC = (l: number) => { let s = 0; for (const id of m.especies(l)) if (id !== S.CO2 && id !== S.CaCO3) s += A.cuantos(l, id) * q.sustancia(id).atomos[iC]!; return s; };
  const at = (id: number) => q.sustancia(id).atomos.reduce((s, v) => s + v, 0);
  const llenar = (l: number, cont: [number, number][], T: number) => {
    const pares = cont.flat(); pares.push(0, Math.round(T * 0.025 * cont.reduce((s, [id, n]) => s + n * at(id), 0)));
    A.fuente(l, Float64Array.from(pares), m.libro);
  };
  const r: { T: number; medio: number; dia1: number; dia4: number }[] = [];
  for (const T of Ts) {
    const suelo = A.nuevo(Rol.Objeto, -1, 0), aire = A.nuevo(Rol.Objeto, -1, 0);
    llenar(suelo, [[S.SiO2, Math.round(1_000_000 * cajas)], [S.CaCO3, Math.round(100_000 * cajas)], [S.NH3, Math.round(30_000 * cajas)],
      [S.H3PO4, Math.round(10_000 * cajas)], [S.H2O, Math.round(0.85 * m.params.escalas.humedad)], [S.N2, 78_000], [S.O2, 21_000], [S.CO2, 2000],
      [S.madera, 100_000], [S.CH2, 10_000], [S.proteina, 10_000], [S.orgP, 5000]], T);
    llenar(aire, [[S.N2, 7_800_000 * 4], [S.O2, 2_100_000 * 4], [S.CO2, 200_000 * 4]], T);
    const c0 = orgC(suelo);
    let t = 0, medio = -1, dia1 = 0, dia4 = 0, antes = c0;
    while (t < 4 * 2400) {
      const dt = t < 2400 ? 1 : 10;
      pasoLote(c, suelo, dt, k);
      for (const id of [S.O2, S.CO2, S.N2, S.H2, S.NH3]) intercambioBruto(c, suelo, aire, id, 1, 10, 400, dt);
      m.termostato(suelo, T); m.termostato(aire, T);
      t += dt;
      const ahora = orgC(suelo);
      if (medio < 0 && ahora <= c0 / 2) medio = t - dt + dt * (antes - c0 / 2) / Math.max(1, antes - ahora);
      if (t === 2400) dia1 = ahora / c0;
      antes = ahora;
    }
    dia4 = orgC(suelo) / c0;
    r.push({ T, medio, dia1, dia4 });
  }
  const [cal, fri] = r as [typeof r[0], typeof r[0]];
  const lento = fri.medio < 0 || fri.medio > 1.2 * cal.medio;
  const lineas = r.map((x) => `masa marcada a ${x.T.toFixed(0)} K: vida media del C orgánico ${x.medio < 0 ? '> 4 días' : `${x.medio.toFixed(1)} ticks`}, queda ${pc(x.dia1)} al día y ${pc(x.dia4)} a los 4 días`);
  lineas.push(`suelo frío más lento (vida media ≥ 1,2× la templada): ${fri.medio < 0 ? '> 4 días' : (fri.medio / cal.medio).toFixed(2) + '×'} → ${veredicto(lento)}`);
  return { r, ok: lento, lineas };
}

// ── d) Ciclos ──

function puntoD(A: ReturnType<typeof args>) {
  const { tiles } = mundoNormal(A.semilla, A.lado);
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(tiles, q, { fisica: A.fisica, semilla: A.semilla });
  const clima = tiempo(A.semilla), cada = A.cadaD, tot = totalesVacios(), S = m.S;
  const iH = 0, iN = ELEMENTOS.indexOf('N'), iP = ELEMENTOS.indexOf('P');
  const atomos = (id: number) => q.sustancia(id).atomos;
  const aceptadas = new Set<number>([S.madera, S.CH2, S.proteina, S.orgP, S.NH3, S.N2, S.H3PO4, S.CaHPO4,
    ...m.plantillas.hoja.flatMap((v) => v.p.sintesis.entradas.map((x) => x.id))]);
  const medir = () => {
    const inv = m.inventario();
    let h = 0, h2 = 0, nFijado = 0, pTot = 0, pAcc = 0, bio = 0;
    for (const [id, c] of inv) {
      const a = atomos(id);
      h += c * a[iH]!; if (id === S.H2) h2 += 2 * c;
      if (id !== S.N2) nFijado += c * a[iN]!;
      pTot += c * a[iP]!; if (aceptadas.has(id)) pAcc += c * a[iP]!;
    }
    for (let i = 0; i < m.n; i++) for (const id of [S.madera, S.CH2, S.proteina, S.orgP]) bio += m.arena.cuantos(m.vida[i]!, id);
    return { agua: inv.get(S.H2O) ?? 0, co2: inv.get(S.CO2) ?? 0, h2: h2 / h, nFijado, pAcc: pAcc / pTot, bio, inv };
  };
  const m0 = medir();
  const H2O0 = m0.agua, desconocidas0 = new Set(m0.inv.keys());
  let caido = 0n, recambios = 0, t = 0, pasos = 0, fallos = 0, ms = 0, aguaMin = Infinity, h2Max = 0, nMin = Infinity, pMin = 1;
  const serie: string[] = [], biomasas: number[] = [];
  // Recambio: el tejido que cayó al suelo (en cuantos) iguala a la biomasa que hay.
  const bioDe = () => { let b = 0; for (let i = 0; i < m.n; i++) for (const id of [S.madera, S.CH2, S.proteina, S.orgP]) b += m.arena.cuantos(m.vida[i]!, id); return b; };
  const tope = A.recambios * 40 * 2400;
  while (recambios < A.recambios && t < tope) {
    const t0 = performance.now();
    const c0 = tot.cuentas[CUENTA.CAIDA]!;
    paso(m, clima(t, cada), tot);
    ms += performance.now() - t0; pasos++; t += cada;
    caido += tot.cuentas[CUENTA.CAIDA]! - c0;
    const ahora = BigInt(bioDe());
    if (caido >= ahora) { caido -= ahora; recambios++;
      const x = medir(); if (!exacto(m, tot)) fallos++;
      biomasas.push(x.bio / m0.bio);
      aguaMin = Math.min(aguaMin, x.agua / H2O0); h2Max = Math.max(h2Max, x.h2); nMin = Math.min(nMin, x.nFijado / m0.nFijado); pMin = Math.min(pMin, x.pAcc);
      if (recambios % 5 === 0 || recambios <= 2) console.log(`    recambio ${recambios} (día ${(t / 2400).toFixed(0)}, ${(ms / pasos).toFixed(0)} ms/paso)`);
      if (recambios % 5 === 0 || recambios <= 2) serie.push(`recambio ${recambios} (día ${(t / 2400).toFixed(0)}): agua ${pc(x.agua / H2O0)}, H₂ ${(100 * x.h2).toFixed(4)} % del H, N fijado ×${(x.nFijado / m0.nFijado).toFixed(3)}, P accesible ${pc(x.pAcc)}, CO₂ ×${(x.co2 / m0.co2).toFixed(3)}, biomasa ×${(x.bio / m0.bio).toFixed(3)}`);
    }
  }
  const fin = medir();
  const nuevas = [...fin.inv].filter(([id]) => !desconocidas0.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, c]) => `${ELEMENTOS.map((x, k) => (atomos(id)[k] ? x + (atomos(id)[k]! > 1 ? atomos(id)[k] : '') : '')).join('')}#${id} ${c}`);
  const ultimas = biomasas.slice(-20), mediaB = ultimas.reduce((a, x) => a + x, 0) / Math.max(1, ultimas.length);
  const desvB = Math.max(...ultimas.map((x) => Math.abs(x / mediaB - 1)));
  const okB = ultimas.length === 20 && desvB <= 0.2;
  const ok = aguaMin >= 0.95 && h2Max <= 0.005 && nMin > 0.5 && pMin > 0.5 && fallos === 0 && okB;
  console.log(`\n(d) Ciclos sin gente, ${m.n} teselas, paso cada ${cada} ticks: ${recambios} recambios en ${(t / 2400).toFixed(0)} días (${pasos} pasos, ${(ms / pasos).toFixed(0)} ms/paso, ${carga()})`);
  for (const x of serie) console.log(`    ${x}`);
  console.log(`  biomasa de los últimos ${ultimas.length} recambios: media ×${mediaB.toFixed(3)} de la inicial, desviación máxima ${pc(desvB)} (≤ 20 %) → ${veredicto(okB)}`);
  console.log(`  agua con el exterior: ${exteriorAgua(tot.cuentas)}`);
  console.log(`  mínimos: agua ${pc(aguaMin)} (≥ 95 %), H₂ máx ${(100 * h2Max).toFixed(4)} % del H (≤ 0,5 %), N fijado ×${nMin.toFixed(3)}, P accesible ${pc(pMin)}; libro: ${fallos} fallos → ${veredicto(ok)}`);
  console.log(`  sustancias nuevas (más abundantes): ${nuevas.join(', ')}`);
  return { recambios, dias: t / 2400, aguaMin, h2Max, nMin, pMin, fallos, serie, nuevas, biomasas, mediaB, desvB, ok, msPaso: ms / pasos };
}

// ── f) Coste ──

async function puntoF(A: ReturnType<typeof args>) {
  const out: Record<string, unknown> = {};
  for (const hilos of A.hilos) {
    const { tiles } = mundoNormal(A.semilla, A.lado);
    const q = crearServicioQuimico({ modo: 'inmediato' });
    const m = MundoMaterial.levantar(tiles, q, { fisica: A.fisica, hilos, semilla: A.semilla });
    const clima = tiempo(A.semilla), cada = A.cada;
    let t = 0;
    // Calentamiento en el hilo principal: que la química conozca las mezclas antes de repartir (cada hilo tiene la suya).
    m.dueno.fill(0);
    for (; t < 30 * cada; t += cada) { m.prepararPaso(); m.pasarLocal(clima(t, cada)); m.recibir(); }
    for (let p = 0; p < m.np; p++) m.dueno[p] = p % hilos;
    const d: DescriptorMundo = { ...m.d, sustancias: serializarSustancias(q) };
    const base = q.totalSustancias();
    const workers = hilos > 1 ? Array.from({ length: hilos }, (_, h) => new Worker(new URL(import.meta.url), { workerData: { mundoMaterial: true, d, hilo: h } })) : [];
    const pasos = 50;
    let ms = 0, divergen = 0;
    for (let k = 0; k < pasos; k++, t += cada) {
      const f = clima(t, cada);
      m.prepararPaso();
      const t0 = performance.now();
      if (hilos === 1) m.pasar(f);
      else {
        const fase = (msg: Forzamiento | 'recibir') => Promise.all(workers.map((wk) => new Promise<{ sustancias: number }>((ok) => { wk.once('message', ok); wk.postMessage(msg); })));
        const r = await fase(f);
        await fase('recibir');
        divergen = Math.max(divergen, ...r.map((x) => x.sustancias - base));
      }
      ms += performance.now() - t0;
    }
    await Promise.all(workers.map((wk) => wk.terminate()));
    const us = 1000 * ms / pasos / m.n / cada, bytes = m.bytes() / m.n;
    out[hilos] = { us, msPaso: ms / pasos, bytes, divergen };
    console.log(`\n(f) ${hilos} hilo(s): ${(ms / pasos).toFixed(1)} ms por paso de ${cada} ticks → ${us.toFixed(2)} µs por tesela y tick; memoria ${bytes.toFixed(0)} B por tesela; sustancias nuevas en los hilos: ${divergen}; ${carga()}`);
    console.log(`  proyección a 60.000 teselas activas: ${(us * 60000 / 1000).toFixed(1)} ms por tick (paso cada ${cada}), ${(us * 60000 * cada / 1000).toFixed(0)} ms por paso; memoria ${(bytes * 60000 / 1e6).toFixed(0)} MB`);
    await q.cerrar();
  }
  return out;
}

// ── Worker: un hilo de la sombra ──
if (!isMainThread && (workerData as { mundoMaterial?: boolean } | null)?.mundoMaterial) {
  const { d, hilo } = workerData as { d: DescriptorMundo; hilo: number };
  const m = MundoMaterial.conectar(d, hilo);
  parentPort!.on('message', (f: Forzamiento | 'recibir') => {
    const t0 = performance.now();
    if (f === 'recibir') m.recibir(); else m.pasarLocal(f);
    parentPort!.postMessage({ ms: performance.now() - t0, sustancias: (m.quimica as ServicioQuimicoImpl).totalSustancias() });
  });
} else if (isMainThread) await principal();
