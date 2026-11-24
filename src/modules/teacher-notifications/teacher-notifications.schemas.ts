import { z } from 'zod';
import { PaginationQuery } from '../../shared/pagination.js';

export const NotificationIdParams = z.object({ id: z.uuid() });
export const NotificationListQuery = PaginationQuery;

export const CreateNotificationBody = z
  .object({
    title: z.string().trim().min(2).max(150),
    body: z.string().trim().min(1).max(2000),
    audience: z.enum(['ALL', 'SELECTED']).default('ALL'),
    /** Needed when audience is SELECTED. */
    teacher_ids: z.array(z.uuid()).max(500).optional(),
    /** ISO date-time; omitted = send now. A future time schedules it. */
    send_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((b) => b.audience === 'ALL' || (b.teacher_ids?.length ?? 0) > 0, {
    message: 'Choose at least one teacher',
    path: ['teacher_ids'],
  });

export const ReadNotificationsBody = z
  .object({
    ids: z.array(z.uuid()).max(200).optional(),
    all: z.boolean().default(false),
  })
  .refine((b) => b.all || (b.ids?.length ?? 0) > 0, 'Send ids or all: true');
