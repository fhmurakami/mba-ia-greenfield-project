import { registerAs } from '@nestjs/config';
import type { JwtSignOptions } from '@nestjs/jwt';

export type JwtExpiration = NonNullable<JwtSignOptions['expiresIn']>;

export default registerAs('auth', () => ({
  jwtSecret: process.env.JWT_SECRET as string,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET as string,
  jwtAccessExpiration: (process.env.JWT_ACCESS_EXPIRATION ||
    '15m') as JwtExpiration,
  jwtRefreshExpiration: (process.env.JWT_REFRESH_EXPIRATION ||
    '7d') as JwtExpiration,
  confirmationTokenExpirationHours: parseInt(
    process.env.CONFIRMATION_TOKEN_EXPIRATION_HOURS || '1',
    10,
  ),
  passwordResetTokenExpirationHours: parseInt(
    process.env.PASSWORD_RESET_TOKEN_EXPIRATION_HOURS || '1',
    10,
  ),
}));
