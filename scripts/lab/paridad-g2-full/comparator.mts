/** Offline/private lossless technical cut. No World import or simulation occurs here. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export class ComparatorIncomplete extends Error {
  constructor(readonly path: string, readonly code: string) { super(`${code} at ${path}`); }
}
export type FirstDifference = Readonly<{ path: string; leftSha256: string; rightSha256: string }>;
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const number = (n: number): unknown => Number.isNaN(n) ? ['number','NaN'] :
  n === Infinity ? ['number','Infinity'] : n === -Infinity ? ['number','-Infinity'] :
  Object.is(n,-0) ? ['number','-0'] : ['number',n];
const ordinaryPrototype = (value: object): string => {
  const p=Object.getPrototypeOf(value);
  if (p===null) return 'null';
  if (p===Object.prototype) return 'Object';
  if (p===Array.prototype) return 'Array';
  if (p===Map.prototype) return 'Map';
  if (p===Set.prototype) return 'Set';
  if (p===Date.prototype) return 'Date';
  if (p===RegExp.prototype) return 'RegExp';
  if (p===ArrayBuffer.prototype) return 'ArrayBuffer';
  if (p===DataView.prototype) return 'DataView';
  if (Buffer.isBuffer(value) && p===Buffer.prototype) return 'Buffer';
  for (const name of ['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array',
    'Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array'] as const) {
    const ctor=(globalThis as unknown as Record<string, {prototype: object}>)[name];
    if (ctor && p===ctor.prototype) return name;
  }
  throw new ComparatorIncomplete('$','CUSTOM_OR_PROXY_PROTOTYPE');
};

/** Preserves aliases/cycles, insertion order, holes, descriptors, typed bytes and number edge cases. */
export function canonicalGraph(value: unknown): Buffer {
  const seen=new WeakMap<object,number>(); let next=1;
  const walk=(v:unknown,path:string):unknown => {
    if (v===null) return ['null'];
    if (v===undefined) return ['undefined'];
    if (typeof v==='number') return number(v);
    if (typeof v==='string') return ['string',v];
    if (typeof v==='boolean') return ['boolean',v];
    if (typeof v==='bigint') return ['bigint',v.toString()];
    if (typeof v==='symbol' || typeof v==='function') throw new ComparatorIncomplete(path,'NON_DATA_VALUE');
    if (seen.has(v)) return ['ref',seen.get(v)];
    const id=next++; seen.set(v,id);
    const proto=ordinaryPrototype(v);
    const own=(skipIndex=false):unknown[] => {
      const entries:unknown[]=[];
      for (const key of Reflect.ownKeys(v)) {
        if (skipIndex && typeof key==='string' && /^(0|[1-9][0-9]*)$/.test(key)) continue;
        const name=typeof key==='symbol' ? Symbol.keyFor(key) : key;
        if (name===undefined) throw new ComparatorIncomplete(path,'LOCAL_SYMBOL_KEY');
        const desc=Object.getOwnPropertyDescriptor(v,key);
        if (!desc || !Object.hasOwn(desc,'value')) throw new ComparatorIncomplete(path+'.'+String(name),'ACCESSOR_OR_DESCRIPTOR_MISSING');
        entries.push([typeof key==='symbol'?'symbol':'string',name,
          Number(desc.enumerable),Number(desc.configurable),Number(desc.writable),
          walk(desc.value,path+'.'+String(name))]);
      }
      return entries;
    };
    if (proto==='Map') return ['object',id,proto,[...(v as Map<unknown,unknown>)].map(([k,x],i)=>
      [walk(k,`${path}.map[${i}].key`),walk(x,`${path}.map[${i}].value`)]),own()];
    if (proto==='Set') return ['object',id,proto,[...(v as Set<unknown>)].map((x,i)=>walk(x,`${path}.set[${i}]`)),own()];
    if (proto==='Date') return ['object',id,proto,number((v as Date).getTime()),own()];
    if (proto==='RegExp') return ['object',id,proto,(v as RegExp).source,(v as RegExp).flags,own()];
    if (proto==='ArrayBuffer') return ['object',id,proto,Buffer.from(v as ArrayBuffer).toString('base64'),own()];
    if (proto==='DataView' || ArrayBuffer.isView(v)) {
      const view=v as ArrayBufferView;
      if (view.buffer instanceof SharedArrayBuffer) throw new ComparatorIncomplete(path,'SHARED_BUFFER');
      return ['object',id,proto,view.byteOffset,view.byteLength,
        walk(view.buffer,`${path}.buffer`),own(true)];
    }
    return ['object',id,proto,own()];
  };
  return Buffer.from(JSON.stringify(walk(value,'$')),'utf8');
}

/** Every main/temp schema entry and every table row, preserving duplicate SQL rows. */
export function captureSqlite(db: DatabaseSync): Readonly<{logical:unknown; excludedSavedAt:unknown; layout:unknown}> {
  const catalog:Record<string,unknown>={};
  const excludedSavedAt:Array<{schema:string;row:number;value:unknown}>=[];
  const layout:Record<string,unknown>={};
  for (const schema of ['main','temp'] as const) {
    const entries=db.prepare(`SELECT type,name,tbl_name,rootpage,sql FROM ${schema}.sqlite_schema ORDER BY type,name,tbl_name,rootpage,sql`).all() as
      Array<{type:string;name:string;tbl_name:string;rootpage:number;sql:string|null}>;
    layout[schema]=entries.map(({type,name,tbl_name,rootpage})=>({type,name,tbl_name,rootpage}));
    const tables:Record<string,readonly string[]>={};
    for (const row of entries) if (row.type==='table') {
      const quoted='"'+row.name.replaceAll('"','""')+'"';
      const data=[...db.prepare(`SELECT * FROM ${schema}.${quoted}`).iterate()].map((x,index)=>{
        const record={...x} as Record<string,unknown>;
        if (schema==='main' && row.name==='snapshots' && Object.hasOwn(record,'saved_at')) {
          excludedSavedAt.push({schema,row:index,value:record.saved_at});
          record.saved_at=['EXCLUDED_EPHEMERAL_SAVED_AT'];
        }
        return canonicalGraph(record).toString('utf8');
      });
      data.sort(); tables[row.name]=data; // sort rows only; duplicates remain.
    }
    catalog[schema]={entries:entries.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql})),tables};
  }
  const applicationId=db.prepare('PRAGMA main.application_id').get();
  const userVersion=db.prepare('PRAGMA main.user_version').get();
  return {logical:{applicationId,userVersion,catalog},excludedSavedAt,layout};
}

/** Inventory only the isolated Store directory, not cut files or public data. */
export function inventoryStoreFiles(root:string): Readonly<{durableFiles:readonly Readonly<{path:string;bytes:number;sha256:string}>[];
  sqliteLayout:readonly Readonly<{path:string;bytes:number;sha256:string}>[]}> {
  const durableFiles:Array<{path:string;bytes:number;sha256:string}>=[];
  const sqliteLayout:Array<{path:string;bytes:number;sha256:string}>=[];
  const visit=(dir:string):void=>{
    for (const name of readdirSync(dir).sort()) {
      const full=join(dir,name), stat=lstatSync(full);
      if (stat.isSymbolicLink()) throw new ComparatorIncomplete(relative(root,full),'STORE_SYMLINK');
      if (stat.isDirectory()) { visit(full); continue; }
      if (!stat.isFile()) throw new ComparatorIncomplete(relative(root,full),'STORE_NONREGULAR');
      const rel=relative(root,full);
      const row={path:rel,bytes:stat.size,sha256:sha(readFileSync(full))};
      (/\.sqlite(?:-wal|-shm)?$/.test(rel)?sqliteLayout:durableFiles).push(row);
    }
  }; visit(root);
  return {durableFiles,sqliteLayout};
}

export function cutBytes(input: Readonly<{world:unknown; params:unknown; sqlite:unknown;
  storeFiles:unknown; app:unknown}>):Buffer {
  return canonicalGraph(input);
}
function firstNodeDiff(a:unknown,b:unknown,path:string):string|null {
  if (Object.is(a,b)) return null;
  if (typeof a!==typeof b || a===null || b===null) return path;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length!==b.length) return path+'.length';
    for (let i=0;i<a.length;i++) {const p=firstNodeDiff(a[i],b[i],`${path}[${i}]`);if(p)return p;}
    return null;
  }
  if (typeof a==='object' && typeof b==='object') {
    const ak=Object.keys(a),bk=Object.keys(b);
    if (ak.length!==bk.length || ak.some((k,i)=>k!==bk[i])) return path+'.keys';
    for (const key of ak) {const p=firstNodeDiff((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],path+'.'+key);if(p)return p;}
    return null;
  }
  return path;
}
/** Exact canonical byte comparison. Hashes are report metadata, never the equality test. */
export function firstCutDifference(left:Buffer,right:Buffer):FirstDifference|null {
  if (left.equals(right)) return null;
  let path='$.canonical';
  try { path=firstNodeDiff(JSON.parse(left.toString('utf8')),JSON.parse(right.toString('utf8')),'$')??path; }
  catch { /* Keep private bytes private; report only opaque hashes. */ }
  return {path,leftSha256:sha(left),rightSha256:sha(right)};
}
export const digestCut=(bytes:Buffer):string=>sha(bytes);
