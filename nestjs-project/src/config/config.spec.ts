import appConfig from './app.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('databaseConfig', () => {
    it('returns default values when env vars are unset', () => {
      delete process.env.DB_HOST;
      delete process.env.DB_PORT;
      delete process.env.DB_USERNAME;
      delete process.env.DB_PASSWORD;
      delete process.env.DB_NAME;

      expect(databaseConfig()).toEqual({
        host: 'localhost',
        port: 5432,
        username: 'streamtube',
        password: 'streamtube',
        database: 'streamtube',
      });
    });

    it('reads and parses values from process.env', () => {
      process.env.DB_HOST = 'db';
      process.env.DB_PORT = '5433';
      process.env.DB_USERNAME = 'admin';
      process.env.DB_PASSWORD = 'secret';
      process.env.DB_NAME = 'mydb';

      expect(databaseConfig()).toEqual({
        host: 'db',
        port: 5433,
        username: 'admin',
        password: 'secret',
        database: 'mydb',
      });
    });
  });

  describe('appConfig', () => {
    it('returns default values when env vars are unset', () => {
      delete process.env.PORT;
      delete process.env.NODE_ENV;

      expect(appConfig()).toEqual({
        port: 3000,
        nodeEnv: 'development',
      });
    });

    it('reads and parses values from process.env', () => {
      process.env.PORT = '4000';
      process.env.NODE_ENV = 'production';

      expect(appConfig()).toEqual({
        port: 4000,
        nodeEnv: 'production',
      });
    });
  });

  describe('envValidationSchema', () => {
    it('accepts valid environment variables and applies defaults', () => {
      const result = envValidationSchema.validate(
        {
          DB_USERNAME: 'streamtube',
          DB_PASSWORD: 'streamtube',
          DB_NAME: 'streamtube',
        },
        { allowUnknown: true, abortEarly: false },
      );

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({
        NODE_ENV: 'development',
        PORT: 3000,
        DB_HOST: 'localhost',
        DB_PORT: 5432,
        DB_USERNAME: 'streamtube',
        DB_PASSWORD: 'streamtube',
        DB_NAME: 'streamtube',
      });
    });

    it.each(['DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'])(
      'rejects when required variable %s is missing',
      (missingKey) => {
        const env: Record<string, string> = {
          DB_USERNAME: 'streamtube',
          DB_PASSWORD: 'streamtube',
          DB_NAME: 'streamtube',
        };
        delete env[missingKey];

        const result = envValidationSchema.validate(env, {
          allowUnknown: true,
          abortEarly: false,
        });

        expect(result.error).toBeDefined();
        expect(result.error?.message).toContain(missingKey);
      },
    );

    it('rejects invalid NODE_ENV and PORT values', () => {
      const result = envValidationSchema.validate(
        {
          NODE_ENV: 'staging',
          PORT: 99999,
          DB_USERNAME: 'streamtube',
          DB_PASSWORD: 'streamtube',
          DB_NAME: 'streamtube',
        },
        { allowUnknown: true, abortEarly: false },
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('NODE_ENV');
      expect(result.error?.message).toContain('PORT');
    });
  });
});
