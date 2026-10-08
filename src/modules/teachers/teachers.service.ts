import { and, asc, count, desc, eq, isNotNull, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  TEACHER_LEAVING_STATUSES,
  teacherHistory,
  teachers,
  type TeacherStatus,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { encryptSecret } from '../../shared/crypto.js';
import { todayIso } from '../../shared/dates.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import type { MemberService } from '../members/members.service.js';
import { likeOf, nextNumber } from '../students/support.js';
import type { AssignmentService } from './assignments.service.js';
import type { ClassTeacherService } from './class-teachers.service.js';
import type { StaffLookupService } from './lookups.service.js';
import type { QualificationService } from './qualifications.service.js';
import {
  addTeacherHistory,
  fullName,
  loadTeacher,
  presentTeacher,
  setTeacherStatus,
  teacherScope,
  type TeacherRow,
  refreshTeacherAccess,
} from './support.js';
import type {
  CreateTeacherBody,
  PortalAccessBody,
  TeacherCommand,
  TeacherListQuery,
  UpdateTeacherBody,
} from './teachers.schemas.js';

/** Lifecycle rules: which command may run from which status, where it leads, what it needs. */
const COMMANDS: Record<
  TeacherCommand,
  {
    from: TeacherStatus[];
    to: TeacherStatus;
    reasonRequired: boolean;
    permission: string;
    /** resign / terminate carry an exit date and reason. */
    exit?: boolean;
  }
> = {
  onboard: {
    from: ['PROSPECTIVE'],
    to: 'ONBOARDING',
    reasonRequired: false,
    permission: 'teachers.update',
  },
  activate: {
    from: ['PROSPECTIVE', 'ONBOARDING', 'INACTIVE'],
    to: 'ACTIVE',
    reasonRequired: false,
    permission: 'teachers.update',
  },
  'start-leave': {
    from: ['ACTIVE'],
    to: 'ON_LEAVE',
    reasonRequired: false,
    permission: 'teachers.update',
  },
  'return-from-leave': {
    from: ['ON_LEAVE'],
    to: 'ACTIVE',
    reasonRequired: false,
    permission: 'teachers.update',
  },
  deactivate: {
    from: ['ACTIVE', 'ON_LEAVE'],
    to: 'INACTIVE',
    reasonRequired: true,
    permission: 'teachers.archive',
  },
  resign: {
    from: ['ACTIVE', 'ON_LEAVE', 'INACTIVE'],
    to: 'RESIGNED',
    reasonRequired: true,
    permission: 'teachers.archive',
    exit: true,
  },
  retire: {
    from: ['ACTIVE', 'ON_LEAVE', 'INACTIVE'],
    to: 'RETIRED',
    reasonRequired: false,
    permission: 'teachers.archive',
    exit: true,
  },
  terminate: {
    from: ['ACTIVE', 'ON_LEAVE', 'INACTIVE'],
    to: 'TERMINATED',
    reasonRequired: true,
    permission: 'teachers.archive',
    exit: true,
  },
  archive: {
    from: ['PROSPECTIVE', 'ONBOARDING', 'INACTIVE', 'RESIGNED', 'TERMINATED', 'RETIRED'],
    to: 'ARCHIVED',
    reasonRequired: false,
    permission: 'teachers.archive',
  },
  restore: {
    from: ['ARCHIVED'],
    to: 'INACTIVE',
    reasonRequired: false,
    permission: 'teachers.archive',
  },
};

/** Permission needed per command (teachers.archive is a sensitive permission). */
export const COMMAND_PERMISSION = Object.fromEntries(
  Object.entries(COMMANDS).map(([k, v]) => [k, v.permission]),
) as Record<TeacherCommand, string>;

export interface DuplicateCandidate {
  id: string;
  teacher_number: string;
  full_name: string;
  date_of_birth: string | null;
  status: TeacherStatus;
  matched_on: string[];
}

export interface Warning {
  code: string;
  message: string;
}

export class TeacherService {
  constructor(
    private readonly deps: Deps,
    private readonly members: MemberService,
    private readonly assignments: AssignmentService,
    private readonly qualifications: QualificationService,
    private readonly classTeachers: ClassTeacherService,
    private readonly lookups: StaffLookupService,
    private readonly calendar: CalendarService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- list ----------------------------------------------------------------------

  async list(tenantId: string, q: z.infer<typeof TeacherListQuery>, principal: Principal) {
    const conds: (SQL | undefined)[] = [
      eq(teachers.tenantId, tenantId),
      teacherScope(principal, 'teachers.read'),
    ];
    if (q.status) conds.push(eq(teachers.status, q.status));
    if (q.staff_type) conds.push(eq(teachers.staffType, q.staff_type));
    if (q.employment_type) conds.push(eq(teachers.employmentType, q.employment_type));
    if (q.department) conds.push(eq(teachers.department, q.department));
    if (q.has_login !== undefined)
      conds.push(q.has_login ? isNotNull(teachers.membershipId) : isNull(teachers.membershipId));
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(
        or(
          like(teachers.teacherNumber, s),
          like(teachers.firstName, s),
          like(teachers.lastName, s),
          like(teachers.email, s),
          like(teachers.phone, s),
          like(teachers.department, s),
          like(teachers.designation, s),
          sql`concat(${teachers.firstName}, ' ', ${teachers.lastName}) like ${s}`,
        ),
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(teachers)
        .where(where)
        .orderBy(
          orderFrom(
            { ...q, order: q.sort ? q.order : 'asc' },
            {
              name: teachers.lastName,
              first_name: teachers.firstName,
              teacher_number: teachers.teacherNumber,
              status: teachers.status,
              staff_type: teachers.staffType,
              department: teachers.department,
              joining_date: teachers.joiningDate,
              created_at: teachers.createdAt,
            },
            'name',
          ),
          asc(teachers.firstName),
          asc(teachers.id),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(teachers).where(where),
    ]);
    const counts = await this.assignments.activeCounts(
      tenantId,
      rows.map((r) => r.id),
    );
    return pageOf(
      rows.map((r) => ({ ...presentTeacher(r), active_assignment_count: counts.get(r.id) ?? 0 })),
      total?.n ?? 0,
      q,
    );
  }

  // ---- detail ----------------------------------------------------------------------

  async get(tenantId: string, id: string, principal: Principal, ex: Executor = this.db) {
    const t = await loadTeacher(ex, tenantId, id, principal, 'teachers.read');
    const [quals, active, portal] = await Promise.all([
      this.qualifications.forTeacher(tenantId, id, ex),
      this.assignments.activeForTeacher(tenantId, id, ex),
      this.portalAccess(tenantId, t, ex),
    ]);
    let manager: { id: string; full_name: string; teacher_number: string } | null = null;
    if (t.reportingManagerId) {
      const [m] = await ex
        .select()
        .from(teachers)
        .where(and(eq(teachers.tenantId, tenantId), eq(teachers.id, t.reportingManagerId)));
      if (m) manager = { id: m.id, full_name: fullName(m), teacher_number: m.teacherNumber };
    }
    return {
      ...presentTeacher(t),
      reporting_manager: manager,
      qualifications: quals,
      active_assignments: active,
      portal_access: portal,
    };
  }

  /** Login information for the profile. `status` is NONE when there is no linked login. */
  private async portalAccess(tenantId: string, t: TeacherRow, ex: Executor = this.db) {
    if (!t.membershipId)
      return {
        status: 'NONE' as const,
        membership_id: null,
        email: null,
        roles: [] as { role_id: string; code: string; name: string }[],
        invitation: null,
      };
    const m = await this.members.get(tenantId, t.membershipId, ex);
    return {
      status: m.status,
      membership_id: m.id,
      email: m.user.email,
      roles: m.roles.map((r) => ({ role_id: r.role_id, code: r.code, name: r.name })),
      invitation: m.invitation,
    };
  }

  async history(tenantId: string, id: string, principal: Principal) {
    await loadTeacher(this.db, tenantId, id, principal, 'teachers.read');
    const rows = await this.db
      .select()
      .from(teacherHistory)
      .where(and(eq(teacherHistory.tenantId, tenantId), eq(teacherHistory.teacherId, id)))
      .orderBy(desc(teacherHistory.createdAt), desc(teacherHistory.id))
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
   * Duplicate handling is a warning, never an automatic merge: same email, same
   * phone, or same name + date of birth. The user decides.
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
    const signals: SQL[] = [];
    if (p.email) signals.push(sql`lower(${teachers.email}) = lower(${p.email})`);
    if (p.phone) signals.push(sql`${teachers.phone} = ${p.phone}`);
    if (p.dateOfBirth)
      signals.push(
        sql`(lower(${teachers.firstName}) = lower(${p.firstName}) and lower(${teachers.lastName}) = lower(${p.lastName}) and ${teachers.dateOfBirth} = ${p.dateOfBirth})`,
      );
    if (!signals.length) return [];
    const rows = await ex
      .select()
      .from(teachers)
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          sql`(${sql.join(signals, sql` or `)})`,
          excludeId ? sql`${teachers.id} <> ${excludeId}` : undefined,
        ),
      )
      .limit(5);
    return rows.map((r) => ({
      id: r.id,
      teacher_number: r.teacherNumber,
      full_name: fullName(r),
      date_of_birth: r.dateOfBirth,
      status: r.status,
      matched_on: [
        ...(p.email && r.email?.toLowerCase() === p.email.toLowerCase() ? ['email'] : []),
        ...(p.phone && r.phone === p.phone ? ['phone'] : []),
        ...(p.dateOfBirth &&
        r.dateOfBirth === p.dateOfBirth &&
        r.firstName.toLowerCase() === p.firstName.toLowerCase() &&
        r.lastName.toLowerCase() === p.lastName.toLowerCase()
          ? ['name_and_date_of_birth']
          : []),
      ],
    }));
  }

  private get cryptoKey() {
    return this.deps.env.DATA_ENCRYPTION_KEY ?? this.deps.env.JWT_SECRET;
  }

  private idNumberColumns(value: string | null | undefined) {
    if (value === undefined) return {};
    if (value === null) return { idNumberEnc: null, idNumberLast4: null };
    const clean = value.replace(/\s+/g, '');
    return {
      idNumberEnc: encryptSecret(clean, this.cryptoKey),
      idNumberLast4: clean.slice(-4),
    };
  }

  /** The manager must be another staff member of this school, and the chain must not loop back. */
  private async assertManager(
    ex: Executor,
    tenantId: string,
    teacherId: string | null,
    managerId: string | null | undefined,
  ) {
    if (!managerId) return;
    if (managerId === teacherId)
      throw new ValidationError('A staff member cannot report to themselves', [
        { field: 'reporting_manager_id', message: 'Choose someone else' },
      ]);
    let cursor: string | null = managerId;
    for (let depth = 0; cursor && depth < 20; depth++) {
      const [row] = await ex
        .select({ id: teachers.id, manager: teachers.reportingManagerId, status: teachers.status })
        .from(teachers)
        .where(and(eq(teachers.tenantId, tenantId), eq(teachers.id, cursor)));
      if (!row)
        throw new ValidationError('Reporting manager not found', [
          { field: 'reporting_manager_id', message: 'This person is not in your school' },
        ]);
      if (depth === 0 && row.status === 'ARCHIVED')
        throw new ValidationError('Reporting manager is archived', [
          { field: 'reporting_manager_id', message: 'Choose an active staff member' },
        ]);
      if (teacherId && row.manager === teacherId)
        throw new ValidationError('That would create a reporting loop', [
          { field: 'reporting_manager_id', message: 'This person already reports to them' },
        ]);
      cursor = row.manager;
    }
  }

  // ---- create / update -------------------------------------------------------------

  async create(
    tenantId: string,
    input: z.infer<typeof CreateTeacherBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const id = await this.db.transaction((tx) => this.insertInTx(tx, tenantId, input, actor));
    return this.get(tenantId, id, principal);
  }

  /** The whole create, inside the caller's transaction (also used by the bulk import). */
  async insertInTx(
    tx: Executor,
    tenantId: string,
    input: z.infer<typeof CreateTeacherBody>,
    actor: Actor,
  ): Promise<string> {
    await this.lookups.assertAllowed(tx, tenantId, 'DEPARTMENT', input.department);
    await this.lookups.assertAllowed(tx, tenantId, 'DESIGNATION', input.designation);
    await this.assertManager(tx, tenantId, null, input.reporting_manager_id);
    const dups = await this.findDuplicates(tx, tenantId, {
      firstName: input.first_name,
      lastName: input.last_name,
      dateOfBirth: input.date_of_birth,
      phone: input.phone,
      email: input.email,
    });
    if (dups.length && !input.confirm_duplicate)
      throw new ConflictError(
        'CONFIRMATION_REQUIRED',
        'A teacher or staff member with the same details already exists. Review and confirm to create anyway.',
        { duplicates: dups },
      );
    const now = this.deps.clock.now();
    const teacherNumber = input.teacher_number ?? (await nextNumber(tx, tenantId, 'TCH', now));
    let newId: string;
    try {
      const [ins] = await tx
        .insert(teachers)
        .values({
          tenantId,
          teacherNumber,
          staffType: input.staff_type ?? 'TEACHING',
          status: input.status,
          firstName: input.first_name,
          middleName: input.middle_name ?? null,
          lastName: input.last_name,
          preferredName: input.preferred_name ?? null,
          dateOfBirth: input.date_of_birth ?? null,
          gender: input.gender ?? 'UNDISCLOSED',
          email: input.email ?? null,
          phone: input.phone ?? null,
          address: input.address ?? null,
          joiningDate: input.joining_date ?? null,
          employmentType: input.employment_type ?? 'FULL_TIME',
          department: input.department ?? null,
          designation: input.designation ?? null,
          emergencyContactName: input.emergency_contact_name ?? null,
          emergencyContactPhone: input.emergency_contact_phone ?? null,
          emergencyContactRelation: input.emergency_contact_relation ?? null,
          reportingManagerId: input.reporting_manager_id ?? null,
          ...this.idNumberColumns(input.id_number),
          notes: input.notes ?? null,
          statusChangedAt: now,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .$returningId();
      newId = ins!.id;
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          `Teacher number ${teacherNumber} is already in use`,
          { field: 'teacher_number' },
        );
      throw err;
    }
    const [row] = await tx.select().from(teachers).where(eq(teachers.id, newId));
    await addTeacherHistory(tx, actor, tenantId, newId, {
      eventType: 'TEACHER_CREATED',
      toStatus: input.status,
      effectiveDate: todayIso(this.deps.clock),
    });
    await recordChange(tx, actor, tenantId, {
      action: 'TEACHER_CREATED',
      entityType: 'teacher',
      entityId: newId,
      event: 'teacher.created',
      after: presentTeacher(row!),
      payload: {
        teacher_number: row!.teacherNumber,
        staff_type: row!.staffType,
        status: input.status,
      },
    });
    if (input.qualifications?.length)
      await this.qualifications.insertInTx(tx, tenantId, newId, input.qualifications, actor);
    return newId;
  }

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateTeacherBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await loadTeacher(tx, tenantId, id, principal, 'teachers.update', {
        lock: true,
      });
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'Archived teachers cannot be edited');
      const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      await this.lookups.assertAllowed(
        tx,
        tenantId,
        'DEPARTMENT',
        input.department,
        before.department,
      );
      await this.lookups.assertAllowed(
        tx,
        tenantId,
        'DESIGNATION',
        input.designation,
        before.designation,
      );
      if (
        input.reporting_manager_id !== undefined &&
        input.reporting_manager_id !== before.reportingManagerId
      )
        await this.assertManager(tx, tenantId, id, input.reporting_manager_id);
      const next = {
        ...this.idNumberColumns(input.id_number),
        emergencyContactName: pick(input.emergency_contact_name, before.emergencyContactName),
        emergencyContactPhone: pick(input.emergency_contact_phone, before.emergencyContactPhone),
        emergencyContactRelation: pick(
          input.emergency_contact_relation,
          before.emergencyContactRelation,
        ),
        reportingManagerId: pick(input.reporting_manager_id, before.reportingManagerId),
        teacherNumber: input.teacher_number ?? before.teacherNumber,
        staffType: input.staff_type ?? before.staffType,
        firstName: input.first_name ?? before.firstName,
        middleName: pick(input.middle_name, before.middleName),
        lastName: input.last_name ?? before.lastName,
        preferredName: pick(input.preferred_name, before.preferredName),
        dateOfBirth: pick(input.date_of_birth, before.dateOfBirth),
        gender: input.gender ?? before.gender,
        email: pick(input.email, before.email),
        phone: pick(input.phone, before.phone),
        address: pick(input.address, before.address),
        joiningDate: pick(input.joining_date, before.joiningDate),
        employmentType: input.employment_type ?? before.employmentType,
        department: pick(input.department, before.department),
        designation: pick(input.designation, before.designation),
        notes: pick(input.notes, before.notes),
      };
      try {
        const [res] = await tx
          .update(teachers)
          .set({ ...next, version: before.version + 1, updatedBy: actor.userId })
          .where(and(eq(teachers.id, id), eq(teachers.version, input.version)));
        if (res.affectedRows !== 1)
          throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            `Teacher number ${next.teacherNumber} is already in use`,
            { field: 'teacher_number' },
          );
        throw err;
      }
      const [after] = await tx.select().from(teachers).where(eq(teachers.id, id));
      const was = presentTeacher(before) as Record<string, unknown>;
      const changed = Object.entries(presentTeacher(after!))
        .filter(
          ([k, v]) =>
            !['version', 'updated_at', 'status_changed_at'].includes(k) &&
            JSON.stringify(v) !== JSON.stringify(was[k]),
        )
        .map(([k]) => k);
      await addTeacherHistory(tx, actor, tenantId, id, {
        eventType: 'TEACHER_UPDATED',
        details: { fields: changed },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_UPDATED',
        entityType: 'teacher',
        entityId: id,
        event: 'teacher.updated',
        before: presentTeacher(before),
        after: presentTeacher(after!),
        payload: { fields: changed },
      });
    });
    return this.get(tenantId, id, principal);
  }

  // ---- lifecycle commands ------------------------------------------------------------

  /**
   * Lifecycle changes are explicit commands — never a free-form `status` edit.
   * Leaving statuses (INACTIVE, RESIGNED, RETIRED, TERMINATED, ARCHIVED) end every open
   * assignment in the same transaction. After commit, and never failing the
   * command, the linked login is suspended (see restrictAccess). Returning to
   * work does NOT reinstate the login: access is restored explicitly.
   */
  async command(
    tenantId: string,
    id: string,
    command: TeacherCommand,
    input: { reason?: string; effective_date?: string; exit_date?: string; leave_end_date?: string },
    principal: Principal,
    actor: Actor,
  ) {
    const rule = COMMANDS[command];
    if (rule.reasonRequired && !input.reason)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'A reason is required', {
        field: 'reason',
      });
    if (input.exit_date && !rule.exit)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'An exit date only applies to resign, retire and terminate',
        { field: 'exit_date' },
      );
    if (input.leave_end_date && command !== 'start-leave')
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'A leave end date only applies to start leave',
        { field: 'leave_end_date' },
      );
    const today = todayIso(this.deps.clock);
    let leftMembership: string | null = null;
    await this.db.transaction(async (tx) => {
      const teacher = await loadTeacher(tx, tenantId, id, principal, rule.permission, {
        lock: true,
      });
      if (!rule.from.includes(teacher.status))
        throw new BusinessRuleError(
          'INVALID_STATE',
          `Cannot ${command} a teacher whose status is ${teacher.status.toLowerCase().replace('_', ' ')}`,
          { teacher_status: teacher.status, allowed_from: rule.from },
        );
      const effective = input.effective_date ?? today;
      let leave: Record<string, unknown> | null = null;
      if (command === 'start-leave') {
        const to = input.leave_end_date ?? effective;
        if (effective > today)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Leave must start today or earlier',
            { field: 'effective_date' },
          );
        if (to < effective)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'The leave end date cannot be before the start date',
            { field: 'leave_end_date' },
          );
        // Weekly off days and school holidays are not counted as leave.
        const days = (await this.calendar.workingDays(tenantId, effective, to, { kind: 'staff' }, tx))
          .working_days;
        if (days === 0)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Every selected day is a weekly off day or a school holiday',
            { field: 'leave_end_date' },
          );
        leave = { leave_from: effective, leave_to: to, leave_days: days };
      }
      let exit: { date: string; reason: string } | 'clear' | undefined;
      if (rule.exit) {
        const date = input.exit_date ?? today;
        if (date > today)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'The exit date cannot be in the future',
            {
              field: 'exit_date',
            },
          );
        if (teacher.joiningDate && date < teacher.joiningDate)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'The exit date cannot be before the joining date',
            { field: 'exit_date', joining_date: teacher.joiningDate },
          );
        exit = { date, reason: input.reason ?? 'Retired' };
      } else if (command === 'activate') {
        exit = 'clear'; // re-activating a restored former employee: the history keeps the old exit
      }
      let ended = 0;
      if (TEACHER_LEAVING_STATUSES.includes(rule.to) || rule.exit) {
        ended = await this.assignments.closeAllForTeacher(tx, actor, teacher, {
          endDate: exit && exit !== 'clear' ? exit.date : effective,
          today,
          reason: input.reason ?? `Teacher ${rule.to.toLowerCase()}`,
        });
        await this.classTeachers.endAllFor(
          tx,
          tenantId,
          teacher.id,
          input.reason ?? `Teacher ${rule.to.toLowerCase()}`,
          actor,
        );
        if (teacher.membershipId) leftMembership = teacher.membershipId;
      }
      await setTeacherStatus(tx, actor, teacher, rule.to, {
        command,
        reason: input.reason ?? null,
        effectiveDate: effective,
        now: this.deps.clock.now(),
        exit,
        assignmentsEnded: ended,
        details: leave,
      });
    });

    await refreshTeacherAccess(this.deps, tenantId);
    const warnings: Warning[] = [];
    if (leftMembership) {
      const w = await this.restrictAccess(
        tenantId,
        id,
        leftMembership,
        `Teacher ${COMMANDS[command].to.toLowerCase()}${input.reason ? `: ${input.reason}` : ''}`,
        principal,
        actor,
      );
      if (w) warnings.push(w);
    }
    return { teacher: await this.get(tenantId, id, principal), warnings };
  }

  /**
   * Best effort, after commit: a departed teacher's login is suspended (or, if
   * the invitation was never accepted, revoked). Failure — e.g. the caller may
   * not manage the login's roles, or it is their own — is logged and reported
   * as a warning; the lifecycle change stands.
   */
  private async restrictAccess(
    tenantId: string,
    teacherId: string,
    membershipId: string,
    reason: string,
    principal: Principal,
    actor: Actor,
  ): Promise<Warning | null> {
    const why = reason.slice(0, 500);
    try {
      const m = await this.members.get(tenantId, membershipId);
      if (m.status === 'ACTIVE')
        await this.members.setStatus(tenantId, membershipId, 'SUSPENDED', why, principal, actor);
      else if (m.status === 'INVITED') {
        await this.members.revoke(tenantId, membershipId, why, principal, actor);
        await this.unlink(tenantId, teacherId, membershipId, why, actor);
      }
      return null;
    } catch (err) {
      this.deps.log.warn(
        { err, tenant_id: tenantId, teacher_id: teacherId, membership_id: membershipId },
        'could not suspend the login of a departed teacher',
      );
      return {
        code: 'PORTAL_ACCESS_NOT_SUSPENDED',
        message:
          'The teacher was updated, but their login could not be suspended automatically. Suspend it from Users.',
      };
    }
  }

  // ---- portal access -------------------------------------------------------------------

  /**
   * Give a teacher a login: invite through the members service (so the
   * anti-escalation rules apply) and link the membership. The teacher record
   * is never invalidated by an invitation failure.
   */
  async invitePortalAccess(
    tenantId: string,
    id: string,
    input: z.infer<typeof PortalAccessBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const t = await loadTeacher(this.db, tenantId, id, principal, 'teachers.portal.manage');
    if (TEACHER_LEAVING_STATUSES.includes(t.status))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Portal access cannot be given to a teacher who has left',
        { teacher_status: t.status },
      );
    if (t.membershipId) {
      const existing = await this.members.get(tenantId, t.membershipId);
      if (existing.status !== 'REVOKED')
        throw new ConflictError('DUPLICATE_RESOURCE', 'This teacher already has portal access', {
          membership_id: t.membershipId,
        });
    }
    const email = input.email ?? t.email;
    if (!email)
      throw new ValidationError('The request is invalid', {
        location: 'body',
        issues: [
          {
            path: 'email',
            code: 'required',
            message: 'This teacher has no email address. Provide one for the invitation.',
          },
        ],
      });
    const member = await this.members.invite(
      tenantId,
      {
        email,
        firstName: t.preferredName ?? t.firstName,
        lastName: t.lastName,
        // A teacher's login sees only the sections they are assigned to, unless the
        // school explicitly gives the role school-wide scope.
        assignments: [
          input.scope === 'ALL'
            ? { roleId: input.role_id }
            : { roleId: input.role_id, scopeType: 'ASSIGNED_SECTION' as const },
        ],
      },
      principal,
      actor,
    );
    try {
      await this.db.transaction(async (tx) => {
        const teacher = await loadTeacher(tx, tenantId, id, principal, 'teachers.portal.manage', {
          lock: true,
        });
        if (teacher.membershipId && teacher.membershipId !== member.id)
          await this.assertRevoked(tx, tenantId, teacher.membershipId);
        await tx
          .update(teachers)
          .set({ membershipId: member.id, version: teacher.version + 1, updatedBy: actor.userId })
          .where(eq(teachers.id, id));
        await addTeacherHistory(tx, actor, tenantId, id, {
          eventType: 'PORTAL_ACCESS_INVITED',
          details: { membership_id: member.id, role_ids: [input.role_id] },
        });
        await recordChange(tx, actor, tenantId, {
          action: 'TEACHER_PORTAL_ACCESS_INVITED',
          entityType: 'teacher',
          entityId: id,
          event: 'teacher.portal_access_invited',
          before: { membership_id: teacher.membershipId },
          after: { membership_id: member.id },
          payload: { membership_id: member.id, role_id: input.role_id },
        });
      });
    } catch (err) {
      // The invitation exists but could not be linked (e.g. the membership is
      // already linked to someone else). Leave it visible in Users for an admin.
      this.deps.log.error(
        { err, tenant_id: tenantId, teacher_id: id, membership_id: member.id },
        'teacher portal invitation could not be linked',
      );
      if (isDuplicateKeyError(err))
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'That login is already linked to another teacher',
          { membership_id: member.id },
        );
      throw err;
    }
    await refreshTeacherAccess(this.deps, tenantId);
    return this.get(tenantId, id, principal);
  }

  private async assertRevoked(tx: Executor, tenantId: string, membershipId: string) {
    const m = await this.members.get(tenantId, membershipId, tx).catch(() => null);
    if (m && m.status !== 'REVOKED')
      throw new ConflictError('DUPLICATE_RESOURCE', 'This teacher already has portal access', {
        membership_id: membershipId,
      });
  }

  /** Remove the login (revoke the membership) and clear the link. The teacher is unchanged. */
  async revokePortalAccess(
    tenantId: string,
    id: string,
    reason: string | undefined,
    principal: Principal,
    actor: Actor,
  ) {
    const t = await loadTeacher(this.db, tenantId, id, principal, 'teachers.portal.manage');
    if (!t.membershipId) throw new NotFoundError('Portal access');
    const why = reason ?? 'Teacher portal access removed';
    const m = await this.members.get(tenantId, t.membershipId);
    if (m.status !== 'REVOKED')
      await this.members.revoke(tenantId, t.membershipId, why, principal, actor);
    await this.unlink(tenantId, id, t.membershipId, why, actor);
    await refreshTeacherAccess(this.deps, tenantId);
    return this.get(tenantId, id, principal);
  }

  /** Clear the teacher → membership link (only if it still points at `membershipId`). */
  private async unlink(
    tenantId: string,
    teacherId: string,
    membershipId: string,
    reason: string,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(teachers)
        .where(and(eq(teachers.id, teacherId), eq(teachers.tenantId, tenantId)))
        .for('update');
      if (!t || t.membershipId !== membershipId) return;
      await tx
        .update(teachers)
        .set({ membershipId: null, version: t.version + 1, updatedBy: actor.userId })
        .where(eq(teachers.id, teacherId));
      await addTeacherHistory(tx, actor, tenantId, teacherId, {
        eventType: 'PORTAL_ACCESS_REVOKED',
        reason,
        details: { membership_id: membershipId },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_PORTAL_ACCESS_REVOKED',
        entityType: 'teacher',
        entityId: teacherId,
        event: 'teacher.portal_access_revoked',
        before: { membership_id: membershipId },
        after: { membership_id: null },
        reason,
        payload: { membership_id: membershipId },
      });
    });
  }
}

// ---- CSV export ------------------------------------------------------------------------

const CSV_HEADERS = [
  'Teacher number',
  'Staff type',
  'First name',
  'Middle name',
  'Last name',
  'Gender',
  'Status',
  'Employment type',
  'Department',
  'Designation',
  'Joining date',
  'Exit date',
  'Email',
  'Phone',
  'Has login',
  'Active assignments',
];

/** Spreadsheet formula injection guard + CSV quoting. */
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportTeachersCsv(
  svc: TeacherService,
  deps: Deps,
  tenantId: string,
  q: z.infer<typeof TeacherListQuery>,
  principal: Principal,
  actor: Actor,
): Promise<string> {
  const lines = [CSV_HEADERS.join(',')];
  const MAX = 10_000;
  for (let page = 1; lines.length <= MAX; page++) {
    const res = await svc.list(tenantId, { ...q, page, page_size: 100 }, principal);
    for (const t of res.data)
      lines.push(
        [
          t.teacher_number,
          t.staff_type,
          t.first_name,
          t.middle_name,
          t.last_name,
          t.gender,
          t.status,
          t.employment_type,
          t.department,
          t.designation,
          t.joining_date,
          t.exit_date,
          t.email,
          t.phone,
          t.has_login ? 'yes' : 'no',
          t.active_assignment_count,
        ]
          .map(csvCell)
          .join(','),
      );
    if (res.data.length < 100) break;
  }
  await deps.db.transaction(async (tx) => {
    await recordChange(tx, actor, tenantId, {
      action: 'TEACHERS_EXPORTED',
      entityType: 'teacher',
      entityId: tenantId,
      event: 'teacher.exported',
      payload: { rows: lines.length - 1, filters: { ...q, page: undefined, page_size: undefined } },
    });
  });
  return lines.join('\n') + '\n';
}

