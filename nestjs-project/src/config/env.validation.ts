import * as Joi from 'joi';
import {
  AUTH_THROTTLE_LIMIT,
  AUTH_THROTTLE_TTL_MS,
} from '../auth/auth.constants';

export const JWT_EXPIRATION_PATTERN = /^[1-9]\d*(ms|[smhd])$/;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  APP_URL: Joi.string().uri().default('https://streamtube.com'),
  DB_HOST: Joi.string().default('db'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string()
    .pattern(JWT_EXPIRATION_PATTERN)
    .default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string()
    .pattern(JWT_EXPIRATION_PATTERN)
    .default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  THROTTLE_TTL_MS: Joi.number()
    .integer()
    .positive()
    .default(AUTH_THROTTLE_TTL_MS),
  THROTTLE_LIMIT: Joi.number()
    .integer()
    .positive()
    .default(AUTH_THROTTLE_LIMIT),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
});
