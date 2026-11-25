/**
 * Laboratorio del carril S (V23, experimento C1): una semilla, un solo hilo, N días, y por cada día las medidas
 * de las comunidades y de la red de vínculos. Sirve para el mundo de antes y el de después: `--raiz` apunta al
 * árbol de código que se mide (un `git archive` del commit base para el «antes»; por defecto, el actual), y sólo
 * se leen campos que los dos tienen (`communities`, `communityId`, `bonds`).
 * La ley nueva (`src/world/comunidades.ts`) va detrás de su interruptor: para medirla, `--params v23.comunidades=true`
 * (y `v23.intentos=true` para que los actos sociales escriban por lado); sin él se mide la ley de hoy.
 * «mutuos» cuenta los vínculos mutuos ≥ 0,3; la ley solo une los cerrados en tríadas, así que una comunidad puede
 * tener menos miembros de los que sugieren los mutuos.
 *
 *   npx tsx scripts/lab/comunidades.mts --semilla 51926 --dias 20 --salida /tmp/atlas-v23-s/despues-51926.jsonl \
 *     [--raiz DIR] [--params social.maxComunidades=64,…] [--tope-mortales 300]
 *   npx tsx scripts/lab/comunidades.mts --resumen antes=a1.jsonl,a2.jsonl despues=d1.jsonl,d2.jsonl
 *     (tablas por día, mediana entre semillas, y el veredicto de C1 de cada semilla)
 *
 * Filas de salida (JSONL): `inicio` (argumentos y carga de la torre), una `dia` por día y `fin`.
 * Cada `dia` trae: población; comunidades (número, tamaño mediana/p90/máximo, fracción de mortales con comunidad,
 * mayor número de miembros a ≤ RADIUS de su centro, dispersión de la mayor); vínculos (por persona: total, fuertes
 * > 0,5, mutuos ≥ 0,3; máximo de fuertes); cambios de etiqueta por persona y día; y ms por tick de las fases
 * «encuentros» (encounters + convivir) y «comunidades».
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Opciones { raiz: string; semilla: number; dias: number; salida: string; params: string; topeMortales: number; }

function leer(args: string[]): Opciones {
  const o: Opciones = { raiz: process.cwd(), semilla: 51926, dias: 20, salida: '', params: '', topeMortales: 0 };
  for (let i = 0; i < args.length; i += 2) {
    const valor = args[i + 1];
    if (valor === undefined) throw new Error(`Falta valor para ${args[i]}`);
    switch (args[i]) {
      case '--raiz': o.raiz = resolve(valor); break;
      case '--semilla': o.semilla = Number(valor); break;
      case '--dias': o.dias = Number(valor); break;
      case '--salida': o.salida = resolve(valor); break;
      case '--params': o.params = valor; break;
      case '--tope-mortales': o.topeMortales = Number(valor); break;
      default: throw new Error(`Opción desconocida: ${args[i]}`);
    }
  }
  if (!o.salida || !Number.isSafeInteger(o.semilla) || !Number.isSafeInteger(o.dias) || o.dias < 1) throw new Error('Faltan --salida, o --semilla/--dias inválidos');
  return o;
}

const percentil = (ordenado: number[], q: number): number => ordenado.length ? ordenado[Math.min(ordenado.length - 1, Math.floor(q * ordenado.length))]! : 0;
const media = (xs: number[]): number => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

type Fila = Record<string, number>;
interface Corrida { semilla: number; dias: Fila[]; }
function cargar(ruta: string): Corrida {
  const filas = readFileSync(ruta, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { semilla: filas.find(f => f.tipo === 'inicio').semilla, dias: filas.filter(f => f.tipo === 'dia') };
}
const mediana = (xs: number[]) => percentil([...xs].sort((a, b) => a - b), 0.5);
const f = (x: number | undefined, d = 1) => x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(d);

/** Veredicto de C1 (leyes-opus §b) para una corrida: cuatro condiciones de fallo, con el día en que ocurren. El día 1 no
 * cuenta para la oscilación: es cuando las comunidades se forman por primera vez y todo el mundo pasa de ninguna a una. */
function veredictoC1(r: Corrida): { fallos: string[]; metricas: Record<string, number> } {
  const RADIUS = 7, fallos: string[] = [];
  for (const d of r.dias) if (d.dispersionMayor > 2 * RADIUS && d.tamMax > 0.6 * d.poblacion) fallos.push(`día ${d.dia}: comunidad de ${d.tamMax}/${d.poblacion} con dispersión ${f(d.dispersionMayor)} > ${2 * RADIUS}`);
  for (const d of r.dias) if (d.dia > 1 && d.cambiosEtiquetaPorPersonaDia > 2) fallos.push(`día ${d.dia}: ${f(d.cambiosEtiquetaPorPersonaDia, 2)} cambios de etiqueta por persona y día > 2`);
  let seguidos = 0, peor = 0;
  for (const d of r.dias) { if (d.mortales >= 20 && d.miembrosCercaMax < 20) peor = Math.max(peor, ++seguidos); else seguidos = 0; }
  if (peor > 2) fallos.push(`${peor} días seguidos con ≥ 20 mortales y ninguna comunidad con ≥ 20 a ≤ ${RADIUS} celdas`);
  const ultimo = r.dias.at(-1)!;
  if (ultimo.fuertesMediana > 150) fallos.push(`grado fuerte mediano ${ultimo.fuertesMediana} > 150 en el día ${ultimo.dia}`);
  return { fallos, metricas: { diasSinComunidadMax: peor, cambiosEtiquetaMax: Math.max(0, ...r.dias.filter(d => d.dia > 1).map(d => d.cambiosEtiquetaPorPersonaDia)) } };
}

/** Tablas por brazo: para cada día, la mediana entre semillas de cada métrica, y el veredicto de C1 por semilla. */
function resumir(brazos: Map<string, Corrida[]>): string {
  const salida: string[] = [];
  const columnas: [string, string, number][] = [['mortales', 'mortales', 0], ['comunidades', 'comunid.', 1], ['tamMediana', 'tam med', 1], ['tamP90', 'tam p90', 1], ['tamMax', 'tam máx', 0],
    ['fraccionMortalesConComunidad', 'frac. con com.', 2], ['vinculosPorPersona', 'víncs/pers', 1], ['fuertesPorPersona', 'fuertes/pers', 1], ['mutuosPorPersona', 'mutuos≥0,3/pers', 1],
    ['cambiosEtiquetaPorPersonaDia', 'cambios etiq./pers·día', 2], ['msEncuentrosPorTick', 'ms/tick encuentros', 3], ['msComunidadesPorTick', 'ms/tick comunidades', 3]];
  for (const [nombre, corridas] of brazos) {
    salida.push(`### ${nombre} (${corridas.length} semillas: ${corridas.map(c => c.semilla).join(', ')}; mediana entre semillas)`, '',
      `| día | ${columnas.map(c => c[1]).join(' | ')} |`, `|${'---|'.repeat(columnas.length + 1)}`);
    const hasta = Math.max(...corridas.map(c => c.dias.at(-1)!.dia));
    for (let dia = 0; dia <= hasta; dia++) {
      const filas = corridas.map(c => c.dias.find(d => d.dia === dia)).filter((d): d is Fila => d !== undefined);
      if (filas.length) salida.push(`| ${dia}${filas.length < corridas.length ? ` (${filas.length})` : ''} | ${columnas.map(([k, , dec]) => f(mediana(filas.map(d => d[k]!)), dec)).join(' | ')} |`);
    }
    salida.push('', 'C1 por semilla:');
    for (const c of corridas) { const v = veredictoC1(c); salida.push(`- ${c.semilla} (${c.dias.at(-1)!.dia} días, ${c.dias.at(-1)!.mortales} mortales al final): ${v.fallos.length ? 'FALLA — ' + v.fallos.join('; ') : 'cumple'}; cambios de etiqueta máx. ${f(v.metricas.cambiosEtiquetaMax, 2)}/pers·día, días sin comunidad ≥ 20: ${v.metricas.diasSinComunidadMax}`); }
    salida.push('');
  }
  return salida.join('\n');
}

async function main(): Promise<void> {
  if (process.argv[2] === '--resumen') {
    const brazos = new Map<string, Corrida[]>();
    for (const arg of process.argv.slice(3)) { const [nombre, rutas] = arg.split('='); brazos.set(nombre!, rutas!.split(',').map(cargar)); }
    process.stdout.write(`${resumir(brazos)}\n`);
    return;
  }
  const o = leer(process.argv.slice(2));
  const importar = (ruta: string) => import(pathToFileURL(join(o.raiz, 'src', ruta)).href);
  const { createWorld, stepWorld, TICKS_PER_DAY } = await importar('world/index.ts') as typeof import('../../src/world/index.js');
  const { parseParams, DEFAULT_PARAMS } = await importar('world/params.ts') as typeof import('../../src/world/params.js');
  const { hostOpenWorldParams } = await importar('server/hardware-limits.ts') as typeof import('../../src/server/hardware-limits.js');
  const { bindWorldContext } = await importar('world/spatial.ts') as typeof import('../../src/world/spatial.js');
  const RADIUS = 7;
  let params = hostOpenWorldParams();
  if (o.params) params = parseParams(o.params, params);
  params = parseParams({ motor: { ...params.motor, hilos: 1, gpu: [] } }, params);
  void DEFAULT_PARAMS;
  const mundo = createWorld(o.semilla, params);
  bindWorldContext(mundo, { loadChunk: () => null });
  writeFileSync(o.salida, '');
  const escribir = (fila: unknown) => appendFileSync(o.salida, `${JSON.stringify(fila)}\n`);
  escribir({ tipo: 'inicio', ...o, carga: loadavg(), params: { social: params.social } });

  const fases = { encuentros: 0, comunidades: 0 }, medicion = { clock: () => performance.now(), fases: {} as Record<string, number> };
  let cambios = 0, personasTick = 0, sinComunidadGrande = 0, ticks = 0;
  let anterior = new Map<string, string | null>();
  for (const p of mundo.people) anterior.set(p.id, p.communityId);
  const instantanea = (dia: number) => {
    const gente = mundo.people, mortales = gente.filter(p => p.role === 'neighbor');
    const miembros = new Map<string, typeof gente>();
    for (const p of gente) if (p.communityId !== null) { const l = miembros.get(p.communityId); if (l) l.push(p); else miembros.set(p.communityId, [p]); }
    const tamanos = [...miembros.values()].map(l => l.length).sort((a, b) => a - b);
    const mayor = [...miembros.values()].sort((a, b) => b.length - a.length)[0];
    let cercaMax = 0, dispersionMayor = 0;
    for (const lista of miembros.values()) {
      const cx = media(lista.map(p => p.x)), cy = media(lista.map(p => p.y));
      cercaMax = Math.max(cercaMax, lista.filter(p => Math.hypot(p.x - cx, p.y - cy) <= RADIUS).length);
    }
    if (mayor) { const cx = media(mayor.map(p => p.x)), cy = media(mayor.map(p => p.y)); dispersionMayor = Math.sqrt(media(mayor.map(p => (p.x - cx) ** 2 + (p.y - cy) ** 2))); }
    const grado = gente.map(p => Object.keys(p.bonds).length);
    const fuertes = gente.map(p => Object.values(p.bonds).filter(v => v > 0.5).length);
    const porId = new Map(gente.map(p => [p.id, p]));
    const mutuos = gente.map(p => Object.entries(p.bonds).filter(([id, v]) => v >= 0.3 && (porId.get(id)?.bonds[p.id] ?? 0) >= 0.3).length);
    sinComunidadGrande = cercaMax >= 20 ? 0 : sinComunidadGrande + 1;
    escribir({ tipo: 'dia', dia, tick: mundo.tick, poblacion: gente.length, mortales: mortales.length,
      comunidades: miembros.size, tamMediana: percentil(tamanos, 0.5), tamP90: percentil(tamanos, 0.9), tamMax: tamanos.at(-1) ?? 0,
      fraccionMortalesConComunidad: mortales.length ? mortales.filter(p => p.communityId !== null).length / mortales.length : 0,
      miembrosCercaMax: cercaMax, diasSinComunidadDe20: sinComunidadGrande, dispersionMayor,
      vinculosPorPersona: media(grado), fuertesPorPersona: media(fuertes), fuertesMediana: percentil([...fuertes].sort((a, b) => a - b), 0.5), fuertesMax: Math.max(0, ...fuertes), mutuosPorPersona: media(mutuos), mutuosMediana: percentil([...mutuos].sort((a, b) => a - b), 0.5),
      cambiosEtiquetaPorPersonaDia: personasTick ? cambios / (personasTick / TICKS_PER_DAY) : 0,
      msEncuentrosPorTick: fases.encuentros / Math.max(1, ticks), msComunidadesPorTick: fases.comunidades / Math.max(1, ticks),
      nacimientos: mundo.totals.births ?? 0, muertes: mundo.demographyDynamics.deaths, carga: loadavg()[0] });
    cambios = 0; personasTick = 0; ticks = 0; fases.encuentros = 0; fases.comunidades = 0;
  };
  instantanea(0);
  for (let dia = 1; dia <= o.dias; dia++) {
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      medicion.fases = {};
      stepWorld(mundo, [], undefined, medicion);
      fases.encuentros += medicion.fases.encuentros ?? 0; fases.comunidades += medicion.fases.comunidades ?? 0; ticks++;
      const actual = new Map<string, string | null>();
      for (const p of mundo.people) { actual.set(p.id, p.communityId); if (anterior.has(p.id) && anterior.get(p.id) !== p.communityId) cambios++; }
      personasTick += mundo.people.length; anterior = actual;
    }
    instantanea(dia);
    if (o.topeMortales && mundo.people.filter(p => p.role === 'neighbor').length >= o.topeMortales) { escribir({ tipo: 'fin', estado: 'tope', dia }); return; }
  }
  escribir({ tipo: 'fin', estado: 'completo' });
}

main().then(() => process.exit(0)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
