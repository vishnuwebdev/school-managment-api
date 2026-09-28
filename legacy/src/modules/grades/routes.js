import { buildCrudRouter, badRequest } from '../../core/crudRoutes.js';

// School Setup > Grading System (the marks-to-grade table used once
// Examinations is built -- see designs/School Managment Feature.png
// panels 15/16, "Grade / Min Marks / Max Marks / Grade Point").
export const gradesRouter = buildCrudRouter({
  collection: 'grades',
  viewPermission: 'school.settings.view',
  managePermission: 'school.settings.update',
  event: 'grade',
  validate(body) {
    const { grade, minMarks, maxMarks, gradePoint } = body;
    if (!grade || typeof grade !== 'string') throw badRequest('grade is required');
    const min = Number(minMarks);
    const max = Number(maxMarks);
    const point = Number(gradePoint);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(point)) {
      throw badRequest('minMarks, maxMarks and gradePoint must be numbers');
    }
    if (min < 0 || max > 100 || min > max) throw badRequest('minMarks/maxMarks must be within 0-100 with minMarks <= maxMarks');
    return { grade: grade.trim(), minMarks: min, maxMarks: max, gradePoint: point };
  },
});
