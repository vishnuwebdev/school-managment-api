export class AppError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = new.target.name;
    }
}
export class ValidationError extends AppError {
    constructor(message = 'The request is invalid', details = null) {
        super(422, 'VALIDATION_ERROR', message, details);
    }
}
export class AuthenticationError extends AppError {
    constructor(code = 'AUTHENTICATION_REQUIRED', message = 'Authentication is required', details = null) {
        super(401, code, message, details);
    }
}
export class AuthorizationError extends AppError {
    constructor(code = 'PERMISSION_DENIED', message = 'You do not have permission to perform this operation', details = null) {
        super(403, code, message, details);
    }
}
export class NotFoundError extends AppError {
    constructor(resource = 'Resource', details = null) {
        super(404, 'RESOURCE_NOT_FOUND', `${resource} was not found`, details);
    }
}
export class ConflictError extends AppError {
    constructor(code = 'CONFLICT', message = 'The resource was changed by someone else. Reload and try again.', details = null) {
        super(409, code, message, details);
    }
}
export class BusinessRuleError extends AppError {
    constructor(code, message, details = null) {
        super(422, code, message, details);
    }
}
export class InfrastructureError extends AppError {
    constructor(message = 'An unexpected error occurred') {
        super(500, 'INTERNAL_ERROR', message);
    }
}
/** MySQL duplicate-key (ER_DUP_ENTRY) detection, including errors wrapped by the ORM. */
export function isDuplicateKeyError(err) {
    let cur = err;
    for (let i = 0; i < 4 && cur; i++) {
        if (typeof cur === 'object' &&
            cur !== null &&
            'code' in cur &&
            cur.code === 'ER_DUP_ENTRY')
            return true;
        cur =
            typeof cur === 'object' && cur !== null && 'cause' in cur
                ? cur.cause
                : undefined;
    }
    return false;
}
