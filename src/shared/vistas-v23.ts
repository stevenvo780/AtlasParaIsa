/**
 * Lo que la V23 añade a lo que viaja al cliente y a la cinta (oleada V23). No es de ningún carril: los campos nuevos de
 * `shared/types.ts` y `shared/life.ts` apuntan aquí. Todo es opcional en la vista: ausente = el mundo servido no tiene
 * encendida la ley que lo produce (el cliente dice «sin dato», nunca dibuja un cero).
 * Lo rellena el gancho `Ley.proyectar` de cada carril de ley; lo dibujan vmapa y vfichas.
 */
import type { SustanciaId, SustanciaVista } from './materia.js';

/** Cuerpo de átomos de una persona o un animal (b y f). Fracciones en [0, 1]; masas en kg. */
export interface CuerpoVisible {
  masa: number;            // tejido + reserva + digestivo
  masaAdulta: number;      // la de su plantilla
  reserva: number;         // energía de la reserva sobre su objetivo
  agua: number;            // agua del tejido sobre su objetivo
  digestivo: number;       // kg en el tubo
  carga: number;           // kg a cuestas
  T: number;               // K
  principal: SustanciaId;  // sustancia de más masa del tejido (color del sprite)
  /** Gestación en curso (n): masa del embrión, la que tendrá al nacer y uid de la pareja que aportó su genoma. */
  embrion?: { masa: number; m0: number; otro: number };
}

/** Cría que aún depende de sus cuidadores y quiénes son (n). */
export interface CrianzaVisible { cuidadores: string[]; madurez: number /* masa sobre masa adulta */ }

/** Un lote con forma visible en una celda: objeto dejado, montón, cadáver, pieza de obra o fuego (w, b, t1, t2). */
export interface LoteVisible {
  x: number; y: number;
  rol: 'objeto' | 'cadaver' | 'pieza' | 'fuego';
  forma: number;           // `codigoForma` (0 = montón sin forma)
  principal: SustanciaId;
  masa: number;            // kg
  T: number;               // K (un horno o un metal al rojo se pintan por su temperatura)
}

/** Lo que la fauna añade a `AnimalView` (f): sin especie en las reglas, el dibujo sale de la masa y los genes. */
export interface FaunaVisible {
  miedo: number;           // [0, 1]
  persigue?: number;       // uid de la presa
  huyeDe?: number;         // uid de la mayor amenaza
  linaje: number;          // linaje fundador: solo para pintar
  /** Última extracción no letal que sufrió: qué y en qué tick («ordeñó», «esquiló»). */
  extraido?: { que: 'reserva' | 'fibra'; tick: number; por: number };
}

/** Panel «Materia» (vfichas): dónde están los átomos del mundo y qué sustancias han aparecido (w). */
export interface MateriaMundoVisible {
  tick: number;
  /** Compartimentos en el orden de `Rol` más 'enVuelo' y 'exterior'. */
  compartimentos: string[];
  /** mmol de átomos por compartimento y elemento (filas = compartimentos, columnas = ELEMENTOS), como texto decimal:
   * la suma del mundo puede pasar de 2⁵³. */
  atomos: string[][];
  /** J por compartimento (energía química más calor), como texto decimal. */
  energia: string[];
  /** Fuentes y sumideros declarados acumulados, por nombre de cuenta. */
  cuentas: Record<string, string>;
  /** Sustancias que existen ahora en algún lote, con su masa total (kg), de mayor a menor. */
  sustancias: { id: SustanciaId; masa: number; desde: number /* tick en que apareció */ }[];
  /** El libro cuadra (I1, I2): Σ lotes + Σ en vuelo = inicial + fuentes − sumideros. */
  conserva: boolean;
}

/** Ciclo del agua y aire de la página que contiene una celda (w): para la capa de humedad y la lluvia. */
export interface AireVisible { humedadRelativa: number; lluvia: number; T: number }

/** Qué dueño tiene cada página visible y cuánto le cuesta (capa «Hilos»; m4a y m7). */
export interface RepartoVisible { paginas: [px: number, py: number, dueno: number][]; msPorHilo: number[] }

/** Sustancias referenciadas por lo que viaja en esta vista (fichas de sustancia). */
export type SustanciasVisibles = SustanciaVista[];
