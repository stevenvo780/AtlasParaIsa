import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const RETURNS_IMPORT = 'import { observeProductiveCompletion, type CompletionContext } from '
  + JSON.stringify(new URL('./retornos_v2.mts', import.meta.url).href) + ';\n';
/** Pinned V1 exact-anchor transforms; only the observer import location changes. */
export function replaceExactlyOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw new Error(`Instrument anchor must occur exactly once: ${anchor.slice(0, 120)}`);
  return source.replace(anchor, replacement);
}

/** Pure source transform; only an owned runtime copy receives the resulting text. */
export function instrumentReturnSources(indexSource: string, utilitySource: string) {
  let index = indexSource, utility = utilitySource;
  index = replaceExactlyOnce(index,
    'const trabajoPrevio = utilidadActiva ? person.technology.project?.progress ?? 0 : 0;',
    'const trabajoPrevio = person.technology.project?.progress ?? 0;');
  index = replaceExactlyOnce(index,
    'const trabajoGlobalPrevio = utilidadActiva ? world.technology.ledger.work : 0;',
    'const trabajoGlobalPrevio = world.technology.ledger.work;');
  index = replaceExactlyOnce(index,
    'if (utilidadActiva) registrarRetornoProductivo(person, person.action, completed ? 1 : 0,\n        trabajoPrevio + (world.technology.ledger.work - trabajoGlobalPrevio), conducta);',
    "registrarRetornoProductivo(person, person.action, completed ? 1 : 0,\n        trabajoPrevio + (world.technology.ledger.work - trabajoGlobalPrevio), conducta, { world, success: completed, site: 'technology' });");
  index = replaceExactlyOnce(index,
    "if (paramsOf(world).conducta.utilidadLocal === 1 && person.action !== 'invent')\n    registrarRetornoProductivo(person, person.action, producido, trabajoPagado, paramsOf(world).conducta);",
    "if (person.action !== 'invent')\n    registrarRetornoProductivo(person, person.action, producido, trabajoPagado, paramsOf(world).conducta, { world, success, site: 'physical' });");
  utility = RETURNS_IMPORT + replaceExactlyOnce(utility,
    'trabajoPagado: number, conducta: ConductaUtilidadLocal): void {\n  if (conducta.utilidadLocal !== 1',
    'trabajoPagado: number, conducta: ConductaUtilidadLocal, captura?: CompletionContext): void {\n  observeProductiveCompletion(captura, persona as AprendizUtilidadLocal & { id: string; role: string; communityId: string | null }, accion, beneficio, trabajoPagado);\n  if (conducta.utilidadLocal !== 1');
  return { index, utility };
}

export const hash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
export function sourceInventory(directory: string, prefix = ''): { path: string; sha256: string; bytes: number }[] {
  const result: { path: string; sha256: string; bytes: number }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...sourceInventory(join(directory, entry.name), relative));
    else if (entry.isFile()) { const body = readFileSync(join(directory, entry.name)); result.push({ path: relative, sha256: hash(body), bytes: body.length }); }
    else throw new Error(`No links or special source files: ${relative}`);
  }
  return result;
}

