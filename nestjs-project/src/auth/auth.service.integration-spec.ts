import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
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
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
} from '../common/exceptions/domain.exception';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import { MAIL_SUBJECTS } from '../mail/mail.constants';
import { Channel } from '../users/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
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
  let usersService: UsersService;
  let jwtService: JwtService;
  let authCfg: ConfigType<typeof authConfig>;
  let dataSource: DataSource;
  let refreshTokenRepository: Repository<RefreshToken>;
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
    usersService = moduleRef.get(UsersService);
    jwtService = moduleRef.get(JwtService);
    authCfg = moduleRef.get<ConfigType<typeof authConfig>>(authConfig.KEY);
    dataSource = moduleRef.get(DataSource);
    refreshTokenRepository = moduleRef.get<Repository<RefreshToken>>(
      getRepositoryToken(RefreshToken),
    );
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

  const extractConfirmationTokenFromLatestEmail = async (): Promise<string> => {
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

  describe('confirm', () => {
    it('should confirm user and mark verification token as used in database', async () => {
      const registered = await authService.register({
        email: 'confirm@example.com',
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();

      await authService.confirm(rawToken);

      const user = await dataSource
        .getRepository(User)
        .findOneBy({ id: registered.id });
      const tokens = await verificationTokenRepository.find({
        where: { user_id: registered.id },
      });

      expect(user?.is_confirmed).toBe(true);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].used_at).toBeInstanceOf(Date);
    });

    it('should throw InvalidTokenException when reusing an already-consumed confirmation token', async () => {
      await authService.register({
        email: 'reuse@example.com',
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();

      await authService.confirm(rawToken);

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        InvalidTokenException,
      );
    });

    it('should throw TokenExpiredException when token is expired and keep user unconfirmed', async () => {
      const registered = await authService.register({
        email: 'expired@example.com',
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();

      await verificationTokenRepository.update(
        { user_id: registered.id },
        { expires_at: new Date(Date.now() - 60_000) },
      );

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        TokenExpiredException,
      );

      const user = await dataSource
        .getRepository(User)
        .findOneBy({ id: registered.id });
      const token = await verificationTokenRepository.findOneBy({
        user_id: registered.id,
      });
      expect(user?.is_confirmed).toBe(false);
      expect(token?.used_at).toBeNull();
    });

    it('should throw InvalidTokenException if a password_reset token is passed to confirm', async () => {
      const registered = await authService.register({
        email: 'reset-type@example.com',
        password: 'MySecretPassword123',
      });
      const rawResetToken = 'b'.repeat(64);
      const resetHash = createHash('sha256')
        .update(rawResetToken)
        .digest('hex');

      await verificationTokenRepository.save(
        verificationTokenRepository.create({
          token_hash: resetHash,
          type: VerificationTokenType.PASSWORD_RESET,
          user_id: registered.id,
          expires_at: new Date(Date.now() + 60_000),
          used_at: null,
        }),
      );

      await expect(authService.confirm(rawResetToken)).rejects.toThrow(
        InvalidTokenException,
      );
    });

    it('should roll back verification token used_at when markEmailConfirmed fails inside transaction', async () => {
      const registered = await authService.register({
        email: 'confirm-tx-rollback@example.com',
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();

      jest
        .spyOn(usersService, 'markEmailConfirmed')
        .mockRejectedValueOnce(new Error('Confirm update failed'));

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        'Confirm update failed',
      );

      const user = await dataSource
        .getRepository(User)
        .findOneBy({ id: registered.id });
      const token = await verificationTokenRepository.findOneBy({
        user_id: registered.id,
      });
      expect(user?.is_confirmed).toBe(false);
      expect(token?.used_at).toBeNull();
    });
  });

  describe('resendConfirmation', () => {
    it('should invalidate previous confirmation tokens, persist a new token, and send a new email', async () => {
      const registered = await authService.register({
        email: 'resend@example.com',
        password: 'MySecretPassword123',
      });
      const firstToken = await extractConfirmationTokenFromLatestEmail();

      await clearMailpitMessages();
      await authService.resendConfirmation('  Resend@Example.com  ');

      const secondToken = await extractConfirmationTokenFromLatestEmail();
      expect(secondToken).not.toBe(firstToken);

      const tokens = await verificationTokenRepository.find({
        where: {
          user_id: registered.id,
          type: VerificationTokenType.EMAIL_CONFIRMATION,
        },
        order: { created_at: 'ASC' },
      });
      expect(tokens).toHaveLength(2);

      const firstHash = createHash('sha256').update(firstToken).digest('hex');
      const secondHash = createHash('sha256').update(secondToken).digest('hex');
      const invalidated = tokens.find((t) => t.token_hash === firstHash);
      const active = tokens.find((t) => t.token_hash === secondHash);

      expect(invalidated?.used_at).toBeInstanceOf(Date);
      expect(active?.used_at).toBeNull();

      await expect(authService.confirm(firstToken)).rejects.toThrow(
        InvalidTokenException,
      );
      await expect(authService.confirm(secondToken)).resolves.toBeUndefined();
    });

    it('should not invalidate unused password_reset tokens when resending confirmation', async () => {
      const registered = await authService.register({
        email: 'keep-reset@example.com',
        password: 'MySecretPassword123',
      });
      const resetToken = await verificationTokenRepository.save(
        verificationTokenRepository.create({
          token_hash: createHash('sha256').update('c'.repeat(64)).digest('hex'),
          type: VerificationTokenType.PASSWORD_RESET,
          user_id: registered.id,
          expires_at: new Date(Date.now() + 60_000),
          used_at: null,
        }),
      );

      await authService.resendConfirmation('keep-reset@example.com');

      const reloadedResetToken = await verificationTokenRepository.findOneBy({
        id: resetToken.id,
      });
      expect(reloadedResetToken?.used_at).toBeNull();
    });

    it('should return silently without creating tokens or sending email for unknown or already-confirmed users', async () => {
      const registered = await authService.register({
        email: 'confirmed@example.com',
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();
      await authService.confirm(rawToken);
      await clearMailpitMessages();

      await expect(
        authService.resendConfirmation('missing@example.com'),
      ).resolves.toBeUndefined();
      await expect(
        authService.resendConfirmation('confirmed@example.com'),
      ).resolves.toBeUndefined();

      expect(
        await verificationTokenRepository.count({
          where: { user_id: registered.id },
        }),
      ).toBe(1);
      expect(await getMailpitMessages()).toHaveLength(0);
    });
  });

  describe('login', () => {
    const registerConfirmedUser = async (
      email: string,
      password = 'MySecretPassword123',
    ): Promise<{ id: string; email: string }> => {
      const registered = await authService.register({ email, password });
      const rawToken = await extractConfirmationTokenFromLatestEmail();
      await authService.confirm(rawToken);
      return registered;
    };

    it('should return verifiable access and refresh tokens and persist refresh token in database', async () => {
      const registered = await registerConfirmedUser('login-int@example.com');

      const result = await authService.login({
        email: '  Login-Int@Example.com  ',
        password: 'MySecretPassword123',
      });

      const accessPayload = jwtService.verify<{
        sub: string;
        email: string;
      }>(result.access_token);
      expect(accessPayload.sub).toBe(registered.id);
      expect(accessPayload.email).toBe('login-int@example.com');

      const refreshPayload = jwtService.verify<{
        sub: string;
        family: string;
        jti: string;
        exp: number;
      }>(result.refresh_token, { secret: authCfg.jwtRefreshSecret });
      expect(refreshPayload.sub).toBe(registered.id);
      expect(refreshPayload.family).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const expectedHash = createHash('sha256')
        .update(result.refresh_token)
        .digest('hex');
      const storedToken = await refreshTokenRepository.findOneBy({
        token_hash: expectedHash,
      });
      expect(storedToken).not.toBeNull();
      expect(storedToken?.user_id).toBe(registered.id);
      expect(storedToken?.family).toBe(refreshPayload.family);
      expect(storedToken?.revoked_at).toBeNull();
      expect(storedToken?.expires_at.getTime()).toBe(refreshPayload.exp * 1000);
    });

    it('should create distinct rotation families on consecutive logins', async () => {
      const registered = await registerConfirmedUser('multi-login@example.com');

      const first = await authService.login({
        email: 'multi-login@example.com',
        password: 'MySecretPassword123',
      });
      const second = await authService.login({
        email: 'multi-login@example.com',
        password: 'MySecretPassword123',
      });

      const firstRefresh = jwtService.verify<{ family: string }>(
        first.refresh_token,
        { secret: authCfg.jwtRefreshSecret },
      );
      const secondRefresh = jwtService.verify<{ family: string }>(
        second.refresh_token,
        { secret: authCfg.jwtRefreshSecret },
      );

      expect(firstRefresh.family).not.toBe(secondRefresh.family);
      expect(
        await refreshTokenRepository.count({
          where: { user_id: registered.id },
        }),
      ).toBe(2);
    });

    it('should reject unknown email, wrong password, and unconfirmed user without persisting refresh tokens', async () => {
      await authService.register({
        email: 'unconfirmed-login@example.com',
        password: 'MySecretPassword123',
      });

      await expect(
        authService.login({
          email: 'unknown-login@example.com',
          password: 'MySecretPassword123',
        }),
      ).rejects.toThrow(InvalidCredentialsException);

      await expect(
        authService.login({
          email: 'unconfirmed-login@example.com',
          password: 'WrongPassword123',
        }),
      ).rejects.toThrow(InvalidCredentialsException);

      await expect(
        authService.login({
          email: 'unconfirmed-login@example.com',
          password: 'MySecretPassword123',
        }),
      ).rejects.toThrow(EmailNotConfirmedException);

      expect(await refreshTokenRepository.count()).toBe(0);
    });
  });
});
