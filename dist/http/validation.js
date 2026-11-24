import { ValidationError } from '../shared/errors.js';
export function parseOrThrow(schema, value, where) {
    const result = schema.safeParse(value ?? {});
    if (!result.success) {
        throw new ValidationError('The request is invalid', {
            location: where,
            issues: result.error.issues.map((i) => ({
                path: i.path.join('.'),
                code: i.code,
                message: i.message,
            })),
        });
    }
    return result.data;
}
