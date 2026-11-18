/**
 * Tagged errors. Every provider failure carries a machine-readable code and
 * keeps partial evidence, so callers never have to guess from a message string.
 */
export type ErrorCode =
  | 'invalid_request'
  | 'missing_tool'
  | 'unsupported_input'
  | 'input_limit'
  | 'output_limit'
  | 'timeout'
  | 'unreadable_output'
  | 'integrity_failure'
  | 'internal_error';

export interface Details {
  [key: string]: unknown;
}

export class IotReaError extends Error {
  readonly code: ErrorCode;
  readonly details: Details;

  constructor(code: ErrorCode, message: string, details: Details = {}) {
    super(message);
    this.name = 'IotReaError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details: Details } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export type Result<T, E = IotReaError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (cause) {
    if (cause instanceof IotReaError) return err(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new IotReaError('internal_error', message));
  }
}
