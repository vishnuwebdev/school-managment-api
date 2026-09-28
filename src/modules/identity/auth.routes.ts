import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import type { AuthService } from './auth.service.js';
import { PasswordSchema } from './password.js';

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .openapi({ example: 'admin@school.test' });

const TokensResponse = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number(),
    refresh_token: z.string(),
    refresh_expires_at: z.string(),
    session_id: z.string(),
  })
  .openapi('Tokens');

const Device = z
  .object({
    device_name: z.string().max(100).optional(),
    device_type: z.enum(['web', 'android', 'ios', 'desktop', 'other']).optional(),
  })
  .optional();

export function authRoutes(auth: AuthService) {
  return [
    defineRoute({
      method: 'post',
      path: '/auth/login',
      summary: 'Sign in with email and password',
      tags: ['Auth'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({
        email: Email,
        password: z.string().min(1).max(128),
        /** Required when the user belongs to more than one school. */
        membership_id: z.string().uuid().optional(),
        device: Device,
      }),
      response: z.object({ data: TokensResponse.extend({ membership: z.unknown() }) }),
      handler: async ({ body, req }) => ({
        data: await auth.login(
          {
            email: body.email,
            password: body.password,
            membershipId: body.membership_id,
            device: { deviceName: body.device?.device_name, deviceType: body.device?.device_type },
          },
          req.ctx.meta,
        ),
      }),
    }),

    defineRoute({
      method: 'post',
      path: '/auth/refresh',
      summary: 'Exchange a refresh token for new tokens (rotation)',
      tags: ['Auth'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({ refresh_token: z.string().min(20).max(200) }),
      response: z.object({ data: TokensResponse }),
      handler: async ({ body, req }) => ({
        data: await auth.refresh(body.refresh_token, req.ctx.meta),
      }),
    }),

    defineRoute({
      method: 'post',
      path: '/auth/logout',
      summary: 'End the current session',
      tags: ['Auth'],
      access: 'authenticated',
      status: 204,
      handler: async ({ req }) => {
        await auth.logout(req.ctx.principal!, req.ctx.meta);
      },
    }),

    defineRoute({
      method: 'post',
      path: '/auth/switch-tenant',
      summary: 'Switch to another school (or the platform) the user belongs to',
      tags: ['Auth'],
      access: 'authenticated',
      body: z.object({ membership_id: z.string().uuid() }),
      handler: async ({ body, req }) => ({
        data: await auth.switchContext(req.ctx.principal!, body.membership_id, req.ctx.meta),
      }),
    }),

    defineRoute({
      method: 'get',
      path: '/auth/me',
      summary: 'Current user, context, effective permissions and entitlements',
      tags: ['Auth'],
      access: 'authenticated',
      handler: async ({ req }) => ({ data: await auth.me(req.ctx.principal!, req.ctx.tenant) }),
    }),

    defineRoute({
      method: 'get',
      path: '/auth/sessions',
      summary: 'List my active sessions',
      tags: ['Auth'],
      access: 'authenticated',
      handler: async ({ req }) => ({ data: await auth.listSessions(req.ctx.principal!) }),
    }),

    defineRoute({
      method: 'delete',
      path: '/auth/sessions/:id',
      summary: 'Revoke one of my sessions',
      tags: ['Auth'],
      access: 'authenticated',
      params: z.object({ id: z.string().uuid() }),
      status: 204,
      handler: async ({ params, req }) => {
        await auth.revokeSession(req.ctx.principal!, params.id, req.ctx.meta);
      },
    }),

    defineRoute({
      method: 'post',
      path: '/auth/change-password',
      summary: 'Change my password (other sessions are signed out)',
      tags: ['Auth'],
      access: 'authenticated',
      rateLimit: 'auth',
      body: z.object({
        current_password: z.string().min(1).max(128),
        new_password: PasswordSchema,
      }),
      status: 204,
      handler: async ({ body, req }) => {
        await auth.changePassword(
          req.ctx.principal!,
          body.current_password,
          body.new_password,
          req.ctx.meta,
        );
      },
    }),

    defineRoute({
      method: 'post',
      path: '/auth/forgot-password',
      summary: 'Request a password reset email',
      tags: ['Auth'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({ email: Email }),
      status: 202,
      handler: async ({ body, req }) => {
        await auth.forgotPassword(body.email, req.ctx.meta);
        return { data: { accepted: true } };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/auth/reset-password',
      summary: 'Set a new password using a reset token',
      tags: ['Auth'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({ token: z.string().min(20).max(200), new_password: PasswordSchema }),
      status: 204,
      handler: async ({ body, req }) => {
        await auth.resetPassword(body.token, body.new_password, req.ctx.meta);
      },
    }),

    defineRoute({
      method: 'post',
      path: '/auth/invitations/preview',
      summary: 'Show who an invitation is for (before accepting)',
      tags: ['Auth'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({ token: z.string().min(20).max(200) }),
      handler: async ({ body }) => ({ data: await auth.previewInvitation(body.token) }),
    }),

    defineRoute({
      method: 'post',
      path: '/auth/invitations/accept',
      summary: 'Accept an invitation (new users set their password)',
      tags: ['Auth'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({
        token: z.string().min(20).max(200),
        password: PasswordSchema.optional(),
        first_name: z.string().trim().min(1).max(100).optional(),
        last_name: z.string().trim().max(100).optional(),
      }),
      handler: async ({ body, req }) => ({
        data: await auth.acceptInvitation(
          {
            token: body.token,
            password: body.password,
            firstName: body.first_name,
            lastName: body.last_name,
          },
          req.ctx.meta,
        ),
      }),
    }),
  ];
}
