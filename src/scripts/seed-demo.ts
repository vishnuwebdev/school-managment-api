import 'dotenv/config';
import request from 'supertest';
import { closeDeps, createDeps } from '../bootstrap.js';
import { loadEnv } from '../config/env.js';
import { createApp } from '../app.js';
import { processEvent, relayOutbox } from '../events/processor.js';
import { MemoryMailer } from '../infrastructure/mail/mailer.js';
import { buildServices } from '../services.js';

/**
 * Demo data for local development: schools in every lifecycle state, school
 * admins and staff, a custom role, platform staff and onboarding requests.
 *
 * Everything goes through the real API (same rules, audit rows and events as
 * production), so what you see in the admin panel is what the system produces.
 * Safe to run again: schools that already exist are skipped.
 *
 * Run it with the worker STOPPED, or invitation links can be picked up by the
 * worker (they would then only appear in the worker log).
 */
if (process.env.NODE_ENV === 'production') throw new Error('Demo data is for development only');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo#Pass2026';
const SUPER_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const SUPER_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe!12345';

process.env.LOG_LEVEL = 'error'; // keep the output readable
const mailer = new MemoryMailer();
// In-process app only (not the running API): "test" mode lifts the 10/min sign-in limit and silences request logs.
const deps = createDeps({ env: { ...loadEnv(), NODE_ENV: 'test' }, mailer });
const svc = buildServices(deps);
const http = request(createApp(deps, svc));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  token: string | null,
  body?: object,
): Promise<{ status: number; body: Json }> {
  const req = http[method](`/api/v1${path}`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await (method === 'get' ? req : req.send(body ?? {}));
  return { status: res.status, body: res.body as Json };
}

async function ok(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  token: string | null,
  body?: object,
) {
  const res = await call(method, path, token, body);
  if (res.status >= 300)
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as Json;
}

async function login(email: string, password: string) {
  const data = await ok('post', '/auth/login', null, { email, password });
  return data.access_token as string;
}

async function drain() {
  for (let i = 0; i < 20; i++) {
    const n = await relayOutbox(deps, (event) => processEvent(deps, event.id));
    if (n === 0) return;
  }
}

/** Accept the newest invitation sent to `email`; returns false if its link was not captured. */
async function accept(email: string): Promise<boolean> {
  await drain();
  const msg = [...mailer.sent]
    .reverse()
    .find((m) => m.to === email.toLowerCase() && m.template === 'invitation');
  if (!msg) return false;
  const res = await call('post', '/auth/invitations/accept', null, {
    token: String(msg.data.token),
    password: DEMO_PASSWORD,
  });
  return res.status < 300;
}

const created: string[] = [];
const skipped: string[] = [];
const warnings: string[] = [];
const accounts: { email: string; role: string; where: string }[] = [];

async function main() {
  const root = await login(SUPER_EMAIL, SUPER_PASSWORD);

  // ---- platform reference data
  const platformRoles = (await ok('get', '/platform/roles', root)) as unknown as Json[];
  const prole = (code: string) => platformRoles.find((r) => r.code === code)?.id as string;

  // ---- platform staff
  const staff = [
    {
      email: 'support@example.com',
      first_name: 'Sara',
      last_name: 'Support',
      role: 'SUPPORT_ADMIN',
    },
    {
      email: 'billing@example.com',
      first_name: 'Ben',
      last_name: 'Billing',
      role: 'BILLING_ADMIN',
    },
    { email: 'sales@example.com', first_name: 'Sam', last_name: 'Sales', role: 'SALES_ADMIN' },
  ];
  const existingUsers = (await ok(
    'get',
    '/platform/users?page_size=100',
    root,
  )) as unknown as Json[];
  const haveUser = new Set(
    existingUsers.map((u) => String(u.email ?? u.user?.email).toLowerCase()),
  );
  for (const s of staff) {
    if (haveUser.has(s.email)) {
      skipped.push(`platform user ${s.email}`);
      continue;
    }
    await ok('post', '/platform/users/invitations', root, {
      email: s.email,
      first_name: s.first_name,
      last_name: s.last_name,
      roles: [{ role_id: prole(s.role), scope_type: 'ALL_TENANTS' }],
    });
    if (await accept(s.email)) {
      created.push(`platform user ${s.email} (${s.role})`);
      accounts.push({ email: s.email, role: s.role, where: 'Platform' });
    } else warnings.push(`invitation link for ${s.email} is in the worker log`);
  }

  // ---- schools
  const schools = [
    {
      code: 'green-valley-public',
      name: 'Green Valley Public School',
      type: 'CBSE',
      city: 'Pune',
      state: 'Maharashtra',
      plan: 'PREMIUM',
      trial: 0,
      admin: ['principal.gv@example.com', 'Meera', 'Kulkarni'] as const,
      staff: true,
      customRole: true,
    },
    {
      code: 'sunrise-international',
      name: 'Sunrise International School',
      type: 'ICSE',
      city: 'Bengaluru',
      state: 'Karnataka',
      plan: 'STANDARD',
      trial: 0,
      admin: ['admin.sunrise@example.com', 'Arjun', 'Rao'] as const,
      staff: true,
    },
    {
      code: 'lakeside-academy',
      name: 'Lakeside Academy',
      type: 'State Board',
      city: 'Hyderabad',
      state: 'Telangana',
      plan: 'STARTER',
      trial: 14,
      admin: ['admin.lakeside@example.com', 'Nisha', 'Reddy'] as const,
      staff: false,
    },
    {
      code: 'oakridge-high',
      name: 'Oakridge High School',
      type: 'CBSE',
      city: 'Delhi',
      state: 'Delhi',
      plan: 'STANDARD',
      trial: 14,
      admin: ['admin.oakridge@example.com', 'Vikram', 'Singh'] as const,
      staff: false,
      suspend: true,
    },
    {
      code: 'riverdale-school',
      name: 'Riverdale School',
      type: 'IB',
      city: 'Chennai',
      state: 'Tamil Nadu',
      plan: 'PREMIUM',
      trial: 30,
      admin: ['admin.riverdale@example.com', 'Priya', 'Nair'] as const,
      staff: false,
    },
    {
      code: 'maple-leaf-kids',
      name: 'Maple Leaf Kids Academy',
      type: 'Pre-primary',
      city: 'Jaipur',
      state: 'Rajasthan',
      plan: 'STARTER',
      trial: 14,
      admin: ['admin.mapleleaf@example.com', 'Kavya', 'Sharma'] as const,
      staff: false,
      archive: true,
    },
  ];
  // "Approved but not provisioned yet" – shows the Provision action.
  const pendingSchool = {
    code: 'harmony-central',
    name: 'Harmony Central School',
    city: 'Kolkata',
    state: 'West Bengal',
  };

  const existing = (await ok('get', '/platform/tenants?page_size=100', root)) as unknown as Json[];
  const haveCode = new Set(existing.map((t) => String(t.code)));

  const teachers = [
    ['ROLE:PRINCIPAL', 'Ananya', 'Iyer'],
    ['ROLE:ACCOUNTANT', 'Rohit', 'Mehta'],
    ['ROLE:TEACHER', 'Divya', 'Menon'],
    ['ROLE:TEACHER', 'Karan', 'Joshi'],
    ['ROLE:RECEPTIONIST', 'Pooja', 'Desai'],
  ] as const;

  for (const s of schools) {
    if (haveCode.has(s.code)) {
      skipped.push(`school ${s.code}`);
      continue;
    }
    const tenant = await ok('post', '/platform/tenants', root, {
      code: s.code,
      name: s.name,
      school_type: s.type,
      contact_email: `office@${s.code}.example.com`,
      contact_phone: '+91 98765 43210',
      address: {
        line1: '12 Main Road',
        city: s.city,
        state: s.state,
        postal_code: '400001',
        country: 'IN',
      },
    });
    const tenantId = tenant.id as string;
    await ok('post', `/platform/tenants/${tenantId}/provision`, root, {
      plan_code: s.plan,
      trial_days: s.trial,
      billing_interval: 'ANNUAL',
      admin: { email: s.admin[0], first_name: s.admin[1], last_name: s.admin[2] },
    });
    const accepted = await accept(s.admin[0]);
    if (!accepted) {
      warnings.push(`${s.code}: admin invitation link is in the worker log (${s.admin[0]})`);
    } else {
      accounts.push({ email: s.admin[0], role: 'SCHOOL_ADMIN', where: s.name });
      const adminToken = await login(s.admin[0], DEMO_PASSWORD);
      const roleList = (await ok('get', '/roles', adminToken)) as unknown as Json[];
      const rid = (code: string) => roleList.find((r) => r.code === code)?.id as string;

      if (s.staff) {
        for (const [i, [tag, first, last]] of teachers.entries()) {
          const roleCode = tag.replace('ROLE:', '');
          const email = `${first}.${last}.${s.code.split('-')[0]}@example.com`.toLowerCase();
          const invited = await ok('post', '/members/invitations', adminToken, {
            email,
            first_name: first,
            last_name: last,
            roles: [{ role_id: rid(roleCode) }],
          });
          if (i < 4) {
            if (await accept(email)) accounts.push({ email, role: roleCode, where: s.name });
            else warnings.push(`${s.code}: link for ${email} is in the worker log`);
          }
          // last one stays "invited, not yet accepted"; one accepted user gets suspended
          if (i === 3) {
            const list = (await ok(
              'get',
              '/members?page_size=100',
              adminToken,
            )) as unknown as Json[];
            const m = list.find((x) => String(x.email ?? x.user?.email).toLowerCase() === email);
            if (m)
              await ok('post', `/members/${m.id}/suspend`, adminToken, {
                reason: 'Demo: on extended leave',
              });
          }
          void invited;
        }
      }

      if (s.customRole) {
        const sub = await ok('post', '/roles', adminToken, {
          code: 'SUB_ADMIN',
          name: 'Sub Admin',
          description: 'Can view users, roles and the school profile, but not change them.',
          permissions: ['members.read', 'roles.read', 'tenant.profile.read'].filter(Boolean),
        }).catch((e: Error) => {
          warnings.push(`custom role skipped: ${e.message.slice(0, 160)}`);
          return null;
        });
        if (sub) {
          const email = `subadmin.${s.code.split('-')[0]}@example.com`;
          await ok('post', '/members/invitations', adminToken, {
            email,
            first_name: 'Sub',
            last_name: 'Admin',
            roles: [{ role_id: sub.id }],
          });
          if (await accept(email))
            accounts.push({ email, role: 'SUB_ADMIN (custom)', where: s.name });
        }
      }
    }

    if (s.suspend)
      await ok('post', `/platform/tenants/${tenantId}/suspend`, root, {
        reason: 'Demo: fees overdue',
      });
    if (s.archive) {
      await ok('post', `/platform/tenants/${tenantId}/suspend`, root, {
        reason: 'Demo: school closed',
      });
      await ok('post', `/platform/tenants/${tenantId}/archive`, root, {
        reason: 'Demo: contract ended',
      });
    }
    created.push(
      `school ${s.name} (${s.plan}${s.suspend ? ', suspended' : s.archive ? ', archived' : ''})`,
    );
  }

  if (!haveCode.has(pendingSchool.code)) {
    await ok('post', '/platform/tenants', root, {
      code: pendingSchool.code,
      name: pendingSchool.name,
      school_type: 'CBSE',
      address: { city: pendingSchool.city, state: pendingSchool.state, country: 'IN' },
    });
    created.push(`school ${pendingSchool.name} (approved, waiting to be provisioned)`);
  } else skipped.push(`school ${pendingSchool.code}`);

  // ---- onboarding requests (public form)
  const pendingReqs = (await ok(
    'get',
    '/platform/school-requests?page_size=100',
    root,
  )) as unknown as Json[];
  if (pendingReqs.length === 0) {
    const reqs = [
      {
        school_name: 'Bluebell Public School',
        contact_name: 'Rekha Pillai',
        contact_email: 'rekha@bluebell.example.com',
        city: 'Kochi',
        country: 'IN',
        message: 'We have 900 students and want to move off spreadsheets.',
      },
      {
        school_name: 'St. Xavier Junior College',
        contact_name: 'Thomas George',
        contact_email: 'thomas@stxavier.example.com',
        city: 'Mumbai',
        country: 'IN',
      },
      {
        school_name: 'Sunny Days Play School',
        contact_name: 'Anita Bose',
        contact_email: 'anita@sunnydays.example.com',
        city: 'Kolkata',
        country: 'IN',
      },
    ];
    const ids: string[] = [];
    for (const r of reqs) {
      const res = await call('post', '/public/school-requests', null, r);
      if (res.status < 300) ids.push(res.body.data?.id as string);
    }
    const list = (await ok(
      'get',
      '/platform/school-requests?page_size=100',
      root,
    )) as unknown as Json[];
    const last = list.find(
      (x) =>
        String(x.contact_email ?? x.school_name).includes('Sunny') ||
        String(x.school_name).includes('Sunny'),
    );
    if (last)
      await ok('post', `/platform/school-requests/${last.id}/reject`, root, {
        note: 'Demo: outside our service area',
      });
    created.push(`${reqs.length} onboarding requests (2 pending, 1 rejected)`);
  } else skipped.push('onboarding requests');
}

/** Academic year, classes, sections, subjects, students, guardians and admissions for two schools. */
async function seedAcademics() {
  const targets = [
    { email: 'principal.gv@example.com', name: 'Green Valley Public School', count: 24 },
    { email: 'admin.sunrise@example.com', name: 'Sunrise International School', count: 12 },
  ];
  const firstNames = [
    'Aarav',
    'Vivaan',
    'Aditya',
    'Ishaan',
    'Kabir',
    'Anaya',
    'Diya',
    'Myra',
    'Saanvi',
    'Aadhya',
    'Riya',
    'Arnav',
  ];
  const lastNames = [
    'Sharma',
    'Verma',
    'Patil',
    'Nair',
    'Reddy',
    'Kulkarni',
    'Iyer',
    'Gupta',
    'Mehta',
    'Joshi',
  ];
  for (const t of targets) {
    let token: string;
    try {
      token = await login(t.email, DEMO_PASSWORD);
    } catch {
      warnings.push(`${t.name}: academic demo data skipped (admin cannot sign in)`);
      continue;
    }
    const years = (await ok('get', '/academic-years?page_size=100', token)) as unknown as Json[];
    if (years.length > 0) {
      skipped.push(`academic data for ${t.name}`);
      continue;
    }
    const year = await ok('post', '/academic-years', token, {
      code: '2026-27',
      name: 'Academic Year 2026-27',
      start_date: '2026-04-01',
      end_date: '2027-03-31',
    });
    await ok('post', `/academic-years/${year.id}/activate`, token, { complete_current: true });
    const sections: { id: string; classId: string }[] = [];
    const classIds: string[] = [];
    for (const [i, n] of [5, 6, 7, 8].entries()) {
      const klass = await ok('post', '/academic-classes', token, {
        code: `G${n}`,
        name: `Class ${n}`,
        sequence: n,
      });
      classIds.push(klass.id as string);
      for (const [j, code] of ['A', 'B'].entries()) {
        const sec = await ok('post', `/academic-years/${year.id}/sections`, token, {
          class_id: klass.id,
          code,
          name: `Section ${code}`,
          capacity: i === 0 && j === 0 ? 5 : 30,
        });
        sections.push({ id: sec.id as string, classId: klass.id as string });
      }
    }
    for (const [code, name, type] of [
      ['ENG', 'English', 'CORE'],
      ['MAT', 'Mathematics', 'CORE'],
      ['SCI', 'Science', 'CORE'],
      ['ART', 'Art', 'ELECTIVE'],
    ] as const) {
      const subject = await ok('post', '/subjects', token, { code, name, subject_type: type });
      for (const classId of classIds)
        await ok('post', '/subject-offerings', token, {
          academic_year_id: year.id,
          subject_id: subject.id,
          class_id: classId,
        });
    }
    for (let i = 0; i < t.count; i++) {
      const sec = sections[i % sections.length]!;
      const last = lastNames[i % lastNames.length]!;
      const student = await ok('post', '/students', token, {
        first_name: firstNames[i % firstNames.length],
        last_name: last,
        date_of_birth: `${2012 + (i % 4)}-0${1 + (i % 9)}-1${i % 9}`,
        gender: i % 2 ? 'FEMALE' : 'MALE',
        guardians: [
          {
            guardian: {
              first_name: 'Parent',
              last_name: last,
              phone: `+91 98${String(10000000 + i * 137).slice(0, 8)}`,
              email: `parent${i}.${t.email.split('@')[0]}@example.com`,
            },
            relationship_type: 'PARENT',
            relationship_label: 'Father',
            is_primary: true,
          },
        ],
        // Enrolled from the first day of the year, so the attendance history below has rosters.
        enrollment: {
          academic_year_id: year.id,
          class_id: sec.classId,
          section_id: sec.id,
          start_date: '2026-04-01',
        },
      });
      if (i === 3)
        await ok('post', `/students/${student.id}/withdraw`, token, {
          reason: 'Demo: family relocated',
        });
    }
    // Admissions in different stages (students not yet enrolled).
    for (const [i, stage] of ['NEW', 'SUBMITTED', 'REVIEW'].entries()) {
      const adm = await ok('post', '/admissions', token, {
        student: {
          first_name: ['Tara', 'Neel', 'Zoya'][i],
          last_name: 'Applicant',
          date_of_birth: '2016-06-15',
        },
        source: 'Walk-in',
      });
      if (stage !== 'NEW') await ok('post', `/admissions/${adm.id}/submit`, token, {});
      if (stage === 'REVIEW') await ok('post', `/admissions/${adm.id}/review`, token, {});
    }
    created.push(
      `academic year, classes, subjects, ${t.count} students and 3 admissions for ${t.name}`,
    );
  }
}

/**
 * Teachers and staff, qualifications and teaching assignments for the two demo
 * schools. Runs after seedAcademics (assignments need its subject offerings).
 * Idempotent: a school that already has teachers is skipped.
 */
async function seedTeachers() {
  type Person = {
    first: string;
    last: string;
    type?: 'TEACHING' | 'NON_TEACHING';
    status?: 'PROSPECTIVE' | 'ONBOARDING' | 'ACTIVE';
    then?: 'start-leave' | 'resign';
    dept: string;
    title: string;
    employment?: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'VISITING';
    joined: string;
    dob: string;
    gender: 'MALE' | 'FEMALE';
    quals?: { type: string; title: string; institution?: string; year?: number }[];
    /** subject code + grade numbers, and the role in each */
    teaches?: { subject: string; grades: number[]; role?: 'PRIMARY' | 'CO_TEACHER' }[];
    portal?: 'accepted' | 'invited';
  };
  const degree = (title: string, institution: string, year: number) => ({
    type: 'DEGREE',
    title,
    institution,
    year,
  });
  const bed = (year: number) => degree('B.Ed', 'Savitribai Phule Pune University', year);
  const targets: { email: string; name: string; domain: string; people: Person[] }[] = [
    {
      email: 'principal.gv@example.com',
      name: 'Green Valley Public School',
      domain: 'greenvalley.example.com',
      people: [
        {
          first: 'Meera',
          last: 'Kapoor',
          dept: 'Mathematics',
          title: 'Head of Mathematics',
          joined: '2016-06-01',
          dob: '1982-03-14',
          gender: 'FEMALE',
          quals: [degree('M.Sc. Mathematics', 'University of Mumbai', 2005), bed(2007)],
          teaches: [{ subject: 'MAT', grades: [7, 8] }],
          portal: 'accepted',
        },
        {
          first: 'Suresh',
          last: 'Rao',
          dept: 'Mathematics',
          title: 'Teacher',
          joined: '2019-06-10',
          dob: '1988-11-02',
          gender: 'MALE',
          quals: [degree('B.Sc. Mathematics', 'Osmania University', 2009), bed(2011)],
          teaches: [{ subject: 'MAT', grades: [5, 6] }],
        },
        {
          first: 'Lakshmi',
          last: 'Pillai',
          dept: 'English',
          title: 'Senior Teacher',
          joined: '2014-04-01',
          dob: '1979-07-21',
          gender: 'FEMALE',
          quals: [degree('M.A. English', 'University of Kerala', 2002), bed(2004)],
          teaches: [{ subject: 'ENG', grades: [5, 6, 7, 8] }],
        },
        {
          first: 'Farhan',
          last: 'Sheikh',
          dept: 'Science',
          title: 'Teacher',
          joined: '2020-06-15',
          dob: '1990-01-30',
          gender: 'MALE',
          quals: [
            degree('M.Sc. Chemistry', 'Aligarh Muslim University', 2013),
            { type: 'CERTIFICATION', title: 'CTET Paper II', year: 2015 },
          ],
          teaches: [{ subject: 'SCI', grades: [7, 8] }],
        },
        {
          first: 'Nisha',
          last: 'Bhatt',
          dept: 'Science',
          title: 'Teacher',
          employment: 'PART_TIME',
          joined: '2022-08-01',
          dob: '1992-09-09',
          gender: 'FEMALE',
          quals: [degree('M.Sc. Biology', 'Gujarat University', 2016)],
          // Co-teaches Class 7 Science with Farhan, and leads Classes 5-6.
          teaches: [
            { subject: 'SCI', grades: [7], role: 'CO_TEACHER' },
            { subject: 'SCI', grades: [5, 6] },
          ],
        },
        {
          first: 'Rahul',
          last: 'Deshmukh',
          dept: 'Arts',
          title: 'Art Teacher',
          joined: '2018-06-01',
          dob: '1985-05-17',
          gender: 'MALE',
          then: 'start-leave',
          quals: [
            {
              type: 'DIPLOMA',
              title: 'Diploma in Fine Arts',
              institution: 'JJ School of Art',
              year: 2008,
            },
          ],
          teaches: [{ subject: 'ART', grades: [5, 6] }],
        },
        {
          first: 'Vikram',
          last: 'Chauhan',
          dept: 'Arts',
          title: 'Art Teacher',
          employment: 'CONTRACT',
          joined: '2021-06-01',
          dob: '1987-12-25',
          gender: 'MALE',
          then: 'resign',
          teaches: [{ subject: 'ART', grades: [7, 8] }],
        },
        {
          first: 'Geeta',
          last: 'Sinha',
          type: 'NON_TEACHING',
          dept: 'Administration',
          title: 'Office Administrator',
          joined: '2017-01-16',
          dob: '1984-04-04',
          gender: 'FEMALE',
        },
        {
          first: 'Ishita',
          last: 'Malhotra',
          type: 'NON_TEACHING',
          status: 'ONBOARDING',
          dept: 'Administration',
          title: 'Front Desk Executive',
          joined: '2026-10-01',
          dob: '1996-02-19',
          gender: 'FEMALE',
        },
      ],
    },
    {
      email: 'admin.sunrise@example.com',
      name: 'Sunrise International School',
      domain: 'sunrise.example.com',
      people: [
        {
          first: 'Arun',
          last: 'Thomas',
          dept: 'Mathematics',
          title: 'Head of Mathematics',
          joined: '2015-06-01',
          dob: '1980-08-08',
          gender: 'MALE',
          quals: [degree('M.Sc. Mathematics', 'Mahatma Gandhi University', 2004), bed(2006)],
          teaches: [{ subject: 'MAT', grades: [5, 6, 7, 8] }],
        },
        {
          first: 'Priya',
          last: 'Menon',
          dept: 'English',
          title: 'Teacher',
          joined: '2018-06-01',
          dob: '1989-10-10',
          gender: 'FEMALE',
          quals: [degree('M.A. English', 'University of Calicut', 2011)],
          teaches: [{ subject: 'ENG', grades: [5, 6, 7, 8] }],
          portal: 'invited',
        },
        {
          first: 'Kavita',
          last: 'Nambiar',
          dept: 'Science',
          title: 'Teacher',
          joined: '2019-06-01',
          dob: '1991-06-23',
          gender: 'FEMALE',
          quals: [degree('M.Sc. Physics', 'Cochin University', 2014)],
          teaches: [
            { subject: 'SCI', grades: [5, 6, 7, 8] },
            { subject: 'ART', grades: [5], role: 'CO_TEACHER' },
          ],
        },
        {
          first: 'Joseph',
          last: 'Fernandes',
          type: 'NON_TEACHING',
          dept: 'Library',
          title: 'Librarian',
          joined: '2016-09-01',
          dob: '1983-03-03',
          gender: 'MALE',
          quals: [
            { type: 'DEGREE', title: 'B.Lib.I.Sc.', institution: 'Goa University', year: 2006 },
          ],
        },
        {
          first: 'Tanvir',
          last: 'Ahmed',
          status: 'PROSPECTIVE',
          dept: 'Science',
          title: 'Science Teacher (candidate)',
          joined: '2026-11-01',
          dob: '1993-01-12',
          gender: 'MALE',
        },
      ],
    },
  ];

  for (const t of targets) {
    let token: string;
    try {
      token = await login(t.email, DEMO_PASSWORD);
    } catch {
      warnings.push(`${t.name}: teacher demo data skipped (admin cannot sign in)`);
      continue;
    }
    const existing = await call('get', '/teachers?page_size=1', token);
    if ((existing.body.meta?.total ?? 0) > 0) {
      skipped.push(`teachers for ${t.name}`);
      continue;
    }
    const offerings = (await ok(
      'get',
      '/subject-offerings?page_size=100&status=ACTIVE',
      token,
    )) as unknown as Json[];
    if (offerings.length === 0) {
      warnings.push(`${t.name}: teacher assignments skipped (no subject offerings)`);
    }
    const offeringFor = (subject: string, grade: number) =>
      offerings.find(
        (o) =>
          o.subject?.code === subject && o.class?.name === `Class ${grade}` && o.section === null,
      )?.id as string | undefined;
    const roleList = (await ok('get', '/roles', token)) as unknown as Json[];
    const teacherRole = roleList.find((r) => r.code === 'TEACHER')?.id as string;

    let assignments = 0;
    for (const p of t.people) {
      const teacher = await ok('post', '/teachers', token, {
        first_name: p.first,
        last_name: p.last,
        staff_type: p.type ?? 'TEACHING',
        status: p.status ?? 'ACTIVE',
        gender: p.gender,
        date_of_birth: p.dob,
        email: `${p.first}.${p.last}@${t.domain}`.toLowerCase(),
        phone: `+91 98${String(20000000 + (Math.abs(hash(p.first + p.last)) % 7000000)).slice(0, 8)}`,
        joining_date: p.joined,
        employment_type: p.employment ?? 'FULL_TIME',
        department: p.dept,
        designation: p.title,
        qualifications: (p.quals ?? []).map((q) => ({
          type: q.type,
          title: q.title,
          institution: q.institution,
          completion_year: q.year,
        })),
      });
      for (const block of p.teaches ?? []) {
        for (const grade of block.grades) {
          const offeringId = offeringFor(block.subject, grade);
          if (!offeringId) continue;
          await ok('post', `/teachers/${teacher.id}/assignments`, token, {
            subject_offering_id: offeringId,
            role: block.role ?? 'PRIMARY',
            start_date: '2026-04-01',
          });
          assignments++;
        }
      }
      if (p.then === 'start-leave')
        await ok('post', `/teachers/${teacher.id}/start-leave`, token, {
          reason: 'Demo: extended medical leave',
        });
      if (p.then === 'resign')
        await ok('post', `/teachers/${teacher.id}/resign`, token, {
          reason: 'Demo: relocated to another city',
          exit_date: '2026-09-15',
        });
      if (p.portal) {
        await ok('post', `/teachers/${teacher.id}/portal-access`, token, { role_id: teacherRole });
        const email = String(teacher.email);
        if (p.portal === 'accepted') {
          if (await accept(email)) accounts.push({ email, role: 'TEACHER', where: t.name });
          else warnings.push(`${t.name}: link for ${email} is in the worker log`);
        }
      }
    }
    created.push(
      `${t.people.length} teachers/staff and ${assignments} teaching assignments for ${t.name}`,
    );
  }
}

/**
 * Attendance for the two demo schools: about three weeks of DAILY registers up to
 * yesterday for three sections (weekends skipped, past days FINAL), one chronically
 * absent student (so the defaulters list is not empty), today's register left DRAFT
 * for one section and not started for the rest, plus one applied and one PENDING
 * correction. Idempotent: a school that already has sessions is skipped. Goes through
 * the real API like everything else here.
 */
async function seedAttendance() {
  const targets = [
    { email: 'principal.gv@example.com', name: 'Green Valley Public School' },
    { email: 'admin.sunrise@example.com', name: 'Sunrise International School' },
  ];
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const weekday = (d: string) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return w !== 0 && w !== 6;
  };
  for (const t of targets) {
    let token: string;
    try {
      token = await login(t.email, DEMO_PASSWORD);
    } catch {
      warnings.push(`${t.name}: attendance demo data skipped (admin cannot sign in)`);
      continue;
    }
    const probe = await call('get', '/attendance/sessions?page_size=1', token);
    if (probe.status === 403) {
      warnings.push(`${t.name}: attendance demo data skipped (attendance is not in the plan)`);
      continue;
    }
    if (probe.status !== 200) throw new Error(`attendance probe → ${probe.status}`);
    if ((probe.body.meta?.total ?? 0) > 0) {
      skipped.push(`attendance for ${t.name}`);
      continue;
    }
    const today = (await ok('get', '/attendance/today', token)).date as string;
    const status = Object.fromEntries(
      ((await ok('get', '/attendance/statuses', token)) as unknown as Json[]).map((s) => [
        s.code as string,
        s.id as string,
      ]),
    ) as Record<string, string>;
    const dashboard = (await ok('get', '/attendance/today', token)).sections as Json[];
    // Register sections that have students today, for the first three classes of the school.
    const picked = dashboard.filter((s) => s.roster_size > 0).slice(0, 3);
    if (picked.length === 0) {
      warnings.push(`${t.name}: attendance demo data skipped (no sections with students)`);
      continue;
    }
    const start = iso(Date.parse(`${today}T00:00:00Z`) - 21 * DAY);
    const yesterday = iso(Date.parse(`${today}T00:00:00Z`) - DAY);
    const days: string[] = [];
    for (let d = start; d <= yesterday; d = iso(Date.parse(`${d}T00:00:00Z`) + DAY))
      if (weekday(d)) days.push(d);

    let chronic: string | undefined; // the student who is often absent
    let corrected = false;
    let registers = 0;
    let marks = 0;
    for (const [si, sec] of picked.entries()) {
      for (const d of days) {
        const session = await ok('post', '/attendance/sessions', token, {
          section_id: (sec.section as Json).id,
          session_date: d,
        });
        const roster = session.roster as Json[];
        if (si === 0 && !chronic) chronic = (roster.length > 1 ? roster[1] : roster[0])!.student.id;
        const records = roster.map((r) => {
          const id = r.student.id as string;
          const roll = Math.abs(hash(`${id}:${d}`)) % 100;
          let code = 'PRESENT';
          let remarks: string | undefined;
          if (id === chronic) code = roll < 60 ? 'ABSENT' : roll < 70 ? 'LATE' : 'PRESENT';
          else if (roll < 3) code = 'ABSENT';
          else if (roll < 7) code = 'LATE';
          else if (roll < 9) code = 'HALF_DAY';
          else if (roll < 10) {
            code = 'EXCUSED';
            remarks = 'Demo: inter-school sports event';
          }
          return { student_id: id, status_id: status[code], ...(remarks ? { remarks } : {}) };
        });
        await ok('put', `/attendance/sessions/${session.id}/records`, token, { records });
        await ok('post', `/attendance/sessions/${session.id}/submit`, token, {});
        registers++;
        marks += records.length;
        // One correction applied straight away (correction approval is switched on below).
        if (!corrected && si === 0 && d === days[days.length - 1]) {
          const final = await ok('get', `/attendance/sessions/${session.id}`, token);
          const rec =
            (final.roster as Json[]).find((r) => r.record.status_code === 'ABSENT')?.record ??
            (final.roster as Json[])[0]!.record;
          await ok('post', `/attendance/records/${rec.id}/corrections`, token, {
            new_status_id: status.EXCUSED,
            reason: 'Demo: parent produced a medical certificate',
          });
          corrected = true;
        }
      }
    }
    // From here on corrections need approval; leave one waiting for the approver.
    const settings = await ok('get', '/attendance/settings', token);
    await ok('patch', '/attendance/settings', token, {
      version: settings.version,
      correction_requires_approval: true,
    });
    const listed = await ok(
      'get',
      `/attendance/sessions?section_id=${(picked[0]!.section as Json).id}&page_size=5`,
      token,
    );
    const latest = (listed as unknown as Json[])[1] ?? (listed as unknown as Json[])[0]!;
    const detail = await ok('get', `/attendance/sessions/${latest.id}`, token);
    const target = (detail.roster as Json[]).find((r) => r.record.status_code === 'PRESENT')!;
    await ok('post', `/attendance/records/${target.record.id}/corrections`, token, {
      new_status_id: status.ABSENT,
      reason: 'Demo: teacher recalls this student left before roll call',
    });
    // Today: a partly-marked DRAFT for the first section, the others not started.
    if (weekday(today)) {
      const draft = await ok('post', '/attendance/sessions', token, {
        section_id: (picked[0]!.section as Json).id,
        session_date: today,
      });
      const roster = draft.roster as Json[];
      await ok('put', `/attendance/sessions/${draft.id}/records`, token, {
        records: roster.slice(0, Math.max(1, roster.length - 1)).map((r, i) => ({
          student_id: r.student.id,
          status_id: status[i === 1 ? 'ABSENT' : 'PRESENT'],
        })),
      });
    }
    created.push(
      `${registers} attendance registers (${marks} marks) for ${t.name}, 1 pending and 1 applied correction`,
    );
  }
}

/**
 * Timetable for the two demo schools: a bell schedule (6 lessons, break, lunch, assembly),
 * teaching days, venues and a PUBLISHED timetable for the active year built by a small
 * deterministic scheduler from the teachers, assignments and offerings seeded above
 * (no teacher, section or venue is ever double-booked), plus one DRAFT version that
 * differs from it. Idempotent: a school that already has a timetable is skipped.
 * Goes through the real API like everything else here.
 */
async function seedTimetable() {
  const targets = [
    {
      email: 'principal.gv@example.com',
      name: 'Green Valley Public School',
      days: [1, 2, 3, 4, 5, 6], // Monday to Saturday
      lessons: { MAT: 5, ENG: 3, SCI: 4, ART: 2 } as Record<string, number>,
    },
    {
      email: 'admin.sunrise@example.com',
      name: 'Sunrise International School',
      days: [1, 2, 3, 4, 5], // Monday to Friday
      lessons: { MAT: 3, ENG: 3, SCI: 3, ART: 2 } as Record<string, number>,
    },
  ];
  const bell = [
    ['ASM', 'Assembly', '08:00', '08:20', 'ASSEMBLY'],
    ['P1', 'Period 1', '08:20', '09:00', 'LESSON'],
    ['P2', 'Period 2', '09:00', '09:40', 'LESSON'],
    ['P3', 'Period 3', '09:40', '10:20', 'LESSON'],
    ['BRK', 'Break', '10:20', '10:40', 'BREAK'],
    ['P4', 'Period 4', '10:40', '11:20', 'LESSON'],
    ['P5', 'Period 5', '11:20', '12:00', 'LESSON'],
    ['LUN', 'Lunch', '12:00', '12:40', 'LUNCH'],
    ['P6', 'Period 6', '12:40', '13:20', 'LESSON'],
  ] as const;
  for (const t of targets) {
    let token: string;
    try {
      token = await login(t.email, DEMO_PASSWORD);
    } catch {
      warnings.push(`${t.name}: timetable demo data skipped (admin cannot sign in)`);
      continue;
    }
    const probe = await call('get', '/timetable/timetables?page_size=1', token);
    if (probe.status === 403) {
      warnings.push(`${t.name}: timetable demo data skipped (timetable is not in the plan)`);
      continue;
    }
    if (probe.status !== 200) throw new Error(`timetable probe → ${probe.status}`);
    if ((probe.body.meta?.total ?? 0) > 0) {
      skipped.push(`timetable for ${t.name}`);
      continue;
    }
    const years = (await ok('get', '/academic-years?page_size=100', token)) as unknown as Json[];
    const year = years.find((y) => y.status === 'ACTIVE');
    if (!year) {
      warnings.push(`${t.name}: timetable demo data skipped (no active academic year)`);
      continue;
    }
    const sections = (
      (await ok(
        'get',
        `/sections?academic_year_id=${year.id}&page_size=100`,
        token,
      )) as unknown as Json[]
    )
      .filter((s) => s.status === 'ACTIVE')
      .sort(
        (a, b) =>
          String(a.class.name).localeCompare(String(b.class.name)) ||
          String(a.code).localeCompare(String(b.code)),
      );
    const offerings = (await ok(
      'get',
      '/subject-offerings?page_size=100&status=ACTIVE',
      token,
    )) as unknown as Json[];
    const activeTeachers = new Set(
      ((await ok('get', '/teachers?status=ACTIVE&page_size=100', token)) as unknown as Json[]).map(
        (x) => x.id as string,
      ),
    );
    const assignments = (
      (await ok(
        'get',
        '/teaching-assignments?status=ACTIVE&page_size=100',
        token,
      )) as unknown as Json[]
    ).filter((a) => activeTeachers.has(a.teacher.id));
    if (sections.length === 0 || assignments.length === 0) {
      warnings.push(`${t.name}: timetable demo data skipped (no sections or teaching assignments)`);
      continue;
    }

    // ---- configuration
    const settings = await ok('get', '/timetable/settings', token);
    await ok('patch', '/timetable/settings', token, {
      version: settings.version,
      working_days: t.days,
    });
    const period: Record<string, string> = {};
    const existingPeriods = (await ok('get', '/timetable/periods', token)) as unknown as Json[];
    if (existingPeriods.length === 0)
      for (const [code, name, start, end, kind] of bell)
        period[code] = (
          await ok('post', '/timetable/periods', token, {
            code,
            name,
            start_time: start,
            end_time: end,
            kind,
          })
        ).id as string;
    else for (const p of existingPeriods) period[p.code as string] = p.id as string;
    const lessonPeriods = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].filter((c) => period[c]);
    const venue: Record<string, string> = {};
    const existingVenues = (await ok(
      'get',
      '/timetable/venues?page_size=100',
      token,
    )) as unknown as Json[];
    if (existingVenues.length === 0) {
      const mk = async (code: string, name: string, type: string, capacity: number) => {
        venue[code] = (
          await ok('post', '/timetable/venues', token, {
            code,
            name,
            venue_type: type,
            capacity,
          })
        ).id as string;
      };
      for (const s of sections)
        await mk(
          `R-${s.class.name}${s.code}`.replace(/\s+/g, ''),
          `Room ${s.class.name} ${s.code}`,
          'CLASSROOM',
          35,
        );
      await mk('LAB', 'Science Lab', 'LAB', 30);
      await mk('ART', 'Art Room', 'OTHER', 30);
      await mk('HALL', 'Assembly Hall', 'HALL', 300);
    } else for (const v of existingVenues) venue[v.code as string] = v.id as string;

    // ---- the scheduler: greedy, deterministic, never double-books teacher, section or venue
    const busy = {
      teacher: new Set<string>(),
      section: new Set<string>(),
      venue: new Set<string>(),
    };
    const cells = new Map<string, Json[]>(); // section id → grid cells
    let placed = 0;
    let missed = 0;
    let lessonsWanted = 0;
    const D = t.days.length;
    for (const [i, sec] of sections.entries()) {
      const room = venue[`R-${sec.class.name}${sec.code}`.replace(/\s+/g, '')] ?? null;
      const mine = offerings.filter(
        (o) => o.class.id === sec.class.id && (o.section === null || o.section?.id === sec.id),
      );
      for (const [si, code] of Object.keys(t.lessons).entries()) {
        const offering = mine.find((o) => o.subject.code === code);
        if (!offering) continue;
        const candidates = assignments.filter((a) => a.subject_offering_id === offering.id);
        const chosen = candidates.find((a) => a.role === 'PRIMARY') ?? candidates[0];
        const wanted = t.lessons[code]!;
        lessonsWanted += wanted;
        if (!chosen) {
          missed += wanted; // nobody teaches it right now (e.g. the teacher left)
          continue;
        }
        const teacherId = chosen.teacher.id as string;
        const special = code === 'SCI' ? venue.LAB : code === 'ART' ? venue.ART : null;
        const daysUsed = new Set<number>();
        for (let j = 0; j < wanted; j++) {
          let done = false;
          for (let pass = 0; pass < 2 && !done; pass++) {
            for (let dd = 0; dd < D && !done; dd++) {
              const day = t.days[(i + si * 2 + j + dd) % D]!;
              if (pass === 0 && daysUsed.has(day)) continue; // spread over the week first
              for (let pp = 0; pp < lessonPeriods.length && !done; pp++) {
                const per = lessonPeriods[(i + si + day + pp) % lessonPeriods.length]!;
                const slot = `${day}:${per}`;
                if (
                  busy.section.has(`${sec.id}:${slot}`) ||
                  busy.teacher.has(`${teacherId}:${slot}`)
                )
                  continue;
                const useSpecial = special && !busy.venue.has(`${special}:${slot}`);
                const where = useSpecial ? special : room;
                if (where && busy.venue.has(`${where}:${slot}`)) continue;
                busy.section.add(`${sec.id}:${slot}`);
                busy.teacher.add(`${teacherId}:${slot}`);
                if (where) busy.venue.add(`${where}:${slot}`);
                daysUsed.add(day);
                const list = cells.get(sec.id) ?? [];
                list.push({
                  day_of_week: day,
                  period_id: period[per],
                  subject_offering_id: offering.id,
                  teacher_id: teacherId,
                  venue_id: where,
                });
                cells.set(sec.id, list);
                placed++;
                done = true;
              }
            }
          }
          if (!done) missed++;
        }
      }
    }

    // ---- the published timetable, then a draft that differs from it
    const main = await ok('post', '/timetable/timetables', token, {
      academic_year_id: year.id,
      name: `Main timetable ${year.code}`,
      effective_from: year.start_date,
      notes: 'Demo timetable generated by the seed scheduler',
    });
    for (const [sectionId, list] of cells)
      await ok('put', `/timetable/timetables/${main.id}/sections/${sectionId}/grid`, token, {
        cells: list,
      });
    await ok('post', `/timetable/timetables/${main.id}/publish`, token, {});
    const draft = await ok('post', `/timetable/timetables/${main.id}/duplicate`, token, {
      name: `${year.code} revised timetable (draft)`,
    });
    const first = sections[0]!;
    const firstCells = cells.get(first.id) ?? [];
    if (firstCells.length > 1)
      await ok('put', `/timetable/timetables/${draft.id}/sections/${first.id}/grid`, token, {
        cells: [
          {
            ...firstCells[0],
            subject_offering_id: null,
            teacher_id: undefined,
            venue_id: undefined,
          },
        ],
      });
    created.push(
      `timetable for ${t.name}: ${t.days.length}-day week, ${bell.length} periods, ${Object.keys(venue).length} venues, ` +
        `${placed}/${lessonsWanted} lessons placed${missed ? ` (${missed} not schedulable: no available teacher or slot)` : ''} ` +
        'in a published version plus one draft',
    );
  }
}


/**
 * Examinations for the two demo schools, in three different states so every screen has
 * something to show: a PUBLISHED Unit Test (all marks in), a Mid-Term still being marked
 * (some papers done, one half done) and a Final Exam that is only set up (dates, no marks).
 * Goes through the real API. Idempotent: a school that already has exams is skipped.
 */
async function seedExams() {
  const targets = [
    { email: 'principal.gv@example.com', name: 'Green Valley Public School' },
    { email: 'admin.sunrise@example.com', name: 'Sunrise International School' },
  ];
  const DAY = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const weekday = (d: string) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return w !== 0 && w !== 6;
  };
  /** The n-th school day on or after `from`. */
  const nthDay = (from: string, n: number) => {
    let d = from;
    let left = n;
    for (;;) {
      if (weekday(d)) {
        if (left === 0) return d;
        left--;
      }
      d = iso(Date.parse(`${d}T00:00:00Z`) + DAY);
    }
  };
  for (const t of targets) {
    let token: string;
    try {
      token = await login(t.email, DEMO_PASSWORD);
    } catch {
      warnings.push(`${t.name}: exam demo data skipped (admin cannot sign in)`);
      continue;
    }
    const probe = await call('get', '/exams', token);
    if (probe.status === 403) {
      warnings.push(`${t.name}: exam demo data skipped (examinations is not in the plan)`);
      continue;
    }
    if (probe.status !== 200) throw new Error(`exams probe → ${probe.status}`);
    if ((probe.body.data as Json[]).length > 0) {
      skipped.push(`exams for ${t.name}`);
      continue;
    }
    const classes = (await ok('get', '/academic-classes?page_size=100&status=ACTIVE', token)) as unknown as Json[];
    const classIds = classes.map((c) => c.id as string);
    if (classIds.length === 0) {
      warnings.push(`${t.name}: exam demo data skipped (no classes)`);
      continue;
    }
    const mk = async (name: string, type: string, startOffset: number, marking: 'all' | 'most' | 'none') => {
      const start = nthDay(iso(Date.now() + startOffset * DAY), 0);
      const exam = await ok('post', '/exams', token, {
        name,
        exam_type: type,
        start_date: start,
        end_date: nthDay(start, 5),
        class_ids: classIds,
        default_max_marks: type === 'UNIT_TEST' ? 50 : 100,
        default_pass_marks: type === 'UNIT_TEST' ? 18 : 35,
      });
      const papers = (await ok('get', `/exams/${exam.id}/papers`, token)) as unknown as Json[];
      // One paper per subject per day, so a class never sits two papers at once.
      const subjectOrder = new Map<string, number>();
      for (const p of papers) {
        const key = `${p.class_id}`;
        const i = subjectOrder.get(key) ?? 0;
        subjectOrder.set(key, i + 1);
        await ok('patch', `/exams/papers/${p.id}`, token, { exam_date: nthDay(start, i) });
      }
      if (marking === 'none') return exam;
      let n = 0;
      for (const p of papers) {
        n++;
        if (p.students === 0) continue;
        // 'most': leave every fourth paper without marks and every seventh half done.
        if (marking === 'most' && n % 4 === 0) continue;
        const sheet = await ok('get', `/exams/papers/${p.id}/marks`, token);
        let rows = sheet.rows as Json[];
        if (marking === 'most' && n % 7 === 0) rows = rows.slice(0, Math.ceil(rows.length / 2));
        const records = rows.map((r) => {
          const roll = Math.abs(hash(`${r.student_id}:${p.id}`)) % 100;
          const ability = 45 + (Math.abs(hash(r.student_id as string)) % 50); // 45–94 %
          if (roll < 3) return { student_id: r.student_id, absent: true };
          const pct = Math.max(8, Math.min(100, ability + ((roll % 21) - 10)));
          const max = p.max_marks as number;
          return { student_id: r.student_id, marks: Math.round(((pct / 100) * max) * 2) / 2 };
        });
        await ok('put', `/exams/papers/${p.id}/marks`, token, { records });
      }
      return exam;
    };
    const unit = await mk('Unit Test 1', 'UNIT_TEST', -50, 'all');
    await ok('post', `/exams/${unit.id}/publish`, token, { allow_incomplete: true });
    await mk('Mid-Term Exam', 'MID_TERM', -4, 'most');
    await mk('Final Exam', 'FINAL', 60, 'none');
    created.push(`3 exams for ${t.name}: Unit Test 1 published, Mid-Term being marked, Final Exam set up`);
  }
}

/** Small deterministic string hash for stable demo phone numbers. */
function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

main()
  .then(() => seedAcademics())
  .then(() => seedTeachers())
  .then(() => seedAttendance())
  .then(() => seedTimetable())
  .then(() => seedExams())
  .then(async () => {
    console.log('\nDemo data ready.');
    for (const c of created) console.log('  + ' + c);
    for (const s of skipped) console.log('  = already there: ' + s);
    for (const w of warnings) console.log('  ! ' + w);
    if (accounts.length) {
      console.log(`\nSign-in accounts (password for all: ${DEMO_PASSWORD})`);
      for (const a of accounts)
        console.log(`  ${a.email.padEnd(44)} ${a.role.padEnd(20)} ${a.where}`);
    }
    await closeDeps(deps);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDeps(deps).catch(() => undefined);
    process.exit(1);
  });
