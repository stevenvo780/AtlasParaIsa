/**
 * V18 ola 2 — archivo de tecnología: validadores sin alocaciones, memoria de referencias atada a la generación
 * de pruebas y páginas de recibos como una sola lectura verificada.
 *
 * 1. Diferencial exhaustivo contra la versión anterior (`2ff91e3`, leída con `git show`): miles de cuerpos
 *    corrompidos con su digesto recalculado (recibos y definiciones), leídos fuera y dentro de la transacción
 *    anfitriona, deben dar EXACTAMENTE el mismo resultado o el mismo error en las dos versiones.
 * 2. Batería fija fail-closed (no depende de git).
 * 3. La memoria de referencias se invalida con cualquier escritura propia, ajena, `truncateAfter` o `ROLLBACK`.
 * 4. Banco realista (40 definiciones, 10 000 recibos con catalizadores, anidadas, transferencias y agua):
 *    `putExecution`, barrido completo de `listExecutionRecords`, `pruneExecutions` y `observeHostWrites`,
 *    antes y después, con paridad de digestos y de recibos.
 */
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { TechnologyDefinition } from '../src/shared/technology-archive.js';
import type { TechnologyExecution, TechnologyProgram } from '../src/shared/technology.js';
import * as current from '../src/server/technology-archive.js';
import { programSignature } from '../src/world/technology.js';
import { sha256 } from './lib/store.js';

type ArchiveModule = typeof current;
type Archive = InstanceType<ArchiveModule['TechnologyArchive']>;
const LEGACY_COMMIT = '2ff91e3';
const repo = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'v18-w2-archive-perf-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let legacyModule: Promise<ArchiveModule | null> | undefined;
/** La implementación anterior, con sus importaciones relativas apuntando a este árbol (sólo cambió este fichero). */
function legacy(): Promise<ArchiveModule | null> {
  legacyModule ??= (async () => {
    try {
      const source = execFileSync('git', ['show', `${LEGACY_COMMIT}:src/server/technology-archive.ts`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const rewritten = source.replace(/from '\.\.\/(shared|world)\//g, (_, folder: string) => `from '${pathToFileURL(join(repo, 'src', folder)).href}/`);
      const file = join(scratch, 'technology-archive.legacy.ts'); writeFileSync(file, rewritten);
      return await import(pathToFileURL(file).href) as ArchiveModule;
    } catch { return null; }
  })();
  return legacyModule;
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN');
  try { const result = run(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** Como `Store`: BEGIN + transacción anfitriona + COMMIT/acknowledge, o ROLLBACK + invalidación. */
function host<T>(db: DatabaseSync, archive: Archive, run: () => T): T {
  db.exec('BEGIN');
  try {
    db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get(); archive.beginHostTransaction();
    const result = run(); db.exec('COMMIT'); archive.acknowledgeHostCommit(); return result;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); archive.invalidateVerification(); throw error; }
}
function database(t: TestContext | null, name: string): { db: DatabaseSync; path: string } {
  const path = join(mkdtempSync(join(scratch, `${name}-`)), 'archive.sqlite'), db = new DatabaseSync(path);
  t?.after(() => db.close());
  return { db, path };
}
function definition(id: number, tick: number, parent?: TechnologyDefinition): TechnologyDefinition {
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: id % 4 + 1, shape: id % 2 ? 'edge' : 'rod' }] };
  if (parent) program.inputs = [{ source: 'product', recipeId: parent.id, mass: 1000 }];
  return { lawsVersion: 1, id: `recipe-${id}`, name: `Design ${id}`, program, signature: programSignature(program),
    parents: parent ? [parent.id] : [], generation: parent ? parent.generation + 1 : 1, inventorId: 'inventor-1', tick, x: 0, y: 0,
    novelty: id === 1 ? 'both' : 'program', capacities: { cutting: 0.2, storage: 0, insulation: 0, cultivation: 0.1, binding: 0, abrasion: 0.2 } };
}
function definitions(count: number): TechnologyDefinition[] {
  const out: TechnologyDefinition[] = [];
  for (let id = 1; id <= count; id++) out.push(definition(id, id, out.at(-1)));
  return out;
}
const line = (resourceId: string, mass: number) => ({ resourceId, mass });
const base = (serial: number, tick: number, kind: TechnologyExecution['kind']): TechnologyExecution => ({
  id: `process-${serial}`, kind, tick, actorId: 'inventor-1', recipeId: null, programSignature: '', inputs: [], outputs: [], residueMass: 0,
  energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0,
  balance: { opening: [], closing: [], externalInputs: [], externalLoss: [] } });
/** Cuatro recibos del mismo tick: herramienta usada (anidada), fabricación que la usa como catalizador,
 * transferencia y fuga de agua; los balances llevan líneas `recipe:` repetidas, como en el mundo real. */
function group(serial: number, tick: number, defs: TechnologyDefinition[], index: number): TechnologyExecution[] {
  const def = defs[index % defs.length]!, other = defs[(index * 7 + 3) % defs.length]!, third = defs[(index * 13 + 5) % defs.length]!;
  const held = [line(`recipe:${other.id}`, 91), line(`recipe:${third.id}`, 661), line('residue:stone', 8244)];
  const use: TechnologyExecution = { ...base(serial, tick, 'use'), recipeId: def.id, energy: 0.001, work: 1,
    balance: { opening: [line(`recipe:${def.id}`, 500), ...held], closing: [line(`recipe:${def.id}`, 500), ...held], externalInputs: [], externalLoss: [] } };
  const craft: TechnologyExecution = { ...base(serial + 1, tick, 'craft'), recipeId: def.id, programSignature: def.signature,
    inputs: [line('raw:stone', 1000)], outputs: [line(`recipe:${def.id}`, 900)], residueMass: 100, energy: 0.5, work: 2, benefit: 0.1,
    parentRecipeIds: [...def.parents], nestedExecutionIds: [use.id],
    catalysts: [{ executionId: use.id, itemId: `product-${serial}`, recipeId: def.id, wear: 1, required: true }],
    balance: { opening: [line(`recipe:${def.id}`, 500), line('raw:stone', 1000), ...held],
      closing: [line(`recipe:${def.id}`, 500), line(`recipe:${def.id}`, 900), line('residue:stone', 100), ...held], externalInputs: [], externalLoss: [] } };
  const transfer: TechnologyExecution = { ...base(serial + 2, tick, 'transfer'), recipeId: def.id, transferId: `transfer-${serial}`,
    counterpartyId: 'inventor-2', balance: { opening: [line(`recipe:${def.id}`, 300), ...held], closing: [...held], externalInputs: [],
      externalLoss: [line(`recipe:${def.id}`, 300)] } };
  const water: TechnologyExecution = { ...base(serial + 3, tick, 'water'),
    water: { version: 1, policyVersion: 1, action: 'leak', opening: [{ itemId: `product-${serial}`, quanta: 1321 }],
      closing: [{ itemId: `product-${serial}`, quanta: 1320 }], filled: 0, consumed: 0, lost: 1, received: 0, sent: 0 },
    balance: { opening: [...held], closing: [...held], externalInputs: [], externalLoss: [] } } as TechnologyExecution;
  return [use, craft, transfer, water];
}
function receipts(defs: TechnologyDefinition[], groups: number, firstTick = 100, firstSerial = 1): TechnologyExecution[] {
  const out: TechnologyExecution[] = [];
  for (let index = 0; index < groups; index++) out.push(...group(firstSerial + index * 4, firstTick + index, defs, index));
  return out;
}
function seed(db: DatabaseSync, archive: Archive, defs: TechnologyDefinition[], list: TechnologyExecution[]): void {
  transaction(db, () => archive.installSchema());
  host(db, archive, () => { for (const value of defs) archive.putDefinition(value); for (const value of list) archive.putExecution(value); });
}
const outcome = (run: () => unknown): string => {
  try { return `ok ${JSON.stringify(run())}`; } catch (error) { return `error ${(error as Error).message}`; }
};
const corrupt = (db: DatabaseSync, table: string, key: string, id: string, body: string, digest = sha256(body)) =>
  db.prepare(`UPDATE ${table} SET body=?,digest=? WHERE ${key}=?`).run(body, digest, id);

// ——— 1. Diferencial exhaustivo ———————————————————————————————————————————————————————————————————————————
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];
const VALUES: Json[] = [null, true, 0, -1, 1.5, 2 ** 53, 4000, '', 'x y', 'a\u0007', 'process-1', 'process-01', 'process-0', 'process-9',
  'recipe-1', 'recipe-0', 'recipe-01', 'recipe-99', 'recipe:recipe-1', 'recipe:recipe-01', 'product-1', 'transfer-1', 'raw:wood', 'spent:water',
  'Raw:wood', 'unclassified', 'inventor-1', 'use', 'craft', [], {}, ['process-1'], ['recipe-1', 'recipe-1'], [{ resourceId: 'raw:wood', mass: 1 }]];
function* paths(value: Json, path: Path = []): Generator<Path> {
  if (path.length) yield path;
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) yield* paths(value[index]!, [...path, index]);
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) yield* paths(value[key]!, [...path, key]);
}
function at(value: Json, path: Path): Json { let node = value; for (const step of path) node = (node as Record<string, Json>)[step]!; return node; }
function* mutants(value: Json): Generator<string> {
  const edit = function* (path: Path, apply: (parent: any, key: string | number) => void): Generator<string> {
    const copy = structuredClone(value), parent = path.length > 1 ? at(copy, path.slice(0, -1)) : copy;
    apply(parent, path.at(-1)!); yield JSON.stringify(copy);
  };
  for (const path of paths(value)) {
    yield* edit(path, (parent, key) => { if (Array.isArray(parent)) parent.splice(key as number, 1); else delete parent[key]; });
    for (const replacement of VALUES) yield* edit(path, (parent, key) => { parent[key] = structuredClone(replacement); });
    const node = at(value, path);
    if (Array.isArray(node) && node.length) {
      yield* edit([...path, 0], parent => { parent.push(structuredClone(parent[0])); });
      yield* edit([...path, 0], parent => { parent.reverse(); });
      yield* edit([...path, 0], parent => { while (parent.length <= 64) parent.push(structuredClone(parent[0])); });
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      yield* edit([...path, '__extra'], (parent, key) => { parent[key] = 0; });
      yield* edit([...path, '__proto__'], parent => { Object.defineProperty(parent, '__proto__', { value: { x: 1 }, enumerable: true, writable: true, configurable: true }); });
    }
  }
  const root = structuredClone(value) as Record<string, Json>; root.__extra = 1; yield JSON.stringify(root);
  yield '{'; yield 'null'; yield '[]'; yield '"process-1"';
}

test('diferencial: todo recibo o definición corrompida da el mismo resultado o el mismo error que la versión anterior', async t => {
  const previous = await legacy();
  if (!previous) { t.skip(`git show ${LEGACY_COMMIT} no disponible`); return; }
  const { db } = database(t, 'diff'), defs = definitions(8), list = receipts(defs, 2);
  const fresh = new current.TechnologyArchive(db), old = new previous.TechnologyArchive(db);
  seed(db, fresh, defs, list);
  const operations = (archive: Archive) => [
    outcome(() => archive.listExecutionRecords({ limit: 10000 })),
    outcome(() => archive.listExecutionRecords({ asOfTick: 100, limit: 3 })),
    outcome(() => archive.getExecution('process-2')),
    outcome(() => archive.getExecution('process-4', 100)),
  ];
  const compare = (table: string, key: string, id: string, body: string, digest?: string): string => {
    const results: string[][] = [];
    for (const archive of [fresh, old]) {
      // Fuera de la transacción anfitriona (transacción cruda, sin memoria) …
      db.exec('BEGIN'); corrupt(db, table, key, id, body, digest);
      try { results.push(operations(archive)); } finally { db.exec('ROLLBACK'); }
      // … y dentro, como `Store.load()`: la memoria de referencias está activa.
      db.exec('BEGIN'); corrupt(db, table, key, id, body, digest);
      try { archive.beginHostTransaction(); results.push(operations(archive)); } finally { db.exec('ROLLBACK'); archive.invalidateVerification(); }
    }
    assert.deepEqual(results.slice(0, 2), results.slice(2), `${table} ${id}: ${body}`);
    return results[0]!.join('\n');
  };
  let total = 0, rejected = 0;
  const messages = new Map<string, number>();
  const tally = (result: string) => {
    total++;
    const errors = result.split('\n').filter(entry => entry.startsWith('error '));
    if (errors.length) rejected++;
    for (const entry of errors) messages.set(entry, (messages.get(entry) ?? 0) + 1);
  };
  for (const value of list.slice(0, 4)) for (const body of mutants(value as unknown as Json)) tally(compare('technology_executions', 'id', value.id, body));
  for (const value of [defs[1]!, defs[4]!]) for (const body of mutants(value as unknown as Json)) tally(compare('technology_definitions', 'id', value.id, body));
  // Digestos y filas que no cuadran, con el cuerpo intacto.
  for (const value of list) {
    const body = JSON.stringify(value);
    tally(compare('technology_executions', 'id', value.id, body, '0'.repeat(64)));
    tally(compare('technology_executions', 'id', value.id, `${body} `, sha256(body)));
  }
  assert.ok(total > 3000, `solo ${total} mutaciones`);
  assert.ok(rejected > total * 0.8, `${rejected}/${total} rechazadas`);
  for (const law of ['execution.', 'catalyst.', 'nested execution identities.', 'transfer identities.', 'unexpected transfer identities.',
    'execution mass envelope.', 'checksum.', 'JSON.', 'execution key, serial or tick.', 'execution definition reference.', 'execution program signature.',
    'nested execution reference.', 'definition.', 'definition key or tick.', 'Invalid contained water state or receipt.'])
    assert.ok([...messages.keys()].some(message => message.includes(law)), `ninguna mutación ejercitó «${law}»`);
  t.diagnostic(`${total} corrupciones × 4 lecturas × {cruda, anfitriona}: ${rejected} rechazadas, idénticas a ${LEGACY_COMMIT}; ${messages.size} mensajes distintos`);
});

test('diferencial: cronología, huecos de anidadas y filas fuera de orden fallan igual en las dos versiones', async t => {
  const previous = await legacy();
  if (!previous) { t.skip(`git show ${LEGACY_COMMIT} no disponible`); return; }
  const { db } = database(t, 'diff-rows'), defs = definitions(8), list = receipts(defs, 3);
  const fresh = new current.TechnologyArchive(db), old = new previous.TechnologyArchive(db);
  seed(db, fresh, defs, list);
  const edits: string[] = ['UPDATE technology_executions SET serial=serial+100 WHERE id=\'process-2\'', 'DELETE FROM technology_executions WHERE id=\'process-5\'',
    'UPDATE technology_executions SET tick=999 WHERE id=\'process-3\'', 'DELETE FROM technology_definitions WHERE id=\'recipe-8\'',
    'UPDATE technology_definitions SET tick=500 WHERE id=\'recipe-2\'', 'UPDATE technology_definitions SET signature=\'x\' WHERE id=\'recipe-3\'',
    'UPDATE technology_definitions SET tick=\'seven\' WHERE id=\'recipe-7\'', 'DELETE FROM technology_definitions WHERE id=\'recipe-1\''];
  for (const value of list) edits.push(`UPDATE technology_executions SET tick=tick+1 WHERE id='${value.id}'`,
    `UPDATE technology_executions SET body=body||'' , digest=upper(digest) WHERE id='${value.id}'`);
  for (const sql of edits) {
    const results: string[] = [];
    for (const archive of [fresh, old]) for (const hosted of [false, true]) {
      db.exec('BEGIN'); db.exec(sql);
      try {
        if (hosted) archive.beginHostTransaction();
        results.push([outcome(() => archive.listExecutionRecords({ limit: 10000 })), outcome(() => archive.listExecutionRecords({ afterSerial: 6, limit: 2 })),
          outcome(() => archive.getExecution('process-6'))].join('\n'));
      } finally { db.exec('ROLLBACK'); archive.invalidateVerification(); }
    }
    assert.deepEqual(results.slice(0, 2), results.slice(2), sql);
    assert.match(results[0]!, /error Invalid technology archive/, sql);
  }
});

// ——— 2. Batería fija ————————————————————————————————————————————————————————————————————————————————————
test('batería fail-closed: forma exacta, series canónicas, recursos, catalizadores, anidadas, transferencias y masa', t => {
  const { db } = database(t, 'battery'), defs = definitions(4), archive = new current.TechnologyArchive(db);
  seed(db, archive, defs, []);
  const [use, craft, transfer, water] = group(1, 100, defs, 1);
  const rejects = (value: unknown, pattern: RegExp, label: string) => {
    assert.throws(() => host(db, archive, () => archive.putExecution(value as TechnologyExecution)), pattern, label);
  };
  const mutate = (value: TechnologyExecution, change: (copy: any) => void): any => { const copy = structuredClone(value) as any; change(copy); return copy; };
  // Series: mismo lenguaje que /^process-[1-9]\d*$/ con entero seguro.
  for (const id of ['process-0', 'process-01', 'process-', 'process-1 ', 'process-1\n', ' process-1', 'process-+1', 'process-1e3', 'process-١',
    'process-9007199254740992', 'process-99999999999999999', 'Process-1', 'process_1']) rejects({ ...use, id }, /execution/, id);
  for (const recipe of ['recipe-0', 'recipe-01', 'recipe-', 'recipe-1.0', 'recipe-1 ', 'recipe-x'])
    rejects({ ...use, recipeId: recipe }, /execution/, recipe);
  for (const resource of ['raw:wood ', 'Raw:wood', 'raw:iron', 'used:wood', 'raw:', 'recipe:recipe-0', 'recipe:recipe-01', 'recipe:recipe-', 'recipe:',
    'recipe:product-1', 'recipe:recipe-1x', 'unclassified ', 'recipe:recipe-9007199254740992', ''])
    rejects(mutate(use, copy => { copy.balance.opening.push(line(resource, 1)); copy.balance.closing.push(line('residue:stone', 1)); }), /execution/, resource);
  // Masa: enteros seguros, suma segura y conservación exacta.
  rejects(mutate(use, copy => { copy.balance.opening[0].mass = 1.5; }), /execution/, 'masa fraccionaria');
  rejects(mutate(use, copy => { copy.balance.opening[0].mass = -1; }), /execution/, 'masa negativa');
  rejects(mutate(use, copy => { copy.inputs = [line('raw:wood', Number.MAX_SAFE_INTEGER), line('raw:wood', 1)]; }), /execution/, 'suma insegura');
  rejects(mutate(use, copy => { copy.balance.closing[0].mass++; }), /execution mass envelope/, 'opening !== closing');
  rejects(mutate(transfer, copy => { copy.balance.externalLoss = []; }), /execution mass envelope/, 'pérdida externa ausente');
  rejects(mutate(use, copy => { copy.balance.opening = Array.from({ length: 65 }, () => line('raw:wood', 0)); }), /execution/, '65 líneas');
  rejects(mutate(use, copy => { copy.balance.opening[0].extra = 1; }), /execution/, 'clave extra en línea');
  rejects(mutate(use, copy => { delete copy.balance.opening[0].mass; }), /execution/, 'línea sin masa');
  rejects(mutate(use, copy => { copy.balance.extra = []; }), /execution/, 'balance con clave extra');
  rejects(mutate(use, copy => { delete copy.balance.externalLoss; }), /execution/, 'balance incompleto');
  // Forma de la raíz: extras, ausentes, heredadas.
  rejects({ ...use, extra: 1 }, /execution/, 'clave extra');
  for (const key of Object.keys(use)) { const copy: any = { ...use }; delete copy[key]; rejects(copy, /execution/, `sin ${key}`); }
  { const copy: any = { ...use }; delete copy.benefit; rejects(Object.assign(Object.create({ benefit: 0 }), copy), /execution/, 'benefit heredado'); }
  for (const [key, value] of [['tick', -1], ['tick', 1.5], ['energy', -0.1], ['energy', Number.NaN], ['energy', Infinity], ['work', 0.5], ['benefit', -1],
    ['success', 1], ['actorId', 'a b'], ['actorId', ''], ['kind', 'magic'], ['programSignature', 'x'.repeat(16001)], ['parentRecipeIds', ['recipe-1', 'recipe-1']],
    ['parentRecipeIds', Array.from({ length: 7 }, (_, i) => `recipe-${i + 1}`)], ['catalysts', 'none'], ['residueMass', -1]] as const)
    rejects({ ...use, [key]: value }, /execution/, `${key}=${String(value)}`);
  // Catalizadores y anidadas.
  rejects(mutate(craft, copy => { copy.catalysts.push({ ...copy.catalysts[0] }); }), /catalyst/, 'catalizador repetido');
  rejects(mutate(craft, copy => { copy.nestedExecutionIds = []; }), /catalyst/, 'catalizador no anidado');
  rejects(mutate(craft, copy => { delete copy.nestedExecutionIds; }), /catalyst/, 'catalizador sin anidadas');
  rejects(mutate(craft, copy => { copy.catalysts[0].itemId = 'item-1'; }), /catalyst/, 'item no canónico');
  rejects(mutate(craft, copy => { copy.catalysts[0].wear = -1; }), /catalyst/, 'desgaste negativo');
  rejects(mutate(craft, copy => { copy.catalysts[0].extra = 1; }), /catalyst/, 'catalizador con clave extra');
  rejects(mutate(craft, copy => { copy.nestedExecutionIds = ['process-2']; copy.catalysts = []; }), /nested execution identities/, 'anidada no anterior');
  rejects(mutate(craft, copy => { copy.nestedExecutionIds = ['process-1', 'process-1']; }), /nested execution identities/, 'anidada repetida');
  rejects(mutate(craft, copy => { copy.nestedExecutionIds = Array.from({ length: 14 }, (_, i) => `process-${i + 1}`); copy.id = 'process-99'; }),
    /nested execution identities/, '14 anidadas');
  rejects(mutate(craft, copy => { copy.nestedExecutionIds = undefined; }), /nested execution identities/, 'anidadas propias indefinidas');
  rejects(craft, /missing nested execution/, 'anidada ausente sin origen');
  rejects(mutate(craft, copy => { copy.programSignature = 'otra'; copy.catalysts = []; copy.nestedExecutionIds = []; }), /execution program signature/, 'firma');
  // Transferencias.
  rejects(mutate(transfer, copy => { delete copy.transferId; }), /transfer identities/, 'sin transferId');
  rejects(mutate(transfer, copy => { copy.counterpartyId = copy.actorId; }), /transfer identities/, 'contraparte = actor');
  rejects({ ...use, transferId: 'transfer-1' }, /unexpected transfer identities/, 'transferId fuera de transferencia');
  rejects(mutate(water, copy => { copy.water.lost = 2; }), /Invalid contained water state or receipt/, 'agua sin conservar');
  // Más estrictos que antes sólo en objetos que JSON no puede producir.
  { const copy = mutate(use, () => {}); Object.defineProperty(copy.balance, 'externalLoss', { value: [line('bogus', 1)], enumerable: false });
    rejects(copy, /execution/, 'clave de balance no enumerable'); }
  { const copy = mutate(use, () => {}); copy.balance.opening = [copy.balance.opening[0], , ...copy.balance.opening.slice(1)];
    rejects(copy, /execution/, 'arreglo disperso'); }
  rejects({ ...use, kind: { toString: () => 'use' } }, /execution/, 'kind convertible');
  { const copy = mutate(craft, c => { delete c.nestedExecutionIds; }); rejects(Object.setPrototypeOf(copy, { nestedExecutionIds: ['process-1'] }), /catalyst/, 'anidadas heredadas'); }
  // Y lo válido sigue entrando, con sus referencias.
  host(db, archive, () => { for (const value of [use, craft, transfer, water]) archive.putExecution(value); });
  assert.deepEqual(archive.listExecutions().map(value => value.id), ['process-1', 'process-2', 'process-3', 'process-4']);
});

test('batería fail-closed: `putExecution` y `pruneExecutions` no escriben ni borran nada ante una fila corrupta', t => {
  const { db } = database(t, 'prune'), defs = definitions(4), archive = new current.TechnologyArchive(db), list = receipts(defs, 3);
  seed(db, archive, defs, list);
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM technology_executions').get() as { n: number }).n;
  const good = JSON.stringify(list[5]);
  for (const [body, digest, pattern] of [[good, '0'.repeat(64), /checksum/], [`${good.slice(0, -1)}`, sha256(good.slice(0, -1)), /JSON/],
    [good.replace('"tick":101', '"tick":-1'), undefined, /execution/], [good.replace('"kind":"craft"', '"kind":"crafted"'), undefined, /execution/]] as const) {
    db.exec('BEGIN'); corrupt(db, 'technology_executions', 'id', 'process-6', body, digest ?? sha256(body)); db.exec('COMMIT');
    assert.throws(() => host(db, archive, () => archive.pruneExecutions(0, 8, current.TECHNOLOGY_CHAIN_EMPTY)), pattern);
    assert.equal(count(), 12);
    // Un recibo que cita la fila corrupta como anidada también falla cerrado, sin escribir nada.
    assert.throws(() => host(db, archive, () => archive.putExecution({ ...base(13, 200, 'research'), energy: 0.001, work: 1, success: false,
      programSignature: 'failed', nestedExecutionIds: ['process-6'] } as TechnologyExecution)), /Invalid technology archive/);
    assert.equal(count(), 12);
    db.exec('BEGIN'); corrupt(db, 'technology_executions', 'id', 'process-6', good); db.exec('COMMIT');
  }
  db.exec('BEGIN'); db.exec('DELETE FROM technology_executions WHERE id=\'process-4\''); db.exec('COMMIT');
  assert.throws(() => host(db, archive, () => archive.pruneExecutions(0, 8, current.TECHNOLOGY_CHAIN_EMPTY)), /gap/);
  assert.equal(count(), 11);
});

// ——— 3. Memoria de referencias ————————————————————————————————————————————————————————————————————————————
test('memoria de referencias: cualquier escritura propia o ajena entre llamadas la invalida y la lectura falla cerrada', t => {
  const defs = definitions(6), list = receipts(defs, 4);
  const make = (name: string) => {
    const { db, path } = database(t, name), archive = new current.TechnologyArchive(db);
    seed(db, archive, defs, list);
    return { db, path, archive };
  };
  const badDefinition = (value: TechnologyDefinition) => JSON.stringify({ ...value, name: '' });
  const badExecution = (value: TechnologyExecution) => JSON.stringify({ ...value, work: -1 });
  const full = (archive: Archive) => archive.listExecutionRecords({ limit: 10000 });

  // a. Escritura cruda propia DENTRO de la transacción anfitriona, entre dos páginas (fuera de `observeHostWrites`).
  for (const [table, id, body] of [['technology_definitions', 'recipe-2', badDefinition(defs[1]!)], ['technology_executions', 'process-6', badExecution(list[5]!)]] as const) {
    const { db, archive } = make(`raw-${table}`);
    assert.throws(() => host(db, archive, () => {
      assert.equal(full(archive).length, list.length);
      corrupt(db, table, 'id', id, body);
      full(archive);
    }), /Invalid technology archive/, table);
  }
  // b. Otra conexión corrompe entre dos cargas (cambia `data_version`).
  for (const [table, id, body] of [['technology_definitions', 'recipe-3', badDefinition(defs[2]!)], ['technology_executions', 'process-2', badExecution(list[1]!)]] as const) {
    const { db, path, archive } = make(`other-${table}`), other = new DatabaseSync(path);
    t.after(() => other.close());
    assert.equal(host(db, archive, () => full(archive)).length, list.length);
    assert.equal(full(archive).length, list.length);
    corrupt(other, table, 'id', id, body);
    assert.throws(() => host(db, archive, () => full(archive)), /Invalid technology archive/, `${table} anfitriona`);
    assert.throws(() => full(archive), /Invalid technology archive/, `${table} sin transacción`);
  }
  // c. `truncateAfter` borra definiciones: una referencia posterior a una definición borrada no sale de la memoria.
  {
    const { db, archive } = make('truncate');
    const referencing = { ...base(90, 200, 'use'), recipeId: 'recipe-6', energy: 0.001, work: 1 } as TechnologyExecution;
    assert.throws(() => host(db, archive, () => {
      full(archive); archive.truncateAfter(4);
      const body = JSON.stringify(referencing); db.prepare('INSERT INTO technology_executions VALUES (?,?,?,?,?)').run(referencing.id, 90, 200, body, sha256(body));
      full(archive);
    }), /execution definition reference/);
  }
  // d. ROLLBACK de una definición memorizada: la siguiente transacción anfitriona no la recuerda (sin invalidación explícita).
  {
    const { db, archive } = make('rollback'), next = definition(7, 50, defs.at(-1));
    const referencing = { ...base(90, 300, 'use'), recipeId: next.id, energy: 0.001, work: 1 } as TechnologyExecution;
    db.exec('BEGIN'); archive.beginHostTransaction();
    archive.putDefinition(next); archive.putExecution(referencing); assert.equal(full(archive).length, list.length + 1);
    db.exec('ROLLBACK');
    const body = JSON.stringify(referencing);
    db.exec('BEGIN'); db.prepare('INSERT INTO technology_executions VALUES (?,?,?,?,?)').run(referencing.id, 90, 300, body, sha256(body)); db.exec('COMMIT');
    assert.throws(() => full(archive), /execution definition reference/);
    archive.invalidateVerification();
    assert.throws(() => host(db, archive, () => full(archive)), /execution definition reference/);
  }
  // e. Un acierto de memoria sigue respetando el tick: una definición posterior al recibo no es referenciable,
  //    tanto por id (padres, receta, catalizadores) como por línea `recipe:` (balance).
  for (const shape of ['recipeId', 'line'] as const) {
    const { db } = database(t, `tick-${shape}`), archive = new current.TechnologyArchive(db), late = defs.at(-1)!;
    seed(db, archive, defs, receipts(defs, 4, 100, 2));
    const early = { ...base(1, 3, 'use'), energy: 0.001, work: 1,
      ...(shape === 'recipeId' ? { recipeId: late.id } : { balance: { opening: [line(`recipe:${late.id}`, 1)], closing: [line(`recipe:${late.id}`, 1)], externalInputs: [], externalLoss: [] } }) };
    const body = JSON.stringify(early);
    transaction(db, () => db.prepare('INSERT INTO technology_executions VALUES (?,?,?,?,?)').run(early.id, 1, 3, body, sha256(body)));
    assert.throws(() => host(db, archive, () => {
      // La memoria ya tiene `late` (tick 6) por los recibos posteriores; el recibo del tick 3 no puede citarlo.
      assert.equal(archive.listExecutionRecords({ afterSerial: 1, limit: 10000 }).length, 16);
      archive.listExecutionRecords({ limit: 1 });
    }), /execution definition reference/, shape);
  }
  // f. Las escrituras anfitrionas declaradas (`observeHostWrites`) conservan la memoria y no ocultan nada después.
  {
    const { db, archive } = make('observe');
    db.exec('CREATE TABLE host_side (n INTEGER)');
    host(db, archive, () => {
      full(archive);
      for (let n = 0; n < 5; n++) archive.observeHostWrites(() => db.prepare('INSERT INTO host_side VALUES (?)').run(n));
      assert.equal(full(archive).length, list.length);
      corrupt(db, 'technology_definitions', 'id', 'recipe-4', badDefinition(defs[3]!));
      assert.throws(() => full(archive), /Invalid technology archive definition/);
      corrupt(db, 'technology_definitions', 'id', 'recipe-4', JSON.stringify(defs[3]));
      assert.equal(full(archive).length, list.length);
      assert.throws(() => archive.observeHostWrites(() => { throw new Error('host failure'); }), /host failure/);
      assert.equal(full(archive).length, list.length);
    });
    assert.equal(full(archive).length, list.length);
  }
});

// ——— 4. Banco ——————————————————————————————————————————————————————————————————————————————————————————
test('banco: 40 definiciones + 10 000 recibos — antes y después, con paridad de digestos, recibos y poda', async t => {
  const previous = await legacy();
  const defs = definitions(40), list = receipts(defs, 2500);
  assert.equal(list.length, 10000);
  type Run = { name: string; put: number; hostScan: number; rawScan: number; prune: number; observe: number;
    records: string; pruned: string };
  const measure = (module: ArchiveModule, name: string): Run => {
    const { db } = database(null, `bench-${name}`), archive = new module.TechnologyArchive(db);
    try {
      transaction(db, () => archive.installSchema());
      host(db, archive, () => { for (const value of defs) archive.putDefinition(value); });
      let started = performance.now();
      host(db, archive, () => { for (const value of list) archive.putExecution(value); });
      const put = performance.now() - started;
      const scan = () => { const out: current.TechnologyExecutionRecord[] = []; let serial = 0;
        for (;;) { const page = archive.listExecutionRecords({ afterSerial: serial, limit: 1000 }); if (!page.length) return out;
          out.push(...page); serial = Number(page.at(-1)!.execution.id.slice(8)); } };
      host(db, archive, scan); // calentamiento
      started = performance.now(); const records = host(db, archive, scan); const hostScan = performance.now() - started;
      started = performance.now(); db.exec('BEGIN'); scan(); db.exec('COMMIT'); const rawScan = performance.now() - started;
      db.exec('CREATE TABLE IF NOT EXISTS host_side (n INTEGER)');
      started = performance.now();
      host(db, archive, () => { for (let n = 0; n < 2000; n++) archive.observeHostWrites(() => db.prepare('INSERT INTO host_side VALUES (?)').run(n)); });
      const observe = performance.now() - started;
      started = performance.now();
      const pruned = host(db, archive, () => archive.pruneExecutions(0, 5000, module.TECHNOLOGY_CHAIN_EMPTY));
      const prune = performance.now() - started;
      let chain = current.TECHNOLOGY_CHAIN_EMPTY;
      for (const record of records.slice(0, 5000)) chain = current.technologyChainStep(chain, record.digest, record.execution.tick);
      assert.equal(pruned.digest, chain, `${name}: pliegue de la poda`);
      return { name, put, hostScan, rawScan, prune, observe, pruned: JSON.stringify(pruned),
        records: sha256(JSON.stringify(records.map(record => [record.digest, record.execution]))) };
    } finally { db.close(); }
  };
  const after = measure(current, 'despues');
  const runs = [after];
  if (previous) runs.unshift(measure(previous, 'antes'));
  const format = (run: Run) => `${run.name}: putExecution ${run.put.toFixed(0)} ms (${(run.put * 100 / list.length).toFixed(1)} µs/recibo) · `
    + `barrido anfitrión ${run.hostScan.toFixed(0)} ms (${(run.hostScan * 100 / list.length).toFixed(1)} µs/recibo) · barrido crudo ${run.rawScan.toFixed(0)} ms · `
    + `pruneExecutions(5000) ${run.prune.toFixed(0)} ms · observeHostWrites ×2000 ${run.observe.toFixed(0)} ms`;
  for (const run of runs) t.diagnostic(format(run));
  if (previous) {
    const [before] = runs as [Run, Run];
    assert.equal(after.records, before.records, 'mismos recibos y digestos que la versión anterior');
    assert.equal(after.pruned, before.pruned, 'misma poda que la versión anterior');
    t.diagnostic(`aceleración: barrido anfitrión ×${(before.hostScan / after.hostScan).toFixed(2)}, crudo ×${(before.rawScan / after.rawScan).toFixed(2)}, `
      + `putExecution ×${(before.put / after.put).toFixed(2)}, poda ×${(before.prune / after.prune).toFixed(2)}`);
  } else t.diagnostic(`versión anterior (${LEGACY_COMMIT}) no disponible: solo se mide la actual`);
});
