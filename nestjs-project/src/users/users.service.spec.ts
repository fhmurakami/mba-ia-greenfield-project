import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { EmailAlreadyExistsException } from '../common/exceptions/domain.exception';
import { Channel } from './entities/channel.entity';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

interface PostgresDriverError extends Error {
  code: string;
  detail: string;
}

function createUniqueViolationError(
  detail: string,
): QueryFailedError<PostgresDriverError> {
  const driverError: PostgresDriverError = Object.assign(
    new Error('duplicate key value violates unique constraint'),
    { code: '23505', detail },
  );
  return new QueryFailedError('INSERT', undefined, driverError);
}

describe('UsersService (unit)', () => {
  let moduleRef: TestingModule;
  let usersService: UsersService;
  let userRepository: jest.Mocked<
    Pick<Repository<User>, 'create' | 'existsBy' | 'createQueryBuilder'>
  >;
  let queryBuilder: jest.Mocked<
    Pick<
      SelectQueryBuilder<User>,
      'addSelect' | 'leftJoinAndSelect' | 'where' | 'getOne'
    >
  >;
  let channelRepository: jest.Mocked<Pick<Repository<Channel>, 'create'>>;
  let dataSource: jest.Mocked<Pick<DataSource, 'transaction'>>;
  let txManager: jest.Mocked<Pick<EntityManager, 'save' | 'transaction'>>;
  let subManager: jest.Mocked<Pick<EntityManager, 'save'>>;

  beforeAll(async () => {
    queryBuilder = {
      addSelect: jest.fn(),
      leftJoinAndSelect: jest.fn(),
      where: jest.fn(),
      getOne: jest.fn(),
    };
    userRepository = {
      create: jest.fn(),
      existsBy: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    channelRepository = {
      create: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(),
    };
    txManager = {
      save: jest.fn(),
      transaction: jest.fn(),
    };
    subManager = {
      save: jest.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: userRepository,
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: channelRepository,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    usersService = moduleRef.get(UsersService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    userRepository.create.mockReset();
    userRepository.existsBy.mockReset();
    userRepository.createQueryBuilder.mockReset();
    queryBuilder.addSelect.mockReset();
    queryBuilder.leftJoinAndSelect.mockReset();
    queryBuilder.where.mockReset();
    queryBuilder.getOne.mockReset();
    channelRepository.create.mockReset();
    dataSource.transaction.mockReset();
    txManager.save.mockReset();
    txManager.transaction.mockReset();
    subManager.save.mockReset();

    userRepository.createQueryBuilder.mockReturnValue(
      queryBuilder as unknown as SelectQueryBuilder<User>,
    );
    queryBuilder.addSelect.mockReturnThis();
    queryBuilder.leftJoinAndSelect.mockReturnThis();
    queryBuilder.where.mockReturnThis();

    userRepository.create.mockImplementation((entityLike) =>
      Object.assign(new User(), entityLike),
    );
    channelRepository.create.mockImplementation((entityLike) =>
      Object.assign(new Channel(), entityLike),
    );
    dataSource.transaction.mockImplementation(
      (
        isolationOrCb:
          string | ((entityManager: EntityManager) => Promise<unknown>),
        maybeCb?: (entityManager: EntityManager) => Promise<unknown>,
      ) => {
        const cb =
          typeof isolationOrCb === 'function' ? isolationOrCb : maybeCb;
        if (!cb) {
          throw new Error('Expected transaction callback');
        }
        return cb(txManager as unknown as EntityManager);
      },
    );
    txManager.transaction.mockImplementation(
      (
        isolationOrCb:
          string | ((entityManager: EntityManager) => Promise<unknown>),
        maybeCb?: (entityManager: EntityManager) => Promise<unknown>,
      ) => {
        const cb =
          typeof isolationOrCb === 'function' ? isolationOrCb : maybeCb;
        if (!cb) {
          throw new Error('Expected nested transaction callback');
        }
        return cb(subManager as unknown as EntityManager);
      },
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('existsByEmail', () => {
    it('should return true when userRepository.existsBy resolves true', async () => {
      userRepository.existsBy.mockResolvedValueOnce(true);

      const result = await usersService.existsByEmail('alice@example.com');

      expect(result).toBe(true);
      expect(userRepository.existsBy).toHaveBeenCalledWith({
        email: 'alice@example.com',
      });
    });

    it('should return false when userRepository.existsBy resolves false', async () => {
      userRepository.existsBy.mockResolvedValueOnce(false);

      const result = await usersService.existsByEmail('missing@example.com');

      expect(result).toBe(false);
      expect(userRepository.existsBy).toHaveBeenCalledWith({
        email: 'missing@example.com',
      });
    });

    it('should normalize email with trim and lowercase before checking existence', async () => {
      userRepository.existsBy.mockResolvedValueOnce(true);

      const result = await usersService.existsByEmail('  Alice@Example.com  ');

      expect(result).toBe(true);
      expect(userRepository.existsBy).toHaveBeenCalledWith({
        email: 'alice@example.com',
      });
    });
  });

  describe('createUserWithChannel', () => {
    it('should start dataSource.transaction when manager is omitted and create user and channel', async () => {
      const savedUser = Object.assign(new User(), {
        id: 'user-uuid-1',
        email: 'alice@example.com',
        password: 'hashed-password',
      });
      const savedChannel = Object.assign(new Channel(), {
        id: 'channel-uuid-1',
        name: 'alice',
        nickname: 'alice',
        description: null,
        user_id: 'user-uuid-1',
      });

      txManager.save.mockResolvedValueOnce(savedUser);
      subManager.save.mockResolvedValueOnce(savedChannel);

      const result = await usersService.createUserWithChannel(
        'alice@example.com',
        'hashed-password',
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(txManager.transaction).toHaveBeenCalledTimes(1);
      expect(result).toBe(savedUser);
      expect(result.channel).toBe(savedChannel);
    });

    it('should reuse provided EntityManager without calling dataSource.transaction', async () => {
      const savedUser = Object.assign(new User(), {
        id: 'user-uuid-2',
        email: 'bob@example.com',
        password: 'hashed-password',
      });
      const savedChannel = Object.assign(new Channel(), {
        id: 'channel-uuid-2',
        name: 'bob',
        nickname: 'bob',
        description: null,
        user_id: 'user-uuid-2',
      });

      txManager.save.mockResolvedValueOnce(savedUser);
      subManager.save.mockResolvedValueOnce(savedChannel);

      const result = await usersService.createUserWithChannel(
        'bob@example.com',
        'hashed-password',
        txManager as unknown as EntityManager,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(txManager.transaction).toHaveBeenCalledTimes(1);
      expect(result.channel).toBe(savedChannel);
    });

    it('should translate email 23505 QueryFailedError on user save to EmailAlreadyExistsException without creating channel', async () => {
      txManager.save.mockRejectedValueOnce(
        createUniqueViolationError(
          'Key (email)=(alice@example.com) already exists.',
        ),
      );

      await expect(
        usersService.createUserWithChannel(
          'alice@example.com',
          'hashed-password',
        ),
      ).rejects.toThrow(EmailAlreadyExistsException);

      expect(txManager.transaction).not.toHaveBeenCalled();
      expect(subManager.save).not.toHaveBeenCalled();
    });

    it('should rethrow non-email QueryFailedError on user save without converting to EmailAlreadyExistsException', async () => {
      const otherUniqueError = createUniqueViolationError(
        'Key (other_col)=(val) already exists.',
      );
      txManager.save.mockRejectedValueOnce(otherUniqueError);

      await expect(
        usersService.createUserWithChannel(
          'alice@example.com',
          'hashed-password',
        ),
      ).rejects.toBe(otherUniqueError);

      expect(txManager.transaction).not.toHaveBeenCalled();
    });

    it('should rethrow generic errors on user save', async () => {
      const genericError = new Error('Connection terminated unexpectedly');
      txManager.save.mockRejectedValueOnce(genericError);

      await expect(
        usersService.createUserWithChannel(
          'alice@example.com',
          'hashed-password',
        ),
      ).rejects.toBe(genericError);
    });

    it('should retry channel save via nested savepoint with random suffix on nickname 23505 collision', async () => {
      const savedUser = Object.assign(new User(), {
        id: 'user-uuid-3',
        email: 'alice@example.com',
        password: 'hashed-password',
      });
      const retriedChannel = Object.assign(new Channel(), {
        id: 'channel-uuid-3',
        name: 'alice_x9z',
        nickname: 'alice_x9z',
        description: null,
        user_id: 'user-uuid-3',
      });

      txManager.save.mockResolvedValueOnce(savedUser);
      subManager.save
        .mockRejectedValueOnce(
          createUniqueViolationError('Key (nickname)=(alice) already exists.'),
        )
        .mockResolvedValueOnce(retriedChannel);

      const result = await usersService.createUserWithChannel(
        'alice@example.com',
        'hashed-password',
      );

      expect(txManager.transaction).toHaveBeenCalledTimes(2);
      expect(subManager.save).toHaveBeenCalledTimes(2);
      expect(result.channel).toBe(retriedChannel);
    });

    it('should normalize email with trim and lowercase before creating user', async () => {
      const savedUser = Object.assign(new User(), {
        id: 'user-uuid-4',
        email: 'alice@example.com',
        password: 'hashed-password',
      });
      const savedChannel = Object.assign(new Channel(), {
        id: 'channel-uuid-4',
        name: 'alice',
        nickname: 'alice',
        description: null,
        user_id: 'user-uuid-4',
      });

      txManager.save.mockResolvedValueOnce(savedUser);
      subManager.save.mockResolvedValueOnce(savedChannel);

      await usersService.createUserWithChannel(
        '  Alice@Example.com  ',
        'hashed-password',
      );

      expect(userRepository.create).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'hashed-password',
      });
    });
  });

  describe('findByEmail', () => {
    it('should normalize email with trim and lowercase when querying user', async () => {
      const foundUser = Object.assign(new User(), {
        id: 'user-uuid-5',
        email: 'alice@example.com',
      });
      queryBuilder.getOne.mockResolvedValueOnce(foundUser);

      const result = await usersService.findByEmail('  Alice@Example.com  ');

      expect(result).toBe(foundUser);
      expect(queryBuilder.where).toHaveBeenCalledWith('user.email = :email', {
        email: 'alice@example.com',
      });
    });
  });
});
