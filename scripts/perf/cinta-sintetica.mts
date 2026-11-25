import { mkdirSync, mkdtempSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Corte } from '../../src/shared/cinta.js';
import type { AnimalView, PersonView, Tile, WorldView } from '../../src/shared/types.js';
import { TICKS_PER_DAY } from '../../src/world/mundo/tipos.js';

const RAZONES = ['busca alimento', 'vuelve con su grupo', 'guarda agua', 'sigue una huella'];
const TERRENOS = ['meadow', 'soil', 'water', 'shelter'] as const;
const ANIMALES = ['hare', 'deer', 'boar', 'fox'] as const;

export function azarCinta(semilla = 7): () => number {
  return () => (semilla = (Math.imul(1664525, semilla) + 1013904223) >>> 0) / 2 ** 32;
}

export function directorioBanco(base: string, bytes: number, prefijo: string): string {
  const raiz = resolve(base);
  mkdirSync(raiz, { recursive: true });
  const disco = statfsSync(raiz);
  if (disco.bavail * disco.bsize < bytes) throw new Error(`Espacio insuficiente en ${raiz}.`);
  return mkdtempSync(join(raiz, prefijo));
}

export function natural(valor: string | undefined, nombre: string, omision?: number): number {
  const n = valor === undefined ? omision : Number(valor);
  if (n === undefined || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${nombre} debe ser un entero positivo.`);
  return n;
}

export function escenaCinta(personas: number, fauna: number, lado: number) {
  const azar = azarCinta();
  const elegir = <T,>(lista: readonly T[]): T => lista[Math.floor(azar() * lista.length)]!;
  const posicion = () => ({ x: Math.floor(azar() * lado), y: Math.floor(azar() * lado) });
  const tiles = Array.from({ length: lado ** 2 }, (_, i): Tile => ({
    x: i % lado, y: Math.floor(i / lado), terrain: elegir(TERRENOS), food: azar(), moisture: azar(),
    vegetation: azar(), elevation: azar(), traffic: azar(),
  }));
  const people = Array.from({ length: personas }, (_, i): PersonView => ({ ...posicion(), id: `p${i}`, name: `Persona ${i}`,
    role: 'neighbor', color: '#87a495', action: 'forage', reason: elegir(RAZONES), need: 'food', recentMemory: null,
    energy: azar(), hunger: azar(), fatigue: azar(), thirst: azar(), age: 100 + Math.floor(azar() * 50_000),
    traits: { curiosity: azar(), sociability: azar(), industriousness: azar(), care: azar(), resilience: azar() },
  }));
  const animals = Array.from({ length: fauna }, (_, i): AnimalView => ({ ...posicion(), id: `a${i}`, species: elegir(ANIMALES),
    generation: 0, action: 'graze', reason: elegir(RAZONES), health: 1, hunger: azar(), thirst: azar(), energy: azar(), fatigue: azar(),
    age: Math.floor(azar() * 24_000), parents: [], genes: { speed: azar(), perception: azar(), metabolism: azar(),
      carnivory: azar(), waterEfficiency: azar(), camouflage: azar() },
  }));
  return (t: number, seq: number, hz: number, completo: boolean): Corte => {
    const avance = seq % 31;
    const movidos = people.map((p, i) => i % 3 === 0 ? { ...p, x: (p.x + avance) % lado, hunger: (p.hunger + avance / 100) % 1 } : p);
    const faunaMovida = animals.map((a, i) => i % 2 ? a : { ...a, y: (a.y + avance) % lado });
    const ini = seq * 200 % tiles.length;
    const cambiadas = completo ? tiles : tiles.slice(ini, ini + 200).map(v => ({ ...v, food: (v.food + avance / 31) % 1 }));
    const vista: WorldView = { instanceId: 'banco-cinta', version: 10, sequence: seq, tick: t,
      day: Math.floor(t / TICKS_PER_DAY) + 1, phase: 'day', weather: 'clear', width: lado, height: lado,
      tiles: cambiadas, people: movidos, animals: faunaMovida, events: [], memories: [], places: [],
    };
    return { seq, epoca: 0, t, vista, tilesCambiadas: completo ? 'todas' : cambiadas, hitos: [], catalogo: [], hz,
      serie: { poblacion: personas, nacimientos: 0, muertes: 0, fauna, estructuras: 0, sustancias: 0, hz },
    };
  };
}
