/** Typed errors used across the MCP/browser boundary. */

export const ERROR_CODES = {
  UNAVAILABLE: 'unavailable',
  UNSUPPORTED: 'unsupported',
  NOT_ALLOWED: 'not_allowed',
  POLICY_DENIED: 'policy_denied',
  STALE_INDEX: 'stale_index',
  STALE_CONTEXT: 'stale_context',
  OWNERSHIP: 'ownership',
  AUTH_REQUIRED: 'auth_required',
  TIMEOUT: 'timeout',
  VALIDATION: 'validation',
  NOT_FOUND: 'not_found',
  CDP_ERROR: 'cdp_error',
  ENVIRONMENT: 'environment',
  UNKNOWN: 'unknown',
};

export class CuaError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CuaError';
    this.code = code;
    this.details = details;
  }

  toPayload() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

function subclass(name, defaultCode) {
  const cls = class extends CuaError {
    constructor(message, details = undefined, code = defaultCode) {
      super(code, message, details);
      this.name = name;
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

export const UnavailableError = subclass('UnavailableError', ERROR_CODES.UNAVAILABLE);
export const UnsupportedError = subclass('UnsupportedError', ERROR_CODES.UNSUPPORTED);
export const NotAllowedError = subclass('NotAllowedError', ERROR_CODES.NOT_ALLOWED);
export const PolicyDeniedError = subclass('PolicyDeniedError', ERROR_CODES.POLICY_DENIED);
export const StaleIndexError = subclass('StaleIndexError', ERROR_CODES.STALE_INDEX);
export const StaleContextError = subclass('StaleContextError', ERROR_CODES.STALE_CONTEXT);
export const OwnershipError = subclass('OwnershipError', ERROR_CODES.OWNERSHIP);
export const AuthRequiredError = subclass('AuthRequiredError', ERROR_CODES.AUTH_REQUIRED);
export const TimeoutError = subclass('TimeoutError', ERROR_CODES.TIMEOUT);
export const ValidationError = subclass('ValidationError', ERROR_CODES.VALIDATION);
export const NotFoundError = subclass('NotFoundError', ERROR_CODES.NOT_FOUND);
export const CdpError = subclass('CdpError', ERROR_CODES.CDP_ERROR);
export const EnvironmentError = subclass('EnvironmentError', ERROR_CODES.ENVIRONMENT);

export function isCuaError(value) {
  return (
    value instanceof CuaError ||
    (value && typeof value.code === 'string' && typeof value.message === 'string')
  );
}

export function errorPayload(error) {
  if (error instanceof CuaError) return error.toPayload();
  const payload = {
    name: error?.name ?? 'Error',
    code: error?.code ?? ERROR_CODES.UNKNOWN,
    message: error?.message ?? String(error),
  };
  if (error?.details !== undefined) payload.details = error.details;
  return payload;
}

export function rehydrateError(payload) {
  const error = new CuaError(
    payload?.code ?? ERROR_CODES.UNKNOWN,
    payload?.message ?? 'unknown error',
    payload?.details,
  );
  if (payload?.name) error.name = payload.name;
  return error;
}
