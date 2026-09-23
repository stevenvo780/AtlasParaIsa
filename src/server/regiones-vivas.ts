/**
 * M10: qué regiones de la cámara simula el servidor ahora. `world.chunks` son las regiones vivas (con sus
 * teselas en `world.tiles`); fuera de ellas `projectTerrain` sirve el estado guardado o una vista previa
 * generada desde la semilla, que en pantalla se ve igual. El cliente vela lo que no está vivo.
 * Puro y de solo lectura: las claves «cx,cy» de las regiones vivas que tocan la ventana proyectada,
 * como mucho 7 × 5 = 35 (ventana máxima 96 × 64), sin importar la población ni lo explorado.
 */
import type { Viewport } from '../shared/types.js';
import type { World } from '../world/index.js';
import { CHUNK_SIZE } from '../world/terrain.js';

export function clavesVivasEn(world: Pick<World, 'chunks'>, v: Viewport): string[] {
  const cx0 = Math.floor(v.x / CHUNK_SIZE), cx1 = Math.floor((v.x + v.width - 1) / CHUNK_SIZE);
  const cy0 = Math.floor(v.y / CHUNK_SIZE), cy1 = Math.floor((v.y + v.height - 1) / CHUNK_SIZE);
  const claves: string[] = [];
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const key = `${cx},${cy}`;
    if (Object.prototype.hasOwnProperty.call(world.chunks, key)) claves.push(key);
  }
  return claves;
}
