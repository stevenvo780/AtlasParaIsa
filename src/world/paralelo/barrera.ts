// Solo control entero. Los valores del mundo nunca se reducen mediante Atomics.
export const BARRIER_HEADER = {
  wake: 0, fatal: 1, ready: 2, quiesced: 3, epoch: 4, supervisorThreadId: 5, pending: 6, phase: 7,
  cells: 8,
} as const;
export const WORKER_CELL = { threadId: 0, completed: 1, errorLength: 2, activoUs: 3, cells: 4 } as const;
export const ERROR_CHARACTERS = 8192;
export const PLAZO_BARRERA_MS = 60_000;

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
