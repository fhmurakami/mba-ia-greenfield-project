import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  clearTestTables,
  getTestTypeOrmOptions,
} from '../../test/create-test-data-source';
import {
  clearMailpitMessages,
  getMailpitMessage,
  getMailpitMessages,
} from '../../test/mailpit';
import { EmailAlreadyExistsException } from '../common/exceptions/domain.exception';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import { MAIL_SUBJECTS } from '../mail/mail.constants';
import { Channel } from '../users/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

interface MailpitMessageDetail {
  ID: string;
  HTML: string;
}

describe('AuthService (integration)', () => {
  jest.setTimeout(15000);

  let moduleRef: TestingModule;
  let authService: AuthService;
  let dataSource: DataSource;
  let verificationTokenRepository: Repository<VerificationToken>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, databaseConfig, authConfig, mailConfig],
        }),
        TypeOrmModule.forRoot(
          getTestTypeOrmOptions([
            User,
            Channel,
            VerificationToken,
            RefreshToken,
          ]),
        ),
        AuthModule,
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    dataSource = moduleRef.get(DataSource);
    verificationTokenRepository = moduleRef.get<Repository<VerificationToken>>(
      getRepositoryToken(VerificationToken),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await clearTestTables(dataSource);
    await clearMailpitMessages();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it('should persist unconfirmed user with Argon2 password hash and sanitized channel', async () => {
      const result = await authService.register({
        email: 'creator@example.com',
        password: 'MySecretPassword123',
      });

      expect(result.id).toBeDefined();
      expect(result.email).toBe('creator@example.com');

      const user = await dataSource
        .getRepository(User)
        .createQueryBuilder('user')
        .addSelect('user.password')
        .leftJoinAndSelect('user.channel', 'channel')
        .where('user.id = :id', { id: result.id })
        .getOne();

      expect(user).not.toBeNull();
      expect(user?.is_confirmed).toBe(false);
      expect(
        await argon2.verify(user?.password ?? '', 'MySecretPassword123'),
      ).toBe(true);
      expect(user?.channel?.nickname).toBe('creator');
    });

    it('should persist email_confirmation verification token with future expiration', async () => {
      const result = await authService.register({
        email: 'token@example.com',
        password: 'MySecretPassword123',
      });

      const tokens = await verificationTokenRepository.find({
        where: { user_id: result.id },
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe(VerificationTokenType.EMAIL_CONFIRMATION);
      expect(tokens[0].used_at).toBeNull();
      expect(tokens[0].expires_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('should deliver confirmation email whose raw token matches stored SHA-256 token_hash', async () => {
      const result = await authService.register({
        email: 'mailer@example.com',
        password: 'MySecretPassword123',
      });

      const tokens = await verificationTokenRepository.find({
        where: { user_id: result.id },
      });
      expect(tokens).toHaveLength(1);

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      expect(messages[0].To[0].Address).toBe('mailer@example.com');
      expect(messages[0].Subject).toBe(MAIL_SUBJECTS.CONFIRMATION);

      const detail = (await getMailpitMessage(
        messages[0].ID,
      )) as MailpitMessageDetail;
      const match = /\/auth\/confirm-email\?token=([a-f0-9]{64})/.exec(
        detail.HTML,
      );
      expect(match).not.toBeNull();

      const rawToken = match![1];
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(tokens[0].token_hash).toBe(expectedHash);
    });

    it('should normalize email with trim and lowercase when persisting and sending confirmation email', async () => {
      const result = await authService.register({
        email: '  Alice@Example.com  ',
        password: 'MySecretPassword123',
      });

      expect(result.email).toBe('alice@example.com');

      const user = await dataSource
        .getRepository(User)
        .findOneBy({ id: result.id });
      expect(user?.email).toBe('alice@example.com');

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      expect(messages[0].To[0].Address).toBe('alice@example.com');
    });

    it('should throw EmailAlreadyExistsException when registering a duplicate email', async () => {
      await authService.register({
        email: 'dup@example.com',
        password: 'MySecretPassword123',
      });

      await expect(
        authService.register({
          email: 'dup@example.com',
          password: 'AnotherPassword123',
        }),
      ).rejects.toThrow(EmailAlreadyExistsException);
    });

    it('should treat Alice@Example.com and alice@example.com as the same email and throw EmailAlreadyExistsException', async () => {
      await authService.register({
        email: 'alice@example.com',
        password: 'MySecretPassword123',
      });

      await expect(
        authService.register({
          email: 'Alice@Example.com',
          password: 'AnotherPassword123',
        }),
      ).rejects.toThrow(EmailAlreadyExistsException);

      await expect(
        authService.register({
          email: '  ALICE@example.com  ',
          password: 'AnotherPassword123',
        }),
      ).rejects.toThrow(EmailAlreadyExistsException);
    });

    it('should roll back user and channel and not send email when verification token save fails', async () => {
      const invalidToken = Object.assign(new VerificationToken(), {
        token_hash: 'invalid-hash',
        type: 'invalid_type' as VerificationTokenType,
        user_id: '00000000-0000-0000-0000-000000000000',
        expires_at: new Date(Date.now() + 60_000),
        used_at: null,
      });

      jest
        .spyOn(verificationTokenRepository, 'create')
        .mockReturnValueOnce(invalidToken);

      await expect(
        authService.register({
          email: 'tx-rollback@example.com',
          password: 'MySecretPassword123',
        }),
      ).rejects.toThrow();

      expect(await dataSource.getRepository(User).count()).toBe(0);
      expect(await dataSource.getRepository(Channel).count()).toBe(0);
      expect(await verificationTokenRepository.count()).toBe(0);
      expect(await getMailpitMessages()).toHaveLength(0);
    });
  });
});
