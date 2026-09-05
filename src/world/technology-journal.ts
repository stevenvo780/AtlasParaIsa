import type { TechnologyExecution, TechnologyState } from '../shared/technology.js';

/** Explicit backpressure for a host that keeps stepping without committing its journal. */
export const MAX_PENDING_TECHNOLOGY_EXECUTIONS = 65_536;

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function serial(execution: TechnologyExecution): number {
  if (!execution || typeof execution.id !== 'string' || !/^process-[1-9]\d*$/.test(execution.id)) return NaN;
  const value = Number(execution.id.slice(8));
  return integer(value) ? value : NaN;
}
function fail(): never { throw new Error('Invalid technology journal coverage. Explicit recovery required.'); }

/** This checks coverage and shared observations; assertTechnology checks the physical receipt envelopes. */
export function assertTechnologyJournal(state: TechnologyState, tick: number): void {
  const journal = state.journal;
  if (journal === undefined) return;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).sort().join(',') !== 'committedThrough,pending,startsAfter,version'
    || journal.version !== 1 || !integer(journal.startsAfter) || !integer(journal.committedThrough)
    || !integer(state.executionCounter) || !integer(state.historyDropped) || !integer(tick)
    || journal.startsAfter > journal.committedThrough || journal.committedThrough > state.executionCounter
    || !Array.isArray(journal.pending) || journal.pending.length > MAX_PENDING_TECHNOLOGY_EXECUTIONS
    || journal.pending.length !== state.executionCounter - journal.committedThrough
    || !Array.isArray(state.history) || state.history.length + state.historyDropped !== state.executionCounter) fail();
  let previousTick = 0;
  for (let index = 0; index < journal.pending.length; index++) {
    const execution = journal.pending[index]!;
    if (serial(execution) !== journal.committedThrough + index + 1 || !integer(execution.tick)
      || execution.tick < previousTick || execution.tick > tick) fail();
    previousTick = execution.tick;
  }
  previousTick = 0;
  for (let index = 0; index < state.history.length; index++) {
    const execution = state.history[index]!;
    const value = serial(execution);
    if (value !== state.historyDropped + index + 1 || !integer(execution.tick)
      || execution.tick < previousTick || execution.tick > tick) fail();
    previousTick = execution.tick;
    if (value > journal.committedThrough) {
      const pending = journal.pending[value - journal.committedThrough - 1];
      if (!pending || JSON.stringify(pending) !== JSON.stringify(execution)) fail();
    }
  }
  // If the last committed receipt remains visible, pending work cannot precede it.
  const committed = state.history.find(execution => serial(execution) === journal.committedThrough);
  if (committed && journal.pending.length && journal.pending[0]!.tick < committed.tick) fail();
}

/** Opening an older host records only its surviving prefix boundary, never invented missing receipts. */
export function enableTechnologyJournal(state: TechnologyState): void {
  if (state.journal !== undefined) {
    assertTechnologyJournal(state, Number.MAX_SAFE_INTEGER);
    return;
  }
  const journal = { version: 1 as const, startsAfter: state.historyDropped,
    committedThrough: state.historyDropped, pending: [...state.history] };
  assertTechnologyJournal({ ...state, journal }, Number.MAX_SAFE_INTEGER);
  state.journal = journal;
}

/** Called before the recent ring can discard an execution. Its final benefit is filled on the same object. */
export function journalTechnologyExecution(state: TechnologyState, execution: TechnologyExecution): void {
  if (!state.journal) return;
  const journal = state.journal;
  if (journal.pending.length >= MAX_PENDING_TECHNOLOGY_EXECUTIONS) {
    throw new Error('Technology journal is full; commit before advancing the simulation.');
  }
  if (serial(execution) !== journal.committedThrough + journal.pending.length + 1) fail();
  journal.pending.push(execution);
}

/** Prepare the snapshot that will be valid only if the host commits every pending receipt atomically. */
export function technologyStateForCommit(state: TechnologyState): TechnologyState {
  enableTechnologyJournal(state);
  return { ...state, journal: { version: 1, startsAfter: state.journal!.startsAfter,
    committedThrough: state.executionCounter, pending: [] } };
}

/** The host calls this strictly after its database transaction succeeds. */
export function markTechnologyJournalCommitted(state: TechnologyState): void {
  if (!state.journal) fail();
  assertTechnologyJournal(state, Number.MAX_SAFE_INTEGER);
  state.journal.committedThrough = state.executionCounter;
  state.journal.pending = [];
}
