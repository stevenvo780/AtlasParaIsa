import { localRandom } from '../../src/world/genetics.js';
import {
  CAMPOS_CUERPO, CEREBRO, COLUMNAS_CEREBRO, COLUMNAS_FIJAS, CUERPO_ANCHO, GENOMA_ANCHO,
  Clase, RASGOS_ANCHO, type Col, type Consulta, type ConsultaOrganismo,
  type FrentePublico, type LotePercepcion, type Plan, type Terreno,
} from '../../src/world/motor/contratos.js';
import { founderPolicy } from '../../src/world/politica.js';

const CAMPOS = ['agua', 'comida', 'refugio', 'madera', 'piedra', 'sol', 'cultivo', 'espacio'] as const;
const [AGUA, COMIDA, REFUGIO, MADERA, PIEDRA, SOL, CULTIVO, ESPACIO] = CAMPOS.map((_, i) => i);
const COLUMNAS = [...COLUMNAS_FIJAS.map(([n]) => n), ...Object.keys(COLUMNAS_CEREBRO)];
const CUERPO = COLUMNAS.indexOf('cuerpo');

function consulta(campo: number, min: number, alcanzable = true): Consulta {
  return {
    campos: Int32Array.of(campo, SOL), pesos: Float32Array.of(-1, -0.09),
    pesoDist: 0.034, pesoPasos: alcanzable ? 0.014 : 0,
    filtros: Float32Array.of(campo, min, 1), alcanzable,
  };
}

function organismo(clase: ConsultaOrganismo['clase'], radio: number, criterio: ConsultaOrganismo['criterio']): ConsultaOrganismo {
  return {
    clase, radio, criterio, columna: CUERPO, componente: CAMPOS_CUERPO.masa,
    filtros: Float32Array.of(CUERPO, CAMPOS_CUERPO.salud, 0.15, 1),
  };
}

function crearPlanes(): Plan[] {
  const personas: Plan = {
    id: 0, transitable: Float32Array.of(AGUA, 0, 0.2),
    celdas: [
      consulta(COMIDA, 0.55), consulta(AGUA, 0.5, false), consulta(REFUGIO, 0.5),
      consulta(MADERA, 0.5), consulta(PIEDRA, 0.5), consulta(SOL, 0.45),
      consulta(CULTIVO, 0.45), consulta(ESPACIO, 0.45), consulta(COMIDA, 0.82),
      consulta(AGUA, 0.82, false),
    ],
    organismos: [organismo(Clase.Animal, 7, 0), organismo(Clase.Persona, 6, 1), organismo(0, 3, 0)],
    acciones: CEREBRO.acciones,
    w: Float32Array.from({ length: CEREBRO.acciones * RASGOS_ANCHO }, (_, i) => Math.sin(i * 3.1) * 0.24),
  };
  const terrestres: Plan = {
    id: 1, transitable: personas.transitable,
    celdas: [consulta(COMIDA, 0.55), consulta(AGUA, 0.5, false), consulta(REFUGIO, 0.5)],
    organismos: [organismo(Clase.Persona, 7, 0), organismo(Clase.Animal, 5, 1)],
    acciones: 0, w: null,
  };
  const acuaticos: Plan = {
    id: 2, transitable: Float32Array.of(AGUA, 0.5, 1),
    celdas: [consulta(COMIDA, 0.55), consulta(AGUA, 0.82)],
    organismos: [organismo(Clase.Animal, 4.5, 0)],
    acciones: 0, w: null,
  };
  return [personas, terrestres, acuaticos];
}

/** Variantes del mundo de prueba. `empates`: campos en cuartos, para que muchas celdas empaten en el mínimo.
 * `borde`: los actores caen en las filas y columnas de borde de su página, con fracción, también junto a páginas
 * no residentes. `peces`: la mitad de la fauna es acuática. */
export interface OpcionesFixture { grande?: boolean; semilla?: number; empates?: boolean; borde?: boolean; peces?: boolean }

function crearTerreno(ancho: number, alto: number, random: () => number, empates: boolean): Terreno {
  const paginas = ancho * alto, px0 = -Math.floor(ancho / 2), py0 = -Math.floor(alto / 2);
  const paginaX = new Int32Array(paginas), paginaY = new Int32Array(paginas);
  const versionPagina = new Uint32Array(paginas), versionVisible = new Uint32Array(paginas);
  const duenoChunk = new Int16Array(paginas);
  const datos = CAMPOS.map(() => new Float32Array(paginas * 256));
  for (let c = 0; c < paginas; c++) {
    const px = px0 + c % ancho, py = py0 + Math.floor(c / ancho);
    paginaX[c] = px;
    paginaY[c] = py;
    if (c % 37 === 7) {
      duenoChunk[c] = -1;
      continue;
    }
    versionPagina[c] = 1;
    versionVisible[c] = 1;
    for (let local = 0; local < 256; local++) {
      const x = px * 16 + (local & 15), y = py * 16 + (local >> 4), i = c * 256 + local;
      const cauce = Math.sin(y / 12) * 8 + Math.floor(x / 42) * 42;
      const agua = Math.abs(cauce - x) < 3 + (y & 1);
      datos[AGUA][i] = agua ? 0.55 + random() * 0.45 : random() * 0.2;
      for (let campo = 1; campo < CAMPOS.length; campo++) datos[campo][i] = random();
      datos[REFUGIO][i] *= agua ? 0.05 : 0.62;
      datos[CULTIVO][i] *= agua ? 0.05 : 0.60;
      if (empates) for (let campo = 1; campo < CAMPOS.length; campo++) datos[campo][i] = Math.round(datos[campo][i] * 4) / 4;
    }
  }
  return {
    paginas, paginaX, paginaY, versionPagina, versionVisible, duenoChunk, campos: CAMPOS,
    celda(x, y) {
      const px = Math.floor(x / 16) - px0, py = Math.floor(y / 16) - py0;
      if (px < 0 || px >= ancho || py < 0 || py >= alto) return -1;
      const pagina = py * ancho + px;
      return duenoChunk[pagina] < 0 ? -1 : pagina * 256 + ((y & 15) << 4) + (x & 15);
    },
    chunkDe: celda => celda >> 8,
    campo(nombre) {
      const i = CAMPOS.findIndex(campo => campo === nombre);
      if (i < 0) throw new Error(`Campo desconocido: ${nombre}`);
      return datos[i];
    },
  };
}

function crearFrente(terreno: Terreno, personas: number, animales: number, random: () => number, borde: boolean, peces: boolean) {
  const alta = personas + animales;
  const x = new Float32Array(alta), y = new Float32Array(alta), chunk = new Int32Array(alta).fill(-1);
  const cuerpo = new Float32Array(alta * CUERPO_ANCHO), rasgos = new Float32Array(alta * RASGOS_ANCHO);
  const gen = new Int32Array(alta), vivo = new Uint8Array(alta), clase = new Uint8Array(alta);
  const uid = new Float64Array(alta), decideEn = new Float64Array(alta).fill(10_000);
  const observacion = new Float32Array(alta * COLUMNAS_CEREBRO.observacion);
  const politica = new Float32Array(alta * COLUMNAS_CEREBRO.politica);
  const sesgo = new Float32Array(alta * COLUMNAS_CEREBRO.sesgo);
  const dueno = new Int32Array(alta), accion = new Uint8Array(alta), objetivo = new Int32Array(alta).fill(-1);
  const genoma = new Float32Array(alta * GENOMA_ANCHO), pareja = new Float64Array(alta).fill(-1);
  const tiposDePlan = new Uint16Array(alta);
  const grupos = { personas: [] as number[], animales: [] as number[] };
  const agua = terreno.campo('agua');
  for (let i = 0; i < alta; i++) {
    if (i % 251 === 250) continue; // una fila reservada que acaba de quedar vacía
    const persona = i < personas, acuatica = !persona && (peces ? i % 2 === 0 : i % 6 === 0);
    let c: number;
    do {
      c = Math.floor(random() * agua.length);
      // En borde, la celda va a la primera o la última fila o columna de su página.
      if (borde) c = (c & ~255) | (random() < 0.5 ? (c & 0xf0) | (random() < 0.5 ? 0 : 15) : (c & 15) | (random() < 0.5 ? 0 : 0xf0));
    } while (terreno.duenoChunk[c >> 8] < 0 || (agua[c] >= 0.5) !== acuatica);
    const p = c >> 8;
    const fx = borde ? Math.fround(random() * 0.999) : 0, fy = borde ? Math.fround(random() * 0.999) : 0;
    x[i] = terreno.paginaX[p] * 16 + (c & 15) + fx;
    y[i] = terreno.paginaY[p] * 16 + ((c & 255) >> 4) + fy;
    chunk[i] = p;
    gen[i] = 1 + (i % 11 === 0 ? 2 ** 20 : 0);
    vivo[i] = 1;
    clase[i] = persona ? Clase.Persona : Clase.Animal;
    uid[i] = i + 1;
    for (let k = 0; k < CUERPO_ANCHO; k++) cuerpo[i * CUERPO_ANCHO + k] = random();
    tiposDePlan[i] = persona ? 0 : acuatica ? 2 : 1;
    (persona ? grupos.personas : grupos.animales).push(i);
    if (!persona) continue;

    for (let k = 0; k < RASGOS_ANCHO; k++) rasgos[i * RASGOS_ANCHO + k] = random() * 2 - 1;
    politica.set(founderPolicy(3781, `p-${i}`).weights, i * COLUMNAS_CEREBRO.politica);
    for (let k = 0; k < CEREBRO.entradas; k++) observacion[i * CEREBRO.entradas + k] = random() * 2 - 1;
    for (let k = 0; k < CEREBRO.acciones; k++) sesgo[i * CEREBRO.acciones + k] = (random() - 0.5) * 0.2;
  }
  const columnas: Record<string, Col> = {
    gen, vivo, clase, uid, dueno, x, y, chunk, accion, objetivo, decideEn, cuerpo, rasgos, genoma, pareja,
    observacion, politica, sesgo,
  };
  const frente: FrentePublico = {
    tick: 0, alta, columnas: COLUMNAS, gen, vivo, clase, uid, dueno, x, y, chunk, accion, objetivo,
    decideEn, cuerpo, rasgos, genoma, pareja,
    col(nombre) {
      const col = columnas[nombre];
      if (!col) throw new Error(`Columna desconocida: ${nombre}`);
      return col;
    },
  };
  return { frente, grupos, tiposDePlan, observacion, sesgo, decideEn, cuerpo, x, y, chunk };
}

function barajar(slots: number[], random: () => number): void {
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
}

export function crearFixtureGpu(opciones: boolean | OpcionesFixture = false) {
  const { grande = false, semilla = 3781, empates = false, borde = false, peces = false } =
    typeof opciones === 'boolean' ? { grande: opciones } : opciones;
  const random = localRandom(semilla, 'm3-percibir');
  const terreno = crearTerreno(grande ? 24 : 4, grande ? 18 : 4, random, empates);
  const {
    frente, grupos, tiposDePlan, observacion, sesgo, decideEn, cuerpo, x, y, chunk,
  } = crearFrente(terreno, grande ? 3000 : 32, grande ? 30000 : 76, random, borde, peces);
  const planes = crearPlanes();
  barajar(grupos.personas, random);
  barajar(grupos.animales, random);
  const vencidos = grande ? [...grupos.personas.slice(0, 768), ...grupos.animales.slice(0, 3232)] : [...grupos.personas, ...grupos.animales];
  barajar(vencidos, random);
  const slots = Int32Array.from(vencidos);
  const plan = Uint16Array.from(vencidos, i => tiposDePlan[i]);
  const cerebrosVencidos = vencidos.filter(i => tiposDePlan[i] === 0);
  let tick = 100;
  let frenteActual = { ...frente, tick };
  for (const slot of slots) decideEn[slot] = tick;
  return {
    terreno, planes,
    get frente(): FrentePublico { return frenteActual; },
    lote(): LotePercepcion { return { tick, slots, plan }; },
    siguiente() {
      tick++;
      const comida = terreno.campo('comida') as Float32Array;
      for (let i = 0; i < 8; i++) {
        const p = (tick * 17 + i * 3) % terreno.paginas;
        if (terreno.duenoChunk[p] < 0) continue;
        comida[p * 256 + (tick & 255)] = random();
        terreno.versionPagina[p]++;
      }
      for (let i = 0; i < 16; i++) {
        const slot = cerebrosVencidos[(tick * 7 + i) % cerebrosVencidos.length];
        observacion[slot * CEREBRO.entradas + (tick % CEREBRO.entradas)] = random() * 2 - 1;
        sesgo[slot * CEREBRO.acciones + (tick % CEREBRO.acciones)] = (random() - 0.5) * 0.2;
      }
      const agua = terreno.campo('agua');
      for (let i = 0; i < Math.min(128, slots.length); i++) {
        const slot = slots[(tick * 131 + i) % slots.length];
        cuerpo[slot * CUERPO_ANCHO + CAMPOS_CUERPO.salud] = random();
        const direccion = (tick + i) & 3;
        const nx = x[slot] + (direccion === 0 ? 1 : direccion === 2 ? -1 : 0);
        const ny = y[slot] + (direccion === 1 ? 1 : direccion === 3 ? -1 : 0);
        const c = terreno.celda(Math.floor(nx), Math.floor(ny));
        if (c < 0 || (agua[c] >= 0.5) !== (tiposDePlan[slot] === 2)) continue;
        x[slot] = nx;
        y[slot] = ny;
        chunk[slot] = terreno.chunkDe(c);
      }
      frenteActual = { ...frente, tick };
      return frenteActual;
    },
  };
}
