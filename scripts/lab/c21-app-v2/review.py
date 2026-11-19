#!/usr/bin/python3.14
"""Offline review of supplied observations; never launches any native process."""
import argparse
import json
from pathlib import Path


def assess(record):
    """Necessary technical gates only. Even a complete record does not imply C21 PASS."""
    if record.get('actualMonotonicSeconds', 0) < record.get('requiredMonotonicSeconds', 0):
        return 'UNKNOWN_SHORT_REAL_EXPOSURE'
    if record.get('sameIdDifferentBodyStatus') not in (None, 409):
        return 'FAIL_IDEMPOTENCY_CONFLICT'
    if record.get('sequenceRegressed'):
        return 'FAIL_SEQUENCE_REGRESSION'
    if record.get('statesOutstanding', 0) > 1:
        return 'FAIL_WS_BACKPRESSURE'
    if record.get('acceptedHttp200') and record.get('durableResultPresent') is False:
        return 'FAIL_UNILATERAL_MUTATION_ACK'
    if record.get('knownCommittedResultLost'):
        return 'FAIL_RECOVERY_LOST_COMMITTED_RESULT'
    barrier = record.get('barrier')
    if not barrier:
        return 'UNKNOWN_MISSING_BARRIER'
    if barrier.get('operationBinding') != 'STORE_SAVE_ARGUMENTS_REAL_GESTURE_ID':
        return 'UNKNOWN_OPERATION_BINDING'
    if barrier.get('commitReturned') and (not barrier.get('writeBeginSeen') or barrier.get('changesDelta', 0) <= 0 or barrier.get('inTransaction')):
        return 'FAIL_NOOP_OR_READ_COMMIT'
    if record.get('afterCommitBeforeAck') and (record.get('clientHeaderBytes') != 0 or not record.get('clientEofObserved')):
        return 'UNKNOWN_CLIENT_DELIVERY_WITNESS'
    if record.get('recoveryStarted') is False:
        return 'UNKNOWN_RECOVERY_NOT_VERIFIED'
    if record.get('projectionSequenceGap'):
        return 'UNKNOWN_UNOBSERVED_HISTORY_PROJECTION_TRANSPORT_MAY_COALESCE'
    if not record.get('retainedRowsReadBack') or not record.get('completeProjectionSameCut'):
        return 'UNKNOWN_RETAINED_OR_SAME_CUT_COVERAGE'
    return 'TECHNICAL_NECESSARY_GATES_ONLY_C21_UNKNOWN'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('record', type=Path)
    args = parser.parse_args()
    record = json.loads(args.record.read_text())
    print(json.dumps({'assessment': assess(record), 'c21': 'UNKNOWN', 'scientificAcceptance': False}))


if __name__ == '__main__':
    main()
