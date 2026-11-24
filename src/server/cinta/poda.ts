import { CINTA, type Nivel } from '../../shared/cinta.js';
import { TICKS_PER_DAY } from '../../world/mundo/tipos.js';
import type { CatalogoCinta, SegmentoCinta } from './catalogo.js';

const PIN_DIAS = 14;
const PIN_MS = PIN_DIAS * 86400_000;

/** Deja sitio antes de hacer el append. El segmento más nuevo por nivel sigue referenciado incluso durante la escritura. */
export function podar(catalogo: CatalogoCinta, tope: number, nivel?: Nivel, entrada = 0, margen = 0): void {
  const segmentos = catalogo.segmentos();
  const ultimo = new Map(segmentos.map(s => [s.nivel, s.id]));
  const activosDesde = Date.now() - PIN_MS;
  const pins = catalogo.db.prepare('SELECT epoca,t FROM marcadores WHERE en>=?')
    .all(activosDesde) as unknown as { epoca: number; t: number }[];
  const pinActual = catalogo.db.prepare('SELECT 1 FROM marcadores WHERE en>=? AND epoca=? AND t BETWEEN ? AND ? LIMIT 1');
  const candidatos = segmentos.filter(s => ultimo.get(s.nivel) !== s.id && (s.nivel !== 0 || !pins.some(p =>
    s.epoca === p.epoca && s.t1 >= p.t && s.t0 <= p.t + PIN_DIAS * TICKS_PER_DAY)));
  const huerfano = (s: SegmentoCinta) => s.visibleHasta !== null && s.t0 > s.visibleHasta;
  const orden = (a: SegmentoCinta, b: SegmentoCinta) => Number(huerfano(b)) - Number(huerfano(a)) || a.id - b.id;
  candidatos.sort(orden);
  let total = segmentos.reduce((suma, s) => suma + s.bytes, 0);
  let usado = nivel === undefined ? 0 : segmentos.reduce((suma, s) => suma + (s.nivel === nivel ? s.bytes : 0), 0);
  const eliminados = new Set<number>();
  const borrar = (s: SegmentoCinta) => {
    const protegido = () => s.nivel === 0 && !!pinActual.get(activosDesde, s.epoca, s.t0 - PIN_DIAS * TICKS_PER_DAY, s.t1);
    if (!catalogo.borrarSegmento(s, protegido)) return false;
    eliminados.add(s.id);
    total -= s.bytes;
    return true;
  };
  // Las cuotas son blandas cuando solo queda el último segmento o los segmentos fijados.
  if (nivel !== undefined) for (const s of candidatos) {
    if (usado + entrada <= tope * CINTA.cuotas[nivel]) break;
    if (s.nivel !== nivel) continue;
    if (borrar(s)) usado -= s.bytes;
  }
  const excede = () => total + entrada + margen + catalogo.bytesIndice() > tope;
  if (excede()) catalogo.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Fuera de cuota global ceden primero huérfanos y luego los niveles más finos.
  candidatos.sort((a, b) => Number(huerfano(b)) - Number(huerfano(a)) || a.nivel - b.nivel || a.id - b.id);
  for (const s of candidatos) {
    if (!excede()) break;
    if (!eliminados.has(s.id)) borrar(s);
  }
  if (excede()) throw new Error('La cinta agotó su presupuesto conservando los últimos fotogramas y los segmentos fijados.');
}
