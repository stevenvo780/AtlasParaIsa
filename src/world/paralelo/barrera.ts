// Solo control entero. Los valores del mundo nunca se reducen mediante Atomics.
export const BARRIER_HEADER = {
  wake: 0, fatal: 1, ready: 2, quiesced: 3, epoch: 4, supervisorThreadId: 5, pending: 6, phase: 7,
  cells: 8,
} as const;
export const WORKER_CELL = { threadId: 0, completed: 1, errorLength: 2, activoUs: 3, cells: 4 } as const;
export const ERROR_CHARACTERS = 8192;
export const PLAZO_BARRERA_MS = 60_000;

/** Fallo permanente del paso (hilo muerto, plazo vencido, memoria compartida agotada): no se reintenta. */
export class ErrorFatalMotor extends Error {
  constructor(motivo: unknown) {
    const mensaje = motivo instanceof Error ? motivo.message : String(motivo);
    // recuperarPaso identifica una piscina caída por este prefijo.
    super(`StaticWorkerPool abortado: ${mensaje}`, { cause: motivo });
    this.name = 'ErrorFatalMotor';
  }
}

/** Exclusión mutua sobre `control[indice]` (0 libre, 1 tomado). Esperar más que el plazo es fatal: quien la
 * tenía murió con ella o quedó colgado. */
export function conCerrojo<T>(control: Int32Array, indice: number, nombre: string, trabajo: () => T): T {
  if (Atomics.compareExchange(control, indice, 0, 1) !== 0) {
    const vence = performance.now() + PLAZO_BARRERA_MS;
    do {
      const queda = vence - performance.now();
      if (queda <= 0) throw new ErrorFatalMotor(`Plazo agotado esperando ${nombre}.`);
      Atomics.wait(control, indice, 1, Math.min(queda, 1000));
    } while (Atomics.compareExchange(control, indice, 0, 1) !== 0);
  }
  try {
    return trabajo();
  } finally {
    Atomics.store(control, indice, 0);
    Atomics.notify(control, indice, 1);
  }
}

export interface SharedBarrier {
  control: Int32Array<SharedArrayBuffer>;
  errors: Uint16Array<SharedArrayBuffer>;
}

export function createBarrier(workers: number): SharedBarrier {
  return {
    control: new Int32Array(new SharedArrayBuffer((BARRIER_HEADER.cells + workers * WORKER_CELL.cells) * 4)),
    // Un slot adicional, escrito solo por el supervisor.
    errors: new Uint16Array(new SharedArrayBuffer((workers + 1) * ERROR_CHARACTERS * 2)),
  };
}

export function workerCell(workerIndex: number, field: number): number {
  return BARRIER_HEADER.cells + workerIndex * WORKER_CELL.cells + field;
}

/** El plazo se renueva con cada avance publicado, nunca por despertarse sin avance. */
export function waitForBarrier(control: Int32Array<SharedArrayBuffer>, complete: () => boolean, plazoMs = PLAZO_BARRERA_MS): boolean {
  let observado = Atomics.load(control, BARRIER_HEADER.wake);
  let vence = performance.now() + plazoMs;
  for (;;) {
    const wake = Atomics.load(control, BARRIER_HEADER.wake);
    if (complete()) return true;
    if (wake !== observado) {
      observado = wake;
      vence = performance.now() + plazoMs;
    }
    const restante = vence - performance.now();
    if (restante <= 0) return false;
    Atomics.wait(control, BARRIER_HEADER.wake, wake, Math.min(restante, 1000));
  }
}

export function readWorkerError(barrier: SharedBarrier, workerIndex: number): string {
  const length = Atomics.load(barrier.control, workerCell(workerIndex, WORKER_CELL.errorLength));
  const start = workerIndex * ERROR_CHARACTERS;
  let message = '';
  for (let i = 0; i < length; i++) message += String.fromCharCode(barrier.errors[start + i]!);
  return message;
}

export function readSupervisorError(barrier: SharedBarrier, workers: number): string {
  const start = workers * ERROR_CHARACTERS;
  let message = '';
  for (let i = 0; i < ERROR_CHARACTERS && barrier.errors[start + i] !== 0; i++) {
    message += String.fromCharCode(barrier.errors[start + i]!);
  }
  return message;
}
