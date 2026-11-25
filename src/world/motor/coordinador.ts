/**
 * INTERFAZ PUENTE del motor de dueños (carril m4a; ARQ-motor §3 y contrato `Motor`). El esqueleto lo fijó la
 * preparación de la oleada: m4a rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consumen srv, lab y los bancos).
 */
import { sinImplementar } from './acceso.js';
import type { Motor, MotorConfig } from './contratos.js';
import type { World } from '../mundo/tipos.js';

/** Arma el motor sobre un mundo ya creado o cargado. Con `config.hilos === 1` no lanza workers: el hilo que llama es el
 * único dueño y `paso` hace lo mismo que `stepWorld`. Con más, reparte el mundo entre dueños (exige `v23.duenos`). */
export function crearMotor(mundo: World, config: MotorConfig): Motor { return sinImplementar('m4a: crearMotor'); }
