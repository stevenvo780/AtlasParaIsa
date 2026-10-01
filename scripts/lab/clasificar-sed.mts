/**
 * Clasificador de muertes por sed para el diagnóstico de sequía (objetivo 3, 2026-09-28).
 *
 * Implementa LITERALMENTE los criterios anotados en la bitácora ANTES de mirar datos
 * (2026-09-28 ≈10:21, campaña lanzada 10:28). Solo lectura sobre dia-NNN.json.
 *
 * Causa primaria por muerte (sedMuertes), en este orden:
 *  1. H-d "con agua encima" si aguaLlevada>0 o contenedores>0
 *  2. H-a-vista si cercaActiva.dist ≤ 8
 *  3. H-a-alcanzable si 8 < cercaActiva.dist ≤ 128
 *  4. H-a-inactiva si cercaActiva=null y cercaInactiva≠null
 *  5. H-b "sequía total" si cercaActiva=null y cercaInactiva=null
 *
 * Flags por muerte: enSitio (rastro primera→última <8 celdas en ≥1000 ticks),
 * memoriaEstado, fuenteConcurrida (bebedores sedFuentes en la celda redondeada
 * de cercaActiva ≥ 10).
 *
 * Agregados H-c (hacinamiento): correlación población-día vs día de agotamiento
 * por región + fracción de muertes H-a/H-b con fuenteConcurrida.
 * H-b regional: fracción de muertes cuya región tiene aguaTeselas==0 y cisternas==0 ese día.
 *
 * División seca/húmeda (corrección del orquestador 28-09): semilla de "pulso seco"
 * ⟺ caída de población ≥50 % en una ventana móvil de 5 días; resto "húmeda".
 *
 * Uso: ./node_modules/.bin/tsx scripts/lab/clasificar-sed.mts --campana <dir-con-seed-*>
 *      ./node_modules/.bin/tsx scripts/lab/clasificar-sed.mts --dir <seed-N> [--json salida.json]
 *      ./node_modules/.bin/tsx scripts/lab/clasificar-sed.mts --self-test
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Fuente = { dist: number; x: number; y: number; fuente: 'tesela' | 'cisterna' } | null;
type Punto = { t: number; x: number; y: number };
type Muerte = {
  tick: number; id: string; edadDias: number; x: number; y: number;
  aguaLlevada: number; contenedores: number;
  memoriaEstado: 'conAgua' | 'seca' | 'fueraDeVista' | null;
  rastro: Punto[]; cercaActiva: Fuente; cercaInactiva: Fuente; region: string;
};
type Region = {
  id: string; tierra: boolean; aguaTeselas: number; fuentes: number; manantiales: number;
  cisternas: number; aguaCisternas: number; poblacion: number;
};
type Dia = {
  tick: number; poblacion: number; muertesPorCausa: Record<string, number>;
  regionesSinAgua: number | null;
  sedMuertes: Muerte[];
  sedRegiones: { lluviaTicks: number; aguaTeselas: number; aguaCisternas: number; manantiales: number; regiones: Region[] };
  sedFuentes: Record<string, number>;
};

export type Causa = 'H-d' | 'H-a-vista' | 'H-a-alcanzable' | 'H-a-inactiva' | 'H-b';

export function causaPrimaria(m: Muerte): Causa {
  if (m.aguaLlevada > 0 || m.contenedores > 0) return 'H-d';
  if (m.cercaActiva !== null) return m.cercaActiva.dist <= 8 ? 'H-a-vista' : 'H-a-alcanzable';
  if (m.cercaInactiva !== null) return 'H-a-inactiva';
  return 'H-b';
}

export function enSitio(m: Muerte): boolean {
  const r = m.rastro;
  if (r.length < 2) return false;
  const a = r[0]!, b = r[r.length - 1]!;
  return b.t - a.t >= 1000 && Math.hypot(b.x - a.x, b.y - a.y) < 8;
}

export function fuenteConcurrida(m: Muerte, sedFuentes: Record<string, number>): boolean {
  if (m.cercaActiva === null) return false;
  const clave = `${Math.round(m.cercaActiva.x)},${Math.round(m.cercaActiva.y)}`;
  return (sedFuentes[clave] ?? 0) >= 10;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export type ResumenSemilla = {
  semilla: string; dias: number; completa: boolean;
  muertesSed: number; muertesTotales: number; fraccionSed: number | null;
  causas: Record<Causa, number>;
  conAguaMax: number; memoria: Record<string, number>;
  enSitio: number; fuenteConcurridaHaHb: number; baseHaHb: number;
  hbRegional: number;
  hcCorrelacion: number | null; hcRegionesAgotadas: number; hcRegionesTierra: number;
  caidaMax5d: number | null; pulsoSeco: boolean;
  lluviaTicksTotal: number; regionesSinAguaMax: number | null;
};

export function clasificarSemilla(semilla: string, dias: Dia[], completa: boolean): ResumenSemilla {
  const causas: Record<Causa, number> = { 'H-d': 0, 'H-a-vista': 0, 'H-a-alcanzable': 0, 'H-a-inactiva': 0, 'H-b': 0 };
  const memoria: Record<string, number> = { conAgua: 0, seca: 0, fueraDeVista: 0, ninguna: 0 };
  let muertesSed = 0, conAguaMax = 0, enSitioN = 0, fcN = 0, baseHaHb = 0, hbRegional = 0;
  for (const d of dias) {
    const regiones = new Map(d.sedRegiones.regiones.map(r => [r.id, r]));
    for (const m of d.sedMuertes) {
      muertesSed++;
      const c = causaPrimaria(m);
      causas[c]++;
      if (m.aguaLlevada > conAguaMax) conAguaMax = m.aguaLlevada;
      memoria[m.memoriaEstado ?? 'ninguna']!++;
      if (enSitio(m)) enSitioN++;
      if (c.startsWith('H-a') || c === 'H-b') {
        baseHaHb++;
        if (fuenteConcurrida(m, d.sedFuentes)) fcN++;
      }
      const reg = regiones.get(m.region);
      if (reg && reg.aguaTeselas === 0 && reg.cisternas === 0) hbRegional++;
    }
  }
  // H-c: población del primer día en que aparece la región vs primer día con fuentes==0.
  const pobIni = new Map<string, number>(), agot = new Map<string, number>();
  const tierra = new Set<string>();
  dias.forEach((d, i) => {
    for (const r of d.sedRegiones.regiones) {
      if (!r.tierra) continue;
      tierra.add(r.id);
      if (!pobIni.has(r.id)) pobIni.set(r.id, r.poblacion);
      if (r.fuentes === 0 && !agot.has(r.id)) agot.set(r.id, i + 1);
    }
  });
  const xs: number[] = [], ys: number[] = [];
  for (const [id, diaAgot] of agot) { xs.push(pobIni.get(id) ?? 0); ys.push(diaAgot); }
  // Caída máxima en ventana móvil de 5 días sobre población de cierre.
  let caidaMax5d: number | null = null;
  for (let i = 5; i < dias.length; i++) {
    const antes = dias[i - 5]!.poblacion;
    if (antes > 0) {
      const caida = (antes - dias[i]!.poblacion) / antes;
      if (caidaMax5d === null || caida > caidaMax5d) caidaMax5d = caida;
    }
  }
  const ultimo = dias[dias.length - 1];
  const muertesTotales = ultimo ? Object.values(ultimo.muertesPorCausa).reduce((a, b) => a + b, 0) : 0;
  const deshidratacionAcum = ultimo?.muertesPorCausa['dehydration'] ?? 0;
  return {
    semilla, dias: dias.length, completa, muertesSed, muertesTotales,
    fraccionSed: muertesTotales > 0 ? deshidratacionAcum / muertesTotales : null,
    causas, conAguaMax, memoria, enSitio: enSitioN,
    fuenteConcurridaHaHb: fcN, baseHaHb, hbRegional,
    hcCorrelacion: pearson(xs, ys), hcRegionesAgotadas: agot.size, hcRegionesTierra: tierra.size,
    caidaMax5d, pulsoSeco: (caidaMax5d ?? 0) >= 0.5,
    lluviaTicksTotal: dias.reduce((a, d) => a + d.sedRegiones.lluviaTicks, 0),
    regionesSinAguaMax: dias.reduce<number | null>((a, d) =>
      d.regionesSinAgua === null ? a : a === null ? d.regionesSinAgua : Math.max(a, d.regionesSinAgua), null),
  };
}

function leerSemilla(dir: string): { dias: Dia[]; completa: boolean } {
  const ficheros = readdirSync(dir).filter(f => /^dia-\d+\.json$/.test(f)).sort();
  const dias = ficheros.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Dia);
  let completa = false;
  try {
    const rep = JSON.parse(readFileSync(join(dir, 'replica.json'), 'utf8')) as { dias?: number };
    completa = rep.dias === dias.length && dias.length > 0;
  } catch { completa = false; }
  return { dias, completa };
}

function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(`self-test: ${msg}`); }

function muerteBase(sobre: Partial<Muerte>): Muerte {
  return {
    tick: 100000, id: 'x', edadDias: 30, x: 0, y: 0, aguaLlevada: 0, contenedores: 0,
    memoriaEstado: null, rastro: [{ t: 0, x: 0, y: 0 }, { t: 2000, x: 50, y: 0 }],
    cercaActiva: null, cercaInactiva: null, region: '0,0', ...sobre,
  };
}

function selfTest(): void {
  // Causa primaria: orden literal H-d > vista > alcanzable > inactiva > H-b.
  assert(causaPrimaria(muerteBase({ aguaLlevada: 3, cercaActiva: { dist: 2, x: 1, y: 1, fuente: 'tesela' } })) === 'H-d', 'H-d gana con agua encima');
  assert(causaPrimaria(muerteBase({ contenedores: 1 })) === 'H-d', 'H-d por contenedores');
  assert(causaPrimaria(muerteBase({ cercaActiva: { dist: 8, x: 8, y: 0, fuente: 'tesela' } })) === 'H-a-vista', 'vista en el borde 8');
  assert(causaPrimaria(muerteBase({ cercaActiva: { dist: 8.1, x: 8, y: 0, fuente: 'cisterna' } })) === 'H-a-alcanzable', 'alcanzable justo sobre 8');
  assert(causaPrimaria(muerteBase({ cercaActiva: { dist: 128, x: 8, y: 0, fuente: 'tesela' } })) === 'H-a-alcanzable', 'alcanzable en 128');
  assert(causaPrimaria(muerteBase({ cercaInactiva: { dist: 5, x: 5, y: 0, fuente: 'tesela' } })) === 'H-a-inactiva', 'inactiva');
  assert(causaPrimaria(muerteBase({})) === 'H-b', 'H-b sin agua');
  // enSitio: <8 celdas en ≥1000 ticks.
  assert(enSitio(muerteBase({ rastro: [{ t: 0, x: 0, y: 0 }, { t: 1000, x: 7.9, y: 0 }] })) === true, 'enSitio borde');
  assert(enSitio(muerteBase({ rastro: [{ t: 0, x: 0, y: 0 }, { t: 999, x: 0, y: 0 }] })) === false, 'enSitio poco tiempo');
  assert(enSitio(muerteBase({ rastro: [{ t: 0, x: 0, y: 0 }, { t: 2000, x: 8, y: 0 }] })) === false, 'enSitio se movió 8');
  assert(enSitio(muerteBase({ rastro: [{ t: 5, x: 1, y: 1 }] })) === false, 'enSitio un punto');
  // fuenteConcurrida: celda redondeada de cercaActiva con ≥10 bebedores.
  const m = muerteBase({ cercaActiva: { dist: 3, x: 10.4, y: 20.6, fuente: 'tesela' } });
  assert(fuenteConcurrida(m, { '10,21': 10 }) === true, 'concurrida en 10');
  assert(fuenteConcurrida(m, { '10,21': 9 }) === false, 'no concurrida en 9');
  assert(fuenteConcurrida(muerteBase({}), { '0,0': 99 }) === false, 'H-b nunca concurrida');
  // Semilla sintética: 6 días, caída 100→40 (60 % ⇒ pulso seco), 2 muertes.
  const mkDia = (dia: number, pob: number, muertes: Muerte[], regiones: Region[]): Dia => ({
    tick: dia * 2400, poblacion: pob,
    muertesPorCausa: { dehydration: muertes.length, starvation: 0 } as Record<string, number>,
    regionesSinAgua: 0.1, sedMuertes: muertes,
    sedRegiones: { lluviaTicks: 10, aguaTeselas: 5, aguaCisternas: 0, manantiales: 1, regiones },
    sedFuentes: {},
  });
  const reg = (id: string, fuentes: number, pob: number): Region =>
    ({ id, tierra: true, aguaTeselas: fuentes, fuentes, manantiales: 0, cisternas: 0, aguaCisternas: 0, poblacion: pob });
  const dias: Dia[] = [
    mkDia(1, 100, [], [reg('0,0', 2, 60), reg('1,0', 2, 30), reg('2,0', 2, 10)]),
    mkDia(2, 100, [], [reg('0,0', 0, 60), reg('1,0', 2, 30), reg('2,0', 2, 10)]),
    mkDia(3, 90, [], [reg('0,0', 0, 55), reg('1,0', 0, 30), reg('2,0', 2, 10)]),
    mkDia(4, 80, [], [reg('0,0', 0, 50), reg('1,0', 0, 25), reg('2,0', 0, 10)]),
    mkDia(5, 60, [], [reg('0,0', 0, 40), reg('1,0', 0, 20), reg('2,0', 0, 10)]),
    mkDia(6, 40, [muerteBase({ cercaActiva: { dist: 3, x: 1, y: 1, fuente: 'tesela' }, region: '0,0' }),
      muerteBase({ region: '1,0' })], [reg('0,0', 0, 30), reg('1,0', 0, 15), reg('2,0', 0, 5)]),
  ];
  const r = clasificarSemilla('sintetica', dias, true);
  assert(r.muertesSed === 2, 'cuenta muertes');
  assert(r.causas['H-a-vista'] === 1 && r.causas['H-b'] === 1, 'causas sintéticas');
  assert(r.pulsoSeco === true && Math.abs((r.caidaMax5d ?? 0) - 0.6) < 1e-9, 'pulso seco 60%');
  assert(r.hbRegional === 2, 'H-b regional: ambas en región sin agua ni cisternas');
  assert(r.hcRegionesAgotadas === 3 && (r.hcCorrelacion ?? 0) < -0.99, 'H-c: más población ⇒ agotamiento antes');
  assert(r.fraccionSed === 1, 'fracción sed acumulada');
  console.log('self-test: 20/20 PASS');
}

function fila(r: ResumenSemilla): string {
  const f = (n: number | null, d = 3): string => n === null ? 'n/a' : n.toFixed(d);
  return `${r.semilla} dias=${r.dias}${r.completa ? '' : ' INCOMPLETA'} sed=${r.muertesSed}/${r.muertesTotales} (${f(r.fraccionSed)})`
    + ` H-d=${r.causas['H-d']} vista=${r.causas['H-a-vista']} alcanz=${r.causas['H-a-alcanzable']}`
    + ` inact=${r.causas['H-a-inactiva']} Hb=${r.causas['H-b']} enSitio=${r.enSitio}`
    + ` conc=${r.fuenteConcurridaHaHb}/${r.baseHaHb} hbReg=${r.hbRegional} hc=${f(r.hcCorrelacion)}`
    + ` caida5d=${f(r.caidaMax5d)} ${r.pulsoSeco ? 'SECA' : 'húmeda'}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { selfTest(); return; }
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dirs: string[] = [];
  const camp = arg('--campana');
  if (camp) for (const e of readdirSync(camp).sort()) {
    if (/^seed-/.test(e)) dirs.push(join(camp, e));
  }
  const uno = arg('--dir');
  if (uno) dirs.push(uno);
  if (dirs.length === 0) throw new Error('Uso: --campana <dir> | --dir <seed> [--json out] [--self-test]');
  const resumen = dirs.map(d => {
    const { dias, completa } = leerSemilla(d);
    return clasificarSemilla(d.split('/').pop() ?? d, dias, completa);
  });
  for (const r of resumen) console.log(fila(r));
  const secas = resumen.filter(r => r.pulsoSeco), humedas = resumen.filter(r => !r.pulsoSeco);
  console.log(`--- secas=${secas.map(r => r.semilla).join(',') || 'ninguna'} húmedas=${humedas.map(r => r.semilla).join(',') || 'ninguna'}`);
  const out = arg('--json');
  if (out) { writeFileSync(out, JSON.stringify(resumen, null, 2) + '\n'); console.log(`JSON → ${out}`); }
}

main();
