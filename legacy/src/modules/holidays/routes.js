import { buildCrudRouter, badRequest } from '../../core/crudRoutes.js';
import { validDate } from '../../core/middleware.js';

// School Setup > Holidays. Gated by school.settings.* like the rest of
// School Setup's own tabs (holidays/grading/fee-types don't have their own
// entries in the permissions catalog -- they're sub-tabs of one screen,
// not separate modules with their own sidebar entry).
export const holidaysRouter = buildCrudRouter({
  collection: 'holidays',
  viewPermission: 'school.settings.view',
  managePermission: 'school.settings.update',
  event: 'holiday',
  validate(body) {
    const { name, startDate, endDate, type = 'School' } = body;
    if (!name || typeof name !== 'string') throw badRequest('name is required');
    if (!validDate(startDate) || !validDate(endDate)) throw badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
    if (startDate > endDate) throw badRequest('startDate must not be after endDate');
    if (typeof type !== 'string') throw badRequest('type must be a string');
    return { name: name.trim(), startDate, endDate, type: type.trim() || 'School' };
  },
});
