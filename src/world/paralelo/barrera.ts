// Sólo control entero. Los valores del mundo nunca se reducen mediante Atomics.
export const BARRIER_HEADER = {
  wake: 0, fatal: 1, ready: 2, quiesced: 3, closed: 4, epoch: 5, supervisorThreadId: 6,
  cells: 7,
} as const;
export const WORKER_CELL = { status: 0, threadId: 1, completed: 2, errorLength: 3, cells: 4 } as const;
export const WORKER_STATUS = { starting: 0, ready: 1, running: 2, done: 3, jobError: 4, fatal: 5 } as const;
export const ERROR_CHARACTERS = 8192;

export interface SharedBarrier {
  control: Int32Array<SharedArrayBuffer>;
  errors: Uint16Array<SharedArrayBuffer>;
}

export function createBarrier(workers: number): SharedBarrier {
  return {
    control: new Int32Array(new SharedArrayBuffer((BARRIER_HEADER.cells + workers * WORKER_CELL.cells) * 4)),
    // Un slot adicional para errores del supervisor.
    errors: new Uint16Array(new SharedArrayBuffer((workers + 1) * ERROR_CHARACTERS * 2)),
  };
}

export function workerCell(workerIndex: number, field: number): number {
  return BARRIER_HEADER.cells + workerIndex * WORKER_CELL.cells + field;
}

/** Sin plazo artificial; releer la condición tras tomar wake evita perder notificaciones. */
export function waitForBarrier(control: Int32Array<SharedArrayBuffer>, complete: () => boolean): void {
  for (;;) {
    const wake = Atomics.load(control, BARRIER_HEADER.wake);
    if (complete()) return;
    Atomics.wait(control, BARRIER_HEADER.wake, wake);
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
