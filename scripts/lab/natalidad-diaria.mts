/** Censo de natalidad de un solo dueño, en JSONL. Cada fila incluye las transiciones entre el censo anterior y el actual.
 * npx tsx scripts/lab/natalidad-diaria.mts --semilla 7 --regimen abierto --dias 6 --hasta intentos
 * `--desde punto.atlas-punto` continúa un mundo guardado sobre su régimen original.
 * Para comparar con el mundo escalar, corre desde semilla con `--hasta comunidades`; con átomos usa `--hasta obra`.
 * `--dias` es la duración desde el arranque o punto guardado. `--ticks` permite una sonda parcial. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import { escalon, INTERRUPTORES, type Interruptor } from '../../src/shared/interruptores.js';
import { SALUD_FERTIL } from '../../src/shared/naturaleza.js';
import { createWorld, stepWorld, TICKS_PER_DAY as DIA, type Person, type World } from '../../src/world/index.js';
import { closeKin } from '../../src/world/family.js';
import { entorno, masaLote, plantillaDe } from '../../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../../src/world/motor/acceso.js';
import { balanceDeMundo, causaNoAporta, causaNoCria, estadoCria, type Balance } from '../../src/world/natalidad.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, type WorldParams } from '../../src/world/params.js';
import { archivoDeChunks, cargarPunto } from './poblacion.mjs';

type CausaAbortiva = 'reserva' | 'agua' | 'nutrientes' | 'materia' | 'sin-evidencia';
interface Bloqueo {
  tick: number;
  reserva: number;
  basalDiario: number;
  aguaFaltante: boolean;
  nutrientesFaltantes: number[];
  causas: CausaAbortiva[];
}
interface Gestacion {
  inicio: number;
  otroId?: string;
  bajoBasalDesde: number;
}
interface PersonaObservada { persona: Person; x: number; y: number; gestacion?: Gestacion; bloqueo?: Bloqueo }
interface Nacimiento { tick: number; muerte?: { tick: number; causa: string } }

const sumar = (tabla: Record<string, number>, clave: string) => { tabla[clave] = (tabla[clave] ?? 0) + 1; };
const diasDe = (ticks: number) => ticks / DIA;

function resumen(datos: number[]) {
  if (!datos.length) return null;
  datos.sort((a, b) => a - b);
  const mediana = (datos[Math.floor((datos.length - 1) / 2)]! + datos[Math.floor(datos.length / 2)]!) / 2;
  return { n: datos.length, min: datos[0], mediana, max: datos.at(-1) };
}

/** El estado después del paso permite identificar carencias concurrentes. La etiqueta del evento histórico no las
 * distingue. «Materia» significa que la síntesis se detuvo aunque en esta observación había para una unidad. */
function bloqueoDe(mundo: World, p: Person, b: Balance): Bloqueo {
  const reserva = b.reserva(p), basalDiario = b.basal(p, DIA), causas: CausaAbortiva[] = [];
  if (reserva < basalDiario) causas.push('reserva');
  const falta: number[] = [];
  let aguaFaltante = false;
  if (p.cuerpo) {
    const c = ctxMateriaDe(mundo), { reserva: r, digestivo: d } = p.cuerpo;
    const g = b.enCurso(p);
    if (g && g.masa + g.grano < g.m0) {
      const h2o = entorno.sustancias(c).H2O;
      for (const { id, nu } of plantillaDe(c, p.cuerpo).sintesis.entradas) {
        if (c.materia.cuantos(r, id) + c.materia.cuantos(d, id) >= nu) continue;
        if (id === h2o) aguaFaltante = true;
        else falta.push(id);
      }
      if (aguaFaltante) causas.push('agua');
      if (falta.length) causas.push('nutrientes');
      if (!causas.length) causas.push('materia');
    }
  }
  if (!causas.length) causas.push('sin-evidencia');
  return { tick: mundo.tick, reserva, basalDiario, aguaFaltante, nutrientesFaltantes: falta, causas };
}

function distanciaEntre(origen: Person[], destino: Person[], radioPareja: number, radioCortejo: number) {
  const porDistancia: Record<string, number> = {}, minimas: number[] = [];
  let conContacto = 0;
  for (const p of origen) {
    let minima = Infinity;
    for (const q of destino) {
      if (p === q) continue;
      const distancia = Math.hypot(p.x - q.x, p.y - q.y), pariente = closeKin(p, q);
      const alcance = distancia <= radioPareja ? 'contacto' : distancia <= radioCortejo ? 'cortejo' : 'lejos';
      sumar(porDistancia, `${pariente ? 'parientes' : 'compatibles'}_${alcance}`);
      if (!pariente) minima = Math.min(minima, distancia);
    }
    if (Number.isFinite(minima)) minimas.push(minima);
    if (minima <= radioPareja) conContacto++;
  }
  return { porDistancia, conContacto, distanciaCompatibleMinima: resumen(minimas) };
}

const cohorteVacia = () => ({ edadDias: [] as number[], tejidoKg: [] as number[], fraccionMasaAdulta: [] as number[],
  saludEnEdadFertil: [] as number[], alcanzaronEdadFertil: 0, enEdadFertil: 0, masaFertilEnEdad: 0, sinAportePorSalud: 0 });

function censoParejas(mundo: World, vivos: Person[], b: Balance) {
  const { poblacion: { radioPareja, radioCortejo }, v23 } = paramsOf(mundo), c = v23.cuerpos ? ctxMateriaDe(mundo) : undefined;
  const aporta: Person[] = [], gesta: Person[] = [], cohortes = new Map<number, ReturnType<typeof cohorteVacia>>();
  const bloqueos: Record<string, number> = {}, duracion: number[] = [], reservaSobreCoste: number[] = [];
  for (const p of vivos) {
    const e = estadoCria(mundo, p, b), generacion = p.genome.generation;
    let cohorte = cohortes.get(generacion);
    if (!cohorte) { cohorte = cohorteVacia(); cohortes.set(generacion, cohorte); }
    cohorte.edadDias.push(diasDe(e.edad));
    const kg = c && p.cuerpo ? masaLote(c, p.cuerpo.tejido) : undefined;
    const masaAdulta = c && p.cuerpo ? plantillaDe(c, p.cuerpo).masaAdulta : undefined;
    const fraccion = kg !== undefined && masaAdulta !== undefined ? kg / masaAdulta : undefined;
    if (kg !== undefined) cohorte.tejidoKg.push(kg);
    if (fraccion !== undefined) cohorte.fraccionMasaAdulta.push(fraccion);
    if (e.edad >= e.madurez) cohorte.alcanzaronEdadFertil++;
    const causaAporte = causaNoAporta(e);
    if (e.edad >= e.madurez && e.edad < e.vejez) {
      cohorte.enEdadFertil++;
      cohorte.saludEnEdadFertil.push(e.salud);
      if (fraccion !== undefined && fraccion >= SALUD_FERTIL) cohorte.masaFertilEnEdad++;
      if (causaAporte === 'salud') cohorte.sinAportePorSalud++;
      duracion.push(diasDe(e.vejez - e.madurez));
      if (e.coste > 0) reservaSobreCoste.push(e.reserva / e.coste);
    }
    if (causaAporte === null) aporta.push(p);
    const causa = causaNoCria(e);
    if (causa === null) gesta.push(p);
    else sumar(bloqueos, causa);
  }
  const parejas = distanciaEntre(gesta, aporta, radioPareja, radioCortejo);
  return { enEdadFertil: duracion.length, puedenAportar: aporta.length, puedenConcebir: gesta.length, bloqueos,
    duracionFertilDias: resumen(duracion), reservaSobreCoste: resumen(reservaSobreCoste), parejasPosibles: parejas.porDistancia,
    gestantesConContacto: parejas.conContacto, distanciaCompatibleMinima: parejas.distanciaCompatibleMinima,
    entreDonantes: distanciaEntre(aporta, aporta, radioPareja, radioCortejo),
    cohortes: Object.fromEntries([...cohortes].map(([generacion, datos]) => {
      const { edadDias, tejidoKg, fraccionMasaAdulta, saludEnEdadFertil, masaFertilEnEdad, ...conteos } = datos;
      return [generacion, { vivos: edadDias.length, ...conteos, edadDias: resumen(edadDias), tejidoKg: resumen(tejidoKg),
        fraccionMasaAdulta: resumen(fraccionMasaAdulta), saludEnEdadFertil: resumen(saludEnEdadFertil),
        masaFertilEnEdad: c ? masaFertilEnEdad : null }];
    })) };
}

function supervivencia(crias: ReadonlyMap<string, Nacimiento>, tick: number) {
  return Object.fromEntries([1, 3, 10].map(h => {
    let evaluables = 0, sobreviven = 0;
    const muertesPorCausa: Record<string, number> = {};
    for (const cria of crias.values()) {
      const fin = cria.tick + h * DIA;
      if (fin > tick) continue;
      evaluables++;
      if (!cria.muerte || cria.muerte.tick > fin) sobreviven++;
      else sumar(muertesPorCausa, cria.muerte.causa);
    }
    return [h, { evaluables, sobreviven, muertesPorCausa }];
  }));
}

const gestacionDe = (p: Person) => p.cuerpo?.gestacion ?? p.gestacion;
const censoVacio = () => ({ concepciones: 0, gestacionesIniciadas: 0, paresReproductivosNuevos: 0,
  distanciaAlConcebir: [] as number[], concepcionesEntreParientes: 0, donanteNoObservado: 0, partos: 0,
  abortos: [] as { tick: number; causaCrónica?: string; bloqueo?: Bloqueo }[], perdidasPorMuerteMaterna: {} as Record<string, number>,
  edadMuerteAdultaDias: {} as Record<string, number[]>, diasFertilesAlMorir: {} as Record<string, number[]>,
  muertesCrías: {} as Record<string, number> });

function medir(mundo: World, archivo: Map<string, Buffer> | undefined, ticks: number, tope?: number) {
  const { archivar } = archivoDeChunks(mundo, archivo), params = paramsOf(mundo), fin = mundo.tick + ticks;
  const crias = new Map<string, Nacimiento>(), pares = new Set<string>();
  let vivos = new Map<string, PersonaObservada>();
  for (const p of mundo.people) if (p.role === 'neighbor') {
    vivos.set(p.id, { persona: p, x: p.x, y: p.y, gestacion: gestacionDe(p) });
  }
  let dia = censoVacio(), ultimoCenso = mundo.tick;
  const emitir = (tipo: string, campos: Record<string, unknown>) => console.log(JSON.stringify({ tipo, semilla: mundo.seed, tick: mundo.tick, ...campos }));
  emitir('inicio', { duracionTicks: ticks, atomos: params.v23.cuerpos, interruptores: params.v23,
    sexo: 'El modelo no tiene sexos: los roles de gestar y aportar genoma se solapan.',
    parejas: 'Pares dirigidos gestante–donante y donante–donante en el censo. Las formadas son pares únicos observados al concebir.',
    abortos: 'Las causas muestran carencias concurrentes en la última observación del bloqueo, no una atribución causal exclusiva.',
    poblacion: vivos.size, mortales: [...vivos.values()].map(({ persona: p }) => ({ id: p.id, edadDias: diasDe(p.demography.age) })) });
  while (mundo.tick < fin) {
    const legadoPrevio = mundo.retiredLegacy.length;
    stepWorld(mundo);
    const ahora = new Map<string, PersonaObservada>();
    const madresConParto = new Set<string>();
    const b = balanceDeMundo(mundo);
    if (!b) throw new Error('El paso no publicó un balance de natalidad.');
    for (const p of mundo.people) {
      if (p.role !== 'neighbor') continue;
      const antes = vivos.get(p.id), gestacion = gestacionDe(p);
      ahora.set(p.id, { persona: p, x: p.x, y: p.y, gestacion, bloqueo: antes?.bloqueo });
      if (!antes) {
        crias.set(p.id, { tick: p.bornAt });
        dia.partos++;
        const madre = p.genome.parents[0];
        if (madre !== undefined) madresConParto.add(madre);
      }
      if (!gestacion) continue;
      if (gestacion.inicio === mundo.tick) {
        dia.concepciones++; dia.gestacionesIniciadas++;
        const otro = gestacion.otroId, donante = otro === undefined ? undefined : vivos.get(otro);
        if (otro !== undefined) {
          const par = [p.id, otro].sort().join('|');
          if (!pares.has(par)) { pares.add(par); dia.paresReproductivosNuevos++; }
        }
        if (donante) {
          // F5 elige con la posición de la gestante tras moverse y la del donante publicada en el frente previo.
          dia.distanciaAlConcebir.push(Math.hypot(p.x - donante.x, p.y - donante.y));
          if (closeKin(p, donante.persona)) dia.concepcionesEntreParientes++;
        } else dia.donanteNoObservado++;
      }
      if (gestacion.bajoBasalDesde >= 0) ahora.get(p.id)!.bloqueo = bloqueoDe(mundo, p, b);
      else ahora.get(p.id)!.bloqueo = undefined;
    }
    for (const [id, antes] of vivos) {
      const despues = ahora.get(id);
      if (!despues) {
        const muerte = mundo.retiredLegacy.slice(legadoPrevio).find(r => r.id === id);
        if (!muerte) throw new Error(`Mortal ${id} desapareció sin registro de muerte en tick ${mundo.tick}.`);
        const edad = muerte.diedAt - muerte.bornAt, cria = crias.get(id);
        if (cria) cria.muerte = { tick: muerte.diedAt, causa: muerte.cause };
        const { maturityAge, senescenceStart } = muerte.traits;
        if (edad >= maturityAge) {
          (dia.edadMuerteAdultaDias[muerte.cause] ??= []).push(diasDe(edad));
          (dia.diasFertilesAlMorir[muerte.cause] ??= []).push(diasDe(Math.min(edad, senescenceStart) - maturityAge));
        } else sumar(dia.muertesCrías, muerte.cause);
        if (antes.gestacion) sumar(dia.perdidasPorMuerteMaterna, muerte.cause);
      } else if (antes.gestacion && !despues.gestacion && !madresConParto.has(id)) {
        const evento = mundo.events.find(e => e.tick === mundo.tick && e.kind === 'care' && e.actors[0] === id && e.text.endsWith('perdió la gestación.'));
        dia.abortos.push({ tick: mundo.tick, causaCrónica: evento?.cause, bloqueo: antes.bloqueo });
      }
    }
    vivos = ahora;
    if (mundo.tick % DIA === 0 || mundo.tick === fin || vivos.size === 0) {
      const { distanciaAlConcebir, ...transiciones } = dia;
      const gestacionesEnCurso = [...vivos.values()].filter(p => p.gestacion);
      emitir('censo', { dia: diasDe(mundo.tick), desdeTick: ultimoCenso, poblacion: vivos.size,
        ...censoParejas(mundo, [...vivos.values()].map(p => p.persona), b), ...transiciones,
        distanciaAlConcebir: resumen(distanciaAlConcebir), gestacionesEnCurso: gestacionesEnCurso.length,
        gestacionesEstancadas: gestacionesEnCurso.filter(p => p.bloqueo).length,
        nacimientosAcumulados: mundo.totals.births ?? 0, muertesAcumuladas: mundo.demographyDynamics.causes,
        supervivenciaCrías: supervivencia(crias, mundo.tick) });
      dia = censoVacio(); ultimoCenso = mundo.tick; archivar();
      if (vivos.size === 0 || (tope !== undefined && vivos.size >= tope)) break;
    }
  }
  emitir('fin', { poblacion: vivos.size, dia: diasDe(mundo.tick) });
}

function entero(texto: string, opcion: string, minimo = 1): number {
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n < minimo) throw new Error(`--${opcion} exige un entero ≥ ${minimo}.`);
  return n;
}

const { values } = parseArgs({ options: {
  semilla: { type: 'string' }, dias: { type: 'string', default: '6' }, ticks: { type: 'string' },
  hasta: { type: 'string' }, desde: { type: 'string' }, params: { type: 'string' }, 'tope-mortales': { type: 'string' },
  regimen: { type: 'string', default: 'defecto' },
} });
if (values.regimen !== 'defecto' && values.regimen !== 'abierto') throw new Error('--regimen admite defecto o abierto.');
function ajustarParams(base: WorldParams): WorldParams {
  let params = values.params ? parseParams(JSON.parse(readFileSync(values.params, 'utf8')), base) : base;
  const hasta = (values.hasta ?? (values.desde ? undefined : 'intentos')) as Interruptor | undefined;
  if (hasta) {
    if (!INTERRUPTORES.includes(hasta)) throw new Error(`--hasta: ${hasta} no es un interruptor V23.`);
    params = parseParams({ v23: { ...escalon(hasta), cadenciaMateria: params.v23.cadenciaMateria } }, params);
  }
  if (!params.v23.natalidad) throw new Error('El censo requiere la ley de natalidad V23.');
  return parseParams({ motor: { ...params.motor, hilos: 1, gpu: [] } }, params);
}
const punto = values.desde ? cargarPunto(values.desde, ajustarParams) : undefined;
const semilla = entero(values.semilla ?? '7', 'semilla', 0);
if (punto && values.semilla !== undefined && punto.mundo.seed !== semilla) {
  throw new Error('La semilla pedida y la del punto guardado no coinciden.');
}
const mundo = punto?.mundo ?? createWorld(semilla, ajustarParams(values.regimen === 'abierto' ? hostOpenWorldParams() : DEFAULT_PARAMS));
medir(mundo, punto?.archivo, values.ticks ? entero(values.ticks, 'ticks') : entero(values.dias, 'dias') * DIA,
  values['tope-mortales'] ? entero(values['tope-mortales'], 'tope-mortales') : undefined);
