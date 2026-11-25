import type { World, Person } from '../mundo/tipos.js';
import { clamp, distance } from '../mundo/geometria.js';
import { addEvent, remember } from '../mundo/crear.js';
import { paramsOf } from '../params.js';
import { inheritGenome, DEFAULT_MUTATION_RATE, expressGenome } from '../genetics.js';
import { proceduralPersonName, proceduralPlaceName } from '../terrain.js';
import { inheritCulture } from '../society.js';
import { initialTechnologyKnowledge } from '../technology.js';
import { initialDemography } from '../demography.js';
import { founderPolicy, inheritPolicy, initialPolicyPlasticity } from '../politica.js';
import { count } from '../statistics.js';
import { selectLocalBirthPairs, ALIMENTO_MEDIO_MINIMO_NATALIDAD } from '../natalidad-local.js';
import { closeKin, pairAffinity, pairTie, chooseReproductivePartner, reproductiveReadiness } from '../family.js';
import { primeroCerca } from '../indice-puntos.js';
import { vecinos } from '../rejilla.js';


/** Resource-dependent, bounded simulated descendants; learned episodes are not copied into genes. */
// TODO params: activar/desactivar elección por afinidad vs. primer elegible
const ELECCION_POR_AFINIDAD = true;

export function reproduce(world: World): void {
  const pop = paramsOf(world).poblacion;
  if (!world.reproductionEnabled || world.people.length >= pop.maxima) return;
  // Leyes candidatas del embudo de natalidad (diagnóstico 2026-09-22). `comprobacionContinua`
  // cambia SÓLO el muestreo: en vez de mirar una vez cada `intervaloComprobacionTicks` pasos,
  // mira cada paso, pero el cupo se cuenta sobre la misma ventana móvil, así que el calendario
  // máximo —`nacimientosPorComprobacion` por ventana— no se mueve (lo cita SC-013). Sin campos
  // nuevos en `World`: la ventana se reconstruye de los `bornAt` que ya existen, y los
  // fundadores (`bornAt ≤ −1200`, `genes.edadFundadoresMinDias` ≥ 0,5 días) no caen dentro
  // de ella con el intervalo por defecto.
  if (!pop.comprobacionContinua && world.tick % pop.intervaloComprobacionTicks !== 0) return;
  const materializeBirth = (a: Person, b: Person, place: (typeof world.places)[number]): void => {
    const serial=world.birthCounter+1, id=`descendant-${serial}`;
    if(!Number.isSafeInteger(serial)||[...world.people,...world.legacy,...world.retiredLegacy].some(p=>p.id===id)) throw new Error('La identidad de un nacimiento ya existe; no se gastaron reservas.');
    const genome=inheritGenome(world.seed,id,[a,b],DEFAULT_MUTATION_RATE*paramsOf(world).genes.tasaMutacion); world.birthCounter=serial;
    const traits = expressGenome(genome);
    const childName = paramsOf(world).social.derivaCultural > 0
      ? proceduralPersonName(world.seed, world.birthCounter, genome.generation)
      : `${proceduralPlaceName(world.seed, world.birthCounter, genome.generation).split(' ')[0]} ${world.birthCounter}`.slice(0, 70);
    const child: Person = { ...structuredClone(a), id, name: childName, role: 'neighbor',
      genome, traits, curiosity: traits.curiosity, sociability: traits.sociability, generosity: traits.care, bornAt: world.tick, lastBirth: world.tick, thirst: 0.15,
      hunger: 0.2, fatigue: 0.1, energy: 0.65, inventory: 0.1, materials: { wood: 0, stone: 0 }, skills: {}, activity: {}, values: {}, experiences: [], habits: [], visited: [], bonds: {},
      culture: inheritCulture(world.seed, id, a.culture, b.culture, paramsOf(world).social.derivaCultural),
      command: null, controlMode: 'auto', target: { x: a.x, y: a.y }, action: 'rest', reason: 'Un nuevo habitante aprende en la comunidad que lo sostiene.', work: 0, decisionAt: world.tick + 30, lastOutcome: world.tick, lastPracticeMemory: world.tick, recentMemory: null,
      lastSocial: world.tick, lastDispute: world.tick, lastMeeting: world.tick, lastShared: world.tick, socialLoad: 0, closeness: 0.2, need: 'Aprender', heading: world.birthCounter * 2.399963229728653,
      blueprintId: null, lastInvention: world.tick,
      technology: initialTechnologyKnowledge(), demography: initialDemography(),
    };
    // La cría parte de una copia de su madre: el uid es identidad del motor y se le da uno propio al entrar en la tabla.
    delete child.uid;
    delete child.home;
    delete child.partnerMemory;
    delete child.agreement;
    delete child.compounds;
    // Lastre de la ley retirada (vocación, ola 1): una cría nunca hereda ese campo.
    delete (child as unknown as Record<string, unknown>).vocacion;
    // Política evolutiva V12: la plasticidad adquirida en vida (efecto Baldwin) jamás se hereda.
    delete child.policy;
    delete child.policyPlasticity;
    if (paramsOf(world).conducta.politicaPeso > 0) {
      const parentPolicyA = a.policy ?? founderPolicy(world.seed, a.id);
      const parentPolicyB = b.policy ?? founderPolicy(world.seed, b.id);
      child.policy = inheritPolicy(world.seed, id, parentPolicyA, parentPolicyB, DEFAULT_MUTATION_RATE * paramsOf(world).genes.tasaMutacion);
      child.policyPlasticity = initialPolicyPlasticity();
    }
    // `agua.memoria`: la cría nace junto a sus padres y conserva el aguadero de `a` (copiado arriba con el
    // resto de su estado); es información, no agua: si está seco lo olvidará al verlo, como cualquiera.
    if (a.waterMemory) child.waterMemory = { x: a.waterMemory.x, y: a.waterMemory.y };
    a.inventory -= 0.08; b.inventory -= 0.08; a.energy = clamp(a.energy - 0.08); b.energy = clamp(b.energy - 0.08); a.lastBirth = world.tick; b.lastBirth = world.tick;
    world.people.push(child);
    // El evento de fundación de una comunidad comparte el arreglo con `group.members`
    // (society.ts). Con la comprobación periódica un nacimiento cae siempre en el mismo paso
    // que ese evento, así que empujar aquí lo extiende ANTES de que se archive y la crónica
    // sigue siendo coherente: eso es lo que guardan las instantáneas de hoy y por eso el
    // camino por defecto no se toca. Con `comprobacionContinua` el nacimiento puede caer
    // 1..119 pasos DESPUÉS, cuando el evento ya es durable, y empujar lo reescribiría: el
    // Store lo rechaza («an immutable event cannot be overwritten»). Reemplazar el arreglo
    // deja el mismo censo sin tocar el pasado. Desde reglas 10 el evento lleva su propia copia
    // (society.ts) y aquí se reemplaza siempre; los mundos V9 conservan el alias histórico.
    const group = world.communities.find(c => c.id === a.communityId);
    if (group) { if (pop.comprobacionContinua || world.version >= 10) group.members = [...group.members, id]; else group.members.push(id); }
    count(world, 'births');
    const event = addEvent(world, { kind: 'birth', actors: [a.id, b.id, child.id], x: child.x, y: child.y, source: 'simulation', text: a.communityId === b.communityId ? `${child.name} nació en la comunidad de ${a.name} y ${b.name}.` : `${child.name} nació del vínculo entre ${a.name} y ${b.name}, de comunidades distintas.`, cause: `${a.name} y ${b.name} junto a ${place.name} (${place.x},${place.y}). Dos progenitores simulados con recursos, confianza y lugar compartido; reserva conjunta −0.16, cría recibe 0.10. Recombina siete pares de parámetros; ${genome.mutations} variaciones. Habilidades y recuerdos comienzan vacíos; cultura inicial por crianza, no por ADN.` });
    remember(child, world, 'La comunidad sostuvo su llegada.', event.id, place.id);
  };
  if (pop.natalidadVecindad) {
    const pairs = selectLocalBirthPairs(
      world,
      {
        radioVecindad: pop.radioVecindadNatalidad,
        cupoLocalPorVentana: pop.nacimientosPorComprobacion,
        ventanaTicks: pop.intervaloComprobacionTicks,
        alimentoMedioMinimo: ALIMENTO_MEDIO_MINIMO_NATALIDAD,
        radioPareja: pop.radioPareja,
        radioLugar: pop.radioLugar,
        exigeComunidad: pop.exigeComunidad,
        maximaPoblacion: pop.maxima,
      },
      person => fertile(world, person),
      closeKin,
      pairAffinity,
      pairTie,
    );
    for (const { a, b, place } of pairs) materializeBirth(a, b, place);
    return;
  }
  const recientes = pop.comprobacionContinua
    ? world.people.filter(p => p.role === 'neighbor' && p.bornAt > world.tick - pop.intervaloComprobacionTicks).length : 0;
  const cupo = pop.nacimientosPorComprobacion - recientes;
  if (cupo <= 0) return;
  const used = new Set<string>();
  const fit = (p: Person): boolean => !used.has(p.id)
    && fertile(world, p) && (!pop.exigeComunidad || !!p.communityId);
  const match = (a: Person, b: Person): boolean => b !== a && fit(b) && distance(a, b) <= pop.radioPareja && (a.bonds[b.id] ?? 0) >= 0.3 && (b.bonds[a.id] ?? 0) >= 0.3 && !closeKin(a, b);
  for (let n = 0; n < cupo && world.people.length < pop.maxima; n++) {
    let pair: { a: Person; b: Person } | undefined, place: (typeof world.places)[number] | undefined;
    for (const a of world.people) {
      if (!fit(a)) continue;
      const here = primeroCerca(world.places, a, pop.radioLugar + 1, p => distance(a, p) <= pop.radioLugar);
      if (!here) continue;
      const b = chooseReproductivePartner(world, a, vecinos(world, a, pop.radioPareja + 1, p => {
        if (!match(a, p)) return false;
        return true;
      }, 'reproduce'), ELECCION_POR_AFINIDAD);
      if (!b) continue;
      if (!ELECCION_POR_AFINIDAD) { pair = { a, b }; place = here; break; }
      const afinidad = pairAffinity(a, b, pop.radioPareja), mejor = pair ? pairAffinity(pair.a, pair.b, pop.radioPareja) : -Infinity;
      if (!pair || afinidad > mejor || (afinidad === mejor && pairTie(world, a, b) > pairTie(world, pair.a, pair.b))) {
        pair = { a, b }; place = here;
      }
    }
    if (!pair || !place) break;
    materializeBirth(pair.a, pair.b, place);
    used.add(pair.a.id); used.add(pair.b.id);
  }
}


function fertile(world: World, person: Person): boolean {
  return person.inventory >= 0.1 && reproductiveReadiness(world, person);
}
