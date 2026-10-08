import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { StudentConfigService } from './config.service.js';
import type { StudentService } from './students.service.js';
import {
  CreateHouseBody,
  HouseParams,
  IdParams,
  UpdateHouseBody,
  UpdateStudentSettingsBody,
} from './students.schemas.js';

const TAG = ['School · Student settings'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;

export function studentConfigRoutes(config: StudentConfigService, students: StudentService) {
  return [
    defineRoute({
      method: 'get',
      path: '/student-houses',
      summary: 'Houses. ?all=true includes switched-off ones.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      query: z.object({ all: z.stringbool().optional() }),
      handler: async ({ query, req }) => ({ data: await config.listHouses(tid(req), query.all) }),
    }),
    defineRoute({
      method: 'post',
      path: '/student-houses',
      summary: 'Add a house',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.settings.manage'],
      body: CreateHouseBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await config.createHouse(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/student-houses/:id',
      summary: 'Rename or switch off a house',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.settings.manage'],
      params: HouseParams,
      body: UpdateHouseBody,
      handler: async ({ params, body, req }) => ({
        data: await config.updateHouse(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/student-settings',
      summary: 'Admission numbering mode (AUTO or MANUAL)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      handler: async ({ req }) => ({ data: await config.getSettings(tid(req)) }),
    }),
    defineRoute({
      method: 'put',
      path: '/student-settings',
      summary: 'Change how admission numbers are produced',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.settings.manage'],
      body: UpdateStudentSettingsBody,
      handler: async ({ body, req }) => ({
        data: await config.updateSettings(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/government-id',
      summary: 'Full government ID of one student. Audited; needs students.government_id.read.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.government_id.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await students.revealGovernmentId(
          tid(req),
          params.id,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
  ];
}
