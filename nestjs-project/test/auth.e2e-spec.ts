import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MAIL_SUBJECTS } from '../src/mail/mail.constants';
import { Channel } from '../src/users/entities/channel.entity';
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await clearTestTables(dataSource);
    await clearMailpitMessages();
  });

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
});
