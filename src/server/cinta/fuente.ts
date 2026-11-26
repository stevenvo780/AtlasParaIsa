import { serialize } from 'node:v8';
import { publicGeologyKey } from '../../shared/chemistry.js';
import type { CampoSerie, Suceso, VistaMundoFotograma, VistaPaginaFotograma, VistasLentas } from '../../shared/fotograma.js';
import type { ChronicleEvent, RuntimeStats, Tile, WorldView } from '../../shared/types.js';
import { chronicleSerial } from '../../world/chronicle-journal.js';
import { ctxSi, type CtxF0, type CtxLeyMateria } from '../../world/motor/acceso.js';
import { Clase, REF_NULA } from '../../world/motor/contratos.js';
import type { FotogramaEnCurso, FuenteFotograma, SucesoFotograma } from '../../world/motor/fotograma.js';
import {
  CAMPOS_TEXTO_OPCIONALES, estadisticasCarasDesdeTerreno,
  type CruceFaunaSaliente, type LoteFotoDuenos,
} from '../../world/motor/fotograma-dueno.js';
import { fundir } from '../../world/motor/reunir.js';
import type { ServicioQuimicoAuditable } from '../../world/materia/servicio.js';
import { projectChemistry, VIEW_EVENTS, VIEW_MEMORIES } from '../../world/proyeccion.js';
import { PAGE_SIDE } from '../../world/soa/region.js';
import { residentFastAccess } from '../../world/soa/terreno.js';
import { estadisticasFotograma, ESTADISTICAS_CARAS_CADA_TICKS, type EstadisticasCaras } from '../../world/statistics.js';
import { projectTechnology, type TechnologyActor } from '../../world/technology.js';
import { analyzeTechnologyOrganization, type TechnologyOrganizationActor } from '../../world/technology-organization.js';
import { tileLookup } from '../../world/tile-index.js';
import { whisperView } from '../../world/whispers.js';
import type { World } from '../../world/index.js';
import { demografiaDeCinta, projectMirrorTile, projectTapeFrame } from '../sim-worker.js';

const RESIDUO_VACIO = Object.freeze({ wood: 0, stone: 0, water: 0 });
const TIPOS_GLOBALES = new Set<string>([
  'mundo', 'cronicaVista', 'clima', 'tecnologia', 'organizacion',
  'lugar', 'recuerdo', 'plano', 'comunidad', 'susurro',
]);

function quimicaDe(c: unknown): ServicioQuimicoAuditable | undefined {
  return (c as CtxLeyMateria | undefined)?.quimica as ServicioQuimicoAuditable | undefined;
}

function sumarMapa(destino: Record<string, number>, origen: Readonly<Record<string, number>>): void {
  for (const [k, v] of Object.entries(origen)) destino[k] = (destino[k] ?? 0) + v;
}

function fundirNumero(base: number, valores: readonly number[]): number {
  let suma = base;
  for (const v of valores) suma += v - base;
  return suma;
}

function unirPorId<T extends { id: string }>(base: readonly T[], extras: readonly (readonly T[])[]): T[] {
  const salida = [...base];
  const vistos = new Set(base.map(v => v.id));
  for (const lista of extras) {
    for (const v of lista) {
      if (vistos.has(v.id)) continue;
      vistos.add(v.id);
      salida.push(v);
    }
  }
  return salida;
}

export function serieDeCinta(mundo: World, base: ReturnType<typeof demografiaDeCinta>, hz: number,
  contexto: unknown = ctxSi(mundo)): Record<CampoSerie, number> {
  const actual = demografiaDeCinta(mundo);
  return { poblacion: actual.poblacion, nacimientos: actual.nacimientos - base.nacimientos,
    muertes: actual.muertes - base.muertes, fauna: mundo.animals.length, estructuras: mundo.structures.length,
    sustancias: quimicaDe(contexto)?.totalSustancias() ?? mundo.chemistry?.formulas.length ?? 0, hz };
}

export function fuenteFotograma(inicial: World, epoca: number, instancia: string, runtime: RuntimeStats,
  hz: () => number, leerEvento: (serial: number) => ChronicleEvent | undefined): FuenteFotograma {
  const base = demografiaDeCinta(inicial);
  const arranque = inicial.events.filter(e => e.tick === inicial.tick && (epoca === 0 || chronicleSerial(e.id) === null));
  let serial = inicial.eventCounter, sustancias = 0, primero = true;
  let anterior = new Map<string, { datos: Buffer | string; baja: Suceso }>();
  let globalesAnterior = new Map<string, { datos: Buffer; baja: Suceso }>();
  let paginasEnCinta = new Set<string>();
  let estructurasEnCinta = new Set<string>();
  let carasConfirmadas: { muestra: EstadisticasCaras; tick: number; epoca: number } | null = null;
  let ultimoCamino: 'ninguno' | 'reunido' | 'duenos' = 'ninguno';

  let siguiente = anterior, globalesSiguientes = globalesAnterior;
  let paginasSiguientes = paginasEnCinta, estructurasSiguientes = estructurasEnCinta;
  let carasSiguientes: { muestra: EstadisticasCaras; fotograma: FotogramaEnCurso } | null = null;
  let caminoSiguiente: 'ninguno' | 'reunido' | 'duenos' = ultimoCamino;
  let serialSiguiente = serial, sustanciasSiguientes = sustancias;

  function necesitaCaras(tick: number, epoca: number, completo: boolean): boolean {
    return completo || !carasConfirmadas || carasConfirmadas.epoca !== epoca || tick < carasConfirmadas.tick
      || tick - carasConfirmadas.muestra.statsTick >= ESTADISTICAS_CARAS_CADA_TICKS;
  }

  function emitirCronicaYSustancias(c: CtxF0, mundo: World): SucesoFotograma[] {
    const sucesos: SucesoFotograma[] = primero ? arranque.map(evento => ({ tipo: 'cronica', evento })) : [];
    const diario = mundo.chronicleJournal;
    for (let n = serial + 1; n <= mundo.eventCounter; n++) {
      const evento = diario?.pending[n - diario.committedThrough - 1] ?? leerEvento(n);
      if (!evento) throw new Error(`Falta el suceso ${n} de la crónica.`);
      sucesos.push({ tipo: 'cronica', evento });
    }
    serialSiguiente = mundo.eventCounter;
    const quimica = quimicaDe(c);
    sustanciasSiguientes = quimica?.totalSustancias() ?? 0;
    for (let id = sustancias + 1; id <= sustanciasSiguientes; id++) {
      const s = quimica!.sustancia(id);
      sucesos.push({ tipo: 'sustancia', sustancia: { id, clase: s.clase, atomos: [...s.atomos],
        enlaces: [...s.enlaces], masa: s.masa, prop: s.prop } });
    }
    return sucesos;
  }

  return {
    necesitaCaras,
    corte(c, f, paginas, mundo = c.mundo) {
      const muestra = necesitaCaras(f.tick, f.epoca, f.completo) ? null : carasConfirmadas!.muestra;
      const { stats, caras } = estadisticasFotograma(mundo, muestra);
      const vista = projectTapeFrame(mundo, runtime, instancia, [], stats);
      const { version: _version, sequence: _sequence, tick: _tick, day: _day, phase: _fase, tiles: _tiles,
        people, animals, places, events, memories, communities, structures, blueprints, technology, organization,
        whispers, weather, ...cabecera } = vista;
      const sucesos = emitirCronicaYSustancias(c, mundo);
      const desdeDuenos = ultimoCamino === 'duenos' && !f.completo;
      siguiente = new Map();
      globalesSiguientes = new Map();
      paginasSiguientes = new Set();
      estructurasSiguientes = new Set();
      carasSiguientes = { muestra: caras, fotograma: f };
      caminoSiguiente = 'reunido';

      function cambiar(clave: string, suceso: Suceso, baja: Suceso, esGlobal: boolean) {
        const datos = serialize(suceso);
        if (esGlobal) {
          const previo = globalesAnterior.get(clave), igual = previo?.datos.equals(datos);
          const registro = igual ? previo! : { datos, baja };
          globalesSiguientes.set(clave, registro);
          siguiente.set(clave, registro);
          if (f.completo || !igual) sucesos.push(suceso);
          return;
        }
        const previo = anterior.get(clave);
        const igual = previo !== undefined && typeof previo.datos !== 'string' && previo.datos.equals(datos);
        siguiente.set(clave, igual ? previo : { datos, baja });
        if (f.completo || desdeDuenos || !igual) sucesos.push(suceso);
      }
      function emitir<K extends keyof VistasLentas>(tipo: K, id: string, vistaValor: VistasLentas[K]) {
        cambiar(`${tipo}:${id}`, { tipo, id, vista: vistaValor } as Suceso, { tipo, id, vista: null } as Suceso, TIPOS_GLOBALES.has(tipo));
      }
      function texto(uid: number, campo: string, valor: string | null | undefined) {
        if (valor == null) {
          if (desdeDuenos && (CAMPOS_TEXTO_OPCIONALES as readonly string[]).includes(campo)) {
            sucesos.push({ tipo: 'texto', uid, campo, valor: null });
          }
          return;
        }
        const clave = `texto:${uid}:${campo}`, previo = anterior.get(clave);
        const igual = previo !== undefined && previo.datos === valor;
        siguiente.set(clave, igual ? previo : {
          datos: valor, baja: previo?.baja ?? { tipo: 'texto', uid, campo, valor: null },
        });
        if (f.completo || desdeDuenos || !igual) sucesos.push({ tipo: 'texto', uid, campo, valor });
      }
      emitir('mundo', '', cabecera);
      emitir('cronicaVista', '', events);
      emitir('clima', '', weather);
      if (technology) emitir('tecnologia', '', technology);
      if (organization) emitir('organizacion', '', organization);
      for (const p of places) emitir('lugar', p.id, p);
      for (const m of memories) emitir('recuerdo', m.id, m);
      for (const s of structures ?? []) { emitir('estructura', s.id, s); estructurasSiguientes.add(s.id); }
      for (const b of blueprints ?? []) emitir('plano', b.id, b);
      for (const s of communities ?? []) emitir('comunidad', s.id, s);
      for (const s of whispers ?? []) emitir('susurro', s.id, s);
      for (let i = 0; i < people.length; i++) {
        const uid = mundo.people[i]!.uid!;
        const { name, color, reason, need, recentMemory, specialty, craftTint, craftFocus,
          x: _x, y: _y, action: _accion, energy: _energia, hunger: _hambre, thirst: _sed, health: _salud,
          experiences: _experiencias, trust: _confianza, ...persona } = people[i]!;
        emitir('persona', String(uid), persona);
        for (const [campo, valor] of Object.entries({ name, color, reason, need, recentMemory, specialty, craftTint, craftFocus })) texto(uid, campo, valor);
      }
      for (let i = 0; i < (animals?.length ?? 0); i++) {
        const uid = mundo.animals[i]!.uid!;
        const { reason, x: _x, y: _y, action: _accion, energy: _energia, hunger: _hambre, thirst: _sed, health: _salud,
          ...animal } = animals![i]!;
        emitir('animal', String(uid), animal);
        texto(uid, 'reason', reason);
      }
      for (const [clave, registro] of anterior) {
        if (registro.baja.tipo === 'pagina' && mundo.chunks[registro.baja.id]) {
          siguiente.set(clave, registro);
          paginasSiguientes.add(registro.baja.id);
        }
      }
      if (!f.completo) {
        for (const id of paginasEnCinta) {
          if (!mundo.chunks[id]) continue;
          paginasSiguientes.add(id);
          const clave = `pagina:${id}`;
          if (!siguiente.has(clave)) {
            siguiente.set(clave, { datos: Buffer.alloc(0), baja: { tipo: 'pagina', id, vista: null } });
          }
        }
      }
      const tileIn = tileLookup(mundo.tiles), fast = residentFastAccess(mundo.tiles);
      for (let p = 0; p < paginas.length; p += 2) {
        const px = paginas[p]!, py = paginas[p + 1]!, celdas: Omit<Tile, 'x' | 'y' | 'mat' | 'T'>[] = [];
        for (let y = py * PAGE_SIDE; y < (py + 1) * PAGE_SIDE; y++) for (let x = px * PAGE_SIDE; x < (px + 1) * PAGE_SIDE; x++) {
          const tile = tileIn(x, y);
          if (!tile) throw new Error(`Falta la tesela ${x},${y} de la página del fotograma.`);
          const { x: _x, y: _y, mat: _mat, T: _T, ...celda } = projectMirrorTile(tile, fast);
          celdas.push(celda);
        }
        const id = `${px},${py}`;
        emitir('pagina', id, celdas);
        paginasSiguientes.add(id);
      }
      if (!f.completo) {
        if (desdeDuenos) {
          for (const [clave, registro] of globalesAnterior) if (!globalesSiguientes.has(clave)) sucesos.push(registro.baja);
          for (const id of estructurasEnCinta) if (!estructurasSiguientes.has(id)) sucesos.push({ tipo: 'estructura', id, vista: null });
          for (const id of paginasEnCinta) if (!paginasSiguientes.has(id)) sucesos.push({ tipo: 'pagina', id, vista: null });
        } else {
          for (const [clave, registro] of anterior) if (!siguiente.has(clave)) sucesos.push(registro.baja);
        }
      }
      return { sucesos, serie: serieDeCinta(mundo, base, hz(), c) };
    },

    cortePorDuenos(c, f, paginas, lote: LoteFotoDuenos) {
      if (lote.partes.length !== lote.hilos) return null;
      let totalBytes = 0;
      for (const parte of lote.partes) {
        if (parte.desbordado || parte.compatFallback || !parte.resumen) return null;
        totalBytes += parte.bytes;
      }
      if (totalBytes > lote.limiteBytesTotal) return null;

      const m = c.mundo, cab = lote.cabecera, frente = c.frente;
      const partes = lote.partes;
      const resumenes = partes.map(p => p.resumen!);
      const renovarCaras = necesitaCaras(f.tick, f.epoca, f.completo);
      if (renovarCaras && !resumenes.every(r => r.diversidad !== undefined)) return null;

      // Cruces de fauna admitidos en F6: comprobar antes de construir sucesos que toda página destino en `f.paginas`
      // fue diferida por su dueño (`paginasPendientesCruce`); si alguna llegó sin diferir, fallback fail-closed.
      const paginasEnFotograma = new Set<string>();
      for (let p = 0; p < paginas.length; p += 2) paginasEnFotograma.add(`${paginas[p]},${paginas[p + 1]}`);
      const pendientesCruce = new Map<string, Omit<Tile, 'x' | 'y' | 'mat' | 'T'>[]>();
      for (const parte of partes) {
        for (const pend of parte.paginasPendientesCruce) pendientesCruce.set(pend.key, pend.celdas);
      }
      const entrantesPorPagina = new Map<string, CruceFaunaSaliente[]>();
      for (const parte of partes) {
        for (const cruce of parte.crucesFaunaSalientes) {
          if (!paginasEnFotograma.has(cruce.key)) continue;
          if (!pendientesCruce.has(cruce.key)) return null;
          let lista = entrantesPorPagina.get(cruce.key);
          if (!lista) entrantesPorPagina.set(cruce.key, lista = []);
          lista.push(cruce);
        }
      }

      // Identidades vivas del frente ya publicado (para organización y filtrado de miembros de comunidades).
      const idsVivos = new Set<string>();
      const inventarioPorId = new Map<string, { x: number; y: number; technology: TechnologyOrganizationActor['technology'] }>();
      for (const a of resumenes[0]!.actoresConInventario ?? []) {
        inventarioPorId.set(a.id, { x: a.x, y: a.y, technology: a.technology });
      }
      const actoresOrg: TechnologyOrganizationActor[] = [];
      const actoresTech: TechnologyActor[] = [];
      for (let s = 0; s < frente.alta; s++) {
        if (frente.vivo[s] !== 1 || frente.clase[s] !== Clase.Persona) continue;
        const uid = frente.uid[s]!;
        const id = c.idDe(uid) ?? lote.altasTick?.get(uid);
        if (!id) return null;
        idsVivos.add(id);
        const inv = inventarioPorId.get(id);
        const technology = inv?.technology ?? { items: [], residue: RESIDUO_VACIO };
        actoresOrg.push({ id, technology });
        if (inv) {
          actoresTech.push({
            id, x: inv.x, y: inv.y, energy: 0, fatigue: 0, materials: { wood: 0, stone: 0 }, skills: {},
            technology: { ...technology, knownRecipes: [], attempts: 0, lastAttempt: 0, project: null, learnedFrom: [], competence: {} },
          });
        }
      }

      const sucesos = emitirCronicaYSustancias(c, m);
      globalesSiguientes = new Map();
      paginasSiguientes = new Set();
      estructurasSiguientes = new Set();
      siguiente = anterior;
      caminoSiguiente = 'duenos';

      // Serie
      let poblacion = 0, fauna = 0, estructuras = 0;
      for (const r of resumenes) {
        poblacion += r.poblacion;
        fauna += r.faunaViva;
        estructuras += r.estructurasVivas;
      }
      const birthCounter = fundirNumero(cab.birthCounter, resumenes.map(r => r.birthCounter));
      const demographyDynamics = fundir(cab.demographyDynamics, resumenes.map(r => r.demographyDynamics)) as World['demographyDynamics'];
      const serie: Record<CampoSerie, number> = {
        poblacion,
        nacimientos: birthCounter - base.nacimientos,
        muertes: demographyDynamics.deaths - base.muertes,
        fauna,
        estructuras,
        sustancias: sustanciasSiguientes || (m.chemistry?.formulas.length ?? 0),
        hz: hz(),
      };

      // Listas globales unidas
      const extras = resumenes.slice(1);
      const places = unirPorId(m.places, extras.map(r => r.nuevos.places))
        .map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, description: p.description, gatherings: p.gatherings }));
      const memories = unirPorId(m.memories, extras.map(r => r.nuevos.memories))
        .slice(-VIEW_MEMORIES)
        .map(mem => ({ id: mem.id, title: mem.title, text: mem.text, source: mem.source, placeId: mem.placeId }));
      const blueprints = unirPorId(m.blueprints, extras.map(r => r.nuevos.blueprints))
        .map(b => ({ id: b.id, name: b.name, components: [...b.components], generation: b.generation, parents: [...b.parents],
          inventorId: b.inventorId, tick: b.tick, uses: b.uses, usefulness: b.usefulness, cost: { wood: b.cost.wood, stone: b.cost.stone, work: b.cost.work } }));
      const whispers = unirPorId(m.whispers ?? [], extras.map(r => r.nuevos.whispers)).map(whisperView);

      // Comunidades podadas por bajas del tick (idéntico a `#reunirMundo` + `projectMirror`).
      const bajasTickIds = new Set<string>(lote.bajasConfirmadas.map(b => b.id));
      for (const r of resumenes) for (const b of r.bajasTick) bajasTickIds.add(b.id);
      const communities = m.communities.reduce<NonNullable<WorldView['communities']>>((acc, com) => {
        const tuvoBaja = bajasTickIds.size > 0 && com.members.some(id => bajasTickIds.has(id));
        const miembros = tuvoBaja ? com.members.filter(id => !bajasTickIds.has(id)) : com.members;
        if (tuvoBaja && miembros.length === 0) return acc;
        acc.push({
          id: com.id, name: com.name, x: com.x, y: com.y, color: com.color,
          members: miembros.filter(id => idsVivos.has(id)),
          memberCount: miembros.length,
          culture: { ...com.culture }, formedAt: com.formedAt, cooperation: com.cooperation, disputes: com.disputes,
        });
        return acc;
      }, []);

      const events = m.events.slice(-VIEW_EVENTS).map(e => ({
        id: e.id, tick: e.tick, kind: e.kind, actors: [...e.actors],
        ...(e.x === undefined ? {} : { x: e.x }), ...(e.y === undefined ? {} : { y: e.y }),
        text: e.text, cause: e.cause, source: e.source,
        ...(e.death === undefined ? {} : { death: { ...e.death, previous: [...e.death.previous] } }),
      }));

      // Estadísticas reducidas en orden determinista de dueño 0..H-1.
      const actions: Record<string, number> = {}, biomes: Record<string, number> = {}, features: Record<string, number> = {};
      const generations: Record<string, number> = {}, wildlife: Record<string, number> = {}, structCounts: Record<string, number> = {};
      const materials = { wood: 0, stone: 0 };
      const lifeStage = { juvenile: 0, adult: 0, senescent: 0, unknown: 0 };
      let hunger = 0, energy = 0, fatigue = 0, thirst = 0;
      let freshWater = 0, cultivatedTiles = 0, trailTiles = 0, pavedTiles = 0;
      let polyominoStructures = 0, synergyLinks = 0, neighbors = 0, identities = 0, protectedCount = 0;
      for (const r of resumenes) {
        const st = r.stats;
        hunger += st.hunger; energy += st.energy; fatigue += st.fatigue; thirst += st.thirst;
        materials.wood += st.materials.wood; materials.stone += st.materials.stone;
        sumarMapa(actions, st.actions); sumarMapa(biomes, st.biomes); sumarMapa(features, st.features);
        sumarMapa(generations, st.generations); sumarMapa(wildlife, st.wildlife); sumarMapa(structCounts, st.structures);
        freshWater += st.freshWater; cultivatedTiles += st.cultivatedTiles; trailTiles += st.trailTiles; pavedTiles += st.pavedTiles;
        polyominoStructures += st.polyominoStructures; synergyLinks += st.synergyLinks;
        neighbors += st.neighbors; identities += st.identities; protectedCount += st.protectedCount;
        lifeStage.juvenile += st.lifeStage.juvenile; lifeStage.adult += st.lifeStage.adult;
        lifeStage.senescent += st.lifeStage.senescent; lifeStage.unknown += st.lifeStage.unknown;
      }
      const caras = renovarCaras
        ? estadisticasCarasDesdeTerreno(c.terreno, lote.chunksActivos, resumenes.map(r => r.diversidad!), f.tick)
        : carasConfirmadas!.muestra;
      carasSiguientes = { muestra: caras, fotograma: f };

      const totals = fundir(cab.totals, resumenes.map(r => r.totals)) as World['totals'];
      const animalDynamics = fundir(cab.animalDynamics, resumenes.map(r => r.animalDynamics)) as World['animalDynamics'];
      const inventionDynamics = fundir(cab.inventionDynamics, resumenes.map(r => r.inventionDynamics)) as World['inventionDynamics'];
      const discoveredChunks = fundirNumero(cab.discoveredChunks, resumenes.map(r => r.discoveredChunks));
      const settlementCount = fundirNumero(cab.settlementCount, resumenes.map(r => r.settlementCount));
      const n = Math.max(1, poblacion);
      const chemistry = m.chemistry ? projectChemistry(m) : undefined;
      const chemicalFormulas = (m.chemistry as { formulas?: unknown[] } | undefined)?.formulas?.length ?? 0;

      const stats: WorldView['stats'] = {
        population: poblacion, meanEnergy: energy / n, meanHunger: hunger / n, meanFatigue: fatigue / n, meanThirst: thirst / n,
        materials, actions, biomes, features, totals: { ...totals }, generations,
        history: m.history.map(s => ({ ...s })), scope: 'active-regions', wildlife,
        freshWater, cultivatedTiles, trailTiles, animalDynamics: { ...animalDynamics },
        structures: structCounts, blueprints: blueprints.length, inventionDynamics: { ...inventionDynamics },
        ...caras, diversidad: { ...caras.diversidad },
        census: { neighbors, identities, protectedCount, lifeStage: { ...lifeStage } },
        ...(pavedTiles > 0 ? { pavedTiles } : {}),
        ...(polyominoStructures > 0 ? { polyominoStructures } : {}),
        ...(synergyLinks > 0 ? { synergyLinks } : {}),
        ...(chemicalFormulas > 0 ? { chemicalFormulas } : {}),
      };

      const techSinCheckpoint = { ...m.technology, checkpoint: undefined };
      const technology = projectTechnology({ ...m, technology: techSinCheckpoint, people: actoresTech }, actoresTech);
      const { resources: _resources, ...orgSummary } = analyzeTechnologyOrganization(techSinCheckpoint, actoresOrg, m.tick);
      const organization = structuredClone(orgSummary);

      const recentLegacy = resumenes.flatMap(r => r.legacy).slice(0, 32).map(p => ({
        id: p.id, name: p.name, generation: p.generation, parents: [...p.parents],
        bornAt: p.bornAt, diedAt: p.diedAt, cause: p.cause,
      }));

      const cabeceraMundo: VistaMundoFotograma = {
        geologyKey: publicGeologyKey(m.seed),
        width: 40, height: 28, originX: 0, originY: 0, infinite: true,
        activeChunks: lote.clavesActivas.size, discoveredChunks, settlementCount,
        stats,
        ...(chemistry ? { chemistry } : {}),
        demography: { deaths: demographyDynamics.deaths, causes: { ...demographyDynamics.causes }, recent: recentLegacy },
        ...(instancia !== undefined ? { instanceId: instancia } : {}),
        performance: { ...runtime },
      };

      function emitirGlobal<K extends keyof VistasLentas>(tipo: K, id: string, valor: VistasLentas[K]) {
        const suceso = { tipo, id, vista: valor } as Suceso;
        const baja = { tipo, id, vista: null } as Suceso;
        const clave = `${tipo}:${id}`;
        const datos = serialize(suceso);
        globalesSiguientes.set(clave, { datos, baja });
        if (f.completo || !globalesAnterior.get(clave)?.datos.equals(datos)) sucesos.push(suceso);
      }

      emitirGlobal('mundo', '', cabeceraMundo);
      emitirGlobal('cronicaVista', '', events);
      emitirGlobal('clima', '', m.weather);
      emitirGlobal('tecnologia', '', technology);
      emitirGlobal('organizacion', '', organization);
      for (const p of places) emitirGlobal('lugar', p.id, p);
      for (const mem of memories) emitirGlobal('recuerdo', mem.id, mem);
      for (const b of blueprints) emitirGlobal('plano', b.id, b);
      for (const com of communities) emitirGlobal('comunidad', com.id, com);
      for (const w of whispers) emitirGlobal('susurro', w.id, w);
      if (!f.completo) {
        for (const [clave, registro] of globalesAnterior) if (!globalesSiguientes.has(clave)) sucesos.push(registro.baja);
      }

      // Páginas: conserva cualquier página previamente registrada que siga en `mundo.chunks` (`clavesActivas`),
      // igual que `fuente.ts` en el camino reunido. Solo emite `pagina: null` cuando ya no está activa.
      if (!f.completo) {
        for (const id of paginasEnCinta) if (lote.clavesActivas.has(id)) paginasSiguientes.add(id);
      }
      for (let p = 0; p < paginas.length; p += 2) paginasSiguientes.add(`${paginas[p]},${paginas[p + 1]}`);
      if (!f.completo) {
        for (const id of paginasEnCinta) if (!paginasSiguientes.has(id)) sucesos.push({ tipo: 'pagina', id, vista: null });
      }
      // Páginas destino de cruces F6 de fauna: aplicar conteo y especie visual mínima de llegadas salientes y emitir.
      for (const [key, celdas] of pendientesCruce) {
        const entrantes = entrantesPorPagina.get(key);
        if (entrantes) {
          for (const cruce of entrantes) {
            const celda = celdas[cruce.indice]!;
            celda.fauna = (celda.fauna ?? 0) + 1;
            celda.species = celda.species === undefined || cruce.especie < celda.species ? cruce.especie : celda.species;
          }
        }
        sucesos.push({ tipo: 'pagina', id: key, vista: celdas as VistaPaginaFotograma });
      }

      // Seguimiento de estructuras vivas en cinta (para fallback sin pérdidas).
      const trasFallback = partes.some(p => p.trasFallback);
      if (f.completo || trasFallback) {
        for (const p of partes) for (const id of p.estructurasAltasIds) estructurasSiguientes.add(id);
        if (!f.completo && trasFallback) {
          for (const id of estructurasEnCinta) if (!estructurasSiguientes.has(id)) sucesos.push({ tipo: 'estructura', id, vista: null });
        }
      } else {
        for (const id of estructurasEnCinta) estructurasSiguientes.add(id);
        for (const p of partes) {
          for (const id of p.estructurasBajasIds) estructurasSiguientes.delete(id);
          for (const id of p.estructurasAltasIds) estructurasSiguientes.add(id);
        }
      }

      // Bloques pre-serializados por dueño en orden determinista 0..H-1 (bajas antes que altas).
      const bloques: Uint8Array[] = [];
      for (const p of partes) for (const bloque of p.bajasBloques) bloques.push(bloque);
      for (const p of partes) for (const bloque of p.altasBloques) bloques.push(bloque);

      return { sucesos, bloques, serie };
    },

    confirmar(f) {
      anterior = siguiente;
      globalesAnterior = globalesSiguientes;
      paginasEnCinta = paginasSiguientes;
      estructurasEnCinta = estructurasSiguientes;
      if (carasSiguientes?.fotograma === f) {
        carasConfirmadas = { muestra: carasSiguientes.muestra, tick: f.tick, epoca: f.epoca };
        carasSiguientes = null;
      }
      ultimoCamino = caminoSiguiente;
      serial = serialSiguiente;
      sustancias = sustanciasSiguientes;
      primero = false;
    },
  };
}
