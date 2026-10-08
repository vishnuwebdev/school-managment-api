import { assertWithinPlanLimit } from '../entitlements/plan-limits.js';
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  guardians,
  OPEN_ENROLLMENT_STATUSES,
  studentGuardians,
  studentExits,
  studentHistory,
  studentHouses,
  studentSettings,
  students,
  type StudentStatus,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import { recordChange } from '../../platform/record.js';
import { encryptSecret, decryptSecret } from '../../shared/crypto.js';
import { todayIso } from '../../shared/dates.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  ValidationError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf, type PaginationQuery } from '../../shared/pagination.js';
import type { EnrollmentService } from './enrollments.service.js';
import type { GuardianService } from './guardians.service.js';
import type {
  CreateStudentBody,
  StudentCommand,
  StudentListQuery,
  UpdateStudentBody,
} from './students.schemas.js';
import {
  addHistory,
  fullName,
  likeOf,
  loadStudent,
  nextNumber,
  setStudentStatus,
  studentScope,
  type StudentRow,
} from './support.js';

const OPEN = [...OPEN_ENROLLMENT_STATUSES];

export const presentStudent = (s: StudentRow) => ({
  id: s.id,
  student_number: s.studentNumber,
  admission_number: s.admissionNumber,
  first_name: s.firstName,
  middle_name: s.middleName,
  last_name: s.lastName,
  preferred_name: s.preferredName,
  full_name: fullName(s),
  date_of_birth: s.dateOfBirth,
  gender: s.gender,
  status: s.status,
  primary_email: s.primaryEmail,
  primary_phone: s.primaryPhone,
  nationality: s.nationality,
  address: s.address,
  notes: s.notes,
  blood_group: s.bloodGroup,
  house_id: s.houseId,
  previous_school: s.previousSchool,
  category: s.category,
  admission_date: s.admissionDate,
  admission_type: s.admissionType,
  has_government_id: s.governmentIdEnc !== null,
  government_id_masked: s.governmentIdLast4 ? `••••${s.governmentIdLast4}` : null,
  has_login: s.userId !== null,
  photo_file_id: s.photoFileId,
  status_changed_at: s.statusChangedAt?.toISOString() ?? null,
  version: s.version,
  created_at: s.createdAt.toISOString(),
  updated_at: s.updatedAt.toISOString(),
});

/** Lifecycle rules: which command may run from which status, and where it leads. */
const COMMANDS: Record<
  StudentCommand,
  { from: StudentStatus[]; to: StudentStatus; reasonRequired: boolean }
> = {
  admit: { from: ['PROSPECTIVE', 'ADMISSION_PENDING'], to: 'ADMITTED', reasonRequired: false },
  activate: { from: ['ADMITTED'], to: 'ACTIVE', reasonRequired: false },
  transfer: { from: ['ACTIVE'], to: 'TRANSFERRED', reasonRequired: true },
  withdraw: {
    from: ['PROSPECTIVE', 'ADMISSION_PENDING', 'ADMITTED', 'ACTIVE'],
    to: 'WITHDRAWN',
    reasonRequired: true,
  },
  graduate: { from: ['ACTIVE'], to: 'GRADUATED', reasonRequired: false },
  archive: {
    from: ['TRANSFERRED', 'WITHDRAWN', 'GRADUATED'],
    to: 'ARCHIVED',
    reasonRequired: false,
  },
  reinstate: { from: ['TRANSFERRED', 'WITHDRAWN'], to: 'ADMITTED', reasonRequired: true },
};

/** Permission needed per command (students.archive is a sensitive permission). */
export const COMMAND_PERMISSION: Record<StudentCommand, string> = {
  admit: 'students.update',
  activate: 'students.update',
  transfer: 'students.archive',
  withdraw: 'students.archive',
  graduate: 'students.archive',
  archive: 'students.archive',
  reinstate: 'students.archive',
};

export interface DuplicateCandidate {
  id: string;
  student_number: string;
  full_name: string;
  date_of_birth: string | null;
  status: StudentStatus;
  matched_on: string[];
}

export class StudentService {
  constructor(
    private readonly deps: Deps,
    private readonly enrollmentSvc: EnrollmentService,
    private readonly guardianSvc: GuardianService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- list ----------------------------------------------------------------------

  async list(tenantId: string, q: z.infer<typeof StudentListQuery>, principal: Principal) {
    const conds: (SQL | undefined)[] = [
      eq(students.tenantId, tenantId),
      studentScope(principal, 'students.read'),
    ];
    if (q.status) conds.push(eq(students.status, q.status));
    if (q.gender) conds.push(eq(students.gender, q.gender));
    if (q.admission_type) conds.push(eq(students.admissionType, q.admission_type));
    if (q.house_id) conds.push(eq(students.houseId, q.house_id));
    if (q.academic_year_id || q.class_id || q.section_id) {
      const place: (SQL | undefined)[] = [
        eq(enrollments.tenantId, students.tenantId),
        eq(enrollments.studentId, students.id),
        inArray(enrollments.status, OPEN),
        q.academic_year_id ? eq(enrollments.academicYearId, q.academic_year_id) : undefined,
        q.class_id ? eq(enrollments.classId, q.class_id) : undefined,
        q.section_id ? eq(enrollments.sectionId, q.section_id) : undefined,
      ];
      conds.push(sql`exists (select 1 from ${enrollments} where ${and(...place)})`);
    }
    if (q.enrolled !== undefined) {
      const open = sql`exists (select 1 from ${enrollments} where ${enrollments.tenantId} = ${students.tenantId} and ${enrollments.studentId} = ${students.id} and ${inArray(enrollments.status, OPEN)})`;
      conds.push(q.enrolled ? open : sql`not ${open}`);
    }
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(
        or(
          like(students.studentNumber, s),
          like(students.admissionNumber, s),
          like(students.firstName, s),
          like(students.lastName, s),
          like(students.primaryPhone, s),
          like(students.primaryEmail, s),
          sql`concat(${students.firstName}, ' ', ${students.lastName}) like ${s}`,
          sql`exists (select 1 from ${studentGuardians} inner join ${guardians} on ${guardians.id} = ${studentGuardians.guardianId} where ${studentGuardians.studentId} = ${students.id} and ${studentGuardians.status} = 'ACTIVE' and (${guardians.firstName} like ${s} or ${guardians.lastName} like ${s} or ${guardians.phone} like ${s} or ${guardians.email} like ${s}))`,
        ),
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(students)
        .where(where)
        .orderBy(
          orderFrom(
            { ...q, order: q.sort ? q.order : 'asc' },
            {
              name: students.lastName,
              first_name: students.firstName,
              student_number: students.studentNumber,
              status: students.status,
              date_of_birth: students.dateOfBirth,
              created_at: students.createdAt,
            },
            'name',
          ),
          asc(students.firstName),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(students).where(where),
    ]);
    const ids = rows.map((r) => r.id);
    const [places, primaries] = await Promise.all([
      this.currentPlacements(tenantId, ids),
      this.primaryGuardians(tenantId, ids),
    ]);
    return pageOf(
      rows.map((r) => ({
        ...presentStudent(r),
        current_enrollment: places.get(r.id) ?? null,
        primary_guardian: primaries.get(r.id) ?? null,
      })),
      total?.n ?? 0,
      q,
    );
  }

  /** The open enrollment of each student (the current academic year's wins). */
  private async currentPlacements(tenantId: string, ids: string[], ex: Executor = this.db) {
    const out = new Map<string, ReturnType<typeof placement>>();
    if (!ids.length) return out;
    const rows = await ex
      .select({
        e: enrollments,
        yearCode: academicYears.code,
        current: academicYears.isCurrent,
        className: academicClasses.name,
        sectionName: academicSections.name,
      })
      .from(enrollments)
      .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
      .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
      .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.studentId, ids),
          inArray(enrollments.status, OPEN),
        ),
      )
      .orderBy(desc(academicYears.isCurrent), desc(academicYears.startDate));
    for (const r of rows) if (!out.has(r.e.studentId)) out.set(r.e.studentId, placement(r));
    return out;
  }

  private async primaryGuardians(tenantId: string, ids: string[], ex: Executor = this.db) {
    const out = new Map<string, { id: string; full_name: string; phone: string | null }>();
    if (!ids.length) return out;
    const rows = await ex
      .select({ l: studentGuardians, g: guardians })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          inArray(studentGuardians.studentId, ids),
          eq(studentGuardians.status, 'ACTIVE'),
          eq(studentGuardians.isPrimary, true),
        ),
      );
    for (const r of rows)
      out.set(r.l.studentId, {
        id: r.g.id,
        full_name: fullName({
          firstName: r.g.firstName,
          middleName: r.g.middleName,
          lastName: r.g.lastName,
        }),
        phone: r.g.phone,
      });
    return out;
  }

  // ---- detail ----------------------------------------------------------------------

  async get(tenantId: string, id: string, principal: Principal) {
    const s = await loadStudent(this.db, tenantId, id, principal, 'students.read');
    const [places, guardianLinks] = await Promise.all([
      this.currentPlacements(tenantId, [id]),
      this.guardianSvc.forStudent(tenantId, id, principal),
    ]);
    let house: { id: string; name: string } | null = null;
    if (s.houseId) {
      const [h] = await this.db
        .select()
        .from(studentHouses)
        .where(and(eq(studentHouses.tenantId, tenantId), eq(studentHouses.id, s.houseId)));
      if (h) house = { id: h.id, name: h.name };
    }
    return {
      ...presentStudent(s),
      house,
      current_enrollment: places.get(id) ?? null,
      guardians: guardianLinks,
    };
  }

  async history(tenantId: string, id: string, principal: Principal) {
    await loadStudent(this.db, tenantId, id, principal, 'students.read');
    const rows = await this.db
      .select()
      .from(studentHistory)
      .where(and(eq(studentHistory.tenantId, tenantId), eq(studentHistory.studentId, id)))
      .orderBy(desc(studentHistory.createdAt), desc(studentHistory.id))
      .limit(500);
    return rows.map((h) => ({
      id: h.id,
      event_type: h.eventType,
      from_status: h.fromStatus,
      to_status: h.toStatus,
      effective_date: h.effectiveDate,
      reason: h.reason,
      details: h.details,
      actor_user_id: h.actorUserId,
      created_at: h.createdAt.toISOString(),
    }));
  }

  // ---- duplicates ------------------------------------------------------------------

  /**
   * V1 duplicate handling is a warning, never an automatic merge: same name +
   * date of birth, or same name + phone/email. The user decides.
   */
  async findDuplicates(
    ex: Executor,
    tenantId: string,
    p: {
      firstName: string;
      lastName: string;
      dateOfBirth?: string | null;
      phone?: string | null;
      email?: string | null;
    },
    excludeId?: string,
  ): Promise<DuplicateCandidate[]> {
    const sameName = and(
      sql`lower(${students.firstName}) = lower(${p.firstName})`,
      sql`lower(${students.lastName}) = lower(${p.lastName})`,
    );
    const signals: SQL[] = [];
    if (p.dateOfBirth) signals.push(sql`${students.dateOfBirth} = ${p.dateOfBirth}`);
    if (p.phone) signals.push(sql`${students.primaryPhone} = ${p.phone}`);
    if (p.email) signals.push(sql`lower(${students.primaryEmail}) = lower(${p.email})`);
    if (!signals.length) return [];
    const rows = await ex
      .select()
      .from(students)
      .where(
        and(
          eq(students.tenantId, tenantId),
          sameName,
          sql`(${sql.join(signals, sql` or `)})`,
          excludeId ? sql`${students.id} <> ${excludeId}` : undefined,
        ),
      )
      .limit(5);
    return rows.map((r) => ({
      id: r.id,
      student_number: r.studentNumber,
      full_name: fullName(r),
      date_of_birth: r.dateOfBirth,
      status: r.status,
      matched_on: [
        'name',
        ...(p.dateOfBirth && r.dateOfBirth === p.dateOfBirth ? ['date_of_birth'] : []),
        ...(p.phone && r.primaryPhone === p.phone ? ['phone'] : []),
        ...(p.email && r.primaryEmail?.toLowerCase() === p.email.toLowerCase() ? ['email'] : []),
      ],
    }));
  }

  assertNoUnconfirmedDuplicates(found: DuplicateCandidate[], confirmed?: boolean) {
    if (found.length && !confirmed)
      throw new ConflictError(
        'CONFIRMATION_REQUIRED',
        'A student with the same details already exists. Review and confirm to create anyway.',
        { duplicates: found },
      );
  }

  // ---- create / update -------------------------------------------------------------

  /** Insert a student row with a generated (or supplied) number. Caller owns the transaction. */
  async insertStudent(
    tx: Executor,
    tenantId: string,
    f: {
      student_number?: string;
      first_name: string;
      middle_name?: string | null;
      last_name: string;
      preferred_name?: string | null;
      date_of_birth?: string | null;
      gender?: StudentRow['gender'];
      primary_email?: string | null;
      primary_phone?: string | null;
      nationality?: string | null;
      address?: StudentRow['address'];
      notes?: string | null;
      blood_group?: StudentRow['bloodGroup'];
      house_id?: string | null;
      previous_school?: string | null;
      category?: string | null;
      admission_date?: string | null;
      admission_type?: StudentRow['admissionType'];
      government_id?: string | null;
    },
    status: StudentStatus,
    actor: Actor,
    extra: { admissionNumber?: string | null } = {},
  ): Promise<StudentRow> {
    const now = this.deps.clock.now();
    if (status === 'ADMITTED' || status === 'ACTIVE')
      await assertWithinPlanLimit(tx, tenantId, now, 'STUDENTS');
    const studentNumber = f.student_number ?? (await nextNumber(tx, tenantId, 'STU', now));
    await this.assertHouse(tx, tenantId, f.house_id);
    try {
      const [ins] = await tx
        .insert(students)
        .values({
          tenantId,
          studentNumber,
          admissionNumber: extra.admissionNumber ?? null,
          firstName: f.first_name,
          middleName: f.middle_name ?? null,
          lastName: f.last_name,
          preferredName: f.preferred_name ?? null,
          dateOfBirth: f.date_of_birth ?? null,
          gender: f.gender ?? 'UNDISCLOSED',
          status,
          primaryEmail: f.primary_email ?? null,
          primaryPhone: f.primary_phone ?? null,
          nationality: f.nationality ?? null,
          address: f.address ?? null,
          notes: f.notes ?? null,
          bloodGroup: f.blood_group ?? null,
          houseId: f.house_id ?? null,
          previousSchool: f.previous_school ?? null,
          category: f.category ?? null,
          admissionDate: f.admission_date ?? todayIso(this.deps.clock),
          admissionType: f.admission_type ?? 'NEW',
          ...this.governmentIdColumns(f.government_id),
          statusChangedAt: now,
          createdBy: actor.userId,
        })
        .$returningId();
      const [row] = await tx.select().from(students).where(eq(students.id, ins!.id));
      await addHistory(tx, actor, tenantId, row!.id, {
        eventType: 'STUDENT_CREATED',
        toStatus: status,
        effectiveDate: todayIso(this.deps.clock),
        details: {
          admission_type: row!.admissionType,
          admission_date: row!.admissionDate,
          admission_number: row!.admissionNumber,
        },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_CREATED',
        entityType: 'student',
        entityId: row!.id,
        event: 'student.created',
        after: presentStudent(row!),
        payload: { student_number: row!.studentNumber, status },
      });
      return row!;
    } catch (err) {
      if (isDuplicateKeyError(err)) throw this.duplicateNumberError(err, studentNumber);
      throw err;
    }
  }

  private duplicateNumberError(err: unknown, studentNumber: string) {
    const e = err as { message?: string; cause?: { message?: string; sqlMessage?: string } };
    const text = `${e?.cause?.sqlMessage ?? ''} ${e?.cause?.message ?? ''} ${e?.message ?? ''}`;
    return /admission/i.test(text)
      ? new ConflictError('DUPLICATE_RESOURCE', 'This admission number is already in use', {
          field: 'admission_number',
        })
      : new ConflictError(
          'DUPLICATE_RESOURCE',
          `Student number ${studentNumber} is already in use`,
          {
            field: 'student_number',
          },
        );
  }

  private get cryptoKey() {
    return this.deps.env.DATA_ENCRYPTION_KEY ?? this.deps.env.JWT_SECRET;
  }

  private governmentIdColumns(value: string | null | undefined) {
    if (value === undefined) return {};
    if (value === null) return { governmentIdEnc: null, governmentIdLast4: null };
    const clean = value.replace(/\s+/g, '');
    return {
      governmentIdEnc: encryptSecret(clean, this.cryptoKey),
      governmentIdLast4: clean.slice(-4),
    };
  }

  private async assertHouse(ex: Executor, tenantId: string, houseId: string | null | undefined) {
    if (!houseId) return;
    const [h] = await ex
      .select()
      .from(studentHouses)
      .where(and(eq(studentHouses.tenantId, tenantId), eq(studentHouses.id, houseId)));
    if (!h || !h.isActive)
      throw new ValidationError('House not found', [
        { field: 'house_id', message: 'Choose a house from the list' },
      ]);
  }

  /** How this school numbers admissions. No settings row means AUTO. */
  private async admissionNumberFor(tx: Executor, tenantId: string, supplied?: string) {
    const [s] = await tx
      .select()
      .from(studentSettings)
      .where(eq(studentSettings.tenantId, tenantId));
    if (s?.admissionNumberMode === 'MANUAL') {
      if (!supplied)
        throw new ValidationError('Admission number is required', [
          { field: 'admission_number', message: 'Enter the admission number' },
        ]);
      return supplied;
    }
    return nextNumber(tx, tenantId, 'ADM', this.deps.clock.now());
  }

  /** Full government ID, for people with students.government_id.read. Every view is audited. */
  async revealGovernmentId(tenantId: string, id: string, principal: Principal, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const s = await loadStudent(tx, tenantId, id, principal, 'students.government_id.read');
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_GOVERNMENT_ID_VIEWED',
        entityType: 'student',
        entityId: id,
      });
      return {
        government_id: s.governmentIdEnc ? decryptSecret(s.governmentIdEnc, this.cryptoKey) : null,
      };
    });
  }

  /**
   * Direct creation by an authorised admin: one transaction creates the
   * student, their guardians and (optionally) the enrollment. Without an
   * enrollment the student starts ADMITTED; with one they start ACTIVE.
   */
  /** Student + guardians + optional enrollment inside the caller's transaction. No duplicate check. */
  async createInTx(
    tx: Executor,
    tenantId: string,
    input: z.infer<typeof CreateStudentBody>,
    actor: Actor,
  ): Promise<string> {
    const admissionNumber = await this.admissionNumberFor(tx, tenantId, input.admission_number);
    const student = await this.insertStudent(tx, tenantId, input, 'ADMITTED', actor, {
      admissionNumber,
    });
    for (const g of input.guardians ?? [])
      await this.guardianSvc.linkInTx(tx, tenantId, student.id, g, actor);
    if (input.enrollment)
      await this.enrollmentSvc.enrollInTx(
        tx,
        tenantId,
        student,
        { ...input.enrollment, activate_student: true },
        actor,
      );
    return student.id;
  }

  async create(
    tenantId: string,
    input: z.infer<typeof CreateStudentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const id = await this.db.transaction(async (tx) => {
      const dups = await this.findDuplicates(tx, tenantId, {
        firstName: input.first_name,
        lastName: input.last_name,
        dateOfBirth: input.date_of_birth,
        phone: input.primary_phone,
        email: input.primary_email,
      });
      this.assertNoUnconfirmedDuplicates(dups, input.confirm_duplicate);
      return this.createInTx(tx, tenantId, input, actor);
    });
    return this.get(tenantId, id, principal);
  }

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateStudentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await loadStudent(tx, tenantId, id, principal, 'students.update', {
        lock: true,
      });
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'Archived students cannot be edited');
      const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      if (input.house_id !== undefined && input.house_id !== before.houseId)
        await this.assertHouse(tx, tenantId, input.house_id);
      const next = {
        ...this.governmentIdColumns(input.government_id),
        admissionNumber: input.admission_number ?? before.admissionNumber,
        bloodGroup: pick(input.blood_group, before.bloodGroup),
        houseId: pick(input.house_id, before.houseId),
        previousSchool: pick(input.previous_school, before.previousSchool),
        category: pick(input.category, before.category),
        admissionDate: pick(input.admission_date, before.admissionDate),
        admissionType: input.admission_type ?? before.admissionType,
        studentNumber: input.student_number ?? before.studentNumber,
        firstName: input.first_name ?? before.firstName,
        middleName: pick(input.middle_name, before.middleName),
        lastName: input.last_name ?? before.lastName,
        preferredName: pick(input.preferred_name, before.preferredName),
        dateOfBirth: pick(input.date_of_birth, before.dateOfBirth),
        gender: input.gender ?? before.gender,
        primaryEmail: pick(input.primary_email, before.primaryEmail),
        primaryPhone: pick(input.primary_phone, before.primaryPhone),
        nationality: pick(input.nationality, before.nationality),
        address: pick(input.address, before.address),
        notes: pick(input.notes, before.notes),
      };
      try {
        const [res] = await tx
          .update(students)
          .set({ ...next, version: before.version + 1 })
          .where(and(eq(students.id, id), eq(students.version, input.version)));
        if (res.affectedRows !== 1)
          throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      } catch (err) {
        if (isDuplicateKeyError(err)) throw this.duplicateNumberError(err, next.studentNumber);
        throw err;
      }
      const [after] = await tx.select().from(students).where(eq(students.id, id));
      const changed = Object.entries(presentStudent(after!))
        .filter(
          ([k, v]) =>
            !['version', 'updated_at', 'status_changed_at'].includes(k) &&
            JSON.stringify(v) !==
              JSON.stringify((presentStudent(before) as Record<string, unknown>)[k]),
        )
        .map(([k]) => k);
      await addHistory(tx, actor, tenantId, id, {
        eventType: 'STUDENT_UPDATED',
        details: { fields: changed },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_UPDATED',
        entityType: 'student',
        entityId: id,
        event: 'student.updated',
        before: presentStudent(before),
        after: presentStudent(after!),
        payload: { fields: changed },
      });
    });
    return this.get(tenantId, id, principal);
  }

  // ---- lifecycle commands ------------------------------------------------------------

  /** Lifecycle changes are explicit commands — never a free-form `status` edit. */
  async command(
    tenantId: string,
    id: string,
    command: StudentCommand,
    input: {
      reason?: string;
      effective_date?: string;
      remarks?: string;
      destination_school?: string;
    },
    principal: Principal,
    actor: Actor,
  ) {
    const rule = COMMANDS[command];
    const isExit = command === 'withdraw' || command === 'transfer';
    if ((input.remarks || input.destination_school) && !isExit)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Remarks and destination only apply to withdraw and transfer',
      );
    if (input.destination_school && command !== 'transfer')
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'A destination school only applies to a transfer',
        { field: 'destination_school' },
      );
    if (rule.reasonRequired && !input.reason)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'A reason is required', {
        field: 'reason',
      });
    await this.db.transaction(async (tx) => {
      const student = await loadStudent(tx, tenantId, id, principal, COMMAND_PERMISSION[command], {
        lock: true,
      });
      if (!rule.from.includes(student.status))
        throw new BusinessRuleError(
          'INVALID_STATE',
          `Cannot ${command} a student whose status is ${student.status.toLowerCase().replace('_', ' ')}`,
          { student_status: student.status, allowed_from: rule.from },
        );
      const effective = input.effective_date ?? todayIso(this.deps.clock);
      if (isExit && effective > todayIso(this.deps.clock))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The exit date cannot be in the future',
          {
            field: 'effective_date',
          },
        );
      if (command === 'activate') {
        const [open] = await tx
          .select({ n: count() })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(enrollments.studentId, id),
              inArray(enrollments.status, OPEN),
            ),
          );
        if (!open?.n)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Enroll the student in a class before activating',
          );
      }
      let closed = 0;
      if (command === 'transfer')
        closed = await this.enrollmentSvc.closeAllForStudent(
          tx,
          tenantId,
          id,
          'TRANSFERRED',
          effective,
          input.reason ?? null,
        );
      if (command === 'withdraw')
        closed = await this.enrollmentSvc.closeAllForStudent(
          tx,
          tenantId,
          id,
          'WITHDRAWN',
          effective,
          input.reason ?? null,
        );
      if (command === 'graduate')
        closed = await this.enrollmentSvc.closeAllForStudent(
          tx,
          tenantId,
          id,
          'COMPLETED',
          effective,
          input.reason ?? null,
        );
      await setStudentStatus(tx, actor, student, rule.to, {
        command,
        reason: input.reason ?? null,
        effectiveDate: effective,
        now: this.deps.clock.now(),
        details: isExit
          ? {
              remarks: input.remarks ?? null,
              destination_school: input.destination_school ?? null,
            }
          : null,
      });
      if (isExit) {
        const [ins] = await tx
          .insert(studentExits)
          .values({
            tenantId,
            studentId: id,
            kind: command === 'transfer' ? 'TRANSFERRED' : 'WITHDRAWN',
            exitDate: effective,
            reason: input.reason!,
            remarks: input.remarks ?? null,
            destinationSchool: input.destination_school ?? null,
            recordedBy: actor.userId,
          })
          .$returningId();
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_EXIT_RECORDED',
          entityType: 'student_exit',
          entityId: ins!.id,
          after: {
            kind: command,
            exit_date: effective,
            reason: input.reason,
            destination_school: input.destination_school ?? null,
          },
        });
      }
      if (command === 'reinstate')
        await tx
          .update(studentExits)
          .set({ reinstatedAt: this.deps.clock.now() })
          .where(
            and(
              eq(studentExits.tenantId, tenantId),
              eq(studentExits.studentId, id),
              isNull(studentExits.reinstatedAt),
            ),
          );
      const specific = { transfer: 'transferred', withdraw: 'withdrawn', graduate: 'graduated' }[
        command as 'transfer' | 'withdraw' | 'graduate'
      ];
      if (specific)
        await publishEvent(tx, actor, {
          tenantId,
          eventType: `student.${specific}`,
          aggregateType: 'student',
          aggregateId: id,
          payload: { student_id: id, effective_date: effective, enrollments_closed: closed },
        });
    });
    return this.get(tenantId, id, principal);
  }
}

function placement(r: {
  e: typeof enrollments.$inferSelect;
  yearCode: string;
  current: boolean;
  className: string;
  sectionName: string | null;
}) {
  return {
    id: r.e.id,
    academic_year: { id: r.e.academicYearId, code: r.yearCode, is_current: r.current },
    class: { id: r.e.classId, name: r.className },
    section: r.e.sectionId ? { id: r.e.sectionId, name: r.sectionName } : null,
    start_date: r.e.startDate,
  };
}

export type { PaginationQuery };

const CSV_HEADERS = [
  'Student number',
  'Admission number',
  'First name',
  'Middle name',
  'Last name',
  'Gender',
  'Date of birth',
  'Status',
  'Academic year',
  'Class',
  'Section',
  'Primary guardian',
  'Guardian phone',
  'Student phone',
  'Student email',
];

/** Spreadsheet formula injection guard + CSV quoting. */
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportStudentsCsv(
  svc: StudentService,
  deps: Deps,
  tenantId: string,
  q: z.infer<typeof StudentListQuery>,
  principal: Principal,
  actor: Actor,
): Promise<string> {
  const lines = [CSV_HEADERS.join(',')];
  const MAX = 10_000;
  for (let page = 1; lines.length <= MAX; page++) {
    const res = await svc.list(tenantId, { ...q, page, page_size: 100 }, principal);
    for (const s of res.data)
      lines.push(
        [
          s.student_number,
          s.admission_number,
          s.first_name,
          s.middle_name,
          s.last_name,
          s.gender,
          s.date_of_birth,
          s.status,
          s.current_enrollment?.academic_year.code,
          s.current_enrollment?.class.name,
          s.current_enrollment?.section?.name,
          s.primary_guardian?.full_name,
          s.primary_guardian?.phone,
          s.primary_phone,
          s.primary_email,
        ]
          .map(csvCell)
          .join(','),
      );
    if (res.data.length < 100) break;
  }
  await deps.db.transaction(async (tx) => {
    await recordChange(tx, actor, tenantId, {
      action: 'STUDENTS_EXPORTED',
      entityType: 'student',
      entityId: tenantId,
      event: 'student.exported',
      payload: { rows: lines.length - 1, filters: { ...q, page: undefined, page_size: undefined } },
    });
  });
  return lines.join('\n') + '\n';
}
