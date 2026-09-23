import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALCANCES, ALCANCES_SERIALES, COLECCIONES_POR_NOMBRE, CONSTANTES_DE_RADIO, ESCRITURAS, ESTADO_GLOBAL, FASES_CON_HALO, FUERA_DEL_PASO, HALO_CELDAS, INVENTARIO,
  LECTURAS_GLOBALES, LECTURAS_POR_IDENTIDAD, LLAMADAS, PRIMITIVAS, RAICES, RECORRIDOS, UMBRALES_QUE_NO_SON_LECTURAS,
  alcanceSerial, alcancesDeFase, excesos, fraccionBorde, funcionesDeFase, haloRequerido,
  type Alcance, type ClaveDeRadio, type Fase, type Inventario, type Llamada, type Sitio,
} from '../src/world/halo.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, parseParams } from '../src/world/params.js';
import { CHUNK_SIZE } from '../src/world/terrain.js';

const DIRECTORIO = fileURLToPath(new URL('../src/world/', import.meta.url));
const FUENTES: Readonly<Record<string, string>> = Object.fromEntries(readdirSync(DIRECTORIO).filter(f => f.endsWith('.ts') && f !== 'halo.ts').sort()
  .map(f => [f, readFileSync(DIRECTORIO + f, 'utf8')]));

// ── Analizador léxico: sin comentarios, cadenas ni expresiones regulares, con las posiciones del original. ──
function limpiar(texto: string): string {
  const out = texto.split(''), blanco = (i: number) => { if (out[i] !== '\n') out[i] = ' '; };
  const pila: { plantilla: boolean; llaves: number }[] = [{ plantilla: false, llaves: 0 }];
  let i = 0, ultimo = '';
  while (i < texto.length) {
    const ctx = pila[pila.length - 1]!, c = texto[i]!, d = texto[i + 1];
    if (ctx.plantilla) {
      if (c === '\\') { blanco(i); blanco(i + 1); i += 2; }
      else if (c === '`') { pila.pop(); ultimo = '`'; i++; }
      else if (c === '$' && d === '{') { pila.push({ plantilla: false, llaves: 0 }); i += 2; ultimo = '{'; }
      else blanco(i++);
      continue;
    }
    if (c === '/' && d === '/') { while (i < texto.length && texto[i] !== '\n') blanco(i++); continue; }
    if (c === '/' && d === '*') { const fin = texto.indexOf('*/', i + 2), hasta = fin < 0 ? texto.length : fin + 2; while (i < hasta) blanco(i++); continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < texto.length && texto[i] !== c && texto[i] !== '\n') { if (texto[i] === '\\') blanco(i++); blanco(i++); }
      i++; ultimo = c; continue;
    }
    if (c === '`') { pila.push({ plantilla: true, llaves: 0 }); i++; continue; }
    if (c === '/' && (ultimo === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(ultimo) || /\b(?:return|typeof|case)\s*$/.test(texto.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1, clase = false;
      while (j < texto.length && texto[j] !== '\n' && (clase || texto[j] !== '/')) { if (texto[j] === '\\') j++; else if (texto[j] === '[') clase = true; else if (texto[j] === ']') clase = false; j++; }
      if (texto[j] === '/') { for (let k = i; k <= j; k++) blanco(k); i = j + 1; while (/[a-z]/.test(texto[i] ?? '')) blanco(i++); ultimo = 'r'; continue; }
    }
    if (c === '{') ctx.llaves++;
    if (c === '}') { if (ctx.llaves === 0 && pila.length > 1) { pila.pop(); i++; continue; } ctx.llaves--; }
    if (!/\s/.test(c)) ultimo = c;
    i++;
  }
  return out.join('');
}

interface Decl { fichero: string; nombre: string; inicio: number; fin: number; tipo: string }
interface Fuente { fichero: string; texto: string; limpio: string; decl: Decl[]; importa: Map<string, string> }
const DECLARACION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum|import|export)\b\s*\*?\s*([A-Za-z_$][\w$]*)?/;
/** Cada declaración de primer nivel (columna 0 del texto limpio) va hasta la siguiente. */
function cargar(textos: Readonly<Record<string, string>>): Map<string, Fuente> {
  const fuentes = new Map<string, Fuente>();
  for (const [fichero, texto] of Object.entries(textos)) {
    const limpio = limpiar(texto), decl: Decl[] = [];
    let pos = 0, n = 0;
    for (const linea of limpio.split('\n')) {
      n++;
      const m = DECLARACION.exec(linea);
      if (m) {
        if (decl.length) decl[decl.length - 1]!.fin = pos;
        const anonima = m[1] === 'import' || m[1] === 'export' || !m[2];
        decl.push({ fichero, nombre: anonima ? `<${m[1]}@${n}>` : m[2]!, inicio: pos, fin: limpio.length, tipo: m[1]! });
      }
      pos += linea.length + 1;
    }
    const importa = new Map<string, string>();
    for (const m of texto.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'\.\/([\w-]+)\.js'/gm)) for (const parte of m[1]!.split(',').map(p => p.trim()).filter(Boolean)) {
      if (parte.startsWith('type ')) continue;
      const [nombre, alias] = parte.split(/\s+as\s+/) as [string, string?];
      importa.set(alias ?? nombre, `${m[2]}.ts:${nombre}`);
    }
    fuentes.set(fichero, { fichero, texto, limpio, decl, importa });
  }
  return fuentes;
}

const COLECCION = /\.\s*(people|places|structures|tiles|animals|communities|invitations|reminders|memories|blueprints|legacy|retiredLegacy|chunks|retiredChunks)\b/g;
const NOMBRES_DE_COLECCION = new Set(COLECCION.source.slice(COLECCION.source.indexOf('(') + 1, COLECCION.source.indexOf(')')).split('|'));
const ESTADO = /\bstate\.(tile|occupants|counts)\b/g;
const PRIMITIVA = new Map(PRIMITIVAS.map(p => [p.funcion, `${p.fichero}:${p.funcion}`]));
const RECIBEN_COLECCION = new Set(COLECCIONES_POR_NOMBRE.map(c => `${c.fichero}:${c.funcion}`));
const NO_CODIGO = /^(?:import|export|interface|type)$/;
type Tipo = 'coleccion' | 'nombre' | 'estado' | 'primitiva' | 'alias' | 'llamada' | 'barrido';
interface Uso { fichero: string; funcion: string; pos: number; tipo: Tipo; nombre: string; llama?: string }
const clave = (fichero: string, funcion: string) => `${fichero}:${funcion}`;
const lineaDe = (f: Fuente, pos: number) => f.texto.slice(0, pos).split('\n').length;
const textoDe = (f: Fuente, pos: number) => f.texto.split('\n')[lineaDe(f, pos) - 1]!.trim().slice(0, 150);

/** Fin del inicializador que empieza en `desde`: la primera `,` o `;` a profundidad 0 (o `argumentos`: sólo
 * el paréntesis que cierra, para leer lo que sigue a una llamada). */
function finDeExpresion(texto: string, desde: number, argumentos = false): number {
  let profundidad = 0;
  for (let i = desde; i < texto.length; i++) {
    const c = texto[i]!;
    if ('([{'.includes(c)) profundidad++;
    else if (')]}'.includes(c)) { if (profundidad === 0) return i; profundidad--; }
    else if (!argumentos && (c === ',' || c === ';') && profundidad === 0) return i;
  }
  return texto.length;
}
/** Operando derecho de una comparación que empieza en `desde`: hasta `,` `;` `)` `&&` `||` `?` `:` `}` a profundidad 0. */
function operando(texto: string, desde: number): string {
  let profundidad = 0, i = desde;
  for (; i < texto.length; i++) {
    const c = texto[i]!, dos = texto.slice(i, i + 2);
    if ('([{'.includes(c)) profundidad++;
    else if (')]}'.includes(c)) { if (profundidad === 0) break; profundidad--; }
    else if (profundidad === 0 && (',;?:\n'.includes(c) || dos === '&&' || dos === '||')) break;
  }
  return texto.slice(desde, i).trim();
}
/** Operando izquierdo de una comparación que acaba en `hasta` (sin incluir): hacia atrás hasta un delimitador a profundidad 0. */
function operandoIzquierdo(texto: string, hasta: number): string {
  let profundidad = 0, i = hasta - 1;
  for (; i >= 0; i--) {
    const c = texto[i]!, dos = texto.slice(i - 1, i + 1);
    if (')]}'.includes(c)) profundidad++;
    else if ('([{'.includes(c)) { if (profundidad === 0) break; profundidad--; }
    else if (profundidad === 0 && (',;?:=!\n'.includes(c) || dos === '&&' || dos === '||')) break;
  }
  return texto.slice(i + 1, hasta).trim();
}
/** Nombres que liga un patrón de declaración: `v`, `[dx, dy]` o `{ x, y: b }`. */
const ligados = (patron: string): string[] => [...patron.replace(/:\s*[A-Za-z_$][\w$]*/g, m => m.replace(/^:\s*/, ' ')).matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]);
/** `v` desplaza una coordenada en `cuerpo`: `p.x + v`, `y - v`, `v + p.x`… */
const desplaza = (cuerpo: string, v: string): boolean =>
  new RegExp(`(?:\\.[xy]|(?<![\\w$.])[xy])\\s*[+-]\\s*${v}!?(?![\\w$.])|(?<![\\w$.])${v}!?\\s*[+-]\\s*[\\w$.]*\\.[xy]\\b`).test(cuerpo);

class Analisis {
  readonly fuentes: Map<string, Fuente>;
  readonly decl = new Map<string, Decl>();
  readonly usos = new Map<string, Uso[]>();
  readonly lectores = new Set<string>();
  constructor(textos: Readonly<Record<string, string>>) {
    this.fuentes = cargar(textos);
    for (const f of this.fuentes.values()) for (const d of f.decl) if (!NO_CODIGO.test(d.tipo)) this.decl.set(clave(f.fichero, d.nombre), d);
    for (const [k, d] of this.decl) this.usos.set(k, this.directos(this.fuentes.get(d.fichero)!, d));
    // Un barrido sin lectura no lee el mundo: sólo cuenta en una función que ya lee.
    for (const [k, u] of this.usos) if (u.some(x => x.tipo !== 'barrido') && !PRIMITIVA.has(this.decl.get(k)!.nombre)) this.lectores.add(k);
    for (const k of PRIMITIVA.values()) this.lectores.add(k);
    for (let cambio = true; cambio;) {
      cambio = false;
      for (const k of this.decl.keys()) if (!this.lectores.has(k) && this.llamadas(k).some(u => this.lectores.has(u.llama!))) { this.lectores.add(k); cambio = true; }
    }
  }
  private resolver(f: Fuente, nombre: string): string | undefined {
    if (this.decl.has(clave(f.fichero, nombre))) return clave(f.fichero, nombre);
    const importado = f.importa.get(nombre);
    return importado && this.decl.has(importado) ? importado : undefined;
  }
  /** Lecturas del mundo escritas en la declaración, con sus alias locales. */
  private directos(f: Fuente, d: Decl): Uso[] {
    const cuerpo = f.limpio.slice(d.inicio, d.fin), usos: Uso[] = [];
    const add = (pos: number, tipo: Tipo, nombre: string) => usos.push({ fichero: f.fichero, funcion: d.nombre, pos: d.inicio + pos, tipo, nombre });
    for (const m of cuerpo.matchAll(COLECCION)) add(m.index!, 'coleccion', m[1]!);
    // `const { people } = world` y `world['people']` también leen una colección.
    for (const m of cuerpo.matchAll(/\{([^{}]*)\}\s*=(?![=>])/g)) for (const nombre of ligados(m[1]!)) if (NOMBRES_DE_COLECCION.has(nombre)) add(m.index!, 'coleccion', nombre);
    const original = f.texto.slice(d.inicio, d.fin);
    for (const m of original.matchAll(/\[\s*['"`]([A-Za-z]+)['"`]\s*\]/g)) if (NOMBRES_DE_COLECCION.has(m[1]!) && cuerpo[m.index!] === '[') add(m.index!, 'coleccion', m[1]!);
    // El mundo entero por reflexión o con una clave calculada: `Object.values(world)`, `{ ...world }`, `world[campo]`.
    // También el mundo con otro tipo o con otro nombre: `world as …`, `(world)[…]`, `const w = world;`.
    for (const m of cuerpo.matchAll(/(?:\b(?:Object|JSON|Reflect)\s*\.\s*\w+\s*\(\s*|\.\.\.\s*)(?:world|host)\b(?!\s*\.)|(?<![\w$.])(?:world|host)\s*(?:\[|as\b|\)\s*\[)|(?<![=!<>])=\s*(?:world|host)\s*(?=[;,)\n])/g)) add(m.index!, 'coleccion', 'reflexion');
    for (const m of cuerpo.matchAll(ESTADO)) add(m.index!, 'estado', m[1]!);
    for (const m of cuerpo.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (PRIMITIVA.has(m[1]!) && m[1] !== d.nombre && !/function\s+$/.test(cuerpo.slice(0, m.index!))) add(m.index!, 'primitiva', m[1]!);
    const nombres = COLECCIONES_POR_NOMBRE.find(c => c.fichero === f.fichero && c.funcion === d.nombre)?.nombres ?? [];
    for (const nombre of nombres) for (const m of cuerpo.matchAll(new RegExp(`(?<![\\w$.])${nombre}\\b(?!\\s*:)(?!\\s*=[^=>])`, 'g'))) add(m.index!, 'nombre', nombre);
    // Alias: `const x = world.people`, `const f = tileLookup(…)` o una función flecha que lee; hasta punto fijo.
    const alias = new Set<string>();
    for (let cambio = true; cambio;) {
      cambio = false;
      for (const m of cuerpo.matchAll(/(?:\b(?:const|let|var)\s+|,\s*)([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=(?![=>])/g)) {
        const nombre = m[1]!, desde = m.index! + m[0].length, valor = cuerpo.slice(desde, finDeExpresion(cuerpo, desde)).trim();
        if (alias.has(nombre)) continue;
        const lee = (t: string) => new RegExp(COLECCION.source).test(t) || new RegExp(ESTADO.source).test(t) || [...PRIMITIVA.keys()].some(p => new RegExp(`\\b${p}\\s*\\(`).test(t))
          || [...alias].some(x => new RegExp(`(?<![\\w$.])${x}\\b`).test(t));
        const desnudo = new RegExp(`^[\\w$.\\s]*\\.\\s*(?:${COLECCION.source.slice(6, -3)})$`).test(valor), consulta = /^tileLookup\s*\(/.test(valor);
        // Una función invocada en el acto (`(() => {…})()`) no es un alias: da un valor, y sus lecturas son directas.
        const flecha = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>/.test(valor) && !/^\(.*\)\s*\(\s*\)$/s.test(valor);
        if (desnudo || consulta || (flecha && lee(valor))) { alias.add(nombre); cambio = true; }
      }
    }
    for (const nombre of alias) for (const m of cuerpo.matchAll(new RegExp(`(?<![\\w$.])${nombre}\\b(?!\\s*:)(?!\\s*=[^=>])`, 'g'))) add(m.index!, 'alias', nombre);
    // Barridos: un `for (let|const …)` o un parámetro de función flecha cuya variable desplaza una coordenada. El patrón
    // que lo fija debe incluir sus cotas (la cabecera del `for`, o el arreglo de desplazamientos y el `.map` que lo recorre).
    for (const m of cuerpo.matchAll(/\bfor\s*\(\s*(?:let|const|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) {
      const cabecera = finDeExpresion(cuerpo, cuerpo.indexOf('(', m.index!) + 1, true);
      for (const v of ligados(m[1]!)) if (desplaza(cuerpo, v)) {
        add(m.index!, 'barrido', v);
        // Un desplazamiento reasignado dentro del cuerpo (`dy += 20`) cambia el barrido sin tocar su cabecera.
        for (const a of cuerpo.matchAll(new RegExp(`(?<![\\w$.])${v}\\s*(?:[-+*/%]?=(?![=>])|\\+\\+|--)|(?:\\+\\+|--)\\s*${v}\\b`, 'g'))) if (a.index! > cabecera) add(a.index!, 'barrido', v);
        break;
      }
    }
    for (const m of cuerpo.matchAll(/(?:\(\s*(\[[^\]]*\]|\{[^}]*\})\s*\)|\(([^()]*)\)|(?<![\w$.])([A-Za-z_$][\w$]*))\s*(?::[^=()]*)?=>/g)) {
      for (const v of ligados(m[1] ?? m[2] ?? m[3]!).filter(v => !/^(?:number|string|boolean|Tile|Point|Person)$/.test(v))) if (desplaza(cuerpo, v)) { add(m.index!, 'barrido', v); break; }
    }
    return usos;
  }
  /** Llamadas (o referencias) a otras declaraciones de `src/world` que no son primitivas. */
  llamadas(k: string): Uso[] {
    const d = this.decl.get(k)!, f = this.fuentes.get(d.fichero)!, cuerpo = f.limpio.slice(d.inicio, d.fin), usos: Uso[] = [];
    const locales = new Set<string>();
    for (const m of cuerpo.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|[,(]\s*([A-Za-z_$][\w$]*)\s*(?:[:,)=]|\?:)|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>|,\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) locales.add(m[1] ?? m[2] ?? m[3] ?? m[4]!);
    let primera = true;
    for (const m of cuerpo.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b/g)) {
      const nombre = m[1]!;
      if (primera && nombre === d.nombre) { primera = false; continue; }
      if (PRIMITIVA.has(nombre)) continue;
      const antes = cuerpo.slice(0, m.index!).trimEnd(), despues = cuerpo.slice(m.index! + nombre.length);
      if (/\btypeof$/.test(antes) || (/^\s*:(?!:)/.test(despues) && /[{,]$/.test(antes))) continue;
      if (!/^\s*(?:<[^<>()]*>)?\(/.test(despues) && locales.has(nombre)) continue;
      const destino = this.resolver(f, nombre);
      if (destino && destino !== k) usos.push({ fichero: f.fichero, funcion: d.nombre, pos: d.inicio + m.index!, tipo: 'llamada', nombre, llama: destino });
    }
    return usos;
  }
  /** Funciones lectoras que alcanza una raíz por el fuente (las primitivas no se recorren). */
  cierre(raices: readonly string[]): Set<string> {
    const vistas = new Set(raices), cola = [...raices];
    while (cola.length) for (const u of this.llamadas(cola.pop()!)) {
      if (this.lectores.has(u.llama!) && ![...PRIMITIVA.values()].includes(u.llama!) && !vistas.has(u.llama!)) { vistas.add(u.llama!); cola.push(u.llama!); }
    }
    return vistas;
  }
}

interface Tablas extends Inventario {
  readonly serial: readonly Sitio[]; readonly globales: readonly (Sitio & { id: string; fase: Fase })[]; readonly identidad: readonly (Sitio & { id: string; fase: Fase })[];
  readonly recorridos: readonly Sitio[]; readonly escrituras: readonly Sitio[];
}
const TABLAS: Tablas = { ...INVENTARIO, serial: ALCANCES_SERIALES, globales: LECTURAS_GLOBALES, identidad: LECTURAS_POR_IDENTIDAD, recorridos: RECORRIDOS, escrituras: ESCRITURAS };
const lecturasDe = (t: Tablas): readonly Sitio[] => [...t.alcances, ...t.serial, ...t.globales, ...t.identidad, ...t.recorridos, ...t.escrituras];

/** Intervalos [inicio, fin) de cada aparición de cada patrón dentro de la declaración. */
function apariciones(f: Fuente, d: Decl, s: Sitio, problemas: string[]): [number, number][] {
  const texto = f.texto.slice(d.inicio, d.fin), res: [number, number][] = [];
  for (const p of s.patrones) {
    let n = 0;
    // En frontera de símbolo: `<= 3` no casa dentro de `<= 30`, ni `person` dentro de `persons`.
    const frontera = (i: number) => !(/[\w$]/.test(p[0]!) && /[\w$]/.test(texto[i - 1] ?? '')) && !(/[\w$]/.test(p.at(-1)!) && /[\w$]/.test(texto[i + p.length] ?? ''))
      && !(/\d/.test(p.at(-1)!) && /\.\d/.test(texto.slice(i + p.length, i + p.length + 2)));
    for (let i = texto.indexOf(p); i >= 0; i = texto.indexOf(p, i + 1)) if (frontera(i)) { res.push([d.inicio + i, d.inicio + i + p.length]); n++; }
    if (n !== (s.veces ?? 1)) problemas.push(`${s.fichero} (${s.funcion}) el patrón aparece ${n} veces (se esperaban ${s.veces ?? 1}): ${p}`);
  }
  return res;
}
const cubre = (intervalos: readonly [number, number][], pos: number) => intervalos.some(([i, f]) => i <= pos && pos < f);
/** Fin de la cadena de miembros y llamadas que empieza en `desde` (`world.people.filter(…)\n  .map(…)[0]!`): sigue
 * con `.x`, `?.x`, `(…)`, `[…]` y `!`, también tras un salto de línea si la línea siguiente empieza por `.`. */
function finDeCadena(limpio: string, desde: number): number {
  let i = desde;
  for (;;) {
    while (/[\w$]/.test(limpio[i] ?? '')) i++;
    if (limpio[i] === '!' && limpio[i + 1] !== '=') { i++; continue; }
    if (limpio[i] === '(' || limpio[i] === '[') { i = finDeExpresion(limpio, i + 1, true) + 1; continue; }
    let j = i;
    while (/\s/.test(limpio[j] ?? '')) j++;
    if (limpio[j] === '.' && limpio[j + 1] !== '.' || limpio.startsWith('?.', j)) { i = j + (limpio[j] === '?' ? 2 : 1); if (limpio[i] === '(' || limpio[i] === '[') continue; if (!/[\w$]/.test(limpio[i] ?? '')) return i; continue; }
    return i;
  }
}
/** Tramo que tiene que quedar fijado entero para una lectura en `pos` (posición absoluta en el fichero): la cadena
 * que cuelga de ella (`world.people.filter(…).map(…)`, una llamada con sus argumentos) o, si recorre una colección
 * con `for (… of …)`, la cabecera y la condición de la primera sentencia del cuerpo, que es la que acota. */
function tramoDeLectura(limpio: string, pos: number, tipo: Tipo): [number, number] {
  let inicio = pos;
  if (tipo === 'coleccion') while (inicio > 0 && /[\w$.?!]/.test(limpio[inicio - 1]!) && !limpio.slice(0, inicio).endsWith('...')) inicio--;
  const antes = limpio.slice(Math.max(0, inicio - 40), inicio);
  /** Desde `i` (inicio de un cuerpo): la condición del primer `if`, la cabecera del primer `for` o la primera sentencia. */
  const primeraSentencia = (i: number): number => {
    while (/[\s{]/.test(limpio[i] ?? '')) i++;
    if (/^(?:if|for)\b/.test(limpio.slice(i, i + 3))) return finDeExpresion(limpio, limpio.indexOf('(', i) + 1, true) + 1;
    return finDeExpresion(limpio, i);
  };
  if (tipo === 'barrido' || /\bof\s*$/.test(antes)) {
    const abre = limpio.lastIndexOf('for', inicio), cierra = finDeExpresion(limpio, limpio.indexOf('(', abre) + 1, true);
    return [abre, tipo === 'barrido' ? cierra + 1 : primeraSentencia(cierra + 1)];
  }
  // `world.structures.flatMap(s => { … })`: como un `for`, hasta lo que acota en la primera sentencia del cuerpo.
  const bloque = /^[\w$.?!]*\s*\.\s*[\w$]+\s*\(\s*(?:[\w$]+|\([^()]*\))\s*=>\s*\{/.exec(limpio.slice(pos));
  if (bloque) return [inicio, primeraSentencia(pos + bloque[0].length)];
  return [inicio, finDeCadena(limpio, pos)];
}
/** Primer carácter no blanco de [inicio, fin) sin fijar, o -1. */
function sinFijar(limpio: string, [inicio, fin]: [number, number], intervalos: readonly [number, number][]): number {
  for (let i = inicio; i < fin; i++) if (!/\s/.test(limpio[i]!) && !cubre(intervalos, i)) return i;
  return -1;
}

/** Todas las comprobaciones estáticas: devuelve los problemas (vacío = inventario al día). */
function verificar(textos: Readonly<Record<string, string>>, t: Tablas = TABLAS, halo = HALO_CELDAS): { problemas: string[]; analisis: Analisis; cierres: Map<Fase, Set<string>> } {
  const analisis = new Analisis(textos), problemas: string[] = [];
  const declDe = (s: { fichero: string; funcion: string }) => analisis.decl.get(clave(s.fichero, s.funcion));
  const fuera = new Set(FUERA_DEL_PASO.map(f => clave(f.fichero, f.funcion)));
  for (const k of [...fuera, ...PRIMITIVA.values()]) if (!analisis.decl.has(k)) problemas.push(`${k}: declaración inexistente`);
  // Intervalos cubiertos por función, separados en lecturas y llamadas.
  const lecturas = new Map<string, [number, number][]>(), llamadas = new Map<string, Map<string, [number, number][]>>();
  for (const s of lecturasDe(t)) {
    const d = declDe(s);
    if (!d) { problemas.push(`${s.fichero} (${s.funcion}): declaración inexistente`); continue; }
    const k = clave(s.fichero, s.funcion);
    lecturas.set(k, [...lecturas.get(k) ?? [], ...apariciones(analisis.fuentes.get(s.fichero)!, d, s, problemas)]);
  }
  for (const l of t.llamadas) {
    const d = declDe(l);
    if (!d) { problemas.push(`${l.fichero} (${l.funcion}): declaración inexistente`); continue; }
    const k = clave(l.fichero, l.funcion), porDestino = llamadas.get(k) ?? new Map<string, [number, number][]>();
    porDestino.set(l.llama, [...porDestino.get(l.llama) ?? [], ...apariciones(analisis.fuentes.get(l.fichero)!, d, l, problemas)]);
    llamadas.set(k, porDestino);
    if (!analisis.lectores.has(l.llama) || [...PRIMITIVA.values()].includes(l.llama)) problemas.push(`${l.id}: ${l.llama} no es una función del paso que lea el mundo`);
  }
  // Raíces y cierres de las fases con halo, desde el fuente.
  const cierres = new Map<Fase, Set<string>>();
  for (const fase of FASES_CON_HALO) {
    const raices = t.raices.filter(r => r.fase === fase).map(r => clave(r.fichero, r.funcion));
    for (const r of raices) if (!analisis.decl.has(r)) problemas.push(`raíz inexistente: ${r}`);
    cierres.set(fase, analisis.cierre(raices.filter(r => analisis.decl.has(r))));
  }
  const estrictas = new Set([...cierres.values()].flatMap(c => [...c]));
  for (const r of t.raices) {
    const d = declDe(r.llamador), f = analisis.fuentes.get(r.llamador.fichero);
    if (!d || !f) { problemas.push(`${r.funcion}: llamador inexistente`); continue; }
    const fijadas = apariciones(f, d, r.llamador, problemas), raiz = clave(r.fichero, r.funcion);
    for (const k of analisis.decl.keys()) for (const u of analisis.llamadas(k)) if (u.llama === raiz && !(k === clave(d.fichero, d.nombre) && cubre(fijadas, u.pos)))
      problemas.push(`${raiz} se llama fuera de su bucle de fase: ${u.fichero}:${lineaDe(analisis.fuentes.get(u.fichero)!, u.pos)} (${u.funcion})`);
    const ids = new Set(lecturasDe(t).map(s => (s as { id?: string }).id));
    for (const id of r.seleccion) if (!ids.has(id)) problemas.push(`${raiz}: selección desconocida ${id}`);
  }
  // Red estricta en las funciones que alcanzan las fases con halo; red de la tarea en el resto del paso.
  const RED_TAREA = new RegExp(`(?<![\\w$])(?<![^.]\\.)(?:world|host)\\s*\\.\\s*(?:${[...NOMBRES_DE_COLECCION].join('|')})\\b`);
  const CONSULTA = /distance\(|Math\.hypot\(|\.(?:filter|some|find|findIndex|findLast|includes|every|reduce|map|flatMap|forEach|slice|sort|indexOf|at)\(|\bof\s+(?:world|host)\.|(?:world|host)\.\w+\s*\[/;
  for (const [k, d] of analisis.decl) {
    if (fuera.has(k) || [...PRIMITIVA.values()].includes(k)) continue;
    const f = analisis.fuentes.get(d.fichero)!, cubiertas = lecturas.get(k) ?? [];
    if (estrictas.has(k)) {
      // Una colección pasada como argumento a una llamada fijada vale si el destino declara ese argumento como colección.
      const pasadas = [...llamadas.get(k) ?? []].filter(([destino]) => RECIBEN_COLECCION.has(destino)).flatMap(([, i]) => i);
      for (const u of analisis.usos.get(k)!) {
        if (!cubre(cubiertas, u.pos) && !(u.tipo !== 'barrido' && cubre(pasadas, u.pos))) {
          problemas.push(`${d.fichero}:${lineaDe(f, u.pos)} (${d.nombre}) ${u.tipo} ${u.nombre} sin inventariar: ${textoDe(f, u.pos)}`);
          continue;
        }
        if (u.nombre === 'reflexion' || cubre(pasadas, u.pos)) continue;
        const hueco = sinFijar(f.limpio, tramoDeLectura(f.limpio, u.pos, u.tipo), cubiertas);
        if (hueco >= 0) problemas.push(`${d.fichero}:${lineaDe(f, hueco)} (${d.nombre}) ${u.tipo} ${u.nombre} fijada a medias (falta «${f.texto.slice(hueco, hueco + 40).split('\n')[0]}»): ${textoDe(f, u.pos)}`);
      }
      for (const m of f.limpio.slice(d.inicio, d.fin).matchAll(/(?<![\w$])(?<![^.]\.)(?:world|host|privateHost)\s*\.\s*([A-Za-z_$][\w$]*)/g))
        if (!NOMBRES_DE_COLECCION.has(m[1]!) && !Object.hasOwn(ESTADO_GLOBAL, m[1]!)) problemas.push(`${d.fichero}:${lineaDe(f, d.inicio + m.index!)} (${d.nombre}) campo global ${m[1]} fuera de ESTADO_GLOBAL: ${textoDe(f, d.inicio + m.index!)}`);
      for (const u of analisis.llamadas(k)) {
        if (!analisis.lectores.has(u.llama!)) continue;
        const fijadas = llamadas.get(k)?.get(u.llama!) ?? [];
        if (!cubre(fijadas, u.pos)) { problemas.push(`${d.fichero}:${lineaDe(f, u.pos)} (${d.nombre}) llamada a ${u.llama} sin inventariar: ${textoDe(f, u.pos)}`); continue; }
        // La llamada entera, con sus argumentos: el punto que recibe es parte de la composición.
        const abre = f.limpio.indexOf('(', u.pos), tramo: [number, number] = [u.pos, abre >= 0 && /^\s*(?:<[^<>()]*>)?$/.test(f.limpio.slice(u.pos + u.nombre.length, abre)) ? finDeExpresion(f.limpio, abre + 1, true) + 1 : u.pos + u.nombre.length];
        const hueco = sinFijar(f.limpio, tramo, fijadas);
        if (hueco >= 0) problemas.push(`${d.fichero}:${lineaDe(f, hueco)} (${d.nombre}) llamada a ${u.llama} fijada a medias (falta «${f.texto.slice(hueco, hueco + 40).split('\n')[0]}»): ${textoDe(f, u.pos)}`);
      }
    } else {
      const cuerpo = f.limpio.slice(d.inicio, d.fin), lineas = cuerpo.split('\n'), avisadas = new Set<number>();
      let pos = d.inicio;
      // Por cadena: la colección y la expresión que cuelga de ella hasta `,` `;` o el paréntesis que la cierra,
      // aunque ocupe varias líneas (`...world.structures\n  .filter(…)`).
      for (const m of cuerpo.matchAll(new RegExp(RED_TAREA.source, 'g'))) {
        const cadena = cuerpo.slice(Math.max(0, m.index! - 12), finDeExpresion(cuerpo, m.index! + m[0].length));
        if (CONSULTA.test(cadena) && !cubre(cubiertas, d.inicio + m.index!)) {
          avisadas.add(d.inicio + m.index!);
          problemas.push(`${d.fichero}:${lineaDe(f, d.inicio + m.index!)} (${d.nombre}) lectura sin inventariar: ${textoDe(f, d.inicio + m.index!)}`);
        }
      }
      for (const linea of lineas) {
        if (RED_TAREA.test(linea) && CONSULTA.test(linea)) for (const m of linea.matchAll(new RegExp(RED_TAREA.source, 'g'))) if (!cubre(cubiertas, pos + m.index!) && !avisadas.has(pos + m.index!))
          problemas.push(`${d.fichero}:${lineaDe(f, pos)} (${d.nombre}) lectura sin inventariar: ${textoDe(f, pos)}`);
        for (const m of linea.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (PRIMITIVA.has(m[1]!) && !cubre(cubiertas, pos + m.index!))
          problemas.push(`${d.fichero}:${lineaDe(f, pos)} (${d.nombre}) primitiva ${m[1]} sin inventariar: ${textoDe(f, pos)}`);
        pos += linea.length + 1;
      }
    }
  }
  // Las tablas de las fases con halo sólo hablan de funciones que las alcanzan, y en su fase.
  for (const e of t.alcances) if (!estrictas.has(clave(e.fichero, e.funcion))) problemas.push(`${e.id}: su función no alcanza ninguna fase con halo (va en ALCANCES_SERIALES)`);
  for (const l of t.llamadas) if (!estrictas.has(clave(l.fichero, l.funcion))) problemas.push(`${l.id}: la llamada sale de una función que no alcanza ninguna fase con halo`);
  for (const e of [...t.globales, ...t.identidad]) {
    const fases = FASES_CON_HALO.filter(fase => cierres.get(fase)!.has(clave(e.fichero, e.funcion)));
    if (fases.length && !fases.includes(e.fase)) problemas.push(`${e.id}: su función está en la fase ${fases.join('/')}, no en ${e.fase}`);
  }
  for (const fase of FASES_CON_HALO) {
    const inventario = [...funcionesDeFase(fase, t)].sort(), fuente = [...cierres.get(fase)!].sort();
    if (inventario.join() !== fuente.join()) problemas.push(`fase ${fase}: el grafo del inventario (${inventario.join(', ')}) no es el del fuente (${fuente.join(', ')})`);
  }
  // Umbrales de distancia: número ≤ halo, constante de radio, o dentro de un patrón fijado; si no, declarado.
  for (const [k, d] of analisis.decl) {
    if (fuera.has(k)) continue;
    const f = analisis.fuentes.get(d.fichero)!, cuerpo = f.limpio.slice(d.inicio, d.fin), cubiertas = [...lecturas.get(k) ?? [], ...[...llamadas.get(k)?.values() ?? []].flat()];
    for (const m of cuerpo.matchAll(/(?<![\w$.])(?:distance|Math\.hypot)\(/g)) {
      const cierra = finDeExpresion(cuerpo, m.index! + m[0].length, true), resto = cuerpo.slice(cierra + 1), op = /^\s*(<=|>=|<|>)(?!=)\s*/.exec(resto);
      // Umbral a la derecha (`distance(…) <= 7`) o a la izquierda (`7 >= distance(…)`).
      const izquierda = /(?:<=|>=|(?<![=>])<|(?<![=-])>)$/.exec(cuerpo.slice(0, m.index!).trimEnd());
      if (!op && !izquierda) continue;
      const umbral = op ? operando(cuerpo, cierra + 1 + op[0].length) : operandoIzquierdo(cuerpo, m.index! - (cuerpo.slice(0, m.index!).length - cuerpo.slice(0, m.index!).trimEnd().length) - izquierda![0].length), numero = /^\d+(?:\.\d+)?$/.test(umbral) ? Number(umbral) : undefined;
      if (numero !== undefined ? numero <= halo : Object.hasOwn(CONSTANTES_DE_RADIO, umbral)) continue;
      if (/^(?:distance|Math\.hypot)\(/.test(umbral) && finDeExpresion(umbral, umbral.indexOf('(') + 1, true) === umbral.length - 1) continue; // distancia contra distancia
      if (cubre(cubiertas, d.inicio + m.index!) || UMBRALES_QUE_NO_SON_LECTURAS.some(u => u.fichero === d.fichero && u.funcion === d.nombre && u.umbral === umbral)) continue;
      problemas.push(`${d.fichero}:${lineaDe(f, d.inicio + m.index!)} (${d.nombre}) umbral ${umbral} fuera del halo o sin inventariar`);
    }
  }
  for (const [nombre, c] of Object.entries(CONSTANTES_DE_RADIO)) {
    const valor = Number(new RegExp(`\\bconst ${nombre} = (\\d+(?:\\.\\d+)?);`).exec(textos[c.fichero] ?? '')?.[1]);
    if (valor !== c.valor) problemas.push(`${nombre} vale ${valor} en ${c.fichero}, el inventario dice ${c.valor}`);
    if (c.valor > halo) problemas.push(`${nombre} = ${c.valor} supera el halo`);
  }
  for (const m of (textos['inventions.ts'] ?? '').matchAll(/functionalNear\(world, \w+, ([\d.]+)\)/g)) if (Number(m[1]) > 1.5) problemas.push(`functionalNear con radio ${m[1]} > 1,5`);
  // Composición.
  try { for (const e of excesos(t, halo)) problemas.push(`${e.id} (${e.fase}) alcanza ${e.alcance} > ${halo}`); }
  catch (error) { problemas.push(String(error)); }
  return { problemas, analisis, cierres };
}

const BASE = verificar(FUENTES);
const conHalo = (fase: Fase) => [...alcancesDeFase(fase)].filter(([id]) => !ALCANCES.find(e => e.id === id)!.excepcion);
const maximoSerial = (fase: Fase, params = HISTORICAL_PARAMS) => Math.max(...ALCANCES_SERIALES.filter(e => e.fase === fase).map(e => alcanceSerial(e.id, ALCANCES_SERIALES, params)!));

test('el inventario cubre cada lectura, llamada y barrido de las fases con halo y ninguna entrada está obsoleta', () => {
  assert.deepEqual(BASE.problemas, []);
  const ids = [...lecturasDe(TABLAS), ...LLAMADAS].map(e => (e as { id?: string }).id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'ids repetidos en el inventario');
  for (const e of ALCANCES) assert.ok(e.centro === 'entrada' || ALCANCES.some(c => c.id === e.centro), `centro desconocido: ${e.id} → ${e.centro}`);
  for (const l of LLAMADAS) assert.ok(l.centro === 'entrada' || ALCANCES.some(c => c.id === l.centro), `centro desconocido: ${l.id} → ${l.centro}`);
  for (const e of ALCANCES_SERIALES) assert.ok(e.centro === 'actor' || ALCANCES_SERIALES.some(c => c.id === e.centro), `centro desconocido: ${e.id} → ${e.centro}`);
});

test('las funciones que alcanza cada fase con halo son las del fuente', () => {
  const tamanos = Object.fromEntries(FASES_CON_HALO.map(fase => [fase, BASE.cierres.get(fase)!.size]));
  assert.deepEqual(tamanos, { decision: 43, ecologia: 4, fauna: 2 });
  for (const fase of FASES_CON_HALO) assert.deepEqual([...funcionesDeFase(fase)].sort(), [...BASE.cierres.get(fase)!].sort());
  // Lecturas que ninguna tabla cubre si la red estricta no se aplicara (lo que la red de la tarea no veía).
  const decision = BASE.cierres.get('decision')!;
  for (const k of ['society.ts:itemNeed', 'society.ts:settlementOpportunity', 'inventions.ts:inventionCandidates', 'inventions.ts:functionalNear']) assert.ok(decision.has(k), k);
});

test('el alcance compuesto de las fases con halo no supera HALO_CELDAS, y el máximo es exactamente el halo', () => {
  assert.deepEqual(excesos(), []);
  const decision = new Map(conHalo('decision'));
  const numericos = [...decision].filter(([id]) => typeof ALCANCES.find(e => e.id === id)!.radio === 'number');
  assert.equal(Math.max(...numericos.map(([, v]) => v!)), HALO_CELDAS);
  // 7 + 7 desde el otro de la cooperación; el 13 de G2 (hogar 7 + personas 6), su rama hermana y la obra.
  assert.deepEqual(numericos.filter(([, v]) => v === HALO_CELDAS).map(([id]) => id).sort(), ['cooperacion.destinoDelOtro', 'cooperacion.insumos', 'cooperacion.necesidad']);
  assert.deepEqual(['asentamiento.hogar.personas', 'asentamiento.hogar.teselas', 'asentamiento.hogar.estructuras', 'asentamiento.lugares.personas', 'decision.obra', 'estructuras.funcionales', 'obra.materiales']
    .map(id => decision.get(id)), [13, 11, 11, 12, 12, 8.5, 7]);
  const porColeccion = (coleccion: Alcance['coleccion']) => Math.max(...numericos.filter(([id]) => ALCANCES.find(e => e.id === id)!.coleccion === coleccion).map(([, v]) => v!));
  assert.deepEqual({ teselas: porColeccion('teselas'), personas: porColeccion('personas'), estructuras: porColeccion('estructuras'), lugares: porColeccion('lugares') },
    { teselas: 14, personas: 13, estructuras: 11, lugares: 12 });
  assert.deepEqual(Object.fromEntries(FASES_CON_HALO.map(fase => [fase, Math.max(...conHalo(fase).map(([, v]) => v ?? 0))])), { decision: 14, ecologia: 1, fauna: 6 });
  // La memoria de la fauna: 6 celdas vistas + 480 pasos de vida a un paso de celda cada ≥ 4 pasos, sólo presencia.
  assert.equal(alcancesDeFase('fauna').get('fauna.memoria'), 6 + Number(/const MEMORY_TTL = (\d+);/.exec(FUENTES['animals.ts']!)![1]) / (11 - 7));
  assert.match(FUENTES['animals.ts']!, /const interval = Math\.ceil\(11 - animal\.genes\.speed \* 7 \+ animal\.fatigue \* 3\);/);
});

test('quién actúa en una fase con halo lo decide la fase serial: el destino propio y dos selecciones globales de la fauna', () => {
  const decision = RAICES.find(r => r.fase === 'decision')!, fauna = RAICES.find(r => r.fase === 'fauna')!;
  assert.equal(Math.max(...decision.seleccion.map(id => alcanceSerial(id)!)), 4096, 'el disparador de destino agotado lee el destino propio');
  for (const id of fauna.seleccion) {
    const e = LECTURAS_GLOBALES.find(g => g.id === id)!;
    assert.equal(e.fase, 'fauna'); assert.equal(e.funcion, 'stepAnimals');
  }
  assert.match(FUENTES['animals.ts']!, /export const MAX_ACTIVE_ANIMALS = 8192;/);
  assert.match(FUENTES['animals.ts']!, /export const MAX_ANIMAL_DECISIONS_PER_TICK = 1024;/);
});

test('alcances fijados de las fases seriales, que el halo no acota', () => {
  const fases: Fase[] = ['faunaSerial', 'accion', 'gestos', 'estructuras', 'encuentros', 'demografia', 'comunidades', 'reproduccion'];
  assert.deepEqual(Object.fromEntries(fases.map(f => [f, maximoSerial(f)])), {
    faunaSerial: 1, accion: 4096, gestos: 7, estructuras: 1.5, encuentros: 3, demografia: 2, comunidades: 7, reproduccion: 4,
  });
  assert.equal(alcanceSerial('accion.caminable'), 24, 'la búsqueda de ruta de `move` lee terreno y presencia a 24 celdas');
  assert.match(FUENTES['index.ts']!, /Math\.abs\(next\.y - start\.y\)\) > 24 \|\| !walkable/);
  const activacion = ESCRITURAS.find(e => e.id === 'activacion')!;
  assert.equal(activacion.radio, 8 + CHUNK_SIZE - 1);
  assert.ok(activacion.radio > HALO_CELDAS, 'el área escrita supera el halo de lectura: la activación queda en el coordinador');
  assert.match(FUENTES['index.ts']!, /earlierForagerExhausts\(person, tile, workers, work, \{\s*tick: world\.tick, radius: RADIUS,/);
});

test('radios de parámetros: el cortejo de reglas 10 exige 128 celdas y el histórico cabe en el halo', () => {
  assert.deepEqual(haloRequerido(HISTORICAL_PARAMS), { celdas: HALO_CELDAS, causa: 'cooperacion.destinoDelOtro' });
  assert.equal(DEFAULT_PARAMS.poblacion.cortejo > 0, true, 'reglas 10 activa el cortejo');
  assert.deepEqual(haloRequerido(DEFAULT_PARAMS), { celdas: DEFAULT_PARAMS.poblacion.radioCortejo, causa: 'decision.cortejo' });
  assert.equal(DEFAULT_PARAMS.poblacion.radioCortejo, 128);
  assert.equal(haloRequerido(parseParams('poblacion.cortejo=0,poblacion.radioCortejo=128', DEFAULT_PARAMS)).celdas, HALO_CELDAS);
  const claves: ClaveDeRadio[] = ['poblacion.radioPareja', 'poblacion.radioLugar', 'poblacion.radioCortejo', 'social.disputaRadio'];
  const exceden = claves.filter(clave => {
    const params = parseParams(`${clave}=${PARAM_RANGES[clave]![1]},poblacion.cortejo=1`, HISTORICAL_PARAMS);
    return ALCANCES_SERIALES.some(e => typeof e.radio !== 'number' && e.radio.param === clave && alcanceSerial(e.id, ALCANCES_SERIALES, params)! > HALO_CELDAS)
      || ALCANCES.some(e => typeof e.radio !== 'number' && e.radio.param === clave && alcancesDeFase('decision', params).get(e.id)! > HALO_CELDAS);
  });
  assert.deepEqual(exceden, ['poblacion.radioPareja', 'poblacion.radioLugar', 'poblacion.radioCortejo']);
  assert.deepEqual(excesos(INVENTARIO, HALO_CELDAS, DEFAULT_PARAMS), [{ id: 'decision.cortejo', fase: 'decision', alcance: 128 }]);
});

/** Aplica sustituciones literales (cada texto viejo debe aparecer una sola vez) a una copia de las fuentes. */
function mutar(cambios: readonly [fichero: string, viejo: string, nuevo: string][]): Record<string, string> {
  const textos = { ...FUENTES };
  for (const [fichero, viejo, nuevo] of cambios) {
    assert.equal(textos[fichero]!.split(viejo).length, 2, `el texto a mutar no aparece una vez en ${fichero}: ${viejo}`);
    textos[fichero] = textos[fichero]!.replace(viejo, nuevo);
  }
  return textos;
}
const detecta = (textos: Record<string, string>, esperado: RegExp, t: Tablas = TABLAS) => {
  const { problemas } = verificar(textos, t);
  assert.ok(problemas.some(p => esperado.test(p)), `no detectado (${esperado}):\n${problemas.join('\n') || '(sin problemas)'}`);
};

test('la prueba muerde: las siete mutaciones de la verificación, una composición 7 + 8 en el código y otras formas de leer más lejos fallan', () => {
  const eleccion = "  const partner = nearbyPeople.find(other => person.role !== 'neighbor' && other.role !== 'neighbor');";
  // M0: un halo de 13 no basta.
  assert.deepEqual(excesos(INVENTARIO, 13).map(e => e.id).sort(), ['cooperacion.destinoDelOtro', 'cooperacion.insumos', 'cooperacion.necesidad']);
  // M1: la percepción de `choose` a 3 · RADIUS.
  detecta(mutar([['index.ts', 'for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {\n    if (dx * dx + dy * dy > RADIUS * RADIUS) continue;',
    'for (let dy = -3 * RADIUS; dy <= 3 * RADIUS; dy++) for (let dx = -3 * RADIUS; dx <= 3 * RADIUS; dx++) {\n    if (dx * dx + dy * dy > 9 * RADIUS * RADIUS) continue;']]),
  /index\.ts:\d+ \(choose\) barrido dy sin inventariar/);
  // M2: la percepción de la fauna × 5.
  detecta(mutar([['animals.ts', 'for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {\n    if (Math.abs(dx) + Math.abs(dy) > radius) continue;',
    'for (let dy = -radius * 5; dy <= radius * 5; dy++) for (let dx = -radius * 5; dx <= radius * 5; dx++) {\n    if (Math.abs(dx) + Math.abs(dy) > radius * 5) continue;']]),
  /animals\.ts:\d+ \(localTiles\) barrido dy sin inventariar/);
  // M3: `itemNeed` compone la comida del destino del otro: 7 + 7 + 1,5.
  detecta(mutar([['society.ts', "import { constructionCost, waterAvailable } from './inventions.js';", "import { constructionCost, foodAvailable, waterAvailable } from './inventions.js';"],
    ['society.ts', '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);',
      '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);\n    if (foodAvailable(world, person.target) > 0) need = Math.max(need, 0.1);']]),
  /society\.ts:\d+ \(itemNeed\) llamada a inventions\.ts:foodAvailable sin inventariar/);
  // …y si alguien la inventaría con su centro honesto, la composición supera el halo.
  const m3 = mutar([['society.ts', "import { constructionCost, waterAvailable } from './inventions.js';", "import { constructionCost, foodAvailable, waterAvailable } from './inventions.js';"],
    ['society.ts', '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);',
      '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);\n    if (foodAvailable(world, person.target) > 0) need = Math.max(need, 0.1);']]);
  const honesta: Llamada = { id: 'itemNeed→foodAvailable', fichero: 'society.ts', funcion: 'itemNeed', llama: 'inventions.ts:foodAvailable', centro: 'cooperacion.necesidad', patrones: ['foodAvailable(world, person.target)'] };
  detecta(m3, /estructuras\.funcionales \(decision\) alcanza 15\.5 > 14/, { ...TABLAS, llamadas: [...LLAMADAS, honesta] });
  // M4: una suma de estructuras a 30 con `.reduce`.
  detecta(mutar([['society.ts', '    food += facilities.reduce((sum,s)=>sum+s.food,0); water += facilities.reduce((sum,s)=>sum+s.water,0);',
    '    food += facilities.reduce((sum,s)=>sum+s.food,0); water += facilities.reduce((sum,s)=>sum+s.water,0);\n    food += world.structures.reduce((sum, s) => sum + (Math.abs(s.x - place.x) <= 30 && Math.abs(s.y - place.y) <= 30 ? s.food : 0), 0);']]),
  /society\.ts:\d+ \(settlementOpportunity\) coleccion structures sin inventariar/);
  // M5: un bucle indexado sobre `world.people`.
  detecta(mutar([['index.ts', eleccion, `${eleccion}\n  let lejanos = 0;\n  for (let i = 0; i < world.people.length; i++) if (Math.hypot(world.people[i]!.x - person.x, world.people[i]!.y - person.y) <= 40) lejanos++;`]]),
    /index\.ts:\d+ \(choose\) coleccion people sin inventariar/);
  // M6: un nombre `radius` que no es el de `functionalNear` ni el de la fauna.
  const m6 = mutar([['index.ts', eleccion, `${eleccion}\n  const radius = 40, lejanos = world.people\n    .filter(o => distance(person, o) <= radius);`]]);
  detecta(m6, /index\.ts:\d+ \(choose\) coleccion people sin inventariar/);
  detecta(m6, /index\.ts:\d+ \(choose\) umbral radius fuera del halo o sin inventariar/);
  // M7: la fauna mira una celda a 40 por `state.tile`.
  detecta(mutar([['animals.ts', '  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(cell(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);',
    '  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(cell(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);\n  const horizonte = state.tile(animal.x + 40, animal.y);']]),
  /animals\.ts:\d+ \(choose\) estado tile sin inventariar/);
  // Composición 7 + 8 en el código: estructuras a ≤ 8 del otro de la cooperación (a ≤ 7). Sin inventariar falla la
  // cobertura; inventariada con su centro, ninguna de las dos lecturas supera 14 y su composición sí.
  const m8 = mutar([['society.ts', '  const skill = learner.action;', '  const skill = learner.action;\n  if (algunoCerca(world.structures, learner, 9, s => distance(s, learner) <= 8)) return;']]);
  detecta(m8, /society\.ts:\d+ \(practicedSkillToTeach\) coleccion structures sin inventariar/);
  const ocho: Alcance = { id: 'sintetico.ocho', coleccion: 'estructuras', centro: 'entrada', radio: 8, fichero: 'society.ts', funcion: 'practicedSkillToTeach',
    patrones: ['algunoCerca(world.structures, learner, 9, s => distance(s, learner) <= 8)'] };
  assert.ok(ALCANCES.find(e => e.id === 'cooperacion.otro')!.radio === 7 && ocho.radio === 8);
  detecta(m8, /sintetico\.ocho \(decision\) alcanza 15 > 14/, { ...TABLAS, alcances: [...ALCANCES, ocho] });
  // Un alias de una lectura usado de nuevo, una constante de radio cambiada y una raíz llamada desde otro sitio.
  detecta(mutar([['index.ts', 'waterAt(tile.x, tile.y + 1);', 'waterAt(tile.x, tile.y + 1) || waterAt(tile.x + 20, tile.y);']]), /index\.ts:\d+ \(ecology\) alias waterAt sin inventariar/);
  detecta(mutar([['index.ts', 'const RADIUS = 7;', 'const RADIUS = 21;']]), /RADIUS vale 21 en index\.ts/);
  detecta(mutar([['index.ts', '  const tile = tileAt(world, person)!;\n  const physiology', '  const tile = tileAt(world, person)!;\n  if (world.tick < 0) choose(world, person);\n  const physiology']]),
    /index\.ts:choose se llama fuera de su bucle de fase/);
  // Una lectura fijada que cambia por dentro: umbral 3 → 30 (el patrón casa en frontera de símbolo), un predicado que
  // se amplía, una sentencia antes del filtro que acota un `for`, un desplazamiento reasignado dentro del barrido.
  detecta(mutar([['inventions.ts', 'distance(person, other) <= 3', 'distance(person, other) <= 30']]), /inventions\.ts \(knownBlueprints\) el patrón aparece 0 veces/);
  detecta(mutar([['family.ts', '    && !closeKin(person, other) && reproductiveReadiness(world, other)', '    && !closeKin(person, other) && reproductiveReadiness(world, other) || Math.abs(other.x - person.x) < 40 && other.hunger > 2']]),
    /family\.ts:\d+ \(familyOpportunity\) coleccion people fijada a medias/);
  detecta(mutar([['society.ts', '  for (const other of world.people) {\n    if (other === person || distance(person, other) > 7',
    '  for (const other of world.people) {\n    if (other.hunger > 0.99 && Math.abs(other.x - person.x) < 40) break;\n    if (other === person || distance(person, other) > 7']]),
  /society\.ts:\d+ \(evaluateCooperation\) coleccion people fijada a medias/);
  detecta(mutar([['index.ts', "    const tile = tileAt(world, { x: person.x + dx, y: person.y + dy }); if (tile && tile.terrain !== 'water') nearbyTiles.push(tile);",
    "    dx += 20; const tile = tileAt(world, { x: person.x + dx, y: person.y + dy }); if (tile && tile.terrain !== 'water') nearbyTiles.push(tile);"]]), /index\.ts:\d+ \(choose\) barrido dx sin inventariar/);
  // El mundo por otro camino: un campo global nuevo, el mundo con otro tipo, y una lectura serial repartida en dos líneas.
  detecta(mutar([['index.ts', eleccion, `${eleccion}\n  if (world.events.length > 1e9) return;`]]), /index\.ts:\d+ \(choose\) campo global events fuera de ESTADO_GLOBAL/);
  detecta(mutar([['index.ts', eleccion, `${eleccion}\n  const todos = (world as unknown as Record<string, unknown[]>)['peo' + 'ple'];`]]), /index\.ts:\d+ \(choose\) coleccion reflexion sin inventariar/);
  detecta(mutar([['index.ts', '  let transferred=0;', '  const lejanos = world.people\n    .filter(other => distance(person, other) <= 40);\n  let transferred=0;']]), /index\.ts:\d+ \(transferEstate\) lectura sin inventariar/);
  // Un ciclo de centros en el inventario no se suma: lanza.
  assert.throws(() => alcancesDeFase('decision', undefined, { ...INVENTARIO, alcances: [...ALCANCES, { ...ocho, centro: 'sintetico.ciclo', id: 'sintetico.ciclo' }] }), /Ciclo/);
});

test('coste del halo: fracción de celdas leídas de las regiones vecinas', () => {
  const casi = (valor: number, esperado: number) => assert.ok(Math.abs(valor - esperado) < 1e-4, `${valor} ≠ ${esperado}`);
  casi(fraccionBorde(256, 8), 0.1289);
  casi(fraccionBorde(256, 13), 0.2134);
  casi(fraccionBorde(256, 14), 0.2307);
  casi(fraccionBorde(512, 13), 0.1041);
  casi(fraccionBorde(512, 14), 0.1124);
  casi(fraccionBorde(256, 128), 3);
  casi(fraccionBorde(512, 128), 1.25);
});
