import { envValidationSchema } from './env.validation';

interface ValidatedEnv {
  JWT_ACCESS_EXPIRATION: string;
  JWT_REFRESH_EXPIRATION: string;
  THROTTLE_TTL_MS: number;
  THROTTLE_LIMIT: number;
}

const validBaseEnv = {
  DB_USERNAME: 'streamtube',
  DB_PASSWORD: 'secret',
  DB_NAME: 'streamtube',
  JWT_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

describe('envValidationSchema (JWT expiration)', () => {
  it('should apply default JWT expiration values when omitted', () => {
    const result = envValidationSchema.validate(validBaseEnv);

    expect(result.error).toBeUndefined();
    const value = result.value as ValidatedEnv;
    expect(value.JWT_ACCESS_EXPIRATION).toBe('15m');
    expect(value.JWT_REFRESH_EXPIRATION).toBe('7d');
  });

  it.each(['500ms', '30s', '15m', '2h', '7d'])(
    'should accept valid duration unit "%s"',
    (duration) => {
      const result = envValidationSchema.validate({
        ...validBaseEnv,
        JWT_ACCESS_EXPIRATION: duration,
        JWT_REFRESH_EXPIRATION: duration,
      });

      expect(result.error).toBeUndefined();
      const value = result.value as ValidatedEnv;
      expect(value.JWT_ACCESS_EXPIRATION).toBe(duration);
      expect(value.JWT_REFRESH_EXPIRATION).toBe(duration);
    },
  );

  it.each(['15', '0m', '-5m', '15minutes', 'invalid'])(
    'should reject invalid JWT_ACCESS_EXPIRATION "%s"',
    (invalidDuration) => {
      const result = envValidationSchema.validate({
        ...validBaseEnv,
        JWT_ACCESS_EXPIRATION: invalidDuration,
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('JWT_ACCESS_EXPIRATION');
    },
  );

  it.each(['7', '0d', '-1d', '7days', 'forever'])(
    'should reject invalid JWT_REFRESH_EXPIRATION "%s"',
    (invalidDuration) => {
      const result = envValidationSchema.validate({
        ...validBaseEnv,
        JWT_REFRESH_EXPIRATION: invalidDuration,
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('JWT_REFRESH_EXPIRATION');
    },
  );
});

describe('envValidationSchema (rate limiting)', () => {
  it('should apply default THROTTLE_TTL_MS and THROTTLE_LIMIT when omitted', () => {
    const result = envValidationSchema.validate(validBaseEnv);

    expect(result.error).toBeUndefined();
    const value = result.value as ValidatedEnv;
    expect(value.THROTTLE_TTL_MS).toBe(60000);
    expect(value.THROTTLE_LIMIT).toBe(10);
  });

  it('should coerce valid positive integer THROTTLE_TTL_MS and THROTTLE_LIMIT values', () => {
    const result = envValidationSchema.validate({
      ...validBaseEnv,
      THROTTLE_TTL_MS: '30000',
      THROTTLE_LIMIT: '25',
    });

    expect(result.error).toBeUndefined();
    const value = result.value as ValidatedEnv;
    expect(value.THROTTLE_TTL_MS).toBe(30000);
    expect(value.THROTTLE_LIMIT).toBe(25);
  });

  it.each(['0', '-1000', '1.5', 'abc'])(
    'should reject invalid THROTTLE_TTL_MS "%s"',
    (invalidTtl) => {
      const result = envValidationSchema.validate({
        ...validBaseEnv,
        THROTTLE_TTL_MS: invalidTtl,
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('THROTTLE_TTL_MS');
    },
  );

  it.each(['0', '-5', '2.5', 'ten'])(
    'should reject invalid THROTTLE_LIMIT "%s"',
    (invalidLimit) => {
      const result = envValidationSchema.validate({
        ...validBaseEnv,
        THROTTLE_LIMIT: invalidLimit,
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('THROTTLE_LIMIT');
    },
  );
});
