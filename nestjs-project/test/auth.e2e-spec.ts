import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { RefreshToken } from '../src/auth/entities/refresh-token.entity';
import { VerificationToken } from '../src/auth/entities/verification-token.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
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

describe('AuthController (e2e)', () => {
  jest.setTimeout(15000);

  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );

    await app.init();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
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
});
