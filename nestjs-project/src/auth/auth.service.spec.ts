import { createHash, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { ConfigType } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  Repository,
  UpdateResult,
} from 'typeorm';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import { MailService } from '../mail/mail.service';
import { Channel } from '../users/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  AUTH_THROTTLE_LIMIT,
  AUTH_THROTTLE_TTL_MS,
  REFRESH_GRACE_PERIOD_MS,
} from './auth.constants';
import type { JwtPayload, RefreshTokenPayload } from './auth.types';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

const mockAuthConfig: ConfigType<typeof authConfig> = {
  jwtSecret: 'test-secret',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtAccessExpiration: '15m',
  jwtRefreshExpiration: '7d',
  confirmationTokenExpirationHours: 2,
  passwordResetTokenExpirationHours: 1,
  throttleTtlMs: AUTH_THROTTLE_TTL_MS,
  throttleLimit: AUTH_THROTTLE_LIMIT,
};

describe('AuthService (unit)', () => {
  let moduleRef: TestingModule;
  let authService: AuthService;
  let jwtService: JwtService;
  let validPasswordHash: string;
  let usersService: jest.Mocked<
    Pick<
      UsersService,
      | 'existsByEmail'
      | 'createUserWithChannel'
      | 'findByEmail'
      | 'findById'
      | 'markEmailConfirmed'
      | 'updatePassword'
    >
  >;
  let mailService: jest.Mocked<
    Pick<MailService, 'sendConfirmationEmail' | 'sendPasswordResetEmail'>
  >;
  let refreshTokenRepository: jest.Mocked<
    Pick<Repository<RefreshToken>, 'create' | 'save' | 'findOne' | 'update'>
  >;
  let verificationTokenRepository: jest.Mocked<
    Pick<Repository<VerificationToken>, 'create' | 'findOne'>
  >;
  let entityManager: jest.Mocked<Pick<EntityManager, 'save' | 'update'>>;
  let dataSource: jest.Mocked<Pick<DataSource, 'transaction'>>;

  beforeAll(async () => {
    validPasswordHash = await argon2.hash('StrongPassword123');
    usersService = {
      existsByEmail: jest.fn(),
      createUserWithChannel: jest.fn(),
      findByEmail: jest.fn(),
      findById: jest.fn(),
      markEmailConfirmed: jest.fn(),
      updatePassword: jest.fn(),
    };
    mailService = {
      sendConfirmationEmail: jest.fn(),
      sendPasswordResetEmail: jest.fn(),
    };
    refreshTokenRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    };
    verificationTokenRepository = {
      create: jest.fn(),
      findOne: jest.fn(),
    };
    entityManager = {
      save: jest.fn(),
      update: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: mockAuthConfig.jwtSecret,
          signOptions: {
            expiresIn: mockAuthConfig.jwtAccessExpiration,
          },
        }),
      ],
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: usersService,
        },
        {
          provide: MailService,
          useValue: mailService,
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokenRepository,
        },
        {
          provide: getRepositoryToken(VerificationToken),
          useValue: verificationTokenRepository,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: authConfig.KEY,
          useValue: mockAuthConfig,
        },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    usersService.existsByEmail.mockReset();
    usersService.createUserWithChannel.mockReset();
    usersService.findByEmail.mockReset();
    usersService.findById.mockReset();
    usersService.markEmailConfirmed.mockReset();
    usersService.updatePassword.mockReset();
    mailService.sendConfirmationEmail.mockReset();
    mailService.sendPasswordResetEmail.mockReset();
    refreshTokenRepository.create.mockReset();
    refreshTokenRepository.save.mockReset();
    refreshTokenRepository.findOne.mockReset();
    refreshTokenRepository.update.mockReset();
    verificationTokenRepository.create.mockReset();
    verificationTokenRepository.findOne.mockReset();
    entityManager.save.mockReset();
    entityManager.update.mockReset();
    dataSource.transaction.mockReset();

    usersService.markEmailConfirmed.mockResolvedValue(undefined);
    usersService.updatePassword.mockResolvedValue(undefined);

    refreshTokenRepository.create.mockImplementation((entityLike) =>
      Object.assign(new RefreshToken(), entityLike),
    );
    refreshTokenRepository.save.mockImplementation((entity) =>
      Promise.resolve(Object.assign(new RefreshToken(), entity)),
    );
    refreshTokenRepository.update.mockResolvedValue({
      affected: 1,
      raw: [],
      generatedMaps: [],
    } satisfies UpdateResult);
    verificationTokenRepository.create.mockImplementation((entityLike) =>
      Object.assign(new VerificationToken(), entityLike),
    );
    entityManager.save.mockImplementation(
      (targetOrEntity: unknown, entity?: unknown) =>
        targetOrEntity === RefreshToken
          ? Promise.resolve(Object.assign(new RefreshToken(), entity))
          : Promise.resolve(Object.assign(new VerificationToken(), entity)),
    );
    entityManager.update.mockResolvedValue({
      affected: 1,
      raw: [],
      generatedMaps: [],
    } satisfies UpdateResult);
    dataSource.transaction.mockImplementation(
      (
        isolationOrCb: string | ((manager: EntityManager) => Promise<unknown>),
        maybeCb?: (manager: EntityManager) => Promise<unknown>,
      ) => {
        const cb =
          typeof isolationOrCb === 'function' ? isolationOrCb : maybeCb;
        if (!cb) {
          throw new Error('Expected transaction callback');
        }
        return cb(entityManager as unknown as EntityManager);
      },
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register', () => {
    const setupValidRegistrationMocks = (): void => {
      usersService.existsByEmail.mockResolvedValueOnce(false);

      const createdChannel = Object.assign(new Channel(), {
        id: 'channel-uuid-1',
        name: 'alice',
        nickname: 'alice',
        description: null,
        user_id: 'user-uuid-1',
      });

      const createdUser = Object.assign(new User(), {
        id: 'user-uuid-1',
        email: 'alice@example.com',
        is_confirmed: false,
        channel: createdChannel,
      });

      usersService.createUserWithChannel.mockResolvedValueOnce(createdUser);
      mailService.sendConfirmationEmail.mockResolvedValueOnce(undefined);
    };

    it('should return user id and email on successful registration', async () => {
      setupValidRegistrationMocks();

      const result = await authService.register({
        email: 'alice@example.com',
        password: 'StrongPassword123',
      });

      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'alice@example.com',
      });
    });

    it('should normalize email with trim and lowercase before checking existence, persisting, and sending confirmation email', async () => {
      setupValidRegistrationMocks();

      const result = await authService.register({
        email: '  Alice@Example.com  ',
        password: 'StrongPassword123',
      });

      expect(usersService.existsByEmail).toHaveBeenCalledWith(
        'alice@example.com',
      );
      expect(usersService.createUserWithChannel).toHaveBeenCalledWith(
        'alice@example.com',
        expect.any(String),
        entityManager,
      );
      expect(mailService.sendConfirmationEmail).toHaveBeenCalledWith(
        'alice@example.com',
        'alice',
        expect.any(String),
      );
      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'alice@example.com',
      });
    });

    it('should hash password with Argon2 and pass EntityManager to createUserWithChannel inside transaction', async () => {
      setupValidRegistrationMocks();

      await authService.register({
        email: 'alice@example.com',
        password: 'StrongPassword123',
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(usersService.createUserWithChannel).toHaveBeenCalledTimes(1);
      const [passedEmail, passedHash, passedManager] =
        usersService.createUserWithChannel.mock.calls[0];
      expect(passedEmail).toBe('alice@example.com');
      expect(passedHash).not.toBe('StrongPassword123');
      expect(await argon2.verify(passedHash, 'StrongPassword123')).toBe(true);
      expect(passedManager).toBe(entityManager);
    });

    it('should create and save SHA-256 confirmation token in transaction and send email afterwards', async () => {
      setupValidRegistrationMocks();
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      await authService.register({
        email: 'alice@example.com',
        password: 'StrongPassword123',
      });

      expect(mailService.sendConfirmationEmail).toHaveBeenCalledTimes(1);
      const [mailTo, mailName, rawToken] =
        mailService.sendConfirmationEmail.mock.calls[0];
      expect(mailTo).toBe('alice@example.com');
      expect(mailName).toBe('alice');
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/);

      expect(verificationTokenRepository.create).toHaveBeenCalledTimes(1);
      const createResult = verificationTokenRepository.create.mock.results[0];
      if (createResult.type !== 'return') {
        throw new Error(
          'Expected verificationTokenRepository.create to return',
        );
      }
      const createdToken = createResult.value;

      expect(entityManager.save).toHaveBeenCalledTimes(1);
      expect(entityManager.save).toHaveBeenCalledWith(
        VerificationToken,
        createdToken,
      );
      expect(entityManager.save.mock.calls[0][1]).toBe(createdToken);

      const expectedHash = createHash('sha256').update(rawToken).digest('hex');
      expect(createdToken.token_hash).toBe(expectedHash);
      expect(createdToken.type).toBe(VerificationTokenType.EMAIL_CONFIRMATION);
      expect(createdToken.user_id).toBe('user-uuid-1');
      expect(createdToken.used_at).toBeNull();
      expect(createdToken.expires_at).toEqual(
        new Date(
          fixedNow +
            mockAuthConfig.confirmationTokenExpirationHours * 60 * 60 * 1000,
        ),
      );
    });

    it('should throw EmailAlreadyExistsException when existsByEmail returns true for normalized email without calling transaction or side effects', async () => {
      usersService.existsByEmail.mockResolvedValueOnce(true);

      await expect(
        authService.register({
          email: 'Alice@Example.com',
          password: 'StrongPassword123',
        }),
      ).rejects.toThrow(EmailAlreadyExistsException);

      expect(usersService.existsByEmail).toHaveBeenCalledWith(
        'alice@example.com',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.createUserWithChannel).not.toHaveBeenCalled();
      expect(verificationTokenRepository.create).not.toHaveBeenCalled();
      expect(entityManager.save).not.toHaveBeenCalled();
      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });

    it('should propagate EmailAlreadyExistsException from createUserWithChannel on race condition', async () => {
      usersService.existsByEmail.mockResolvedValueOnce(false);
      usersService.createUserWithChannel.mockRejectedValueOnce(
        new EmailAlreadyExistsException(),
      );

      await expect(
        authService.register({
          email: 'alice@example.com',
          password: 'StrongPassword123',
        }),
      ).rejects.toThrow(EmailAlreadyExistsException);

      expect(verificationTokenRepository.create).not.toHaveBeenCalled();
      expect(entityManager.save).not.toHaveBeenCalled();
      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });

    it('should propagate unexpected errors from createUserWithChannel without saving token or sending email', async () => {
      const unexpectedError = new Error('Database connection lost');
      usersService.existsByEmail.mockResolvedValueOnce(false);
      usersService.createUserWithChannel.mockRejectedValueOnce(unexpectedError);

      await expect(
        authService.register({
          email: 'alice@example.com',
          password: 'StrongPassword123',
        }),
      ).rejects.toBe(unexpectedError);

      expect(entityManager.save).not.toHaveBeenCalled();
      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });

    it('should propagate error when saving verification token fails and not send confirmation email', async () => {
      usersService.existsByEmail.mockResolvedValueOnce(false);
      usersService.createUserWithChannel.mockResolvedValueOnce(
        Object.assign(new User(), {
          id: 'user-uuid-1',
          email: 'alice@example.com',
          channel: Object.assign(new Channel(), {
            id: 'channel-uuid-1',
            name: 'alice',
            nickname: 'alice',
          }),
        }),
      );
      const tokenSaveError = new Error('Token persistence failed');
      entityManager.save.mockRejectedValueOnce(tokenSaveError);

      await expect(
        authService.register({
          email: 'alice@example.com',
          password: 'StrongPassword123',
        }),
      ).rejects.toBe(tokenSaveError);

      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    const rawToken = 'a'.repeat(64);
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');

    it('should mark verification token as used and confirm user inside transaction', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const tokenRecord = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 60_000),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(tokenRecord);

      await authService.confirm(rawToken);

      expect(verificationTokenRepository.findOne).toHaveBeenCalledWith({
        where: {
          token_hash: expectedHash,
          type: VerificationTokenType.EMAIL_CONFIRMATION,
        },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(entityManager.update).toHaveBeenCalledTimes(1);
      expect(entityManager.update).toHaveBeenCalledWith(
        VerificationToken,
        { id: 'token-uuid-1', used_at: IsNull() },
        { used_at: new Date(fixedNow) },
      );
      expect(usersService.markEmailConfirmed).toHaveBeenCalledTimes(1);
      expect(usersService.markEmailConfirmed).toHaveBeenCalledWith(
        'user-uuid-1',
        entityManager,
      );
    });

    it('should throw InvalidTokenException when token is not found', async () => {
      verificationTokenRepository.findOne.mockResolvedValueOnce(null);

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        InvalidTokenException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.markEmailConfirmed).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException when token was already used even if also expired', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const usedToken = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow - 60_000),
        used_at: new Date(fixedNow - 120_000),
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(usedToken);

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        InvalidTokenException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.markEmailConfirmed).not.toHaveBeenCalled();
    });

    it('should throw TokenExpiredException when unused token is expired at boundary', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const expiredToken = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(expiredToken);

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        TokenExpiredException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.markEmailConfirmed).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException on concurrent consumption without updating user', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const tokenRecord = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 60_000),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(tokenRecord);
      entityManager.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      } satisfies UpdateResult);

      await expect(authService.confirm(rawToken)).rejects.toThrow(
        InvalidTokenException,
      );

      expect(entityManager.update).toHaveBeenCalledTimes(1);
      expect(usersService.markEmailConfirmed).not.toHaveBeenCalled();
    });

    it('should propagate error when markEmailConfirmed fails inside transaction', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const tokenRecord = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 60_000),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(tokenRecord);
      const confirmError = new Error('User confirmation update failed');
      usersService.markEmailConfirmed.mockRejectedValueOnce(confirmError);

      await expect(authService.confirm(rawToken)).rejects.toBe(confirmError);
    });
  });

  describe('resendConfirmation', () => {
    const createUnconfirmedUser = (): User =>
      Object.assign(new User(), {
        id: 'user-uuid-1',
        email: 'alice@example.com',
        is_confirmed: false,
        channel: Object.assign(new Channel(), {
          id: 'channel-uuid-1',
          name: 'alice',
          nickname: 'alice',
        }),
      });

    it('should invalidate unused confirmation tokens, create new token, and send confirmation email', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      usersService.findByEmail.mockResolvedValueOnce(createUnconfirmedUser());
      mailService.sendConfirmationEmail.mockResolvedValueOnce(undefined);

      await authService.resendConfirmation('  Alice@Example.com  ');

      expect(usersService.findByEmail).toHaveBeenCalledWith(
        'alice@example.com',
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(entityManager.update).toHaveBeenCalledWith(
        VerificationToken,
        {
          user_id: 'user-uuid-1',
          type: VerificationTokenType.EMAIL_CONFIRMATION,
          used_at: IsNull(),
        },
        { used_at: new Date(fixedNow) },
      );

      expect(mailService.sendConfirmationEmail).toHaveBeenCalledTimes(1);
      const [mailTo, mailName, rawToken] =
        mailService.sendConfirmationEmail.mock.calls[0];
      expect(mailTo).toBe('alice@example.com');
      expect(mailName).toBe('alice');
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/);

      expect(verificationTokenRepository.create).toHaveBeenCalledTimes(1);
      const createResult = verificationTokenRepository.create.mock.results[0];
      if (createResult.type !== 'return') {
        throw new Error(
          'Expected verificationTokenRepository.create to return',
        );
      }
      const createdToken = createResult.value;

      expect(entityManager.save).toHaveBeenCalledWith(
        VerificationToken,
        createdToken,
      );
      expect(createdToken.token_hash).toBe(
        createHash('sha256').update(rawToken).digest('hex'),
      );
      expect(createdToken.type).toBe(VerificationTokenType.EMAIL_CONFIRMATION);
      expect(createdToken.user_id).toBe('user-uuid-1');
      expect(createdToken.used_at).toBeNull();
      expect(createdToken.expires_at).toEqual(
        new Date(
          fixedNow +
            mockAuthConfig.confirmationTokenExpirationHours * 60 * 60 * 1000,
        ),
      );
    });

    it('should return silently when email is not found', async () => {
      usersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        authService.resendConfirmation('unknown@example.com'),
      ).resolves.toBeUndefined();

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(entityManager.save).not.toHaveBeenCalled();
      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });

    it('should return silently when user is already confirmed', async () => {
      const confirmedUser = Object.assign(createUnconfirmedUser(), {
        is_confirmed: true,
      });
      usersService.findByEmail.mockResolvedValueOnce(confirmedUser);

      await expect(
        authService.resendConfirmation('alice@example.com'),
      ).resolves.toBeUndefined();

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(entityManager.save).not.toHaveBeenCalled();
      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });

    it('should propagate error when saving new token fails and not send email', async () => {
      usersService.findByEmail.mockResolvedValueOnce(createUnconfirmedUser());
      const saveError = new Error('Token save failed');
      entityManager.save.mockRejectedValueOnce(saveError);

      await expect(
        authService.resendConfirmation('alice@example.com'),
      ).rejects.toBe(saveError);

      expect(mailService.sendConfirmationEmail).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const createUserForLogin = (isConfirmed = true): User =>
      Object.assign(new User(), {
        id: 'user-uuid-1',
        email: 'alice@example.com',
        password: validPasswordHash,
        is_confirmed: isConfirmed,
      });

    it('should normalize email, issue signed access and refresh tokens, and persist hashed refresh token', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
      usersService.findByEmail.mockResolvedValueOnce(createUserForLogin(true));

      const result = await authService.login({
        email: '  Alice@Example.com  ',
        password: 'StrongPassword123',
      });

      expect(usersService.findByEmail).toHaveBeenCalledWith(
        'alice@example.com',
      );

      const accessPayload = jwtService.verify<Required<JwtPayload>>(
        result.access_token,
      );
      expect(accessPayload.sub).toBe('user-uuid-1');
      expect(accessPayload.email).toBe('alice@example.com');
      expect(accessPayload.exp - accessPayload.iat).toBe(15 * 60);

      const refreshPayload = jwtService.verify<Required<RefreshTokenPayload>>(
        result.refresh_token,
        { secret: mockAuthConfig.jwtRefreshSecret },
      );
      expect(refreshPayload.sub).toBe('user-uuid-1');
      expect(refreshPayload.family).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(refreshPayload.jti).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(refreshPayload.exp - refreshPayload.iat).toBe(7 * 24 * 60 * 60);

      expect(() =>
        jwtService.verify<object>(result.refresh_token, {
          secret: mockAuthConfig.jwtSecret,
        }),
      ).toThrow();

      const expectedHash = createHash('sha256')
        .update(result.refresh_token)
        .digest('hex');

      expect(refreshTokenRepository.create).toHaveBeenCalledWith({
        token_hash: expectedHash,
        family: refreshPayload.family,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 7 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });
      expect(refreshTokenRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should throw InvalidCredentialsException when user is not found', async () => {
      usersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        authService.login({
          email: 'unknown@example.com',
          password: 'StrongPassword123',
        }),
      ).rejects.toThrow(InvalidCredentialsException);

      expect(refreshTokenRepository.save).not.toHaveBeenCalled();
    });

    it('should throw InvalidCredentialsException when password does not match even if user is unconfirmed', async () => {
      usersService.findByEmail.mockResolvedValueOnce(createUserForLogin(false));

      await expect(
        authService.login({
          email: 'alice@example.com',
          password: 'WrongPassword123',
        }),
      ).rejects.toThrow(InvalidCredentialsException);

      expect(refreshTokenRepository.save).not.toHaveBeenCalled();
    });

    it('should throw EmailNotConfirmedException when password matches but user is unconfirmed', async () => {
      usersService.findByEmail.mockResolvedValueOnce(createUserForLogin(false));

      await expect(
        authService.login({
          email: 'alice@example.com',
          password: 'StrongPassword123',
        }),
      ).rejects.toThrow(EmailNotConfirmedException);

      expect(refreshTokenRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const userId = 'user-uuid-1';
    const userEmail = 'alice@example.com';

    const createUserForRefresh = (): User =>
      Object.assign(new User(), {
        id: userId,
        email: userEmail,
        is_confirmed: true,
      });

    const signTestRefreshJwt = (
      family: string,
      secret = mockAuthConfig.jwtRefreshSecret,
      expiresIn = mockAuthConfig.jwtRefreshExpiration,
    ): string => {
      const payload: RefreshTokenPayload = {
        sub: userId,
        family,
        jti: randomUUID(),
      };
      return jwtService.sign(payload, {
        secret,
        expiresIn,
      });
    };

    const createStoredRefreshToken = (
      rawToken: string,
      family: string,
      overrides: Partial<RefreshToken> = {},
    ): RefreshToken =>
      Object.assign(new RefreshToken(), {
        id: 'refresh-uuid-1',
        token_hash: createHash('sha256').update(rawToken).digest('hex'),
        family,
        user_id: userId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revoked_at: null,
        ...overrides,
      });

    it('should rotate valid refresh token inside transaction and issue new tokens in the same family', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const rawToken = signTestRefreshJwt(family);
      const storedToken = createStoredRefreshToken(rawToken, family, {
        expires_at: new Date(fixedNow + 60_000),
      });

      refreshTokenRepository.findOne.mockResolvedValueOnce(storedToken);
      usersService.findById.mockResolvedValueOnce(createUserForRefresh());

      const result = await authService.refresh(rawToken);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(entityManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { id: storedToken.id, revoked_at: IsNull() },
        { revoked_at: new Date(fixedNow) },
      );
      expect(entityManager.save).toHaveBeenCalledTimes(1);
      expect(result.refresh_token).not.toBe(rawToken);

      const accessPayload = jwtService.verify<JwtPayload>(result.access_token);
      expect(accessPayload.sub).toBe(userId);
      expect(accessPayload.email).toBe(userEmail);

      const rotatedPayload = jwtService.verify<Required<RefreshTokenPayload>>(
        result.refresh_token,
        { secret: mockAuthConfig.jwtRefreshSecret },
      );
      expect(rotatedPayload.sub).toBe(userId);
      expect(rotatedPayload.family).toBe(family);

      const expectedNewHash = createHash('sha256')
        .update(result.refresh_token)
        .digest('hex');
      expect(refreshTokenRepository.create).toHaveBeenCalledWith({
        token_hash: expectedNewHash,
        family,
        user_id: userId,
        expires_at: new Date(rotatedPayload.exp * 1000),
        revoked_at: null,
      });
    });

    it('should throw InvalidTokenException when token_hash is not found', async () => {
      refreshTokenRepository.findOne.mockResolvedValueOnce(null);

      await expect(authService.refresh('missing-token')).rejects.toThrow(
        InvalidTokenException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should throw TokenExpiredException when expires_at is at or before now', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const rawToken = signTestRefreshJwt(family);
      const expiredToken = createStoredRefreshToken(rawToken, family, {
        expires_at: new Date(fixedNow),
      });

      refreshTokenRepository.findOne.mockResolvedValueOnce(expiredToken);

      await expect(authService.refresh(rawToken)).rejects.toThrow(
        TokenExpiredException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException when JWT signature is invalid', async () => {
      const family = randomUUID();
      const wrongSecretToken = signTestRefreshJwt(
        family,
        mockAuthConfig.jwtSecret,
      );
      const storedToken = createStoredRefreshToken(wrongSecretToken, family);

      refreshTokenRepository.findOne.mockResolvedValueOnce(storedToken);

      await expect(authService.refresh(wrongSecretToken)).rejects.toThrow(
        InvalidTokenException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException when user is not found', async () => {
      const family = randomUUID();
      const rawToken = signTestRefreshJwt(family);
      const storedToken = createStoredRefreshToken(rawToken, family);

      refreshTokenRepository.findOne.mockResolvedValueOnce(storedToken);
      usersService.findById.mockResolvedValueOnce(null);

      await expect(authService.refresh(rawToken)).rejects.toThrow(
        InvalidTokenException,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should return valid access_token and active refresh_token within 10s grace period without creating another token or revoking family', async () => {
      const t0 = new Date('2026-11-27T12:00:00.000Z').getTime();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

      const family = randomUUID();
      const token1 = signTestRefreshJwt(family);
      const storedToken1 = createStoredRefreshToken(token1, family, {
        expires_at: new Date(t0 + 7 * 24 * 60 * 60 * 1000),
      });

      refreshTokenRepository.findOne.mockResolvedValueOnce(storedToken1);
      usersService.findById.mockResolvedValueOnce(createUserForRefresh());

      const firstRotation = await authService.refresh(token1);
      const token2 = firstRotation.refresh_token;
      const token2Hash = createHash('sha256').update(token2).digest('hex');

      dateNowSpy.mockReturnValue(t0 + REFRESH_GRACE_PERIOD_MS);
      const revokedToken1 = createStoredRefreshToken(token1, family, {
        revoked_at: new Date(t0),
        expires_at: new Date(t0 + 7 * 24 * 60 * 60 * 1000),
      });
      const activeToken2 = Object.assign(new RefreshToken(), {
        id: 'refresh-uuid-2',
        token_hash: token2Hash,
        family,
        user_id: userId,
        expires_at: new Date(t0 + 7 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      refreshTokenRepository.findOne
        .mockResolvedValueOnce(revokedToken1)
        .mockResolvedValueOnce(activeToken2);
      usersService.findById.mockResolvedValueOnce(createUserForRefresh());

      const graceResult = await authService.refresh(token1);

      expect(graceResult.refresh_token).toBe(token2);
      expect(jwtService.verify<JwtPayload>(graceResult.access_token).sub).toBe(
        userId,
      );
      expect(refreshTokenRepository.findOne).toHaveBeenLastCalledWith({
        where: { family, revoked_at: IsNull() },
        order: { created_at: 'DESC' },
      });
      expect(entityManager.save).toHaveBeenCalledTimes(1);
      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException within grace period when no active token remains in family', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const rawToken = signTestRefreshJwt(family);
      const revokedToken = createStoredRefreshToken(rawToken, family, {
        revoked_at: new Date(fixedNow - 1_000),
        expires_at: new Date(fixedNow + 60_000),
      });

      refreshTokenRepository.findOne
        .mockResolvedValueOnce(revokedToken)
        .mockResolvedValueOnce(null);

      await expect(authService.refresh(rawToken)).rejects.toThrow(
        InvalidTokenException,
      );

      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });

    it('should revoke entire family and throw TokenReuseDetectedException when reused beyond 10s grace period', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const rawToken = signTestRefreshJwt(family);
      const staleRevokedToken = createStoredRefreshToken(rawToken, family, {
        revoked_at: new Date(fixedNow - (REFRESH_GRACE_PERIOD_MS + 1)),
        expires_at: new Date(fixedNow + 60_000),
      });

      refreshTokenRepository.findOne.mockResolvedValueOnce(staleRevokedToken);

      await expect(authService.refresh(rawToken)).rejects.toThrow(
        TokenReuseDetectedException,
      );

      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { family, revoked_at: IsNull() },
        { revoked_at: new Date(fixedNow) },
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should handle concurrent rotation race when conditional update affects 0 rows', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const token1 = signTestRefreshJwt(family);
      const token2 = signTestRefreshJwt(family);

      const initialToken = createStoredRefreshToken(token1, family, {
        revoked_at: null,
        expires_at: new Date(fixedNow + 60_000),
      });
      const reloadedRevokedToken = createStoredRefreshToken(token1, family, {
        revoked_at: new Date(fixedNow - 50),
        expires_at: new Date(fixedNow + 60_000),
      });
      const activeToken2 = createStoredRefreshToken(token2, family, {
        id: 'refresh-uuid-2',
        revoked_at: null,
        expires_at: new Date(fixedNow + 60_000),
      });

      refreshTokenRepository.findOne
        .mockResolvedValueOnce(initialToken)
        .mockResolvedValueOnce(reloadedRevokedToken)
        .mockResolvedValueOnce(activeToken2);
      usersService.findById
        .mockResolvedValueOnce(createUserForRefresh())
        .mockResolvedValueOnce(createUserForRefresh());
      entityManager.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      } satisfies UpdateResult);

      const result = await authService.refresh(token1);

      expect(jwtService.verify<JwtPayload>(result.access_token).sub).toBe(
        userId,
      );
      expect(entityManager.save).not.toHaveBeenCalled();
    });

    it('should throw TokenExpiredException within grace period when latest active token in family is expired', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const token1 = signTestRefreshJwt(family);
      const token2 = signTestRefreshJwt(family);

      const revokedToken1 = createStoredRefreshToken(token1, family, {
        revoked_at: new Date(fixedNow - 1_000),
        expires_at: new Date(fixedNow + 60_000),
      });
      const expiredActiveToken2 = createStoredRefreshToken(token2, family, {
        id: 'refresh-uuid-2',
        revoked_at: null,
        expires_at: new Date(fixedNow),
      });

      refreshTokenRepository.findOne
        .mockResolvedValueOnce(revokedToken1)
        .mockResolvedValueOnce(expiredActiveToken2);

      await expect(authService.refresh(token1)).rejects.toThrow(
        TokenExpiredException,
      );

      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });

    it('should propagate error and evict tentative grace-cache entry when saving rotated token fails inside transaction', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const family = randomUUID();
      const token1 = signTestRefreshJwt(family);
      const storedToken1 = createStoredRefreshToken(token1, family, {
        expires_at: new Date(fixedNow + 60_000),
      });

      refreshTokenRepository.findOne.mockResolvedValueOnce(storedToken1);
      usersService.findById.mockResolvedValueOnce(createUserForRefresh());
      const saveError = new Error('Refresh token save failed');
      entityManager.save.mockRejectedValueOnce(saveError);

      await expect(authService.refresh(token1)).rejects.toBe(saveError);

      // Subsequent grace-period fallback should not receive a deleted tentative cache entry
      const createdEntity = refreshTokenRepository.create.mock.results[0];
      if (createdEntity.type !== 'return') {
        throw new Error('Expected refreshTokenRepository.create to return');
      }
      const revokedToken1 = createStoredRefreshToken(token1, family, {
        revoked_at: new Date(fixedNow),
        expires_at: new Date(fixedNow + 60_000),
      });
      refreshTokenRepository.findOne
        .mockResolvedValueOnce(revokedToken1)
        .mockResolvedValueOnce(createdEntity.value);
      usersService.findById.mockResolvedValueOnce(createUserForRefresh());

      const fallbackResult = await authService.refresh(token1);
      expect(fallbackResult.refresh_token).toBe(token1);
    });
  });

  describe('logout', () => {
    it('should revoke all non-revoked refresh tokens for the user', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      await authService.logout('user-uuid-1');

      expect(refreshTokenRepository.update).toHaveBeenCalledTimes(1);
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { user_id: 'user-uuid-1', revoked_at: IsNull() },
        { revoked_at: new Date(fixedNow) },
      );
    });

    it('should resolve when user has no active refresh tokens', async () => {
      refreshTokenRepository.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      } satisfies UpdateResult);

      await expect(
        authService.logout('user-uuid-empty'),
      ).resolves.toBeUndefined();
    });

    it('should propagate repository update errors', async () => {
      const dbError = new Error('Database update failed');
      refreshTokenRepository.update.mockRejectedValueOnce(dbError);

      await expect(authService.logout('user-uuid-1')).rejects.toBe(dbError);
    });
  });

  describe('forgotPassword', () => {
    const createUserForReset = (isConfirmed = true): User =>
      Object.assign(new User(), {
        id: 'user-uuid-1',
        email: 'alice@example.com',
        is_confirmed: isConfirmed,
        channel: Object.assign(new Channel(), {
          id: 'channel-uuid-1',
          name: 'alice',
          nickname: 'alice',
        }),
      });

    it('should normalize email, invalidate unused password_reset tokens, save SHA-256 token, and send reset email', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      usersService.findByEmail.mockResolvedValueOnce(createUserForReset(true));
      mailService.sendPasswordResetEmail.mockResolvedValueOnce(undefined);

      await authService.forgotPassword('  Alice@Example.com  ');

      expect(usersService.findByEmail).toHaveBeenCalledWith(
        'alice@example.com',
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(entityManager.update).toHaveBeenCalledWith(
        VerificationToken,
        {
          user_id: 'user-uuid-1',
          type: VerificationTokenType.PASSWORD_RESET,
          used_at: IsNull(),
        },
        { used_at: new Date(fixedNow) },
      );

      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      const [mailTo, mailName, rawToken] =
        mailService.sendPasswordResetEmail.mock.calls[0];
      expect(mailTo).toBe('alice@example.com');
      expect(mailName).toBe('alice');
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/);

      expect(verificationTokenRepository.create).toHaveBeenCalledTimes(1);
      const createResult = verificationTokenRepository.create.mock.results[0];
      if (createResult.type !== 'return') {
        throw new Error(
          'Expected verificationTokenRepository.create to return',
        );
      }
      const createdToken = createResult.value;

      expect(entityManager.save).toHaveBeenCalledWith(
        VerificationToken,
        createdToken,
      );
      expect(createdToken.token_hash).toBe(
        createHash('sha256').update(rawToken).digest('hex'),
      );
      expect(createdToken.type).toBe(VerificationTokenType.PASSWORD_RESET);
      expect(createdToken.user_id).toBe('user-uuid-1');
      expect(createdToken.used_at).toBeNull();
      expect(createdToken.expires_at).toEqual(
        new Date(
          fixedNow +
            mockAuthConfig.passwordResetTokenExpirationHours * 60 * 60 * 1000,
        ),
      );
    });

    it('should return silently when email is not found', async () => {
      usersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        authService.forgotPassword('unknown@example.com'),
      ).resolves.toBeUndefined();

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(entityManager.save).not.toHaveBeenCalled();
      expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('should send password reset email even when registered user is unconfirmed', async () => {
      usersService.findByEmail.mockResolvedValueOnce(createUserForReset(false));
      mailService.sendPasswordResetEmail.mockResolvedValueOnce(undefined);

      await authService.forgotPassword('alice@example.com');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });

    it('should propagate error when saving new token fails inside transaction without sending email', async () => {
      usersService.findByEmail.mockResolvedValueOnce(createUserForReset(true));
      const saveError = new Error('Token save failed');
      entityManager.save.mockRejectedValueOnce(saveError);

      await expect(
        authService.forgotPassword('alice@example.com'),
      ).rejects.toBe(saveError);

      expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const rawToken = 'b'.repeat(64);
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');

    it('should validate token, hash new password with Argon2, update password, and revoke refresh tokens atomically', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const tokenRecord = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 60_000),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(tokenRecord);

      await authService.resetPassword(rawToken, 'NewStrongPassword456');

      expect(verificationTokenRepository.findOne).toHaveBeenCalledWith({
        where: {
          token_hash: expectedHash,
          type: VerificationTokenType.PASSWORD_RESET,
        },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(entityManager.update).toHaveBeenNthCalledWith(
        1,
        VerificationToken,
        { id: 'token-uuid-1', used_at: IsNull() },
        { used_at: new Date(fixedNow) },
      );
      expect(usersService.updatePassword).toHaveBeenCalledTimes(1);
      const [updatedUserId, hashedPassword, passedManager] =
        usersService.updatePassword.mock.calls[0];
      expect(updatedUserId).toBe('user-uuid-1');
      expect(hashedPassword).not.toBe('NewStrongPassword456');
      expect(await argon2.verify(hashedPassword, 'NewStrongPassword456')).toBe(
        true,
      );
      expect(passedManager).toBe(entityManager);

      expect(entityManager.update).toHaveBeenNthCalledWith(
        2,
        RefreshToken,
        { user_id: 'user-uuid-1', revoked_at: IsNull() },
        { revoked_at: new Date(fixedNow) },
      );
    });

    it('should throw InvalidTokenException when token is not found', async () => {
      verificationTokenRepository.findOne.mockResolvedValueOnce(null);

      await expect(
        authService.resetPassword(rawToken, 'NewStrongPassword456'),
      ).rejects.toThrow(InvalidTokenException);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException when token was already used even if also expired', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const usedToken = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow - 60_000),
        used_at: new Date(fixedNow - 120_000),
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(usedToken);

      await expect(
        authService.resetPassword(rawToken, 'NewStrongPassword456'),
      ).rejects.toThrow(InvalidTokenException);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('should throw TokenExpiredException when unused token is expired at boundary', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const expiredToken = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(expiredToken);

      await expect(
        authService.resetPassword(rawToken, 'NewStrongPassword456'),
      ).rejects.toThrow(TokenExpiredException);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('should throw InvalidTokenException on concurrent consumption without updating password or revoking tokens', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const tokenRecord = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 60_000),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(tokenRecord);
      entityManager.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      } satisfies UpdateResult);

      await expect(
        authService.resetPassword(rawToken, 'NewStrongPassword456'),
      ).rejects.toThrow(InvalidTokenException);

      expect(entityManager.update).toHaveBeenCalledTimes(1);
      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('should propagate error when updatePassword fails inside transaction without revoking refresh tokens', async () => {
      const fixedNow = new Date('2026-11-27T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const tokenRecord = Object.assign(new VerificationToken(), {
        id: 'token-uuid-1',
        token_hash: expectedHash,
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'user-uuid-1',
        expires_at: new Date(fixedNow + 60_000),
        used_at: null,
      });
      verificationTokenRepository.findOne.mockResolvedValueOnce(tokenRecord);
      const updateError = new Error('Password update failed');
      usersService.updatePassword.mockRejectedValueOnce(updateError);

      await expect(
        authService.resetPassword(rawToken, 'NewStrongPassword456'),
      ).rejects.toBe(updateError);

      expect(entityManager.update).toHaveBeenCalledTimes(1);
    });
  });
});
