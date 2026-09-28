import { buildCrudRouter, badRequest } from '../../core/crudRoutes.js';

// Subjects (School Setup > Subjects tab in designs/). A subject applies to
// a free-text class range (e.g. "Nursery - 12") for now -- there's no
// Classes & Sections registry yet to reference by ID (that module has its
// own permission/route already reserved in nav_items.dart and is planned
// as its own build slot, see context-memory/implementation-baseline.md).
export const subjectsRouter = buildCrudRouter({
  collection: 'subjects',
  viewPermission: 'subjects.view',
  managePermission: 'subjects.manage',
  event: 'subject',
  validate(body) {
    const { name, code = '', applicableClasses = '' } = body;
    if (!name || typeof name !== 'string') throw badRequest('name is required');
    if (typeof code !== 'string' || typeof applicableClasses !== 'string') throw badRequest('code and applicableClasses must be strings');
    return { name: name.trim(), code: code.trim(), applicableClasses: applicableClasses.trim() };
  },
});
