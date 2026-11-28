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
  TokenReuseDetectedException,
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

  const extractPasswordResetTokenFromLatestEmail =
    async (): Promise<string> => {
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

  describe('refresh', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const registered = await authService.register({
        email,
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();
      await authService.confirm(rawToken);
      const tokens = await authService.login({
        email,
        password: 'MySecretPassword123',
      });
      return {
        userId: registered.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should rotate refresh token in database, preserve family, and allow chaining next refresh', async () => {
      const { userId, refresh_token: token1 } = await registerConfirmAndLogin(
        'refresh-int@example.com',
      );

      const rotated1 = await authService.refresh(token1);
      expect(rotated1.refresh_token).not.toBe(token1);

      const payload1 = jwtService.verify<{ family: string }>(token1, {
        secret: authCfg.jwtRefreshSecret,
      });
      const payload2 = jwtService.verify<{ family: string }>(
        rotated1.refresh_token,
        { secret: authCfg.jwtRefreshSecret },
      );
      expect(payload2.family).toBe(payload1.family);

      const accessPayload = jwtService.verify<{ sub: string; email: string }>(
        rotated1.access_token,
      );
      expect(accessPayload.sub).toBe(userId);
      expect(accessPayload.email).toBe('refresh-int@example.com');

      const tokensAfterFirst = await refreshTokenRepository.find({
        where: { user_id: userId },
        order: { created_at: 'ASC' },
      });
      expect(tokensAfterFirst).toHaveLength(2);
      expect(tokensAfterFirst[0].revoked_at).toBeInstanceOf(Date);
      expect(tokensAfterFirst[1].revoked_at).toBeNull();
      expect(tokensAfterFirst[1].token_hash).toBe(
        createHash('sha256').update(rotated1.refresh_token).digest('hex'),
      );

      const rotated2 = await authService.refresh(rotated1.refresh_token);
      expect(rotated2.refresh_token).not.toBe(rotated1.refresh_token);
      expect(
        await refreshTokenRepository.count({ where: { user_id: userId } }),
      ).toBe(3);
    });

    it('should throw TokenExpiredException when refresh token is expired in database', async () => {
      const { userId, refresh_token } = await registerConfirmAndLogin(
        'refresh-expired-int@example.com',
      );

      await refreshTokenRepository.update(
        { user_id: userId },
        { expires_at: new Date(Date.now() - 60_000) },
      );

      await expect(authService.refresh(refresh_token)).rejects.toThrow(
        TokenExpiredException,
      );

      const stored = await refreshTokenRepository.findOneBy({
        user_id: userId,
      });
      expect(stored?.revoked_at).toBeNull();
    });

    it('should return active refresh token within 10s grace period without creating extra rows or revoking family', async () => {
      const { userId, refresh_token: token1 } = await registerConfirmAndLogin(
        'refresh-grace-int@example.com',
      );

      const rotated1 = await authService.refresh(token1);
      const graceResult = await authService.refresh(token1);

      expect(graceResult.refresh_token).toBe(rotated1.refresh_token);
      expect(
        jwtService.verify<{ sub: string }>(graceResult.access_token).sub,
      ).toBe(userId);

      const tokens = await refreshTokenRepository.find({
        where: { user_id: userId },
        order: { created_at: 'ASC' },
      });
      expect(tokens).toHaveLength(2);
      expect(tokens[1].revoked_at).toBeNull();

      await expect(
        authService.refresh(rotated1.refresh_token),
      ).resolves.toBeDefined();
    });

    it('should handle concurrent refresh calls safely with exactly one new token persisted', async () => {
      const { userId, refresh_token: token1 } = await registerConfirmAndLogin(
        'refresh-concurrent-int@example.com',
      );

      const [resA, resB] = await Promise.all([
        authService.refresh(token1),
        authService.refresh(token1),
      ]);

      expect(resA.refresh_token).toBe(resB.refresh_token);

      const tokens = await refreshTokenRepository.find({
        where: { user_id: userId },
      });
      expect(tokens).toHaveLength(2);
      expect(tokens.filter((t) => t.revoked_at === null)).toHaveLength(1);
    });

    it('should persist family revocation when token is reused beyond 10s grace period without affecting other families', async () => {
      const { userId, refresh_token: familyAToken1 } =
        await registerConfirmAndLogin('refresh-reuse-int@example.com');
      const otherLogin = await authService.login({
        email: 'refresh-reuse-int@example.com',
        password: 'MySecretPassword123',
      });

      await authService.refresh(familyAToken1);

      const familyAHash1 = createHash('sha256')
        .update(familyAToken1)
        .digest('hex');
      await refreshTokenRepository.update(
        { token_hash: familyAHash1 },
        { revoked_at: new Date(Date.now() - 11_000) },
      );

      await expect(authService.refresh(familyAToken1)).rejects.toThrow(
        TokenReuseDetectedException,
      );

      const familyADecoded = jwtService.verify<{ family: string }>(
        familyAToken1,
        { secret: authCfg.jwtRefreshSecret },
      );
      const familyBDecoded = jwtService.verify<{ family: string }>(
        otherLogin.refresh_token,
        { secret: authCfg.jwtRefreshSecret },
      );

      const familyATokens = await refreshTokenRepository.find({
        where: { user_id: userId, family: familyADecoded.family },
      });
      expect(familyATokens).toHaveLength(2);
      expect(
        familyATokens.every((token) => token.revoked_at instanceof Date),
      ).toBe(true);

      const familyBTokens = await refreshTokenRepository.find({
        where: { user_id: userId, family: familyBDecoded.family },
      });
      expect(familyBTokens).toHaveLength(1);
      expect(familyBTokens[0].revoked_at).toBeNull();
    });

    it('should throw InvalidTokenException when refresh token is not found in database', async () => {
      await expect(
        authService.refresh('unknown-refresh-token'),
      ).rejects.toThrow(InvalidTokenException);
    });

    it('should roll back old token revocation when saving new refresh token fails inside transaction', async () => {
      const { userId, refresh_token: token1 } = await registerConfirmAndLogin(
        'refresh-rollback-int@example.com',
      );

      const invalidNewToken = Object.assign(new RefreshToken(), {
        token_hash: 'failed-hash',
        family: '00000000-0000-0000-0000-000000000000',
        user_id: '00000000-0000-0000-0000-000000000000',
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: null,
      });

      jest
        .spyOn(refreshTokenRepository, 'create')
        .mockReturnValueOnce(invalidNewToken);

      await expect(authService.refresh(token1)).rejects.toThrow();

      const storedTokens = await refreshTokenRepository.find({
        where: { user_id: userId },
      });
      expect(storedTokens).toHaveLength(1);
      expect(storedTokens[0].revoked_at).toBeNull();
    });
  });

  describe('logout', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const registered = await authService.register({
        email,
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();
      await authService.confirm(rawToken);
      const tokens = await authService.login({
        email,
        password: 'MySecretPassword123',
      });
      return {
        userId: registered.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should set revoked_at on all active refresh tokens across multiple families while preserving prior revoked_at timestamps', async () => {
      const { userId, refresh_token: session1Token1 } =
        await registerConfirmAndLogin('logout-multi-int@example.com');
      await authService.login({
        email: 'logout-multi-int@example.com',
        password: 'MySecretPassword123',
      });

      await authService.refresh(session1Token1);

      const priorRevokedAt = new Date(Date.now() - 5_000);
      const session1Token1Hash = createHash('sha256')
        .update(session1Token1)
        .digest('hex');
      await refreshTokenRepository.update(
        { token_hash: session1Token1Hash },
        { revoked_at: priorRevokedAt },
      );

      await authService.logout(userId);

      const allTokens = await refreshTokenRepository.find({
        where: { user_id: userId },
      });
      expect(allTokens).toHaveLength(3);
      expect(allTokens.every((token) => token.revoked_at instanceof Date)).toBe(
        true,
      );

      const previouslyRevoked = allTokens.find(
        (token) => token.token_hash === session1Token1Hash,
      );
      expect(previouslyRevoked?.revoked_at?.getTime()).toBe(
        priorRevokedAt.getTime(),
      );
    });

    it('should reject post-logout refresh within 10s grace period with InvalidTokenException for both rotated and latest tokens', async () => {
      const { userId, refresh_token: token1 } = await registerConfirmAndLogin(
        'logout-grace-int@example.com',
      );
      const { refresh_token: token2 } = await authService.refresh(token1);

      await authService.logout(userId);

      await expect(authService.refresh(token1)).rejects.toThrow(
        InvalidTokenException,
      );
      await expect(authService.refresh(token2)).rejects.toThrow(
        InvalidTokenException,
      );
    });

    it('should reject post-logout refresh beyond 10s grace period with TokenReuseDetectedException', async () => {
      const { userId, refresh_token } = await registerConfirmAndLogin(
        'logout-reuse-int@example.com',
      );

      await authService.logout(userId);

      const tokenHash = createHash('sha256')
        .update(refresh_token)
        .digest('hex');
      await refreshTokenRepository.update(
        { token_hash: tokenHash },
        { revoked_at: new Date(Date.now() - 11_000) },
      );

      await expect(authService.refresh(refresh_token)).rejects.toThrow(
        TokenReuseDetectedException,
      );
    });

    it('should not revoke refresh tokens belonging to other users', async () => {
      const userA = await registerConfirmAndLogin(
        'logout-user-a-int@example.com',
      );
      const userB = await registerConfirmAndLogin(
        'logout-user-b-int@example.com',
      );

      await authService.logout(userA.userId);

      const userATokens = await refreshTokenRepository.find({
        where: { user_id: userA.userId },
      });
      expect(userATokens).toHaveLength(1);
      expect(userATokens[0].revoked_at).toBeInstanceOf(Date);

      const userBTokens = await refreshTokenRepository.find({
        where: { user_id: userB.userId },
      });
      expect(userBTokens).toHaveLength(1);
      expect(userBTokens[0].revoked_at).toBeNull();

      await expect(
        authService.refresh(userB.refresh_token),
      ).resolves.toBeDefined();
    });
  });

  describe('forgotPassword', () => {
    it('should persist password_reset token and deliver email with channel name and matching SHA-256 token', async () => {
      const registered = await authService.register({
        email: 'forgot@example.com',
        password: 'MySecretPassword123',
      });
      await clearMailpitMessages();

      await authService.forgotPassword('  Forgot@Example.com  ');

      const resetTokens = await verificationTokenRepository.find({
        where: {
          user_id: registered.id,
          type: VerificationTokenType.PASSWORD_RESET,
        },
      });
      expect(resetTokens).toHaveLength(1);
      expect(resetTokens[0].used_at).toBeNull();
      expect(resetTokens[0].expires_at.getTime()).toBeGreaterThan(Date.now());

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      expect(messages[0].To[0].Address).toBe('forgot@example.com');
      expect(messages[0].Subject).toBe(MAIL_SUBJECTS.PASSWORD_RESET);

      const detail = (await getMailpitMessage(
        messages[0].ID,
      )) as MailpitMessageDetail;
      expect(detail.HTML).toContain('forgot');
      const rawToken = await extractPasswordResetTokenFromLatestEmail();
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(resetTokens[0].token_hash).toBe(expectedHash);
    });

    it('should invalidate previous unused password_reset tokens without invalidating email_confirmation tokens', async () => {
      const registered = await authService.register({
        email: 'forgot-invalidate@example.com',
        password: 'MySecretPassword123',
      });
      await clearMailpitMessages();

      await authService.forgotPassword('forgot-invalidate@example.com');
      const firstResetToken = await extractPasswordResetTokenFromLatestEmail();
      await clearMailpitMessages();

      await authService.forgotPassword('forgot-invalidate@example.com');
      const secondResetToken = await extractPasswordResetTokenFromLatestEmail();
      expect(secondResetToken).not.toBe(firstResetToken);

      const resetTokens = await verificationTokenRepository.find({
        where: {
          user_id: registered.id,
          type: VerificationTokenType.PASSWORD_RESET,
        },
      });
      expect(resetTokens).toHaveLength(2);

      const firstHash = createHash('sha256')
        .update(firstResetToken)
        .digest('hex');
      const secondHash = createHash('sha256')
        .update(secondResetToken)
        .digest('hex');
      expect(
        resetTokens.find((t) => t.token_hash === firstHash)?.used_at,
      ).toBeInstanceOf(Date);
      expect(
        resetTokens.find((t) => t.token_hash === secondHash)?.used_at,
      ).toBeNull();

      const confirmationToken = await verificationTokenRepository.findOneBy({
        user_id: registered.id,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
      });
      expect(confirmationToken?.used_at).toBeNull();
    });

    it('should return silently without creating tokens or sending email for unknown email', async () => {
      await expect(
        authService.forgotPassword('missing@example.com'),
      ).resolves.toBeUndefined();

      expect(await verificationTokenRepository.count()).toBe(0);
      expect(await getMailpitMessages()).toHaveLength(0);
    });
  });

  describe('resetPassword', () => {
    const registerConfirmAndLogin = async (
      email: string,
    ): Promise<{
      userId: string;
      access_token: string;
      refresh_token: string;
    }> => {
      const registered = await authService.register({
        email,
        password: 'MySecretPassword123',
      });
      const rawToken = await extractConfirmationTokenFromLatestEmail();
      await authService.confirm(rawToken);
      const tokens = await authService.login({
        email,
        password: 'MySecretPassword123',
      });
      await clearMailpitMessages();
      return {
        userId: registered.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      };
    };

    it('should update password hash, mark token used, and revoke all user refresh tokens without affecting other users', async () => {
      const userA = await registerConfirmAndLogin('reset-user-a@example.com');
      const userB = await registerConfirmAndLogin('reset-user-b@example.com');

      await authService.forgotPassword('reset-user-a@example.com');
      const resetToken = await extractPasswordResetTokenFromLatestEmail();

      await authService.resetPassword(resetToken, 'NewSecretPassword456');

      const reloadedUserA = await usersService.findByEmail(
        'reset-user-a@example.com',
      );
      expect(
        await argon2.verify(
          reloadedUserA?.password ?? '',
          'NewSecretPassword456',
        ),
      ).toBe(true);

      const usedToken = await verificationTokenRepository.findOneBy({
        user_id: userA.userId,
        type: VerificationTokenType.PASSWORD_RESET,
      });
      expect(usedToken?.used_at).toBeInstanceOf(Date);

      const userARefreshTokens = await refreshTokenRepository.find({
        where: { user_id: userA.userId },
      });
      expect(userARefreshTokens).toHaveLength(1);
      expect(userARefreshTokens[0].revoked_at).toBeInstanceOf(Date);

      const userBRefreshTokens = await refreshTokenRepository.find({
        where: { user_id: userB.userId },
      });
      expect(userBRefreshTokens).toHaveLength(1);
      expect(userBRefreshTokens[0].revoked_at).toBeNull();
    });

    it('should allow login with new password and reject old password with InvalidCredentialsException after resetPassword', async () => {
      await registerConfirmAndLogin('reset-login-int@example.com');
      await authService.forgotPassword('reset-login-int@example.com');
      const resetToken = await extractPasswordResetTokenFromLatestEmail();

      await authService.resetPassword(resetToken, 'NewSecretPassword456');

      await expect(
        authService.login({
          email: 'reset-login-int@example.com',
          password: 'MySecretPassword123',
        }),
      ).rejects.toThrow(InvalidCredentialsException);

      const loginResult = await authService.login({
        email: 'reset-login-int@example.com',
        password: 'NewSecretPassword456',
      });
      expect(typeof loginResult.access_token).toBe('string');
      expect(typeof loginResult.refresh_token).toBe('string');
    });

    it('should reject post-reset refresh within 10s grace period with InvalidTokenException for both rotated and latest tokens', async () => {
      const { refresh_token: token1 } = await registerConfirmAndLogin(
        'reset-grace-int@example.com',
      );
      const { refresh_token: token2 } = await authService.refresh(token1);

      await authService.forgotPassword('reset-grace-int@example.com');
      const resetToken = await extractPasswordResetTokenFromLatestEmail();
      await authService.resetPassword(resetToken, 'NewSecretPassword456');

      await expect(authService.refresh(token1)).rejects.toThrow(
        InvalidTokenException,
      );
      await expect(authService.refresh(token2)).rejects.toThrow(
        InvalidTokenException,
      );
    });

    it('should throw InvalidTokenException when password_reset token is unknown', async () => {
      await expect(
        authService.resetPassword('0'.repeat(64), 'NewSecretPassword456'),
      ).rejects.toThrow(InvalidTokenException);
    });

    it('should throw InvalidTokenException when passing an email_confirmation token to resetPassword', async () => {
      await authService.register({
        email: 'reset-wrong-type-int@example.com',
        password: 'MySecretPassword123',
      });
      const confirmToken = await extractConfirmationTokenFromLatestEmail();

      await expect(
        authService.resetPassword(confirmToken, 'NewSecretPassword456'),
      ).rejects.toThrow(InvalidTokenException);
    });

    it('should throw InvalidTokenException when reusing an already-consumed password_reset token', async () => {
      const registered = await authService.register({
        email: 'reset-reuse-int@example.com',
        password: 'MySecretPassword123',
      });
      const confirmToken = await extractConfirmationTokenFromLatestEmail();
      await authService.confirm(confirmToken);
      await clearMailpitMessages();

      await authService.forgotPassword('reset-reuse-int@example.com');
      const resetToken = await extractPasswordResetTokenFromLatestEmail();
      await authService.resetPassword(resetToken, 'NewSecretPassword456');

      await expect(
        authService.resetPassword(resetToken, 'AnotherPassword789'),
      ).rejects.toThrow(InvalidTokenException);

      const reloadedUser = await usersService.findByEmail(
        'reset-reuse-int@example.com',
      );
      expect(reloadedUser?.id).toBe(registered.id);
      expect(
        await argon2.verify(
          reloadedUser?.password ?? '',
          'NewSecretPassword456',
        ),
      ).toBe(true);
    });

    it('should throw TokenExpiredException when password_reset token is expired without updating password or revoking refresh tokens', async () => {
      const { userId } = await registerConfirmAndLogin(
        'reset-expired-int@example.com',
      );
      await authService.forgotPassword('reset-expired-int@example.com');
      const resetToken = await extractPasswordResetTokenFromLatestEmail();

      await verificationTokenRepository.update(
        { user_id: userId, type: VerificationTokenType.PASSWORD_RESET },
        { expires_at: new Date(Date.now() - 60_000) },
      );

      await expect(
        authService.resetPassword(resetToken, 'NewSecretPassword456'),
      ).rejects.toThrow(TokenExpiredException);

      const reloadedUser = await usersService.findByEmail(
        'reset-expired-int@example.com',
      );
      expect(
        await argon2.verify(
          reloadedUser?.password ?? '',
          'MySecretPassword123',
        ),
      ).toBe(true);

      const refreshTokens = await refreshTokenRepository.find({
        where: { user_id: userId },
      });
      expect(refreshTokens[0].revoked_at).toBeNull();
    });

    it('should roll back token used_at and refresh token revocation when updatePassword fails inside transaction', async () => {
      const { userId } = await registerConfirmAndLogin(
        'reset-rollback-int@example.com',
      );
      await authService.forgotPassword('reset-rollback-int@example.com');
      const resetToken = await extractPasswordResetTokenFromLatestEmail();

      jest
        .spyOn(usersService, 'updatePassword')
        .mockRejectedValueOnce(new Error('Password update failed'));

      await expect(
        authService.resetPassword(resetToken, 'NewSecretPassword456'),
      ).rejects.toThrow('Password update failed');

      const storedResetToken = await verificationTokenRepository.findOneBy({
        user_id: userId,
        type: VerificationTokenType.PASSWORD_RESET,
      });
      expect(storedResetToken?.used_at).toBeNull();

      const refreshTokens = await refreshTokenRepository.find({
        where: { user_id: userId },
      });
      expect(refreshTokens[0].revoked_at).toBeNull();

      const reloadedUser = await usersService.findByEmail(
        'reset-rollback-int@example.com',
      );
      expect(
        await argon2.verify(
          reloadedUser?.password ?? '',
          'MySecretPassword123',
        ),
      ).toBe(true);
    });
  });
});
