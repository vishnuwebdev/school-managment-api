import { z } from 'zod';
import { NOTICE_AUDIENCE, NOTICE_CATEGORY } from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

const IsoDate = z.iso.date();

const noticeFields = {
  category: z.enum(NOTICE_CATEGORY).default('NOTICE'),
  title: z.string().trim().min(1).max(150),
  /** One-line preview; defaults to the start of the body. */
  summary: z.string().trim().max(300).optional(),
  /** Full text. Separate paragraphs with a blank line. */
  body: z.string().trim().min(1).max(20000),
  audience: z.enum(NOTICE_AUDIENCE).default('SCHOOL'),
  class_ids: z.array(z.uuid()).max(100).optional(),
  section_ids: z.array(z.uuid()).max(200).optional(),
  requires_acknowledgement: z.boolean().default(false),
  /** Shows the notice under "Coming up" in the parent app on this date. */
  event_date: IsoDate.nullable().optional(),
  event_title: z.string().trim().max(120).nullable().optional(),
  event_subtitle: z.string().trim().max(160).nullable().optional(),
  /** Publish later; default now. */
  publish_at: z.iso.datetime({ offset: true }).optional(),
};

export const CreateNoticeBody = z.object({
  ...noticeFields,
  /** Name shown to parents. Office default: "School office". Ignored for teachers. */
  posted_by_name: z.string().trim().min(1).max(150).optional(),
});

export const UpdateNoticeBody = z.object({
  version: z.number().int().positive(),
  category: noticeFields.category.optional(),
  title: noticeFields.title.optional(),
  summary: noticeFields.summary,
  body: noticeFields.body.optional(),
  audience: noticeFields.audience.optional(),
  class_ids: noticeFields.class_ids,
  section_ids: noticeFields.section_ids,
  requires_acknowledgement: z.boolean().optional(),
  event_date: noticeFields.event_date,
  event_title: noticeFields.event_title,
  event_subtitle: noticeFields.event_subtitle,
  publish_at: noticeFields.publish_at,
  posted_by_name: z.string().trim().min(1).max(150).optional(),
});

export const CancelNoticeBody = z.object({ reason: z.string().trim().max(500).optional() });

export const NoticeListQuery = PaginationQuery.extend({
  category: z.enum(NOTICE_CATEGORY).optional(),
  state: z.enum(['SCHEDULED', 'PUBLISHED', 'CANCELLED']).optional(),
  /** Only notices posted by teachers (true) or by the office (false). */
  from_teachers: z.stringbool().optional(),
});

export const AttachmentQuery = z.object({ filename: z.string().trim().max(200).optional() });

export const ParentNoticeQuery = PaginationQuery.extend({
  category: z.enum(NOTICE_CATEGORY).optional(),
  /** Only notices that concern this child. */
  child_id: z.uuid().optional(),
  unread: z.stringbool().optional(),
});
