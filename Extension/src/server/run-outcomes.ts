// Copyright (c) 2026 Naotsun

import type { CheckOutcome } from './check-scheduler.ts';
import type { PingProcessResult } from './engine-registry.ts';
import { PROTOCOL_VERSION, type IdeSuccess } from './ide-protocol.ts';
import { DEFAULT_TIMEOUT_MS, type RunOutcome } from './verse-ide-runner.ts';

/** Every run outcome except a successful one. */
type FailedRunOutcome = Exclude<RunOutcome, { status: 'ok' }>;

/** Appends stderr, without the whitespace around it, to a message on a new line when there is any. */
function appendStderr(message: string, stderr: string): string {
  const trimmedStderr = stderr.trim();
  return (trimmedStderr === '' ? message : `${message}\n${trimmedStderr}`);
}

/** Describes a failed run for the output channel. */
export function describeFailure(outcome: Readonly<FailedRunOutcome>): string {
  switch (outcome.status) {
    case 'rejected':
      return `verse.exe refused the request: ${outcome.error}`;

    case 'protocolMismatch':
      return `verse.exe speaks protocol ${String(outcome.protocol)}, not ${PROTOCOL_VERSION}.`;

    case 'invalid':
      return `verse.exe gave an answer that is not understood: ${outcome.error}`;

    case 'spawnFailed':
      return `verse.exe could not be started: ${outcome.error}`;

    case 'noResponse': {
      const exitNote = `exit code ${String(outcome.exitCode)}`;
      const stdinNote = (outcome.stdinError === undefined ? '' : `; writing the request failed: ${outcome.stdinError}`);
      return appendStderr(`verse.exe ended without an answer (${exitNote}${stdinNote}).`, outcome.stderr);
    }

    case 'timeout':
      return appendStderr(
        `verse.exe did not answer within ${DEFAULT_TIMEOUT_MS / 1000} seconds and was stopped.`,
        outcome.stderr,
      );

    case 'outputTooLarge':
      return outcome.error;

    case 'requestTooLarge':
      return outcome.error;

    case 'cancelled':
      return 'The request was cancelled.';
  }
}

/** Turns the outcome of a check into what the scheduler expects. */
export function toCheckOutcome(outcome: Readonly<RunOutcome>): CheckOutcome<IdeSuccess> {
  if (outcome.status === 'ok') {
    return { isOk: true, response: outcome.response };
  }
  return { isOk: false, error: describeFailure(outcome) };
}

/**
 * Turns the outcome of a ping into what the engine registry classifies. An answer is passed on as JSON, so that the
 * registry reads the protocol version itself. Only an exit code of 1 without an answer means an exe that does not
 * know the flag; every other failure is passed on with a description, which the registry treats as temporary.
 */
export function toPingResult(outcome: Readonly<RunOutcome>): PingProcessResult {
  switch (outcome.status) {
    case 'ok':
      // The validated answer has no "ok" flag, but the registry parses the JSON again and requires one. A valid
      // answer was ok: true, so the flag is put back.
      return { kind: 'answered', responseJson: JSON.stringify({ protocol: outcome.response.protocol, ok: true }) };

    case 'protocolMismatch':
      return { kind: 'answered', responseJson: JSON.stringify({ protocol: outcome.protocol, ok: true }) };

    case 'spawnFailed':
      return { kind: 'spawnFailed', errorCode: outcome.code, message: outcome.error };

    default:
      if (outcome.status === 'noResponse' && outcome.exitCode === 1) {
        return { kind: 'noAnswer', exitCode: 1 };
      }
      return { kind: 'failed', message: describeFailure(outcome) };
  }
}
