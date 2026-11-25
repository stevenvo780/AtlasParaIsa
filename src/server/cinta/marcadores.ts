/**
 * INTERFAZ PUENTE de los marcadores de la cinta (carril cinta; cinta-sonnet §8 «Marcadores y perfil» y `RutasCinta`).
 * El esqueleto lo fijó la preparación de la oleada: cinta rellena los cuerpos y puede añadir exportaciones, pero no
 * cambia estas firmas (las consume srv al servir `/api/cinta/marcador`).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CINTA, type Marcador, type Nivel } from '../../shared/cinta.js';
import { TICKS_PER_DAY } from '../../world/mundo/tipos.js';
import { INDICE_CINTA, type SegmentoCinta } from './catalogo.js';

const MARCADORES_POR_PERFIL = 5;
const FIJACION_DIAS = 14;
const FIJACION_MS = FIJACION_DIAS * 86400_000;
const FIJACION_TICKS = FIJACION_DIAS * TICKS_PER_DAY;
const PERFIL = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ENTERO = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const VIGENTES = 'en BETWEEN ? AND ?';

export function fijadosEn(db: DatabaseSync, ahoraMs: number): ReturnType<MarcadoresCinta['fijados']> {
  return db.prepare(`SELECT epoca,t AS t0,t+? AS t1 FROM marcadores WHERE ${VIGENTES} ORDER BY epoca,t`)
    .all(FIJACION_TICKS, ahoraMs - FIJACION_MS, ahoraMs).map(fila => ({ ...fila })) as ReturnType<MarcadoresCinta['fijados']>;
}

export function segmentoFijado(db: DatabaseSync, s: SegmentoCinta, ahoraMs: number): boolean {
  return s.nivel === 0 && !!db.prepare(`SELECT 1 FROM marcadores WHERE ${VIGENTES} AND epoca=? AND t BETWEEN ? AND ? LIMIT 1`)
    .get(ahoraMs - FIJACION_MS, ahoraMs, s.epoca, s.t0 - FIJACION_TICKS, s.t1);
}

/** Marcadores por perfil de navegador, junto al catálogo de la cinta de un mundo. Guarda los 5 últimos de cada perfil. */
export interface MarcadoresCinta {
  leer(perfil: string): Marcador[];
  guardar(m: Marcador): void;
  /** Ticks de L0 que los marcadores vigentes piden conservar (el podador no los borra). */
  fijados(ahoraMs: number): { epoca: number; t0: number; t1: number }[];
  cerrar(): void;
}
export function abrirMarcadores(directorioCinta: string): MarcadoresCinta {
  const ruta = join(directorioCinta, INDICE_CINTA);
  const db = statSync(ruta, { throwIfNoEntry: false }) && new DatabaseSync(ruta);
  try {
    db?.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (db && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='marcadores'").get()) {
      throw new Error('El catálogo de marcadores todavía no está disponible.');
    }
  } catch (error) { db?.close(); throw error; }

  return {
    leer(perfil) {
      if (!PERFIL.test(perfil)) throw new Error('El perfil del marcador debe ser un UUID.');
      const filas = db?.prepare('SELECT * FROM marcadores WHERE perfil=? ORDER BY en DESC LIMIT ?')
        .all(perfil, MARCADORES_POR_PERFIL) ?? [];
      return filas.map(({ nombre, ...fila }) => ({ ...fila, ...(nombre === null ? {} : { nombre }) })) as unknown as Marcador[];
    },
    guardar(m) {
      if (!db) throw new Error('El catálogo de marcadores todavía no está disponible.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO marcadores (perfil,en,nombre,epoca,t,nivel,velocidad) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(perfil,en) DO UPDATE SET nombre=excluded.nombre,epoca=excluded.epoca,t=excluded.t,
            nivel=excluded.nivel,velocidad=excluded.velocidad`)
          .run(m.perfil, m.en, m.nombre ?? null, m.epoca, m.t, m.nivel, m.velocidad);
        db.prepare(`DELETE FROM marcadores WHERE perfil=? AND en < (
          SELECT en FROM marcadores WHERE perfil=? ORDER BY en DESC LIMIT 1 OFFSET ?)`)
          .run(m.perfil, m.perfil, MARCADORES_POR_PERFIL - 1);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    fijados: ahoraMs => db ? fijadosEn(db, ahoraMs) : [],
    cerrar: () => db?.close(),
  };
}

/** Valida un cuerpo de `PUT /api/cinta/marcador`; lanza con un mensaje claro si no es un `Marcador`. */
export function leerMarcador(crudo: unknown): Marcador {
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) throw new Error('El marcador debe ser un objeto.');
  const { perfil, nombre, epoca, t, nivel, velocidad, en } = crudo as Record<string, unknown>;
  if (typeof perfil !== 'string' || !PERFIL.test(perfil)) throw new Error('El perfil del marcador debe ser un UUID.');
  if (nombre !== undefined && typeof nombre !== 'string') throw new Error('El nombre del marcador debe ser un texto.');
  if (!ENTERO(epoca) || !ENTERO(t) || !ENTERO(en)) throw new Error('Época, tick y fecha del marcador deben ser enteros no negativos.');
  if (!ENTERO(nivel) || nivel >= CINTA.pasos.length) throw new Error('El nivel del marcador debe estar entre 0 y 4.');
  if (typeof velocidad !== 'number' || !CINTA.velocidades.some(v => v === velocidad)) throw new Error('La velocidad del marcador no está admitida.');
  return { perfil, ...(nombre === undefined ? {} : { nombre }), epoca, t, nivel: nivel as Nivel, velocidad, en };
}
