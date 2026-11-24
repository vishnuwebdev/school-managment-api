import { BusinessRuleError } from '../../shared/errors.js';
/**
 * School lifecycle. It answers "is this school operationally active?" and is
 * deliberately separate from the subscription lifecycle (commercial access).
 * Archival is never physical deletion: an archived school can be restored
 * (to SUSPENDED, then reactivated) by a platform user allowed to archive.
 */
const TRANSITIONS = {
    REQUESTED: ['UNDER_REVIEW', 'ARCHIVED'],
    UNDER_REVIEW: ['APPROVED', 'ARCHIVED'],
    APPROVED: ['PROVISIONING', 'ARCHIVED'],
    PROVISIONING: ['ACTIVE', 'APPROVED'],
    ACTIVE: ['SUSPENDED', 'ARCHIVED'],
    SUSPENDED: ['ACTIVE', 'ARCHIVED'],
    ARCHIVED: ['SUSPENDED'], // restore only — see TenantService.transition
};
export function canTransition(from, to) {
    return TRANSITIONS[from].includes(to);
}
export function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new BusinessRuleError('INVALID_STATE', `A school cannot move from ${from} to ${to}`, {
            from,
            to,
            allowed: TRANSITIONS[from],
        });
    }
}
