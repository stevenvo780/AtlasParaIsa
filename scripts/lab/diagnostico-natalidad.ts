/**
 * Embudo de natalidad (instrumento de diagnóstico, 2026-09-22): en cada comprobación de
 * `reproduce()` (cada `poblacion.intervaloComprobacionTicks` pasos) cuenta cuántos vecinos mortales
 * superan cada condición de la ley vigente (src/world/index.ts `reproduce`/`fertile`,
 * src/world/family.ts `reproductiveReadiness`), para saber QUÉ condición bloquea los nacimientos.
 * Con `v23.natalidad` el embudo es el de la ley nueva (`embudoLey`): la primera causa de `causaNoCria` por mortal y
 * cuántos fértiles tienen a alguien que aporta, no pariente, en contacto (`radioPareja`) y al alcance del cortejo.
 * No cambia el mundo: solo lee. Uso: --seed N --dias D [--params "..."] [--salida fichero.json]
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, stepWorld, TICKS_PER_DAY, type World, type Person } from '../../src/world/index.js';
import { parseParams, paramsOf } from '../../src/world/params.js';
import { demographicTraits, updateDemography } from '../../src/world/demography.js';
import { closeKin } from '../../src/world/family.js';
import { balanceDeMundo, causaNoAporta, causaNoCria, estadoCria } from '../../src/world/natalidad.js';
import { Store } from '../../src/server/store.js';

function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; }
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

interface Embudo { comprobaciones: number; mortales: number; inventario: number; cooldown: number; madurez: number; noSenescente: number; cuerpoApto: number; fertil: number; comunidad: number; lugar: number; pareja: number; parejaSinVinculo: number; parejaSinDistancia: number }
const vacio = (): Embudo => ({ comprobaciones: 0, mortales: 0, inventario: 0, cooldown: 0, madurez: 0, noSenescente: 0, cuerpoApto: 0, fertil: 0, comunidad: 0, lugar: 0, pareja: 0, parejaSinVinculo: 0, parejaSinDistancia: 0 });

function embudo(world: World, acc: Embudo): void {
  const cuerpo = paramsOf(world).cuerpo;
  acc.comprobaciones++;
  const mortales = world.people.filter(p => p.role === 'neighbor');
  const info = new Map<Person, { fertil: boolean; comunidad: boolean }>();
  for (const p of mortales) {
    acc.mortales++;
    const traits = demographicTraits(p.genome, cuerpo);
    const inventario = p.inventory >= 0.1; if (inventario) acc.inventario++;
    const cooldown = world.tick - p.lastBirth >= traits.fertilityCooldown; if (cooldown) acc.cooldown++;
    const madurez = p.demography.age >= traits.maturityAge; if (madurez) acc.madurez++;
    const noSen = p.demography.age < traits.senescenceStart; if (noSen) acc.noSenescente++;
    const apto = updateDemography({ state: p.demography, traits, hunger: p.hunger, thirst: p.thirst, energy: p.energy, fatigue: p.fatigue }, { exposure: 0, shelter: 0, protected: false }, 0).offspringEligible;
    if (apto) acc.cuerpoApto++;
    const fertil = inventario && cooldown && apto; if (fertil) acc.fertil++;
    const comunidad = !!p.communityId; if (comunidad) acc.comunidad++;
    info.set(p, { fertil, comunidad });
  }
  for (const a of mortales) {
    const ia = info.get(a)!; if (!ia.fertil || !ia.comunidad) continue;
    const lugar = world.places.some(pl => dist(a, pl) <= 4); if (lugar) acc.lugar++;
    let pareja = false, sinVinculo = false, sinDistancia = false;
    for (const b of mortales) {
      if (b === a) continue; const ib = info.get(b)!; if (!ib.fertil || !ib.comunidad || closeKin(a, b)) continue;
      const cerca = dist(a, b) <= 3, vinculo = (a.bonds[b.id] ?? 0) >= 0.3 && (b.bonds[a.id] ?? 0) >= 0.3;
      if (cerca && vinculo) { pareja = true; break; }
      if (cerca && !vinculo) sinVinculo = true; if (!cerca && vinculo) sinDistancia = true;
    }
    if (pareja && lugar) acc.pareja++; else if (sinVinculo) acc.parejaSinVinculo++; else if (sinDistancia) acc.parejaSinDistancia++;
  }
}

/** Embudo de `v23.natalidad`: por comprobación, mortales según la primera causa que les impide concebir, y de los
 * fértiles, cuántos tienen a ≤ `radioPareja` (y a ≤ `radioCortejo`) a alguien que aporta y no es pariente. */
function embudoLey(world: World, acc: Record<string, number>): void {
  const b = balanceDeMundo(world);
  if (!b) return;
  const suma = (k: string) => { acc[k] = (acc[k] ?? 0) + 1; };
  const { radioPareja, radioCortejo } = paramsOf(world).poblacion;
  suma('comprobaciones');
  const mortales = world.people.filter(p => p.role === 'neighbor');
  const estados = new Map(mortales.map(p => [p, estadoCria(world, p, b)] as const));
  for (const a of mortales) {
    suma('mortales');
    const causa = causaNoCria(estados.get(a)!);
    suma(causa ?? 'fertil');
    if (b.enCurso(a)?.bajoBasalDesde !== undefined && b.enCurso(a)!.bajoBasalDesde >= 0) suma('gestandoBajoBasal');
    if (causa !== null) continue;
    let contacto = false, cortejo = false;
    for (const q of mortales) {
      if (q === a || closeKin(a, q) || causaNoAporta(estados.get(q)!) !== null) continue;
      const d = dist(a, q);
      if (d <= radioPareja) { contacto = true; break; }
      if (d <= radioCortejo) cortejo = true;
    }
    if (contacto) suma('fertilConContacto'); else if (cortejo) suma('fertilConCortejo'); else suma('fertilSinNadie');
  }
}

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 42), dias = Number(arg('--dias') ?? 5), salida = arg('--salida');
  const params = parseParams(arg('--params'));
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-diag-')); process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    const world = createWorld(seed, params); store.save(world);
    const intervalo = params.poblacion.intervaloComprobacionTicks, filas: Record<string, unknown>[] = [];
    let acc = vacio();
    const conLey = params.v23.natalidad;
    let accLey: Record<string, number> = {};
    for (let tick = 1; tick <= dias * TICKS_PER_DAY; tick++) {
      if ((world.tick + 1) % intervalo === 0) { if (conLey) embudoLey(world, accLey); else embudo(world, acc); }
      stepWorld(world);
      if (tick % params.persistencia.cadaTicks === 0) store.save(world);
      if (conLey && tick % TICKS_PER_DAY === 0) {
        const n = accLey.comprobaciones || 1;
        const fila = { dia: tick / TICKS_PER_DAY, poblacion: world.people.length, nacimientos: world.totals.births ?? 0,
          media: Object.fromEntries(Object.entries(accLey).filter(([k]) => k !== 'comprobaciones').map(([k, v]) => [k, Math.round(v / n * 100) / 100])) };
        filas.push(fila); console.log(JSON.stringify(fila)); accLey = {};
      } else if (tick % TICKS_PER_DAY === 0) {
        const n = acc.comprobaciones || 1, media = (v: number) => Math.round(v / n * 100) / 100;
        const fila = { dia: tick / TICKS_PER_DAY, poblacion: world.people.length, nacimientos: world.birthCounter, lugares: world.places.length,
          media: { mortales: media(acc.mortales), inventario: media(acc.inventario), cooldown: media(acc.cooldown), madurez: media(acc.madurez), noSenescente: media(acc.noSenescente), cuerpoApto: media(acc.cuerpoApto), fertil: media(acc.fertil), comunidad: media(acc.comunidad), fertilConComunidadYLugar: media(acc.lugar), conPareja: media(acc.pareja), bloqueadoPorVinculo: media(acc.parejaSinVinculo), bloqueadoPorDistancia: media(acc.parejaSinDistancia) } };
        filas.push(fila); console.log(JSON.stringify(fila)); acc = vacio();
      }
    }
    if (salida) writeFileSync(salida, JSON.stringify({ seed, dias, params, filas }, null, 2) + '\n');
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}
main().catch(e => { console.error((e as Error).stack ?? String(e)); process.exitCode = 1; });
