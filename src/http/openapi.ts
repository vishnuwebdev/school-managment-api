import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/** Single registry: every route defined with `defineRoute` is documented automatically. */
export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

export const ErrorResponse = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string().openapi({ example: 'PERMISSION_DENIED' }),
      message: z.string(),
      details: z.unknown().nullable(),
      request_id: z.string(),
    }),
  }),
);

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'School Management Platform API',
      version: '1.0.0',
      description:
        'Multi-tenant school management API. Every protected request runs: request id → rate limit → authentication → tenant context → permission → entitlement → validation → handler. Errors use stable machine-readable codes.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
