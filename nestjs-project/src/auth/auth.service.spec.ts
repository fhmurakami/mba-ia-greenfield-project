import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import type { ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EmailAlreadyExistsException } from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import { MailService } from '../mail/mail.service';
import { Channel } from '../users/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
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
};

describe('AuthService (unit)', () => {
  let moduleRef: TestingModule;
  let authService: AuthService;
  let usersService: jest.Mocked<
    Pick<UsersService, 'existsByEmail' | 'createUserWithChannel'>
  >;
  let mailService: jest.Mocked<Pick<MailService, 'sendConfirmationEmail'>>;
  let verificationTokenRepository: jest.Mocked<
    Pick<Repository<VerificationToken>, 'create'>
  >;
  let entityManager: jest.Mocked<Pick<EntityManager, 'save'>>;
  let dataSource: jest.Mocked<Pick<DataSource, 'transaction'>>;

  beforeAll(async () => {
    usersService = {
      existsByEmail: jest.fn(),
      createUserWithChannel: jest.fn(),
    };
    mailService = {
      sendConfirmationEmail: jest.fn(),
    };
    verificationTokenRepository = {
      create: jest.fn(),
    };
    entityManager = {
      save: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(),
    };

    moduleRef = await Test.createTestingModule({
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
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    usersService.existsByEmail.mockReset();
    usersService.createUserWithChannel.mockReset();
    mailService.sendConfirmationEmail.mockReset();
    verificationTokenRepository.create.mockReset();
    entityManager.save.mockReset();
    dataSource.transaction.mockReset();

    verificationTokenRepository.create.mockImplementation((entityLike) =>
      Object.assign(new VerificationToken(), entityLike),
    );
    entityManager.save.mockImplementation(
      (_targetOrEntity: unknown, entity?: unknown) =>
        Promise.resolve(Object.assign(new VerificationToken(), entity)),
    );
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
});
