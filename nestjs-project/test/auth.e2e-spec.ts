import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  getStorageToken,
  SkipThrottle,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { Test, TestingModule } from '@nestjs/testing';
import type { Express } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AUTH_THROTTLE_LIMIT } from '../src/auth/auth.constants';
import type { JwtPayload } from '../src/auth/auth.types';
import { CurrentUser } from '../src/auth/decorators/current-user.decorator';
import { RefreshToken } from '../src/auth/entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from '../src/auth/entities/verification-token.entity';
import { configureApp } from '../src/common/configure-app';
import { MAIL_SUBJECTS } from '../src/mail/mail.constants';
import { Channel } from '../src/users/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { clearTestTables } from './create-test-data-source';
import {
  clearMailpitMessages,
  getMailpitMessage,
  getMailpitMessages,
} from './mailpit';

interface RegisterResponseBody {
  id: string;
  email: string;
}

interface LoginResponseBody {
  access_token: string;
  refresh_token: string;
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

interface MailpitMessageDetail {
  ID: string;
  HTML: string;
}

@SkipThrottle()
@Controller('test-protected')
class TestProtectedController {
  @Get('me')
  getMe(
    @CurrentUser() user: JwtPayload,
    @CurrentUser('sub') userId: string,
  ): { user: JwtPayload; userId: string } {
    return { user, userId };
  }
}

describe('AuthController (e2e)', () => {
  jest.setTimeout(15000);

  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestProtectedController],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);

    await app.init();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    throttlerStorage = app.get<ThrottlerStorageService>(getStorageToken());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    throttlerStorage.onApplicationShutdown();
    await clearTestTables(dataSource);
    await clearMailpitMessages();
  });

  const extractConfirmationToken = async (): Promise<string> => {
    const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
    expect(messages.length).toBeGreaterThan(0);

    const detail = (await getMailpitMessage(
      messages[0].ID,
    )) as MailpitMessageDetail;
    const match = /\/auth\/confirm-email\?token=([a-f0-9]{64})/.exec(
      detail.HTML,
    );
    expect(match).not.toBeNull();
    return match![1];
  };

  const extractPasswordResetToken = async (): Promise<string> => {
    const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
    expect(messages.length).toBeGreaterThan(0);

    const detail = (await getMailpitMessage(
      messages[0].ID,
    )) as MailpitMessageDetail;
    const match = /\/auth\/reset-password\?token=([a-f0-9]{64})/.exec(
      detail.HTML,
    );
    expect(match).not.toBeNull();
    return match![1];
  };

  const registerAndGetToken = async (
    email: string,
  ): Promise<{ userId: string; token: string }> => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: 'StrongPassword123',
      })
      .expect(201);

    const body = response.body as RegisterResponseBody;
    const token = await extractConfirmationToken();
    return { userId: body.id, token };
  };

  describe('POST /auth/register', () => {
    it('should return 201 with user id and normalized email without exposing password', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'Alice.Creator@example.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const body = response.body as RegisterResponseBody;
      expect(body.id).toBeDefined();
      expect(body.email).toBe('alice.creator@example.com');
      expect(body).not.toHaveProperty('password');
    });

    it('should create channel with sanitized nickname derived from email prefix', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'Alice.Creator@example.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const body = response.body as RegisterResponseBody;
      const channel = await dataSource.getRepository(Channel).findOneBy({
        user_id: body.id,
      });

      expect(channel).not.toBeNull();
      expect(channel?.nickname).toBe('alicecreator');
      expect(channel?.name).toBe('alicecreator');
    });

    it('should deliver confirmation email with channel name and confirmation link', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'Alice.Creator@example.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      expect(messages[0].To[0].Address).toBe('alice.creator@example.com');
      expect(messages[0].Subject).toBe(MAIL_SUBJECTS.CONFIRMATION);

      const detail = (await getMailpitMessage(
        messages[0].ID,
      )) as MailpitMessageDetail;
      expect(detail.HTML).toContain('alicecreator');
      expect(detail.HTML).toMatch(/\/auth\/confirm-email\?token=[a-f0-9]{64}/);
    });

    it('should succeed with random suffix when email prefix collides with existing nickname (201)', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'streamer@domainone.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const secondRes = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'streamer@domaintwo.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const secondBody = secondRes.body as RegisterResponseBody;
      const secondChannel = await dataSource.getRepository(Channel).findOneBy({
        user_id: secondBody.id,
      });
      expect(secondChannel?.nickname).toMatch(/^streamer_[a-z0-9]{3}$/);
    });

    it('should return 409 EMAIL_ALREADY_EXISTS on duplicate email', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'StrongPassword123',
        })
        .expect(409);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 409,
        error: 'EMAIL_ALREADY_EXISTS',
        message: 'Email is already registered',
      });
    });

    it('should return 409 EMAIL_ALREADY_EXISTS when registering same email with different casing', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'alice@example.com',
          password: 'StrongPassword123',
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'Alice@Example.com',
          password: 'StrongPassword123',
        })
        .expect(409);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 409,
        error: 'EMAIL_ALREADY_EXISTS',
        message: 'Email is already registered',
      });
    });

    describe('validation errors (400)', () => {
      it('should reject invalid email format', async () => {
        const response = await request(app.getHttpServer())
          .post('/auth/register')
          .send({
            email: 'not-an-email',
            password: 'StrongPassword123',
          })
          .expect(400);

        const body = response.body as ErrorResponseBody;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('VALIDATION_ERROR');
        expect(body.message).toEqual(
          expect.arrayContaining(['email must be an email']),
        );
      });

      it('should reject password shorter than 8 characters', async () => {
        const response = await request(app.getHttpServer())
          .post('/auth/register')
          .send({
            email: 'valid@example.com',
            password: 'short',
          })
          .expect(400);

        const body = response.body as ErrorResponseBody;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('VALIDATION_ERROR');
        expect(body.message).toEqual(
          expect.arrayContaining([
            'password must be longer than or equal to 8 characters',
          ]),
        );
      });

      it('should reject password longer than 128 characters', async () => {
        const response = await request(app.getHttpServer())
          .post('/auth/register')
          .send({
            email: 'valid@example.com',
            password: 'a'.repeat(129),
          })
          .expect(400);

        const body = response.body as ErrorResponseBody;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('VALIDATION_ERROR');
        expect(body.message).toEqual(
          expect.arrayContaining([
            'password must be shorter than or equal to 128 characters',
          ]),
        );
      });

      it('should reject missing required fields', async () => {
        const response = await request(app.getHttpServer())
          .post('/auth/register')
          .send({})
          .expect(400);

        const body = response.body as ErrorResponseBody;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('VALIDATION_ERROR');
        expect(Array.isArray(body.message)).toBe(true);
        if (Array.isArray(body.message)) {
          expect(body.message.length).toBeGreaterThan(0);
        }
      });

      it('should reject unknown properties in request body', async () => {
        const response = await request(app.getHttpServer())
          .post('/auth/register')
          .send({
            email: 'valid@example.com',
            password: 'StrongPassword123',
            unknownField: 'rejected',
          })
          .expect(400);

        const body = response.body as ErrorResponseBody;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('VALIDATION_ERROR');
        expect(body.message).toEqual(
          expect.arrayContaining(['property unknownField should not exist']),
        );
      });
    });
  });

  describe('POST /auth/confirm-email', () => {
    it('should return 204 with empty body and mark user as confirmed', async () => {
      const { userId, token } = await registerAndGetToken(
        'confirm-e2e@example.com',
      );

      const response = await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);

      expect(response.text).toBe('');

      const user = await dataSource.getRepository(User).findOneBy({
        id: userId,
      });
      expect(user?.is_confirmed).toBe(true);
    });

    it('should return 401 INVALID_TOKEN when token does not exist', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token: '0'.repeat(64) })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 INVALID_TOKEN when token has already been used', async () => {
      const { token } = await registerAndGetToken('used-e2e@example.com');

      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);

      const response = await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 TOKEN_EXPIRED when token is expired', async () => {
      const { userId, token } = await registerAndGetToken(
        'expired-e2e@example.com',
      );

      await dataSource
        .getRepository(VerificationToken)
        .update(
          { user_id: userId },
          { expires_at: new Date(Date.now() - 60_000) },
        );

      const response = await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 401,
        error: 'TOKEN_EXPIRED',
        message: 'Token has expired',
      });
    });

    it('should return 400 VALIDATION_ERROR when token is missing or empty', async () => {
      const emptyResponse = await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token: '' })
        .expect(400);

      const emptyBody = emptyResponse.body as ErrorResponseBody;
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.error).toBe('VALIDATION_ERROR');
      expect(emptyBody.message).toEqual(
        expect.arrayContaining(['token should not be empty']),
      );

      const missingResponse = await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({})
        .expect(400);

      const missingBody = missingResponse.body as ErrorResponseBody;
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.error).toBe('VALIDATION_ERROR');
      expect(missingBody.message).toEqual(
        expect.arrayContaining([
          'token should not be empty',
          'token must be a string',
        ]),
      );
    });
  });

  describe('POST /auth/resend-confirmation', () => {
    it('should return 204, invalidate old token, and deliver new confirmation email', async () => {
      const { token: oldToken } = await registerAndGetToken(
        'resend-e2e@example.com',
      );
      await clearMailpitMessages();

      const response = await request(app.getHttpServer())
        .post('/auth/resend-confirmation')
        .send({ email: 'resend-e2e@example.com' })
        .expect(204);

      expect(response.text).toBe('');

      const newToken = await extractConfirmationToken();
      expect(newToken).not.toBe(oldToken);

      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token: oldToken })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token: newToken })
        .expect(204);
    });

    it('should return 204 without sending email when email is not registered', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/resend-confirmation')
        .send({ email: 'unknown-e2e@example.com' })
        .expect(204);

      expect(response.text).toBe('');
      expect(await getMailpitMessages()).toHaveLength(0);
    });

    it('should return 204 without sending email when user is already confirmed', async () => {
      const { token } = await registerAndGetToken('confirmed-e2e@example.com');
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);
      await clearMailpitMessages();

      const response = await request(app.getHttpServer())
        .post('/auth/resend-confirmation')
        .send({ email: 'confirmed-e2e@example.com' })
        .expect(204);

      expect(response.text).toBe('');
      expect(await getMailpitMessages()).toHaveLength(0);
    });

    it('should return 400 VALIDATION_ERROR when email format is invalid', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/resend-confirmation')
        .send({ email: 'not-an-email' })
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.message).toEqual(
        expect.arrayContaining(['email must be an email']),
      );
    });
  });

  describe('POST /auth/login', () => {
    const registerAndConfirmUser = async (
      email: string,
    ): Promise<{ userId: string }> => {
      const { userId, token } = await registerAndGetToken(email);
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);
      return { userId };
    };

    it('should return 200 with access_token and refresh_token for confirmed user and persist refresh token', async () => {
      const { userId } = await registerAndConfirmUser('login-e2e@example.com');

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'Login-E2E@Example.com',
          password: 'StrongPassword123',
        })
        .expect(200);

      const body = response.body as LoginResponseBody;
      expect(typeof body.access_token).toBe('string');
      expect(typeof body.refresh_token).toBe('string');

      const accessPayload = jwtService.verify<{
        sub: string;
        email: string;
      }>(body.access_token);
      expect(accessPayload.sub).toBe(userId);
      expect(accessPayload.email).toBe('login-e2e@example.com');

      const storedTokens = await dataSource.getRepository(RefreshToken).find({
        where: { user_id: userId },
      });
      expect(storedTokens).toHaveLength(1);
      expect(storedTokens[0].family).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(storedTokens[0].revoked_at).toBeNull();
    });

    it('should return 401 INVALID_CREDENTIALS for unknown email', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'StrongPassword123',
        })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 401,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    });

    it('should return 401 INVALID_CREDENTIALS for wrong password', async () => {
      await registerAndConfirmUser('wrong-pass@example.com');

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'wrong-pass@example.com',
          password: 'WrongPassword123',
        })
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 401,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    });

    it('should return 403 EMAIL_NOT_CONFIRMED for unconfirmed user', async () => {
      await registerAndGetToken('unconfirmed-e2e@example.com');

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'unconfirmed-e2e@example.com',
          password: 'StrongPassword123',
        })
        .expect(403);

      const body = response.body as ErrorResponseBody;
      expect(body).toEqual({
        statusCode: 403,
        error: 'EMAIL_NOT_CONFIRMED',
        message: 'Email not confirmed',
      });
    });

    it('should return 400 VALIDATION_ERROR when email is invalid or password is missing or empty', async () => {
      const invalidResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'not-an-email',
          password: '',
        })
        .expect(400);

      const invalidBody = invalidResponse.body as ErrorResponseBody;
      expect(invalidBody.statusCode).toBe(400);
      expect(invalidBody.error).toBe('VALIDATION_ERROR');
      expect(invalidBody.message).toEqual(
        expect.arrayContaining([
          'email must be an email',
          'password should not be empty',
        ]),
      );

      const missingPasswordResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'user@example.com',
        })
        .expect(400);

      const missingPasswordBody =
        missingPasswordResponse.body as ErrorResponseBody;
      expect(missingPasswordBody.statusCode).toBe(400);
      expect(missingPasswordBody.error).toBe('VALIDATION_ERROR');
      expect(missingPasswordBody.message).toEqual(
        expect.arrayContaining([
          'password should not be empty',
          'password must be a string',
        ]),
      );
    });
  });

  describe('JWT Access Token Guard & @Public()', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const { userId, token } = await registerAndGetToken(email);
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email,
          password: 'StrongPassword123',
        })
        .expect(200);

      const tokens = loginResponse.body as LoginResponseBody;
      return {
        userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should return 401 on protected endpoint when Authorization header is missing', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-protected/me')
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body.statusCode).toBe(401);
      expect(body.error).toBe('Unauthorized');
      expect(typeof body.message).toBe('string');
      expect((body.message as string).length).toBeGreaterThan(0);
    });

    it('should return 401 on protected endpoint when Bearer token is malformed or signed with refresh secret', async () => {
      const { refresh_token } = await registerConfirmAndLogin(
        'guard-invalid@example.com',
      );

      const malformedRes = await request(app.getHttpServer())
        .get('/test-protected/me')
        .set('Authorization', 'Bearer malformed-token')
        .expect(401);

      const malformedBody = malformedRes.body as ErrorResponseBody;
      expect(malformedBody.statusCode).toBe(401);
      expect(malformedBody.error).toBe('Unauthorized');
      expect(typeof malformedBody.message).toBe('string');

      const refreshSecretRes = await request(app.getHttpServer())
        .get('/test-protected/me')
        .set('Authorization', `Bearer ${refresh_token}`)
        .expect(401);

      const refreshSecretBody = refreshSecretRes.body as ErrorResponseBody;
      expect(refreshSecretBody.statusCode).toBe(401);
      expect(refreshSecretBody.error).toBe('Unauthorized');
      expect(typeof refreshSecretBody.message).toBe('string');
    });

    it('should return 401 on protected endpoint when Bearer JWT is expired', async () => {
      const { userId } = await registerConfirmAndLogin(
        'guard-expired@example.com',
      );
      const expiredToken = jwtService.sign(
        { sub: userId, email: 'guard-expired@example.com' },
        { expiresIn: '-1s' },
      );

      const response = await request(app.getHttpServer())
        .get('/test-protected/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      const body = response.body as ErrorResponseBody;
      expect(body.statusCode).toBe(401);
      expect(body.error).toBe('Unauthorized');
      expect(typeof body.message).toBe('string');
    });

    it('should return 200 with authenticated user payload on protected endpoint when access_token is valid', async () => {
      const { userId, access_token } = await registerConfirmAndLogin(
        'guard-valid@example.com',
      );

      const response = await request(app.getHttpServer())
        .get('/test-protected/me')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(response.body).toEqual({
        user: expect.objectContaining({
          sub: userId,
          email: 'guard-valid@example.com',
        }) as JwtPayload,
        userId,
      });
    });

    it('should allow unauthenticated access to @Public() routes even with a stale Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/')
        .expect(200)
        .expect('Hello World!');

      await request(app.getHttpServer())
        .get('/')
        .set('Authorization', 'Bearer stale-token')
        .expect(200)
        .expect('Hello World!');

      await request(app.getHttpServer())
        .post('/auth/register')
        .set('Authorization', 'Bearer stale-token')
        .send({
          email: 'guard-public-register@example.com',
          password: 'StrongPassword123',
        })
        .expect(201);
    });
  });

  describe('POST /auth/refresh', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const { userId, token } = await registerAndGetToken(email);
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email,
          password: 'StrongPassword123',
        })
        .expect(200);

      const tokens = loginResponse.body as LoginResponseBody;
      return {
        userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should return 200 with rotated tokens in the same family and revoke old token', async () => {
      const { userId, refresh_token: initialRefreshToken } =
        await registerConfirmAndLogin('refresh-e2e@example.com');

      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(200);

      const body = response.body as LoginResponseBody;
      expect(typeof body.access_token).toBe('string');
      expect(typeof body.refresh_token).toBe('string');
      expect(body.refresh_token).not.toBe(initialRefreshToken);

      await request(app.getHttpServer())
        .get('/test-protected/me')
        .set('Authorization', `Bearer ${body.access_token}`)
        .expect(200);

      const initialDecoded = jwtService.decode<{ family: string } | null>(
        initialRefreshToken,
      );
      const rotatedDecoded = jwtService.decode<{ family: string } | null>(
        body.refresh_token,
      );
      expect(rotatedDecoded?.family).toBe(initialDecoded?.family);

      const tokens = await dataSource.getRepository(RefreshToken).find({
        where: { user_id: userId },
        order: { created_at: 'ASC' },
      });
      expect(tokens).toHaveLength(2);
      expect(tokens[0].revoked_at).toBeInstanceOf(Date);
      expect(tokens[1].revoked_at).toBeNull();
    });

    it('should return 200 with active refresh token within 10s grace period without creating a third token', async () => {
      const { userId, refresh_token: initialRefreshToken } =
        await registerConfirmAndLogin('refresh-grace-e2e@example.com');

      const firstRefreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(200);
      const firstBody = firstRefreshRes.body as LoginResponseBody;

      const graceRefreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(200);
      const graceBody = graceRefreshRes.body as LoginResponseBody;

      expect(typeof graceBody.access_token).toBe('string');
      expect(graceBody.refresh_token).toBe(firstBody.refresh_token);

      const tokens = await dataSource.getRepository(RefreshToken).find({
        where: { user_id: userId },
      });
      expect(tokens).toHaveLength(2);
      expect(tokens.filter((token) => token.revoked_at === null)).toHaveLength(
        1,
      );

      await request(app.getHttpServer())
        .get('/test-protected/me')
        .set('Authorization', `Bearer ${graceBody.access_token}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: graceBody.refresh_token })
        .expect(200);
    });

    it('should return 401 TOKEN_REUSE_DETECTED and revoke entire family when reusing token beyond 10s grace period', async () => {
      const { userId, refresh_token: initialRefreshToken } =
        await registerConfirmAndLogin('refresh-reuse-e2e@example.com');

      const firstRefreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(200);
      const rotatedToken = (firstRefreshRes.body as LoginResponseBody)
        .refresh_token;

      const staleRevokedAt = new Date(Date.now() - 11_000);

      // Update only the first (already revoked) token's revoked_at to >10s ago
      const allTokens = await dataSource.getRepository(RefreshToken).find({
        where: { user_id: userId },
        order: { created_at: 'ASC' },
      });
      await dataSource
        .getRepository(RefreshToken)
        .update({ id: allTokens[0].id }, { revoked_at: staleRevokedAt });

      const reuseRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(401);

      expect(reuseRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'TOKEN_REUSE_DETECTED',
        message: 'Token reuse detected — all sessions revoked',
      });

      const tokensAfterReuse = await dataSource
        .getRepository(RefreshToken)
        .find({
          where: { user_id: userId },
        });
      expect(tokensAfterReuse).toHaveLength(2);
      expect(
        tokensAfterReuse.every((token) => token.revoked_at instanceof Date),
      ).toBe(true);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: rotatedToken })
        .expect(401);
    });

    it('should return 401 INVALID_TOKEN when refresh_token is unknown', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: 'unknown.refresh.token' })
        .expect(401);

      expect(response.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 TOKEN_EXPIRED when refresh_token is expired in database', async () => {
      const { userId, refresh_token } = await registerConfirmAndLogin(
        'refresh-expired-e2e@example.com',
      );

      await dataSource
        .getRepository(RefreshToken)
        .update(
          { user_id: userId },
          { expires_at: new Date(Date.now() - 60_000) },
        );

      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token })
        .expect(401);

      expect(response.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'TOKEN_EXPIRED',
        message: 'Token has expired',
      });
    });

    it('should return 400 VALIDATION_ERROR when refresh_token is missing, empty, or body has unknown properties', async () => {
      const emptyRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: '' })
        .expect(400);

      const emptyBody = emptyRes.body as ErrorResponseBody;
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.error).toBe('VALIDATION_ERROR');
      expect(emptyBody.message).toEqual(
        expect.arrayContaining(['refresh_token should not be empty']),
      );

      const missingRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({})
        .expect(400);

      const missingBody = missingRes.body as ErrorResponseBody;
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.error).toBe('VALIDATION_ERROR');
      expect(missingBody.message).toEqual(
        expect.arrayContaining([
          'refresh_token should not be empty',
          'refresh_token must be a string',
        ]),
      );

      const extraRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: 'some-token', extraField: 'nope' })
        .expect(400);

      const extraBody = extraRes.body as ErrorResponseBody;
      expect(extraBody.statusCode).toBe(400);
      expect(extraBody.error).toBe('VALIDATION_ERROR');
      expect(extraBody.message).toEqual(
        expect.arrayContaining(['property extraField should not exist']),
      );
    });

    it('should return 200 on POST /auth/refresh even when an expired Authorization Bearer header is attached', async () => {
      const { userId, refresh_token } = await registerConfirmAndLogin(
        'refresh-expired-bearer-e2e@example.com',
      );
      const expiredAccessToken = jwtService.sign(
        { sub: userId, email: 'refresh-expired-bearer-e2e@example.com' },
        { expiresIn: '-1s' },
      );

      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${expiredAccessToken}`)
        .send({ refresh_token })
        .expect(200);

      const body = response.body as LoginResponseBody;
      expect(typeof body.access_token).toBe('string');
      expect(typeof body.refresh_token).toBe('string');
    });
  });

  describe('POST /auth/logout', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const { userId, token } = await registerAndGetToken(email);
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email,
          password: 'StrongPassword123',
        })
        .expect(200);

      const tokens = loginResponse.body as LoginResponseBody;
      return {
        userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should return 204 with empty body and revoke all refresh tokens for the authenticated user', async () => {
      const { userId, access_token } = await registerConfirmAndLogin(
        'logout-e2e@example.com',
      );
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'logout-e2e@example.com',
          password: 'StrongPassword123',
        })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(204);

      expect(response.text).toBe('');

      const repeatResponse = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(204);

      expect(repeatResponse.text).toBe('');

      const storedTokens = await dataSource.getRepository(RefreshToken).find({
        where: { user_id: userId },
      });
      expect(storedTokens).toHaveLength(2);
      expect(
        storedTokens.every((token) => token.revoked_at instanceof Date),
      ).toBe(true);
    });

    it('should return 401 when Authorization header is missing', async () => {
      const missingRes = await request(app.getHttpServer())
        .post('/auth/logout')
        .expect(401);

      expect((missingRes.body as ErrorResponseBody).statusCode).toBe(401);
      expect((missingRes.body as ErrorResponseBody).error).toBe('Unauthorized');
    });

    it('should return 401 when Bearer token is malformed, expired, or signed with refresh secret without revoking stored tokens', async () => {
      const { userId, refresh_token } = await registerConfirmAndLogin(
        'logout-unauth-e2e@example.com',
      );

      const malformedRes = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);
      expect((malformedRes.body as ErrorResponseBody).statusCode).toBe(401);

      const refreshSecretRes = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${refresh_token}`)
        .expect(401);
      expect((refreshSecretRes.body as ErrorResponseBody).statusCode).toBe(401);

      const expiredAccessToken = jwtService.sign(
        { sub: userId, email: 'logout-unauth-e2e@example.com' },
        { expiresIn: '-1s' },
      );
      const expiredRes = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${expiredAccessToken}`)
        .expect(401);
      expect((expiredRes.body as ErrorResponseBody).statusCode).toBe(401);

      const storedToken = await dataSource
        .getRepository(RefreshToken)
        .findOneBy({ user_id: userId });
      expect(storedToken?.revoked_at).toBeNull();
    });

    it('should return 401 INVALID_TOKEN when refreshing within 10s grace period after logout (including rotated tokens)', async () => {
      const { access_token, refresh_token: initialRefreshToken } =
        await registerConfirmAndLogin('logout-grace-e2e@example.com');

      const rotateRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(200);
      const rotatedRefreshToken = (rotateRes.body as LoginResponseBody)
        .refresh_token;

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(204);

      const rotatedOutRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(401);
      expect(rotatedOutRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });

      const latestRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: rotatedRefreshToken })
        .expect(401);
      expect(latestRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 TOKEN_REUSE_DETECTED when refreshing a logged-out token beyond 10s grace period', async () => {
      const { userId, access_token, refresh_token } =
        await registerConfirmAndLogin('logout-reuse-e2e@example.com');

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(204);

      await dataSource
        .getRepository(RefreshToken)
        .update(
          { user_id: userId },
          { revoked_at: new Date(Date.now() - 11_000) },
        );

      const beyondGraceRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token })
        .expect(401);
      expect(beyondGraceRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'TOKEN_REUSE_DETECTED',
        message: 'Token reuse detected — all sessions revoked',
      });
    });

    it('should not affect refresh tokens belonging to other users', async () => {
      const userA = await registerConfirmAndLogin('logout-user-a@example.com');
      const userB = await registerConfirmAndLogin('logout-user-b@example.com');

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${userA.access_token}`)
        .expect(204);

      const userBRefreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: userB.refresh_token })
        .expect(200);

      const body = userBRefreshRes.body as LoginResponseBody;
      expect(typeof body.access_token).toBe('string');
      expect(typeof body.refresh_token).toBe('string');
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('should return 204 and deliver password reset email with channel name and reset link', async () => {
      await registerAndGetToken('forgot-e2e@example.com');
      await clearMailpitMessages();

      const response = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'Forgot-E2E@Example.com' })
        .expect(204);

      expect(response.text).toBe('');

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      expect(messages[0].To[0].Address).toBe('forgot-e2e@example.com');
      expect(messages[0].Subject).toBe(MAIL_SUBJECTS.PASSWORD_RESET);

      const detail = (await getMailpitMessage(
        messages[0].ID,
      )) as MailpitMessageDetail;
      expect(detail.HTML).toContain('forgote2e');
      expect(detail.HTML).toMatch(/\/auth\/reset-password\?token=[a-f0-9]{64}/);
    });

    it('should return 204 without sending email when email is not registered', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'unknown-forgot@example.com' })
        .expect(204);

      expect(response.text).toBe('');
      expect(await getMailpitMessages()).toHaveLength(0);
    });

    it('should invalidate previous unused reset token when requesting a new password reset', async () => {
      await registerAndGetToken('forgot-rotate@example.com');
      await clearMailpitMessages();

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'forgot-rotate@example.com' })
        .expect(204);
      const oldToken = await extractPasswordResetToken();
      await clearMailpitMessages();

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'forgot-rotate@example.com' })
        .expect(204);
      const newToken = await extractPasswordResetToken();
      expect(newToken).not.toBe(oldToken);

      const oldTokenRes = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: oldToken, new_password: 'NewStrongPassword456' })
        .expect(401);
      expect(oldTokenRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: newToken, new_password: 'NewStrongPassword456' })
        .expect(204);
    });

    it('should return 400 VALIDATION_ERROR when email format is invalid', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400);

      const body = response.body as ErrorResponseBody;
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.message).toEqual(
        expect.arrayContaining(['email must be an email']),
      );
    });
  });

  describe('POST /auth/reset-password', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const { userId, token } = await registerAndGetToken(email);
      await request(app.getHttpServer())
        .post('/auth/confirm-email')
        .send({ token })
        .expect(204);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email,
          password: 'StrongPassword123',
        })
        .expect(200);
      await clearMailpitMessages();

      const tokens = loginResponse.body as LoginResponseBody;
      return {
        userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should return 204 with empty body, allow login with new password, and reject old password with 401 INVALID_CREDENTIALS', async () => {
      await registerConfirmAndLogin('reset-e2e@example.com');

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'reset-e2e@example.com' })
        .expect(204);
      const resetToken = await extractPasswordResetToken();

      const resetRes = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: resetToken, new_password: 'NewStrongPassword456' })
        .expect(204);
      expect(resetRes.text).toBe('');

      const oldPasswordRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'reset-e2e@example.com',
          password: 'StrongPassword123',
        })
        .expect(401);
      expect(oldPasswordRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });

      const newPasswordRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'reset-e2e@example.com',
          password: 'NewStrongPassword456',
        })
        .expect(200);
      expect(
        typeof (newPasswordRes.body as LoginResponseBody).access_token,
      ).toBe('string');
    });

    it('should revoke all refresh tokens (including rotated families) and return 401 INVALID_TOKEN within 10s grace period', async () => {
      const { refresh_token: initialRefreshToken } =
        await registerConfirmAndLogin('reset-grace-e2e@example.com');

      const rotateRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(200);
      const rotatedRefreshToken = (rotateRes.body as LoginResponseBody)
        .refresh_token;

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'reset-grace-e2e@example.com' })
        .expect(204);
      const resetToken = await extractPasswordResetToken();

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: resetToken, new_password: 'NewStrongPassword456' })
        .expect(204);

      const initialRefreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken })
        .expect(401);
      expect(initialRefreshRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });

      const rotatedRefreshRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: rotatedRefreshToken })
        .expect(401);
      expect(rotatedRefreshRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 TOKEN_REUSE_DETECTED when refreshing a reset-revoked token beyond 10s grace period', async () => {
      const { userId, refresh_token } = await registerConfirmAndLogin(
        'reset-reuse-grace-e2e@example.com',
      );

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'reset-reuse-grace-e2e@example.com' })
        .expect(204);
      const resetToken = await extractPasswordResetToken();

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: resetToken, new_password: 'NewStrongPassword456' })
        .expect(204);

      await dataSource
        .getRepository(RefreshToken)
        .update(
          { user_id: userId },
          { revoked_at: new Date(Date.now() - 11_000) },
        );

      const refreshBeyondGraceRes = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token })
        .expect(401);
      expect(refreshBeyondGraceRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'TOKEN_REUSE_DETECTED',
        message: 'Token reuse detected — all sessions revoked',
      });
    });

    it('should allow POST /auth/forgot-password and POST /auth/reset-password even when an expired Authorization Bearer header is attached', async () => {
      const { userId } = await registerConfirmAndLogin(
        'reset-public-bearer-e2e@example.com',
      );
      const expiredAccessToken = jwtService.sign(
        { sub: userId, email: 'reset-public-bearer-e2e@example.com' },
        { expiresIn: '-1s' },
      );

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .set('Authorization', `Bearer ${expiredAccessToken}`)
        .send({ email: 'reset-public-bearer-e2e@example.com' })
        .expect(204);
      const resetToken = await extractPasswordResetToken();

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .set('Authorization', `Bearer ${expiredAccessToken}`)
        .send({ token: resetToken, new_password: 'NewStrongPassword456' })
        .expect(204);
    });

    it('should return 401 INVALID_TOKEN when token does not exist', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: '0'.repeat(64),
          new_password: 'NewStrongPassword456',
        })
        .expect(401);

      expect(response.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 INVALID_TOKEN when token has already been used', async () => {
      await registerAndGetToken('reset-used-e2e@example.com');
      await clearMailpitMessages();

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'reset-used-e2e@example.com' })
        .expect(204);
      const resetToken = await extractPasswordResetToken();

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: resetToken, new_password: 'NewStrongPassword456' })
        .expect(204);

      const secondRes = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: resetToken, new_password: 'AnotherPassword789' })
        .expect(401);

      expect(secondRes.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'INVALID_TOKEN',
        message: 'Invalid or already used token',
      });
    });

    it('should return 401 TOKEN_EXPIRED when token has expired', async () => {
      const { userId } = await registerAndGetToken(
        'reset-expired-e2e@example.com',
      );
      await clearMailpitMessages();

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'reset-expired-e2e@example.com' })
        .expect(204);
      const resetToken = await extractPasswordResetToken();

      await dataSource
        .getRepository(VerificationToken)
        .update(
          { user_id: userId, type: VerificationTokenType.PASSWORD_RESET },
          { expires_at: new Date(Date.now() - 60_000) },
        );

      const response = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: resetToken, new_password: 'NewStrongPassword456' })
        .expect(401);

      expect(response.body as ErrorResponseBody).toEqual({
        statusCode: 401,
        error: 'TOKEN_EXPIRED',
        message: 'Token has expired',
      });
    });

    it('should return 400 VALIDATION_ERROR for invalid payload fields', async () => {
      const emptyRes = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: '', new_password: 'short' })
        .expect(400);

      const emptyBody = emptyRes.body as ErrorResponseBody;
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.error).toBe('VALIDATION_ERROR');
      expect(emptyBody.message).toEqual(
        expect.arrayContaining([
          'token should not be empty',
          'new_password must be longer than or equal to 8 characters',
        ]),
      );

      const missingTokenRes = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ new_password: 'NewStrongPassword456' })
        .expect(400);

      const missingTokenBody = missingTokenRes.body as ErrorResponseBody;
      expect(missingTokenBody.statusCode).toBe(400);
      expect(missingTokenBody.error).toBe('VALIDATION_ERROR');
      expect(missingTokenBody.message).toEqual(
        expect.arrayContaining([
          'token should not be empty',
          'token must be a string',
        ]),
      );

      const longPasswordRes = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: 'valid-token',
          new_password: 'a'.repeat(129),
          extraField: 'nope',
        })
        .expect(400);

      const longPasswordBody = longPasswordRes.body as ErrorResponseBody;
      expect(longPasswordBody.statusCode).toBe(400);
      expect(longPasswordBody.error).toBe('VALIDATION_ERROR');
      expect(longPasswordBody.message).toEqual(
        expect.arrayContaining([
          'new_password must be shorter than or equal to 128 characters',
          'property extraField should not exist',
        ]),
      );
    });
  });

  describe('Rate Limiting on Auth Endpoints', () => {
    it('should allow 10 requests within 60s to a public auth endpoint and return 429 Too Many Requests on the 11th request', async () => {
      for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/auth/forgot-password')
          .send({ email: 'rate-limit@example.com' })
          .expect(204);

        expect(res.headers['x-ratelimit-limit']).toBe(
          String(AUTH_THROTTLE_LIMIT),
        );
        expect(res.headers['x-ratelimit-remaining']).toBe(
          String(AUTH_THROTTLE_LIMIT - 1 - i),
        );
      }

      const throttledRes = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'rate-limit@example.com' })
        .expect(429);

      expect(throttledRes.headers['retry-after']).toBeDefined();
      expect(
        throttledRes.body as { statusCode: number; message: string },
      ).toEqual({
        statusCode: 429,
        message: 'ThrottlerException: Too Many Requests',
      });
    });

    it('should enforce rate limiting on authenticated POST /auth/logout before JwtAuthGuard', async () => {
      for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
        await request(app.getHttpServer()).post('/auth/logout').expect(401);
      }

      await request(app.getHttpServer()).post('/auth/logout').expect(429);
    });

    it('should return 429 on the 11th authenticated POST /auth/logout request within 60s', async () => {
      const accessToken = jwtService.sign({
        sub: '00000000-0000-4000-8000-000000000002',
        email: 'logout-throttle@example.com',
      });

      for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/logout')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(204);
      }

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(429);
    });

    it('should not rate-limit public non-auth endpoint GET / even after an auth endpoint is throttled', async () => {
      for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'nobody@example.com', password: 'WrongPassword123' })
          .expect(401);
      }

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'WrongPassword123' })
        .expect(429);

      for (let i = 0; i < AUTH_THROTTLE_LIMIT + 5; i += 1) {
        const rootRes = await request(app.getHttpServer())
          .get('/')
          .expect(200)
          .expect('Hello World!');

        expect(rootRes.headers['x-ratelimit-limit']).toBeUndefined();
      }
    });

    it('should not rate-limit authenticated non-auth endpoints (@SkipThrottle) even after an auth endpoint is throttled', async () => {
      for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'nobody@example.com', password: 'WrongPassword123' })
          .expect(401);
      }

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'WrongPassword123' })
        .expect(429);

      const accessToken = jwtService.sign({
        sub: '00000000-0000-4000-8000-000000000001',
        email: 'viewer@example.com',
      });

      for (let i = 0; i < AUTH_THROTTLE_LIMIT + 5; i += 1) {
        const protectedRes = await request(app.getHttpServer())
          .get('/test-protected/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(protectedRes.headers['x-ratelimit-limit']).toBeUndefined();
      }
    });

    it('should not allow bypassing rate limit via spoofed X-Forwarded-For header when trust proxy is disabled', async () => {
      for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/forgot-password')
          .send({ email: 'spoof@example.com' })
          .expect(204);
      }

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.99')
        .send({ email: 'spoof@example.com' })
        .expect(429);
    });

    it('should track rate limits per client IP (default ThrottlerGuard behavior)', async () => {
      const expressApp = app.getHttpAdapter().getInstance() as Express;

      expressApp.set('trust proxy', true);
      try {
        for (let i = 0; i < AUTH_THROTTLE_LIMIT; i += 1) {
          await request(app.getHttpServer())
            .post('/auth/forgot-password')
            .set('X-Forwarded-For', '203.0.113.10')
            .send({ email: 'per-ip@example.com' })
            .expect(204);
        }

        await request(app.getHttpServer())
          .post('/auth/forgot-password')
          .set('X-Forwarded-For', '203.0.113.10')
          .send({ email: 'per-ip@example.com' })
          .expect(429);

        const secondIpRes = await request(app.getHttpServer())
          .post('/auth/forgot-password')
          .set('X-Forwarded-For', '203.0.113.20')
          .send({ email: 'per-ip@example.com' })
          .expect(204);

        expect(secondIpRes.headers['x-ratelimit-remaining']).toBe(
          String(AUTH_THROTTLE_LIMIT - 1),
        );
      } finally {
        expressApp.set('trust proxy', false);
      }
    });
  });
});
