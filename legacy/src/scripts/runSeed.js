import { seed } from '../db/seed.js';

// `npm run seed` — for mysql/mongo, run this once against a fresh database
// (after applying src/db/schema.sql for mysql) to create the demo school,
// the three default roles, one login per role, and a handful of students.
seed()
  .then(({ school }) => {
    console.log(`Seed complete for "${school.name}". Demo logins (password: ChangeMe123!):`); // eslint-disable-line no-console
    console.log('  superadmin@edusphere.app  (Super Admin)'); // eslint-disable-line no-console
    console.log('  admin@brightfuture.edu    (School Admin)'); // eslint-disable-line no-console
    console.log('  subadmin@brightfuture.edu (Sub Admin)'); // eslint-disable-line no-console
    process.exit(0);
  })
  .catch((err) => {
    console.error('Seed failed:', err); // eslint-disable-line no-console
    process.exit(1);
  });
