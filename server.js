// Entry file for hosts that start the app without a build step (Hostinger: Entry file
// "server.js", Root directory = this folder). Runs the TypeScript source through tsx (a
// dependency), so the code that runs is always what is in src/ — a committed dist/ can't go
// stale. Set USE_DIST=1 to run the compiled dist/server.js instead (after `npm run build`).
// Local development is unchanged: `npm run dev` / `./start-api.sh`.
import { existsSync } from 'node:fs';

const useDist = process.env.USE_DIST === '1' && existsSync(new URL('./dist/server.js', import.meta.url));
console.log(`[api] starting from ${useDist ? 'dist/server.js' : 'src/server.ts (tsx)'}, PORT=${process.env.PORT ?? '(not set, 4000)'}`);

try {
  if (useDist) {
    await import('./dist/server.js');
  } else {
    const { register } = await import('tsx/esm/api');
    register();
    await import('./src/server.ts');
  }
} catch (err) {
  console.error('[api] failed to start:', err);
  process.exit(1);
}
