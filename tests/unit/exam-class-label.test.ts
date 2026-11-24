import { describe, expect, it } from 'vitest';
import { classRangeLabel } from '../../src/modules/exams/exams.service.js';

describe('classRangeLabel (exam cards)', () => {
  it('names one class', () => {
    expect(classRangeLabel(['Class 8'], false)).toBe('Class 8');
    expect(classRangeLabel([], false)).toBeNull();
  });
  it('shows a run of classes as a range', () => {
    expect(classRangeLabel(['Class 1', 'Class 2', 'Class 10'], true)).toBe('Class 1–10');
    expect(classRangeLabel(['Nursery', 'LKG', 'UKG'], true)).toBe('Nursery–UKG');
  });
  it('lists up to three scattered classes, then counts them', () => {
    expect(classRangeLabel(['Class 1', 'Class 3', 'Class 5'], false)).toBe('Class 1, 3, 5');
    expect(classRangeLabel(['Nursery', 'Class 3'], false)).toBe('Nursery, Class 3');
    expect(classRangeLabel(['Class 1', 'Class 3', 'Class 5', 'Class 7'], false)).toBe('4 classes');
  });
});
