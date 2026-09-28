import { buildCrudRouter, badRequest } from '../../core/crudRoutes.js';

// School Setup > Fee Configuration -- defines fee TYPES (what can be
// charged and how often), not actual collection/payment records. Real fee
// collection is the separate, now-built "Fees & Payments" module
// (api/src/modules/fees/routes.js) -- it has its own fees:<page>:<action>
// permission catalog (core/permissionsV2.js), unrelated to and not
// touching this router's school.settings.* permissions.
export const feeTypesRouter = buildCrudRouter({
  collection: 'feeTypes',
  viewPermission: 'school.settings.view',
  managePermission: 'school.settings.update',
  event: 'feeType',
  validate(body) {
    const { name, frequency, applicableClasses = '', amount } = body;
    const allowedFrequencies = new Set(['One Time', 'Monthly', 'Quarterly', 'Annual']);
    if (!name || typeof name !== 'string') throw badRequest('name is required');
    if (!allowedFrequencies.has(frequency)) throw badRequest(`frequency must be one of ${[...allowedFrequencies].join(', ')}`);
    if (typeof applicableClasses !== 'string') throw badRequest('applicableClasses must be a string');
    let amountValue = null;
    if (amount !== undefined && amount !== null && amount !== '') {
      amountValue = Number(amount);
      if (!Number.isFinite(amountValue) || amountValue < 0) throw badRequest('amount must be a non-negative number');
    }
    return { name: name.trim(), frequency, applicableClasses: applicableClasses.trim(), amount: amountValue };
  },
});
