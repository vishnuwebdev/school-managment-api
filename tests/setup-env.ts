// Loaded before every test file. Tests use their own database and Redis DB.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'mysql://sms:sms@localhost:3306/sms_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.MAIL_DRIVER = 'memory';
process.env.LOG_LEVEL = 'silent';
process.env.CACHE_TTL_SECONDS = '60';
process.env.APP_BASE_URL = 'http://app.test';
process.env.STORAGE_DIR = `${process.env.TMPDIR ?? '/tmp'}/sms-test-storage`;
