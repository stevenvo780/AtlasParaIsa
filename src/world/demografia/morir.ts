import type { World, Person } from '../mundo/tipos.js';
import type { ChronicleEvent } from '../../shared/types.js';
import { distance } from '../mundo/geometria.js';
import { addEvent } from '../mundo/crear.js';
import { cancelTechnologyProject, settleTechnologyEstate } from '../technology.js';
import { vecinos } from '../rejilla.js';
import { ley } from '../params.js';
import { ctxMateriaDe, type CtxLeyMateria } from '../motor/acceso.js';
import { morir, soltar } from '../materia/cuerpo.js';
import { Rol } from '../materia/tipos.js';
import { PAGE_CELLS, pageOf, pageOffset } from '../soa/region.js';

function celdaDeMuerte(c: CtxLeyMateria, x: number, y: number): number {
  const t = c.terreno, celda = t.celda(x, y);
  if (celda >= 0) return celda;
  // La percepción puede vaciarse aunque la página conserve los lotes de esas coordenadas.
  const px = pageOf(x), py = pageOf(y), desplazamiento = pageOffset(x, y), sinLeer = new Float64Array(0);
  for (let pagina = 0; pagina < t.paginas; pagina++) {
    if (t.duenoChunk[pagina]! < 0 || t.paginaX[pagina] !== px || t.paginaY[pagina] !== py) continue;
    const material = pagina * PAGE_CELLS + desplazamiento;
    if (c.materia.lotes(material, Rol.Suelo, sinLeer) > 0) return material;
  }
  throw new Error('b: falta la celda material de la defunción.');
}

/** V23 (`v23.cuerpos`): la muerte deja el cuerpo como un lote Cadaver en la celda donde cayó (lo descompone la κ del
 * suelo) y lo que la persona llevaba a cuestas queda en el suelo como objetos, con su forma. Nada sale del mundo. */
export function dejarCadaver(world: World, person: Person): void {
  const cuerpo = person.cuerpo;
  if (!cuerpo) return;
  const c = ctxMateriaDe(world), celda = celdaDeMuerte(c, person.x, person.y);
  if (person.carga) {
    for (const lote of person.carga) soltar(c, lote, celda);
    person.carga.length = 0;
  }
  morir(c, cuerpo, celda);
  person.cuerpo = undefined;
}

export function transferEstate(world: World, person: Person,
  emitir: (e: Omit<ChronicleEvent, 'id' | 'tick'>) => void = e => { addEvent(world, e); }): void {
  if (ley(world, 'cuerpos')) dejarCadaver(world, person);
  cancelTechnologyProject(world,person);
  const recipients=vecinos(world,person,3,other=>other!==person&&other.demography.deathCause===null&&distance(person,other)<=2,'transferEstate').sort((a,b)=>distance(person,a)-distance(person,b)||a.id.localeCompare(b.id));
  let transferred=0;
  for (const other of recipients) {
    const food=Math.min(person.inventory,Math.max(0,0.25-other.inventory)); person.inventory-=food; other.inventory+=food; transferred+=food;
    for (const material of ['wood','stone'] as const) {
      const amount=Math.min(person.materials[material],Math.max(0,(material==='wood'?12:8)-other.materials[material]));
      person.materials[material]-=amount; other.materials[material]+=amount; transferred+=amount;
    }
  }
  world.demographyDynamics.foodLost+=person.inventory; world.demographyDynamics.woodLost+=person.materials.wood; world.demographyDynamics.stoneLost+=person.materials.stone;
  const lost=person.inventory+person.materials.wood+person.materials.stone;
  person.inventory=0; person.materials={wood:0,stone:0};
  const estate=settleTechnologyEstate(world,person,recipients);
  if (transferred>0||estate.transfers.length||lost>0||Object.values(estate.lost).some(n=>n>0)) emitir({kind:'ecology',actors:[person.id,...recipients.map(p=>p.id)],x:person.x,y:person.y,source:'simulation',text:`Las pertenencias de ${person.name} quedaron a cargo de quienes estaban cerca; el remanente salió de las reservas utilizables.`,cause:`Entrega física a distancia máxima 2 con capacidad limitada; pérdidas registradas de alimento y materias ${lost.toFixed(4)}, tecnológicas ${Object.values(estate.lost).reduce((s,n)=>s+n,0)} unidades de masa. El conocimiento adquirido no se copia.`});
}
