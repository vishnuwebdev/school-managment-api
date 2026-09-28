import { createApp } from './app.js';
import { env } from './config/env.js';
import { db } from './db/index.js';
import { seed } from './db/seed.js';

async function start() {
  await db.ready();

  // The memory driver has nothing to persist between restarts, so it seeds
  // itself automatically on every boot. mysql/mongo are expected to already
  // hold data (run `npm run seed` once against a fresh database instead).
  if (env.databaseDriver === 'memory') {
    await seed();
  }

  const app = createApp();
  app.listen(env.port, () => {
    console.log(`EduSphere API listening on :${env.port} (database: ${env.databaseDriver})`); // eslint-disable-line no-console
  });
}

start().catch((err) => {
  console.error('Failed to start EduSphere API:', err); // eslint-disable-line no-console
  process.exit(1);
});
