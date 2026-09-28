import { writeFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { createDeps, closeDeps } from '../bootstrap.js';
import { buildOpenApiDocument } from '../http/openapi.js';
import { buildServices } from '../services.js';

/** Writes openapi.json (the contract for the Flutter app, QA and integrations). */
const deps = createDeps();
createApp(deps, buildServices(deps)); // registers every route in the OpenAPI registry
const out = process.argv[2] ?? 'docs/api/openapi.json';
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2));
console.log(`Wrote ${out}`);
await closeDeps(deps);
