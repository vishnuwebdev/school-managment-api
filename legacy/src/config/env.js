import 'dotenv/config';

// Central place for environment configuration. Nothing in the app should
// read process.env directly outside this file, so every setting has one
// documented source of truth (spec: "Configuration over hard-coding").
const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const env = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: required('JWT_SECRET', 'development-only-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 10),

  // 'memory' | 'mysql' | 'mongo'. Memory is the zero-setup dev default;
  // mysql/mongo activate once DATABASE_URL points at a real instance.
  databaseDriver: process.env.DATABASE_DRIVER || 'memory',
  databaseUrl: process.env.DATABASE_URL || '',

  // 'local' is the only storage driver implemented for dev (no third-party
  // signup required). A cloud driver (e.g. Cloudflare R2/S3) can be added
  // later behind the same storage interface — see src/modules/storage.
  objectStorageDriver: process.env.OBJECT_STORAGE_DRIVER || 'local',
  objectStorageLocalPath: process.env.OBJECT_STORAGE_LOCAL_PATH || 'storage/uploads',

  allowDevLogin: (process.env.ALLOW_DEV_LOGIN || 'true') === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
};
