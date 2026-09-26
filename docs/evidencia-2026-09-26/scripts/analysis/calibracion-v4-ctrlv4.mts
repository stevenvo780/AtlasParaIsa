/** Calibración descriptiva de C8 en CTRLV4. Solo lee datos; nunca decide una lectura v4.
 * Uso: npx tsx scripts/analysis/calibracion-v4-ctrlv4.mts [--muestra]
 * Sin --muestra exige los 20 días 1..60 completos y escribe JSON y Markdown en balance/.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { evaluarConjunto, evaluarSerieDiversidad, mannKendall, UMBRALES_POR_DEFECTO,
  COBERTURA_MIN, TOLERANCIA_PLANA, type ResultadoCriterio } from '../lab/criterio-terminado.mjs';

const RAIZ = '/datos/tmp-atlas-lab/datos-lab/ctrlv4';
const SALIDA = '/datos/tmp-atlas-lab/balance';
const MUESTRA = process.argv.slice(2).includes('--muestra');
if (process.argv.slice(2).some(x => x !== '--muestra')) throw new Error('Uso: script [--muestra]');
type Dia = Record<string, unknown>;
type Estado = 'cumple' | 'falla' | 'desconocido';
type Medida = { estado: Estado; base: number; campo: string; puntos: number; media: number | null;
  p: number | null; subida: number | null; umbral: number | null; motivo?: string };
const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sub = (x: unknown, ...camino: string[]): unknown => camino.reduce<unknown>((a, k) =>
  a !== null && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>)[k] : undefined, x);
const estadoC8 = (r: ResultadoCriterio, base: number, campo: string): Medida => ({
  estado: r.estado, base, campo, puntos: Number(r.valores.puntos ?? 0), media: null,
  p: n(r.valores.p) ? r.valores.p : null,
  subida: n(r.valores.subida) ? r.valores.subida : null,
  umbral: 0.02, motivo: r.estado === 'desconocido' ? r.motivo : undefined,
});

/** Misma prueba exportada por el evaluador congelado; la escala de B/C impide usar su
 * evaluarSerieDiversidad, que exige valores en [0,1]. Conservamos sus reglas de cobertura,
 * bloques extremos y tolerancia. Sin huecos interiores para un aprobado: desconocido. */
function medir(dias: Map<number, Dia>, base: number, campo: string,
  leer: (d: Dia) => unknown, umbral: 'relativo' | 'absoluto'): Medida {
  const vacio = (motivo: string, puntos = 0): Medida => ({ estado: 'desconocido', base, campo,
    puntos, media: null, p: null, subida: null, umbral: null, motivo });
  if (60 - base < 25) return vacio('Tramo menor de 25 días, mínimo explorado por la auditoría');
  const puntos: [number, number][] = [], faltan: number[] = [];
  for (let i = base; i <= 60; i++) {
    const v = leer(dias.get(i)!);
    if (v === null || v === undefined) faltan.push(i);
    else if (!n(v)) return vacio(`Valor no numérico/no finito en día ${i}`, puntos.length);
    else puntos.push([i, v]);
  }
  const total = 61 - base, k = Math.min(10, Math.floor(total / 2));
  if (puntos.length / total < COBERTURA_MIN) return vacio(`Cobertura ${puntos.length}/${total} < 80 %`, puntos.length);
  if (faltan.some(i => i < base + k || i > 60 - k)) return vacio(`Faltan extremos: ${faltan.join(',')}`, puntos.length);
  if (puntos.length < 10) return vacio('Menos de 10 puntos', puntos.length);
  // La cota pesimista de S del evaluador no está exportada. Exigir serie completa
  // evita dar un falso positivo por huecos interiores y deja visible la omisión.
  if (faltan.length) return vacio(`Huecos interiores: ${faltan.join(',')}`, puntos.length);
  const valores = puntos.map(p => p[1]);
  const tolerancia = TOLERANCIA_PLANA * Math.max(1, ...valores.map(Math.abs));
  const mk = mannKendall(puntos, tolerancia, 'hamed-rao-ar1');
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const subida = mk.pendienteSen === null ? null : mk.pendienteSen * (60 - base);
  const limite = umbral === 'relativo' ? 0.05 * media : 0.02;
  if (umbral === 'relativo' && !(media > 0)) return vacio(`Media ${media} no positiva`, puntos.length);
  return { estado: mk.p < 0.05 && subida !== null && subida >= limite ? 'cumple' : 'falla',
    base, campo, puntos: puntos.length, media, p: mk.p, subida, umbral: limite };
}

/** Wilson bilateral 95 % para la proporción entre resultados conocidos. */
function wilson(exitos: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054, q = exitos / total, zz = z * z;
  const centro = (q + zz / (2 * total)) / (1 + zz / total);
  const radio = z * Math.sqrt(q * (1 - q) / total + zz / (4 * total * total)) / (1 + zz / total);
  return [Math.max(0, centro - radio), Math.min(1, centro + radio)];
}

const incompletas: { semilla: number; diasFaltantes: number[] }[] = [];
const datos = new Map<number, Map<number, Dia>>();
for (let s = 6001; s <= 6020; s++) {
  const dias = new Map<number, Dia>(), faltantes: number[] = [];
  for (let i = 1; i <= 60; i++) {
    const f = join(RAIZ, `CTRLV4-${s}`, `dia-${String(i).padStart(3, '0')}.json`);
    if (!existsSync(f)) { faltantes.push(i); continue; }
    dias.set(i, JSON.parse(readFileSync(f, 'utf8')) as Dia);
  }
  if (faltantes.length) incompletas.push({ semilla: s, diasFaltantes: faltantes });
  datos.set(s, dias);
}
if (incompletas.length && !MUESTRA) throw new Error(`Panel incompleto; no se escriben salidas: ${incompletas.map(x => `${x.semilla}: faltan ${x.diasFaltantes.length}`).join('; ')}`);

const oficial = evaluarConjunto(RAIZ, { dia: 60, diversidadCampo: 'diversidadConductaVentana' });
const porSemilla = new Map(oficial.replicas.map(x => [x.semilla, x]));
const filas: Record<string, unknown>[] = [];
for (const [semilla, dias] of datos) {
  if (incompletas.some(x => x.semilla === semilla)) continue;
  const extinta = [...dias.values()].some(d => d.vecinosMortales === 0);
  const base = [...dias].find(([, d]) => d.fundadoresMortalesVivos === 0)?.[0];
  const replica = porSemilla.get(semilla);
  if (!replica?.criterios) throw new Error(`Evaluador sin C8 para ${semilla}`);
  const v3 = estadoC8(replica.criterios.diversidad, 5, 'diversidadConductaVentana');
  const a = base === undefined ? null : estadoC8(evaluarSerieDiversidad(
    i => dias.get(i)?.diversidadConductaVentana, 60, { ...UMBRALES_POR_DEFECTO, diaBaseDiversidad: base,
      diversidadCampo: 'diversidadConductaVentana' }), base, 'diversidadConductaVentana');
  const ap = base === undefined ? null : estadoC8(evaluarSerieDiversidad(
    i => sub(dias.get(i), 'diversidadConductaVentanaComponentes', 'conducta'), 60,
    { ...UMBRALES_POR_DEFECTO, diaBaseDiversidad: base }), base, 'diversidadConductaVentanaComponentes.conducta');
  const alt: Record<string, Medida | null> = { v3, A: a, 'A_prima': ap };
  for (const [etiqueta, leer, tipo] of [
    ['B_clasesR100', (d: Dia) => sub(d, 'repertorioAbierto', 'clasesR100'), 'relativo'],
    ['C_comunidades', (d: Dia) => sub(d, 'diversidadEntreGrupos', 'comunidades'), 'absoluto'],
    ['C_linajes', (d: Dia) => sub(d, 'diversidadEntreGrupos', 'linajes'), 'absoluto'],
  ] as const) {
    alt[`${etiqueta}_base5`] = medir(dias, 5, etiqueta, leer, tipo);
    alt[`${etiqueta}_sinFundadores`] = base === undefined ? null : medir(dias, base, etiqueta, leer, tipo);
  }
  // Igual que el evaluador congelado: una réplica extinta falla C8 al corte, aunque
  // los instrumentos de los días siguientes sean nulos. Se conserva el dato crudo
  // de cada lectura para auditar por qué el test numérico habría sido desconocido.
  const lecturas = extinta ? Object.fromEntries(Object.entries(alt).map(([clave, valor]) =>
    [clave, { ...valor, estado: 'falla', motivo: 'Extinción antes o en el día 60',
      estadoSerieSinReglaExtincion: valor?.estado ?? 'desconocido' }])) : alt;
  filas.push({ semilla, extinta, baseSinFundadores: base ?? null, lecturas });
}
const claves = Object.keys((filas[0]?.lecturas ?? {}) as Record<string, unknown>);
function resumir(subconjunto: Record<string, unknown>[], totalPanel?: number) {
  return Object.fromEntries(claves.map(clave => {
    const resultados = subconjunto.map(f => (f.lecturas as Record<string, Medida | null>)[clave]);
    const cumple = resultados.filter(x => x?.estado === 'cumple').length;
    const falla = resultados.filter(x => x?.estado === 'falla').length;
    const desconocido = resultados.length - cumple - falla;
    const sinCompletar = totalPanel === undefined ? 0 : totalPanel - resultados.length;
    if (sinCompletar < 0) throw new Error(`Total del panel menor que las semillas completas: ${totalPanel}`);
    return [clave, { cumple, falla, desconocido, totalCompletas: resultados.length,
      fraccionConocida: cumple + falla ? cumple / (cumple + falla) : null,
      intervaloWilson95Conocidos: wilson(cumple, cumple + falla),
      fraccionCompletasIdentificada: resultados.length ? [cumple / resultados.length, (cumple + desconocido) / resultados.length] : null,
      ...(totalPanel === undefined ? {} : { totalPanel, incompletas: sinCompletar,
        desconocidoPanel: desconocido + sinCompletar,
        fraccionPanelIdentificada: [cumple / totalPanel, (cumple + desconocido + sinCompletar) / totalPanel] }) }];
  }));
}
const resumen = resumir(filas, 20), resumenVivos = resumir(filas.filter(x => !x.extinta));
const resultado = { tipo: 'calibracion_descriptiva_control', panel: 'CTRLV4 6001..6020', corte: 60,
  estado: incompletas.length ? 'muestra_provisional' : 'panel_completo', incompletas,
  metodo: { v3: 'evaluarConjunto congelado, campo ventana', A: 'mismo evaluador, base primer día sin fundadores mortales',
    A_prima: 'A con componente conducta y mismo umbral absoluto 0.02',
    B: 'clasesR100, subida Sen >= 5% de media del tramo', C: 'comunidades y linajes separados, Sen >= 0.02',
    variantes: 'base 5 y base sin fundadores para B/C; ninguna elegida',
    faltantes: 'desconocido; aprobado exige serie completa, cobertura >=80% y extremos completos',
    intervalos: 'Wilson bilateral 95% entre clasificados; fracción de completas y fracción del panel de 20 separadas; esta última cuenta incompletas y desconocidos como 0 o 1' },
  resumen, resumenVivos, semillas: filas };
if (MUESTRA) console.log(JSON.stringify(resultado, null, 2));
else {
  mkdirSync(SALIDA, { recursive: true });
  writeFileSync(resolve(SALIDA, 'calibracion-v4-ctrlv4.json'), JSON.stringify(resultado, null, 2) + '\n');
  const lineas = ['# Calibración descriptiva CTRLV4 a 60 días', '',
    'Solo controles, sin elección de lectura ni preregistro. Wilson 95 % se calcula entre resultados conocidos. La fracción identificada del panel usa siempre 20 semillas: una incompleta o desconocida puede fallar o aprobar.', '',
    '| Lectura | Cumple | Falla | Desconocido | Fracción conocida | Wilson 95 % |', '|---|---:|---:|---:|---:|---:|'];
  for (const [k, v] of Object.entries(resumen)) {
    const x = v as { cumple: number; falla: number; desconocido: number; fraccionConocida: number | null; intervaloWilson95Conocidos: [number, number] | null };
    lineas.push(`| ${k} | ${x.cumple} | ${x.falla} | ${x.desconocido} | ${x.fraccionConocida?.toFixed(3) ?? '—'} | ${x.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  lineas.push('', '## Solo controles vivos al día 60', '',
    'Desglose de sensibilidad: las extinciones no prueban especificidad de la lectura entre mundos vivos.', '',
    '| Lectura | Cumple | Falla | Desconocido | Fracción conocida | Wilson 95 % |', '|---|---:|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(resumenVivos)) {
    const x = v as { cumple: number; falla: number; desconocido: number; fraccionConocida: number | null; intervaloWilson95Conocidos: [number, number] | null };
    lineas.push(`| ${k} | ${x.cumple} | ${x.falla} | ${x.desconocido} | ${x.fraccionConocida?.toFixed(3) ?? '—'} | ${x.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  lineas.push('', '## Decisiones de implementación y límites', '',
    '- A y A′ empiezan en el primer día con cero fundadores mortales. Si falta ese día, quedan desconocidas.',
    '- B informa clases funcionales rarificadas a 100 usos. C informa comunidad y linaje por separado. Base 5 y base sin fundadores son variantes descriptivas, sin seleccionar una.',
    '- B exige subida relativa de 5 % de la media del tramo; C exige subida absoluta de 0,02. Se usa Mann–Kendall exportado por el evaluador, con Hamed–Rao + AR(1).',
    '- Una réplica extinta falla todas las lecturas al corte, como en C8 v3; se conserva el estado de la serie sin esa regla en el JSON.',
    '- Los valores B pueden exceder 1 y C puede ser negativo por corrección de permutaciones. Por eso no pasan por la validación [0,1] de C8 v3.',
    '- Una serie con nulos o huecos interiores no puede aprobar: queda desconocida. El evaluador congelado aplica además una cota pesimista a esos huecos, que aquí no está exportada.',
    '- Los intervalos de Wilson son descriptivos y no corrigen la selección de alternativas ni prueban generalización. Hay que atender también a los desconocidos.',
    '- Esta tabla no prueba potencia frente a leyes nuevas ni reemplaza un preregistro v4 decidido por Steven.', '');
  writeFileSync(resolve(SALIDA, 'calibracion-v4-ctrlv4.md'), lineas.join('\n'));
  console.log(`Escritos ${resolve(SALIDA, 'calibracion-v4-ctrlv4.json')} y .md`);
}
