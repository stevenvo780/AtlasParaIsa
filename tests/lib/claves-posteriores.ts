import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestoSin } from '../../scripts/lab/rendimiento.js';
import { Store } from '../../src/server/store.js';
import { paramsOf, type WorldParams } from '../../src/world/params.js';
import type { World } from '../../src/world/index.js';

/**
 * Claves de params declaradas después de los árboles en que se midieron los digestos literales de las
 * pruebas de control. `digestoCanonico` hashea `{world, params}`, así que declarar una clave mueve el hash
 * aunque el mundo no se mueva; con su valor por defecto (0) ninguna actúa, y quitarlas de la forma de
 * params reproduce el digesto de esos árboles. Una ley nueva con default 0 añade aquí su clave, y sus
 * propios controles se miden en el árbol anterior quitando las claves que ya estaban en esta lista.
 */
export const CLAVES_POSTERIORES = ['social.memoriaDisputa', 'agua.rebano'] as const;

/** Valor de una clave punteada `seccion.hoja`. */
function valor(params: WorldParams, clave: string): unknown {
  const [seccion, hoja] = clave.split('.') as [string, string];
  return (params as unknown as Record<string, Record<string, unknown>>)[seccion]?.[hoja];
}

/** Quitar una clave del hash sólo es legítimo si con el valor que tiene no actúa (0). */
export function clavesPosterioresApagadas(params: WorldParams): void {
  for (const clave of CLAVES_POSTERIORES) {
    const actual = valor(params, clave);
    if (actual !== 0) throw new Error(`${clave} = ${String(actual)}: con la ley activa el digesto no es comparable`);
  }
}

/** Digesto con la forma de params de antes de `CLAVES_POSTERIORES`, quitando además las claves `propias`
 * (la de la ley que controla cada prueba, medida en un árbol que tampoco la declaraba). */
export function digestoSinPosteriores(world: World, propias: readonly string[] = []): string {
  clavesPosterioresApagadas(paramsOf(world));
  return digestoSin(world, [...propias, ...CLAVES_POSTERIORES]);
}

/** Quita `CLAVES_POSTERIORES` de una copia de params (las secciones que la copia ya no tenga se saltan). */
export function quitarClavesPosteriores(forma: Record<string, Record<string, unknown> | undefined>): void {
  for (const clave of CLAVES_POSTERIORES) {
    const [seccion, hoja] = clave.split('.') as [string, string];
    const nodo = forma[seccion];
    if (!nodo) continue;
    if (nodo[hoja] !== 0) throw new Error(`${clave} = ${String(nodo[hoja])}: con la ley activa el digesto no es comparable`);
    delete nodo[hoja];
  }
}

/**
 * Guarda `world` en un Store temporal y lo vuelve a cargar. Con `quitar` (`seccion.hoja`), antes de cargar
 * borra esa clave de los params de la instantánea, como la escribía un árbol que aún no la declaraba (con el
 * sello recalculado); la carga completa la clave ausente con `HISTORICAL_PARAMS` (`readSnapshotParams`).
 * El Store queda ligado al mundo cargado hasta el final de la prueba; `world` no debe seguir avanzando.
 */
export function recargar(t: { after(callback: () => unknown): void }, world: World, quitar?: string): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-recarga-')), path = join(directory, 'world.sqlite');
  let lector: Store | undefined;
  t.after(() => { lector?.close(); rmSync(directory, { recursive: true, force: true }); });
  const escritor = new Store(path);
  try {
    escritor.save(world);
    if (quitar) {
      const fila = escritor.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string };
      const cuerpo = JSON.parse(fila.body) as { params: Record<string, Record<string, unknown>> };
      const [seccion, hoja] = quitar.split('.') as [string, string];
      if (!Object.hasOwn(cuerpo.params[seccion] ?? {}, hoja)) throw new Error(`la instantánea no declara ${quitar}`);
      delete cuerpo.params[seccion]![hoja];
      const body = JSON.stringify(cuerpo);
      escritor.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, createHash('sha256').update(body).digest('hex'));
    }
  } finally { escritor.close(); }
  lector = new Store(path);
  return lector.load()!.world;
}
