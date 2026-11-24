// Entry file for hosts that start the app without a build step (Hostinger: Entry file
// "server.js", Root directory = this folder). Runs the compiled API when `npm run build`
// has produced dist/, otherwise the TypeScript source directly through tsx (a dependency).
// Local development is unchanged: `npm run dev` / `./start-api.sh`.
import { existsSync } from 'node:fs';

if (existsSync(new URL('./dist/server.js', import.meta.url))) {
  await import('./dist/server.js');
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('./src/server.ts');
}
