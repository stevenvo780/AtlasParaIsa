/**
 * Observador de comunidades (instrumento, 2026-09-22, hipótesis COM «comunidades vivas»).
 *
 * Se precarga delante de la réplica SIN tocarla, así que el `dia-NNN.json` de la réplica
 * sigue siendo el mismo contrato byte a byte (tests/lab.test.ts):
 *
 *   npx tsx --import ./scripts/lab/observa-comunidades.ts scripts/lab/replica.ts --seed S ... --salida DIR
 *
 * Envuelve `Store.prototype.save`: cada vez que la réplica guarda (cada
 * `persistencia.cadaTicks` pasos y al cerrar cada día) añade una línea a
 * `DIR/comunidades.jsonl` con el censo de comunidades de ese instante. Sólo LEE campos
 * planos del mundo (`tick`, `communities`, `people[].{id,x,y,communityId,role}`): no llama a
 * nada con caché ni muta estado, así que el mundo simulado es el mismo con y sin observador.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import type { World } from '../../src/world/index.js';

const index = process.argv.indexOf('--salida');
const salida = index === -1 ? undefined : process.argv[index + 1];
const RADIO_CONTACTO = 6; // el mismo radio de «vecino» de updateCommunities (society.ts)
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Componentes conexas de miembros a ≤ RADIO_CONTACTO celdas (enlace simple). */
function grupos(puntos: readonly { x: number; y: number }[]): number {
  const visto = new Array<boolean>(puntos.length).fill(false);
  let componentes = 0;
  for (let i = 0; i < puntos.length; i++) {
    if (visto[i]) continue;
    componentes++; visto[i] = true;
    const pila = [i];
    while (pila.length) {
      const actual = pila.pop()!;
      for (let j = 0; j < puntos.length; j++) if (!visto[j] && dist(puntos[actual]!, puntos[j]!) <= RADIO_CONTACTO) { visto[j] = true; pila.push(j); }
    }
  }
  return componentes;
}

let anterior = new Map<string, string | null>();
let comunidadesPrevias = new Set<string>();
const vistasAlguna = new Set<string>();

function observar(world: World): void {
  if (!salida) return;
  const actual = new Map<string, string | null>(world.people.map(person => [person.id, person.communityId]));
  let cambios = 0, salidas = 0, entradas = 0;
  for (const [id, comunidad] of actual) {
    if (!anterior.has(id)) continue; // nacido desde la observación anterior
    const antes = anterior.get(id)!;
    if (antes === comunidad) continue;
    if (antes && comunidad) cambios++; else if (antes) salidas++; else entradas++;
  }
  const ids = new Set(world.communities.map(group => group.id));
  const fundadas = [...ids].filter(id => !comunidadesPrevias.has(id)).length;
  const disueltas = [...comunidadesPrevias].filter(id => !ids.has(id)).length;
  for (const id of ids) vistasAlguna.add(id);
  const detalle = world.communities.map(group => {
    const miembros = world.people.filter(person => person.communityId === group.id);
    const centro = miembros.length ? { x: miembros.reduce((s, p) => s + p.x, 0) / miembros.length, y: miembros.reduce((s, p) => s + p.y, 0) / miembros.length } : { x: group.x, y: group.y };
    const distancias = miembros.map(p => dist(p, centro));
    return { id: group.id, n: miembros.length, formedAt: group.formedAt,
      distMedia: distancias.length ? distancias.reduce((s, d) => s + d, 0) / distancias.length : 0,
      distMax: distancias.length ? Math.max(...distancias) : 0, grupos: grupos(miembros) };
  });
  const linea = { tick: world.tick, poblacion: world.people.length, comunidades: world.communities.length,
    fundadasTotal: world.communityCounter, vistasAlguna: vistasAlguna.size,
    sinComunidad: world.people.filter(person => !person.communityId).length,
    sinComunidadMortales: world.people.filter(person => !person.communityId && person.role === 'neighbor').length,
    cambios, salidas, entradas, fundadas, disueltas, detalle };
  mkdirSync(salida, { recursive: true });
  appendFileSync(join(salida, 'comunidades.jsonl'), JSON.stringify(linea) + '\n');
  anterior = actual; comunidadesPrevias = ids;
}

const original = Store.prototype.save;
Store.prototype.save = function (this: Store, world: World, ...resto: unknown[]) {
  const resultado = (original as (...args: unknown[]) => void).call(this, world, ...resto);
  observar(world);
  return resultado;
} as typeof Store.prototype.save;
