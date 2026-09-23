/**
 * M6: textos en claro. Los textos del servidor (crónica, causas, intenciones, experiencias) llevan claves
 * internas en inglés e identificadores (`combine·abrade 456`, `wolf animal-51926--12--6-2`, `Estrategia
 * teach`, `descendant-4`, `e768`, `0.025`…). Este módulo puro los traduce AL MOSTRARLOS, solo con
 * diccionarios de claves conocidas y nombres que llegaron en el estado; lo desconocido pasa tal cual.
 * Nunca añade un hecho: solo cambia cómo se nombra lo que ya dice el texto.
 */
import type { TechnologyRecipeSummary, WorldView } from '../shared/types.js';
import { nombreConocido } from './vistos.js';

export const operaciones: Record<string, string> = { combine: 'Unir', separate: 'Separar', form: 'Dar forma', abrade: 'Desgastar', heat: 'Calentar', cool: 'Enfriar', compress: 'Comprimir', weave: 'Entrelazar' };
export const especiesConArticulo: Record<string, string> = { hare: 'una liebre', deer: 'un venado', boar: 'un jabalí', fish: 'un pez', wolf: 'un lobo', fox: 'un zorro' };
export const estrategias: Record<string, string> = { supply: 'aportar material', assist: 'ayudar en un trabajo', teach: 'enseñar', trade: 'trocar', tools: 'intercambiar objetos' };
export const contextos: Record<string, string> = { ready: 'disponible', hungry: 'con hambre', thirsty: 'con sed', tired: 'con cansancio',
  'partner-tired': 'acompañar en el cansancio', 'shelter-tired': 'refugiarse al estar cansado', 'food-hungry': 'comida con hambre', 'rain-shelter': 'refugio bajo la lluvia', irrelevant: 'sin relación con la decisión' };
export const causasMuerte: Record<string, string> = { starvation: 'falta prolongada de alimento', dehydration: 'falta prolongada de agua', exposure: 'desgaste por exposición', senescence: 'vejez' };
/** `specialty()` (world/index.ts) nombra algunas acciones y deja otras como clave; aquí se completan. */
export const especialidades: Record<string, string> = { research: 'investigación', craft: 'fabricación', invent: 'invención', repair: 'reparación', approach: 'acercarse a otros', accompany: 'compañía', retreat: 'buscar espacio', eat: 'alimentarse' };
/** Acciones en infinitivo, para «aumenta la preferencia por compartir». */
export const accionesInfinitivo: Record<string, string> = { explore: 'explorar', eat: 'comer', forage: 'cosechar', drink: 'beber', hunt: 'cazar', rest: 'descansar', approach: 'acercarse', accompany: 'acompañar', retreat: 'buscar espacio', share: 'compartir', gather: 'recolectar', farm: 'cultivar', build: 'construir', cooperate: 'cooperar', invent: 'inventar', repair: 'reparar', research: 'investigar', craft: 'fabricar' };
const materiales: Record<string, string> = { wood: 'madera', stone: 'piedra', water: 'agua' };
const fuentes: Record<string, string> = { raw: 'en bruto', residue: 'residuo de', water: 'agua' };

const OPS = Object.keys(operaciones).join('|');
const reOpsFlecha = new RegExp(`\\b(?:${OPS})\\b(?= → )|(?<=→ )(?:${OPS})\\b`, 'g');
const reOpsNombre = new RegExp(`\\b((?:${OPS})(?:·(?:${OPS}))*)·?(?= \\d|\\b)`, 'g');
/** Identificador de un recuerdo de la carta en una causa de la ley («recuerdo sample-rest», «Recordatorio approved-4»). */
const ID_RECUERDO = '(sample-[a-z-]+|approved-[A-Za-z0-9-]+)';
const reRecuerdo = new RegExp(`\\brecuerdo ${ID_RECUERDO}`, 'g'), reRecordatorio = new RegExp(`\\bRecordatorio ${ID_RECUERDO}`, 'g');

export interface ContextoTexto { world?: Partial<Pick<WorldView, 'people' | 'demography' | 'technology' | 'blueprints' | 'memories'>> | null }

/** Nombre legible de una persona por id; «alguien» si no llegó con ningún estado. */
export function nombreDe(id: string, world?: ContextoTexto['world']): string {
  return nombreConocido(id, world?.people ? { people: world.people, demography: world.demography } : null) ?? 'alguien';
}

/** Un procedimiento sin nombre propio se llama como sus operaciones: «Unir · Desgastar 456». */
export function nombreProcedimiento(id: string, world?: ContextoTexto['world']): string {
  const recipe = world?.technology?.recipes.find(r => r.id === id);
  if (recipe) return etiquetaReceta(recipe);
  const serial = /^recipe-(\d+)$/.exec(id)?.[1];
  return serial ? `procedimiento ${serial}` : id;
}
export function etiquetaReceta(recipe: Pick<TechnologyRecipeSummary, 'id' | 'name'>): string {
  const serial = recipe.id.replace('recipe-', ''), suffix = ` ${serial}`;
  if (!recipe.name.endsWith(suffix)) return recipe.name;
  const program = recipe.name.slice(0, -suffix.length);
  return /^[a-z]+(·[a-z]+)*·?$/.test(program) ? `${program.split('·').filter(Boolean).map(op => operaciones[op] ?? op).join(' · ')} ${serial}` : recipe.name;
}

/** Un recurso de la organización técnica («recipe:recipe-157», «raw:wood», «residue:stone»). */
export function recursoEnClaro(id: string, world?: ContextoTexto['world']): string {
  if (id.startsWith('recipe:')) return nombreProcedimiento(id.slice(7), world);
  if (id === 'unclassified') return 'material sin clasificar';
  const [source, material] = id.split(':');
  if (source && material && materiales[material]) return source === 'residue' ? `residuo de ${materiales[material]}` : `${materiales[material]}${fuentes[source] && source !== 'residue' ? ` ${fuentes[source]}` : ''}`;
  return id;
}

const mayuscula = (texto: string): string => texto.charAt(0).toLocaleUpperCase('es') + texto.slice(1);

/*
 * Constitución: «la carta (S e I, recuerdos) solo la cambia Steven». Un recuerdo de la carta llega a
 * los textos del servidor de dos maneras, y en ambas se muestra LITERAL (sin traducir, sin comas, sin
 * tocar lo que parezca un identificador):
 *  · citado entre «» por las plantillas de la ley (world/index.ts: `decide()` escribe «Influye
 *    «título»» en `reason` y «al recordar «título»» en el evento `memory`; el gesto `remember`, «Se hizo
 *    disponible «título»»). La ley no usa «» para nada más, así que todo tramo entre «» se protege,
 *    también uno sin cerrar (un texto recortado por el navegador);
 *  · entero, como experiencia o `recentMemory` (`remember(person, world, memory.text, …)`): se protege
 *    cada título y texto de `world.memories` que aparezca, del más largo al más corto.
 * Cada tramo protegido se cambia por un carácter de uso privado que ninguna regla reconoce y se
 * restaura al final. Si el texto ya trae caracteres de ese rango, no se traduce nada: antes un texto
 * de la ley sin traducir que un recuerdo alterado.
 */
const BASE_USO_PRIVADO = 0xE000, MAX_TRAMOS = 0xF8FF - BASE_USO_PRIVADO;
const hayUsoPrivado = (texto: string): boolean => /[\uE000-\uF8FF]/.test(texto);
type Memorias = NonNullable<ContextoTexto['world']>['memories'];

/** Títulos y textos de la carta que llegaron en el estado, del más largo al más corto. Uno de menos de
 * 4 caracteres no se busca DENTRO de otro texto (partiría identificadores de la ley como `neighbor-3`);
 * sigue protegido cuando es el texto entero o va citado entre «». */
function literalesDeCarta(memories: Memorias | undefined): string[] {
  const out = new Set<string>();
  for (const m of memories ?? []) {
    for (const literal of [m.text, m.title]) if (literal && literal.length >= 4) out.add(literal);
    // La forma citada no parte identificadores de la ley, así que se protege sea cual sea su longitud:
    // un título corto con comillas dentro rompería la regex de citas.
    if (m.title) out.add(`«${m.title}»`);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** true si `texto` es, entero, el título o el texto de un recuerdo de la carta que llegó en el estado. */
export function esTextoDeCarta(texto: string, ctx: ContextoTexto = {}): boolean {
  return !!texto && (ctx.world?.memories ?? []).some(m => m.text === texto || m.title === texto);
}

/** Traduce al mostrar. `contexto` 'especialidad' trata el texto como lista «a · b» de claves de acción. */
export function enClaro(texto: string, ctx: ContextoTexto = {}, contexto: 'texto' | 'especialidad' = 'texto'): string {
  if (!texto) return texto;
  if (contexto === 'especialidad') return texto.split(' · ').map(token => especialidades[token] ?? token).join(' · ');
  if (hayUsoPrivado(texto) || esTextoDeCarta(texto, ctx)) return texto;
  const world = ctx.world;
  const tramos: string[] = [];
  const proteger = (literal: string): string => {
    tramos.push(literal);
    return String.fromCharCode(BASE_USO_PRIVADO + Math.min(tramos.length - 1, MAX_TRAMOS));
  };
  let t = texto;
  for (const literal of literalesDeCarta(world?.memories)) if (t.includes(literal)) t = t.split(literal).join(proteger(literal));
  // Una cita que a su vez contiene «» (un título con comillas) se cierra de dentro hacia fuera.
  const cita = /«[^«»]*(?:»|$)/g;
  while (cita.test(t)) { cita.lastIndex = 0; t = t.replace(cita, proteger); }
  // Objetos, procedimientos, planos y animales por identificador.
  t = t.replace(/\bel objeto product-\d+/g, 'un objeto').replace(/\bproduct-\d+/g, 'un objeto');
  t = t.replace(/\brecipe:(recipe-\d+)/g, (_, id: string) => nombreProcedimiento(id, world));
  t = t.replace(/\brecipe-\d+\b/g, id => nombreProcedimiento(id, world));
  t = t.replace(/\bPlano (blueprint-\d+)/g, (_, id: string) => { const name = world?.blueprints?.find(b => b.id === id)?.name; return name ? `Plano «${name}»` : 'Un plano'; });
  t = t.replace(/\bblueprint-(\d+)\b/g, (id, serial: string) => world?.blueprints?.find(b => b.id === id)?.name ?? `plano ${serial}`);
  t = t.replace(/\bde blueprint-base\b/g, 'del plano inicial').replace(/\bblueprint-base\b/g, 'el plano inicial');
  t = t.replace(/ animal-[A-Za-z0-9-]+/g, '');
  t = t.replace(/(^|[.;]\s+|Nace )(hare|deer|boar|fish|wolf|fox)\b/g, (_, before: string, species: string) => `${before}${before ? especiesConArticulo[species] : mayuscula(especiesConArticulo[species]!)}`);
  // Personas y episodios por identificador.
  t = t.replace(/\b(?:neighbor|descendant)-\d+\b/g, id => nombreDe(id, world));
  t = t.replace(/ observada en e\d+\b/g, ' observada en un episodio anterior').replace(/\be\d+\b/g, 'un episodio anterior');
  // Claves de la ley.
  t = t.replace(/\bEstrategia (supply|assist|teach|trade|tools)\b/g, (_, key: string) => `Estrategia: ${estrategias[key]}`);
  t = t.replace(/\b([Cc])ontexto (partner-tired|shelter-tired|food-hungry|rain-shelter|irrelevant|ready|hungry|thirsty|tired)\b/g, (_, c: string, key: string) => `${c}ontexto: ${contextos[key]}`);
  // El título insertado viene de la carta: entra ya protegido, así las reglas siguientes no lo tocan.
  const citaDe = (id: string): string | null => {
    const title = world?.memories?.find(m => m.id === id)?.title;
    return title ? proteger(`«${title}»`) : null;
  };
  t = t.replace(reRecuerdo, (_, id: string) => { const c = citaDe(id); return c ? `recuerdo ${c}` : 'un recuerdo'; });
  t = t.replace(reRecordatorio, (_, id: string) => `Recordatorio de ${citaDe(id) ?? 'un recuerdo'}`);
  t = t.replace(/\bpreferencia por (explore|eat|forage|drink|hunt|rest|approach|accompany|retreat|share|gather|farm|build|cooperate|invent|repair|research|craft)\b/g, (_, key: string) => `preferencia por ${accionesInfinitivo[key]}`);
  t = t.replace(/\bCausa del modelo: (starvation|dehydration|exposure|senescence)\b/g, (_, key: string) => `Causa: ${causasMuerte[key]}`);
  // Secuencias de operaciones («abrade → combine») en minúscula, dentro de la frase; luego los nombres.
  t = t.replace(reOpsFlecha, (op: string) => operaciones[op]!.toLocaleLowerCase('es'));
  t = t.replace(reOpsNombre, (match: string) => match.split('·').filter(Boolean).map(op => operaciones[op] ?? op).join(' · '));
  // Un par de coordenadas enteras sin espacio («junto a La huerta (12,5)», nacimientos en world/index.ts)
  // se leería como el decimal 12,5 una vez que los decimales llevan coma: se separa como «(12, 5)».
  t = t.replace(/\((-?\d+),(-?\d+)\)/g, '($1, $2)');
  // Coma decimal: «0.120» → «0,120» (los textos del servidor no usan separador de miles).
  t = t.replace(/(\d)\.(\d)/g, '$1,$2');
  // Más tramos que caracteres de uso privado no ocurre con la carta real; si ocurriera, el texto sale
  // tal cual antes que arriesgar un recuerdo mal restaurado.
  if (tramos.length > MAX_TRAMOS) return texto;
  // Un tramo puede contener otro protegido antes (el título dentro de su cita): se restaura hacia dentro.
  const restaurar = (s: string): string => s.replace(/[\uE000-\uF8FF]/g, c => {
    const tramo = tramos[c.charCodeAt(0) - BASE_USO_PRIVADO];
    return tramo === undefined ? c : restaurar(tramo);
  });
  return tramos.length ? restaurar(t) : t;
}

/** «1 ejecución», «3 ejecuciones». */
export function plural(n: number, uno: string, varios: string, formato: (n: number) => string = v => v.toLocaleString('es-CO')): string {
  return `${formato(n)} ${n === 1 ? uno : varios}`;
}
