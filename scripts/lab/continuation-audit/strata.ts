import type { DatabaseSync } from 'node:sqlite';
import { hash, type Json } from './common.js';

export const RECIPE_CAUSE = 'Transmisión cercana de una receta realmente conocida; enseñar cuesta energía y no entrega productos ni materias primas.';
type Group = 'mortal' | 'S' | 'I' | 'unknown';
function group(person: Json | undefined, tick?: number): Group {
  if (!person || tick !== undefined && (person.bornAt > tick || person.diedAt !== undefined && person.diedAt < tick)) return 'unknown';
  return person.role === 'neighbor' ? 'mortal' : person.role === 'S' || person.role === 'I' ? person.role : 'unknown';
}
/** Actor is not inventor. Dead actors remain in the immutable legacy roster. */
export function activityStrata(db: DatabaseSync, after: number, end: number) {
  if(!Number.isInteger(after)||!Number.isInteger(end)||after<0||end<after) throw new Error('Invalid activity interval');
  const snapshot = db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as {body:string;digest:string};
  if(!snapshot || hash(snapshot.body)!==snapshot.digest) throw new Error('Invalid roster snapshot');
  const world = JSON.parse(snapshot.body), roster = new Map<string,Json>();
  for(const person of world.people) roster.set(person.id,person);
  for(const row of db.prepare('SELECT body,digest FROM legacy').iterate() as Iterable<{body:string;digest:string}>) {
    if(hash(row.body)!==row.digest)throw new Error('Invalid legacy checksum'); const person=JSON.parse(row.body);
    if(roster.has(person.id))throw new Error('Duplicate living/legacy identity');roster.set(person.id,person);
  }
  const authors = new Map<string,string>();
  for(const row of db.prepare('SELECT id,body,digest FROM technology_definitions').iterate() as Iterable<{id:string;body:string;digest:string}>) {
    if(hash(row.body)!==row.digest)throw new Error('Invalid recipe checksum'); authors.set(row.id,JSON.parse(row.body).inventorId);
  }
  const uses=new Map<string,{actor:Group;author:Group;uses:number;benefit:number;foreignUses:number;recipes:Set<string>}>();
  for(const row of db.prepare('SELECT body,digest FROM technology_executions WHERE tick>? AND tick<=? ORDER BY serial').iterate(after,end) as Iterable<{body:string;digest:string}>) {
    if(hash(row.body)!==row.digest)throw new Error('Invalid execution checksum');const e=JSON.parse(row.body);
    if(!e.success||e.kind!=='use'||!e.recipeId||!(e.benefit>0))continue;
    const authorId=authors.get(e.recipeId),actor=group(roster.get(e.actorId),e.tick),author=group(authorId?roster.get(authorId):undefined),key=`${actor}/${author}`;
    let entry=uses.get(key);if(!entry){entry={actor,author,uses:0,benefit:0,foreignUses:0,recipes:new Set()};uses.set(key,entry);}
    entry.uses++;entry.benefit+=e.benefit;entry.foreignUses+=authorId!==undefined&&authorId!==e.actorId?1:0;entry.recipes.add(e.recipeId);
  }
  const teaching=new Map<string,{kind:string;teacher:Group;learner:Group;episodes:number}>();
  for(const row of db.prepare('SELECT body FROM events WHERE tick>? AND tick<=? ORDER BY tick,id').iterate(after,end) as Iterable<{body:string}>) {
    const e=JSON.parse(row.body);if(e.source!=='simulation'||e.actors?.length!==2)continue;
    const kind=e.kind==='learning'&&e.cause===RECIPE_CAUSE?'recipe':e.kind==='cooperation'&&String(e.cause).startsWith('Estrategia teach;')?'cooperation':null;
    if(!kind)continue;const teacher=group(roster.get(e.actors[0]),e.tick),learner=group(roster.get(e.actors[1]),e.tick),key=`${kind}/${teacher}/${learner}`;
    let entry=teaching.get(key);if(!entry){entry={kind,teacher,learner,episodes:0};teaching.set(key,entry);}entry.episodes++;
  }
  const byActor=Object.fromEntries((['mortal','S','I','unknown'] as const).map(actor=>[actor,{uses:0,benefit:0}]));
  const rows=[...uses].sort(([a],[b])=>a.localeCompare(b)).map(([,entry])=>{byActor[entry.actor].uses+=entry.uses;byActor[entry.actor].benefit+=entry.benefit;return {...entry,recipes:undefined,distinctRecipes:entry.recipes.size};});
  return {schema:1,window:{afterExclusive:after,endInclusive:end},byActor,actorAuthor:rows,teaching:[...teaching].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v),
    limits:'Recipe teaching and cooperation are separate views, never summed. Episodes do not prove causal benefit. Unknown roles remain explicit; dead actors included.'};
}
