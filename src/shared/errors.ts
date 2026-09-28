/**
 * Central error hierarchy. Every error maps to an HTTP status and a stable,
 * machine-readable code; clients must never parse human-readable messages.
 */
export type ErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_TOKEN'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_DISABLED'
  | 'CONTEXT_SELECTION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'FEATURE_NOT_ENABLED'
  | 'TENANT_ACCESS_DENIED'
  | 'SCHOOL_SUSPENDED'
  | 'SCHOOL_NOT_ACTIVE'
  | 'SUBSCRIPTION_EXPIRED'
  | 'RESOURCE_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'DUPLICATE_RESOURCE'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'OPERATION_NOT_ALLOWED'
  | 'CONFIRMATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request is invalid', details: unknown = null) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(
    code:
      | 'AUTHENTICATION_REQUIRED'
      | 'INVALID_TOKEN'
      | 'INVALID_CREDENTIALS' = 'AUTHENTICATION_REQUIRED',
    message = 'Authentication is required',
  ) {
    super(401, code, message);
  }
}

export class AuthorizationError extends AppError {
  constructor(
    code: Extract<
      ErrorCode,
      | 'PERMISSION_DENIED'
      | 'FEATURE_NOT_ENABLED'
      | 'TENANT_ACCESS_DENIED'
      | 'SCHOOL_SUSPENDED'
      | 'SCHOOL_NOT_ACTIVE'
      | 'SUBSCRIPTION_EXPIRED'
      | 'ACCOUNT_DISABLED'
      | 'ACCOUNT_LOCKED'
    > = 'PERMISSION_DENIED',
    message = 'You do not have permission to perform this operation',
    details: unknown = null,
  ) {
    super(403, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', details: unknown = null) {
    super(404, 'RESOURCE_NOT_FOUND', `${resource} was not found`, details);
  }
}

export class ConflictError extends AppError {
  constructor(
    code: Extract<
      ErrorCode,
      'CONFLICT' | 'DUPLICATE_RESOURCE' | 'CONFIRMATION_REQUIRED' | 'CONTEXT_SELECTION_REQUIRED'
    > = 'CONFLICT',
    message = 'The resource was changed by someone else. Reload and try again.',
    details: unknown = null,
  ) {
    super(409, code, message, details);
  }
}

export class BusinessRuleError extends AppError {
  constructor(
    code: Extract<ErrorCode, 'INVALID_STATE' | 'OPERATION_NOT_ALLOWED'>,
    message: string,
    details: unknown = null,
  ) {
    super(422, code, message, details);
  }
}

export class InfrastructureError extends AppError {
  constructor(message = 'An unexpected error occurred') {
    super(500, 'INTERNAL_ERROR', message);
  }
}

/** MySQL duplicate-key (ER_DUP_ENTRY) detection, including errors wrapped by the ORM. */
export function isDuplicateKeyError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (
      typeof cur === 'object' &&
      cur !== null &&
      'code' in cur &&
      (cur as { code: unknown }).code === 'ER_DUP_ENTRY'
    )
      return true;
    cur =
      typeof cur === 'object' && cur !== null && 'cause' in cur
        ? (cur as { cause: unknown }).cause
        : undefined;
  }
  return false;
}
