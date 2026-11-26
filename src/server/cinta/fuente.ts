import { serialize } from 'node:v8';
import type { CampoSerie, Suceso, VistasLentas } from '../../shared/fotograma.js';
import type { ChronicleEvent, RuntimeStats, Tile } from '../../shared/types.js';
import { chronicleSerial } from '../../world/chronicle-journal.js';
import { ctxSi, type CtxLeyMateria } from '../../world/motor/acceso.js';
import type { FuenteFotograma } from '../../world/motor/fotograma.js';
import type { ServicioQuimicoAuditable } from '../../world/materia/servicio.js';
import { PAGE_SIDE } from '../../world/soa/region.js';
import { residentFastAccess } from '../../world/soa/terreno.js';
import { tileLookup } from '../../world/tile-index.js';
import type { World } from '../../world/index.js';
import { demografiaDeCinta, projectMirrorTile, projectTapeFrame } from '../sim-worker.js';

function quimicaDe(c: unknown): ServicioQuimicoAuditable | undefined {
  return (c as CtxLeyMateria | undefined)?.quimica as ServicioQuimicoAuditable | undefined;
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
  let siguiente = anterior, serialSiguiente = serial, sustanciasSiguientes = sustancias;
  return {
    corte(c, f, paginas, mundo = c.mundo) {
      const vista = projectTapeFrame(mundo, runtime, instancia, []);
      const { version: _version, sequence: _sequence, tick: _tick, day: _day, phase: _fase, tiles: _tiles,
        people, animals, places, events, memories, communities, structures, blueprints, technology, organization,
        whispers, weather, ...cabecera } = vista;
      const sucesos: Suceso[] = primero ? arranque.map(evento => ({ tipo: 'cronica', evento })) : [];
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
      siguiente = new Map();
      function cambiar(clave: string, suceso: Suceso, baja: Suceso) {
        const datos = serialize(suceso), previo = anterior.get(clave);
        const igual = previo !== undefined && typeof previo.datos !== 'string' && previo.datos.equals(datos);
        siguiente.set(clave, igual ? previo : { datos, baja });
        if (f.completo || !igual) sucesos.push(suceso);
      }
      function emitir<K extends keyof VistasLentas>(tipo: K, id: string, vista: VistasLentas[K]) {
        cambiar(`${tipo}:${id}`, { tipo, id, vista } as Suceso, { tipo, id, vista: null } as Suceso);
      }
      function texto(uid: number, campo: string, valor: string | null | undefined) {
        if (valor == null) return;
        const clave = `texto:${uid}:${campo}`, previo = anterior.get(clave);
        const igual = previo !== undefined && previo.datos === valor;
        siguiente.set(clave, igual ? previo : {
          datos: valor, baja: previo?.baja ?? { tipo: 'texto', uid, campo, valor: null },
        });
        if (f.completo || !igual) sucesos.push({ tipo: 'texto', uid, campo, valor });
      }
      emitir('mundo', '', cabecera);
      emitir('cronicaVista', '', events);
      emitir('clima', '', weather);
      if (technology) emitir('tecnologia', '', technology);
      if (organization) emitir('organizacion', '', organization);
      for (const p of places) emitir('lugar', p.id, p);
      for (const m of memories) emitir('recuerdo', m.id, m);
      for (const s of structures ?? []) emitir('estructura', s.id, s);
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
        if (registro.baja.tipo === 'pagina' && mundo.chunks[registro.baja.id]) siguiente.set(clave, registro);
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
        emitir('pagina', `${px},${py}`, celdas);
      }
      if (!f.completo) for (const [clave, registro] of anterior) if (!siguiente.has(clave)) sucesos.push(registro.baja);
      return { sucesos, serie: serieDeCinta(mundo, base, hz(), c) };
    },
    confirmar() {
      anterior = siguiente;
      serial = serialSiguiente;
      sustancias = sustanciasSiguientes;
      primero = false;
    },
  };
}
