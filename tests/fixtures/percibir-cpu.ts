import {
  CEREBRO, COLUMNAS_CEREBRO, COLUMNAS_FIJAS, RASGOS_ANCHO, REF_NULA, refDe,
  type Col, type ConsultaOrganismo, type FrentePublico, type LotePercepcion, type Percepcion, type Percibidor,
  type Plan, type Terreno,
} from '../../src/world/motor/contratos.js';
import { evaluatePolicySingle } from '../../src/world/politica.js';

const RADIO = 7, LADO = 15, CENTRO = 112;
const VECINOS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const clave = (x: number, y: number) => `${x},${y}`;

function filtrar(datos: Float32Array, ancho: number, leer: (i: number) => number): boolean {
  for (let i = 0; i < datos.length; i += ancho) {
    const valor = leer(i);
    if (!(valor >= datos[i + ancho - 2] && valor <= datos[i + ancho - 1])) return false;
  }
  return true;
}

function ventana(terreno: Terreno, campos: readonly Col[], x: number, y: number, plan: Plan) {
  const celdas = new Int32Array(LADO * LADO).fill(-1), pasos = new Int16Array(LADO * LADO).fill(-1);
  for (let dx = -RADIO; dx <= RADIO; dx++) for (let dy = -RADIO; dy <= RADIO; dy++) {
    if (dx * dx + dy * dy <= RADIO * RADIO)
      celdas[(dy + RADIO) * LADO + dx + RADIO] = terreno.celda(x + dx, y + dy);
  }
  const cola = [CENTRO];
  pasos[CENTRO] = 0;
  for (let i = 0; i < cola.length; i++) {
    const local = cola[i];
    for (const [dx, dy] of VECINOS) {
      const nx = local % LADO + dx, ny = Math.floor(local / LADO) + dy, otro = ny * LADO + nx;
      if (nx < 0 || nx >= LADO || ny < 0 || ny >= LADO || celdas[otro] < 0 || pasos[otro] >= 0) continue;
      if (!filtrar(plan.transitable, 3, j => campos[plan.transitable[j]][celdas[otro]])) continue;
      pasos[otro] = pasos[local] + 1;
      cola.push(otro);
    }
  }
  return { celdas, pasos };
}

function percibir(frente: FrentePublico, terreno: Terreno, lote: LotePercepcion, planes: readonly Plan[]): Percepcion {
  const q = Math.max(0, ...planes.map(p => p.celdas.length));
  const v = Math.max(0, ...planes.map(p => p.organismos.length));
  const a = Math.max(0, ...planes.map(p => p.acciones));
  const n = lote.slots.length;
  const p: Percepcion = { q, v, a, celda: new Int32Array(n * q).fill(-1), pasos: new Int16Array(n * q).fill(-1),
    valor: new Float32Array(n * q).fill(Infinity), organismo: new Float64Array(n * v).fill(REF_NULA), utilidad: new Float32Array(n * a) };
  const campos = terreno.campos.map(nombre => terreno.campo(nombre));
  const ubicaciones = new Map<string, number[]>();
  const vivos: number[] = [];
  if (v) for (let i = 0; i < frente.alta; i++) {
    if (frente.vivo[i] !== 1) continue;
    const k = clave(Math.floor(frente.x[i]), Math.floor(frente.y[i]));
    const slots = ubicaciones.get(k);
    if (slots) slots.push(i); else ubicaciones.set(k, [i]);
    vivos.push(i);
  }
  const columnas = frente.columnas.map(nombre => {
    const fija = COLUMNAS_FIJAS.find(c => c[0] === nombre);
    const datos = fija ? frente[fija[0]] : frente.col(nombre);
    return { datos, ancho: fija?.[2] ?? datos.length / frente.vivo.length };
  });
  const leer = (col: number, slot: number, componente: number) => columnas[col].datos[slot * columnas[col].ancho + componente];
  const cercano = (slot: number, x: number, y: number, c: ConsultaOrganismo): number => {
    const radio = Math.fround(c.radio), radio2 = radio * radio;
    const xmin = Math.floor(x - radio), xmax = Math.floor(x + radio), ymin = Math.floor(y - radio), ymax = Math.floor(y + radio);
    let ganador = -1, mejor = Infinity;
    const probar = (otro: number) => {
      if (otro === slot || (c.clase !== 0 && c.clase !== frente.clase[otro])) return;
      const dx = x - frente.x[otro], dy = y - frente.y[otro], d = dx * dx + dy * dy;
      if (d > radio2 || !filtrar(c.filtros, 4, i => leer(c.filtros[i], otro, c.filtros[i + 1]))) return;
      const valor = c.criterio === 0 ? d : -leer(c.columna, otro, c.componente);
      if (valor < mejor || (valor === mejor && (ganador < 0 || otro < ganador))) { ganador = otro; mejor = valor; }
    };
    if ((xmax - xmin + 1) * (ymax - ymin + 1) > 8 * vivos.length) {
      for (const otro of vivos) probar(otro);
    } else for (let cy = ymin; cy <= ymax; cy++) for (let cx = xmin; cx <= xmax; cx++) {
      for (const otro of ubicaciones.get(clave(cx, cy)) ?? []) probar(otro);
    }
    return ganador < 0 ? REF_NULA : refDe(ganador, frente.gen[ganador]);
  };
  for (let i = 0; i < n; i++) {
    const slot = lote.slots[i], plan = planes[lote.plan[i]], x = frente.x[slot], y = frente.y[slot];
    const cx = Math.floor(x), cy = Math.floor(y);
    if (plan.celdas.length) {
      const { celdas, pasos } = ventana(terreno, campos, cx, cy, plan);
      plan.celdas.forEach((c, j) => {
        const k = i * q + j;
        for (let l = 0; l < celdas.length; l++) {
          const celda = celdas[l], ruta = pasos[l];
          if (celda < 0 || (c.alcanzable && ruta < 0) || !filtrar(c.filtros, 3, f => campos[c.filtros[f]][celda])) continue;
          const distancia = Math.hypot(cx + l % LADO - RADIO - x, cy + Math.floor(l / LADO) - RADIO - y);
          let valor = Math.fround(c.pesoDist) * distancia + Math.fround(c.pesoPasos) * Math.max(0, ruta);
          c.campos.forEach((f, t) => { valor += campos[f][celda] * c.pesos[t]; });
          const score = Math.fround(valor);
          if (score < p.valor[k]) { p.celda[k] = celda; p.pasos[k] = ruta; p.valor[k] = score; }
        }
      });
    }
    plan.organismos.forEach((c, j) => { p.organismo[i * v + j] = cercano(slot, x, y, c); });
    if (plan.w) {
      const obs = frente.col('observacion'), pesos = frente.col('politica'), sesgo = frente.col('sesgo');
      const red = evaluatePolicySingle(
        Array.from({ length: CEREBRO.entradas }, (_, j) => obs[slot * CEREBRO.entradas + j]),
        Array.from({ length: COLUMNAS_CEREBRO.politica }, (_, j) => pesos[slot * COLUMNAS_CEREBRO.politica + j]),
      );
      for (let j = 0; j < a; j++) {
        let u = red[j] + sesgo[slot * a + j];
        for (let r = 0; r < RASGOS_ANCHO; r++) u += plan.w[j * RASGOS_ANCHO + r] * frente.rasgos[slot * RASGOS_ANCHO + r];
        p.utilidad[i * a + j] = u;
      }
    }
  }
  return p;
}

/** Doble de M2b. Repite la misma lectura del frente aunque el despacho decida cambiar de dispositivo. */
export class PercibidorCpu implements Percibidor {
  readonly dispositivo = 'cpu';
  private pendiente?: () => Percepcion;
  constructor(private frente: FrentePublico, private terreno: Terreno) {}

  fuentes(frente: FrentePublico, terreno: Terreno): void { this.frente = frente; this.terreno = terreno; }

  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    if (this.pendiente) throw new Error('Ya hay un lote CPU pendiente.');
    const { frente, terreno } = this;
    this.pendiente = () => percibir(frente, terreno, lote, planes);
  }

  esperar(_plazoMs: number): Percepcion {
    const ejecutar = this.pendiente;
    if (!ejecutar) throw new Error('No hay un lote CPU pendiente.');
    this.pendiente = undefined;
    return ejecutar();
  }
}
