import { expect, it } from 'vitest';
import { StaffImportService } from '../../src/modules/teachers/import.service.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = new StaffImportService({} as never, {} as never, {} as never) as any;

it('the template reads back through the parser', async () => {
  const rows = await svc.parse(await svc.template(), XLSX);
  expect(rows[0].first_name).toBe('Asha');
  expect(rows[0].joining_date).toBe('2026-01-12');
});

it('reads CSV and rejects unknown columns', async () => {
  const rows = await svc.parse(
    Buffer.from('first_name,last_name,joining_date\nA,B,2026-01-02\n'),
    'text/csv',
  );
  expect(rows[0].joining_date).toBe('2026-01-02');
  await expect(
    svc.parse(Buffer.from('first_name,last_name,salary\nA,B,10\n'), 'text/csv'),
  ).rejects.toThrow(/Unknown columns/);
});
