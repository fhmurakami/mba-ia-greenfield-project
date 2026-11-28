import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  clearTestTables,
  getTestTypeOrmOptions,
} from '../../test/create-test-data-source';
import { EmailAlreadyExistsException } from '../common/exceptions/domain.exception';
import { Channel } from './entities/channel.entity';
import { User } from './entities/user.entity';
import { UsersModule } from './users.module';
import { UsersService } from './users.service';

describe('UsersService (integration)', () => {
  let moduleRef: TestingModule;
  let usersService: UsersService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(getTestTypeOrmOptions([User, Channel])),
        UsersModule,
      ],
    }).compile();

    usersService = moduleRef.get(UsersService);
    dataSource = moduleRef.get(DataSource);
    userRepository = moduleRef.get(getRepositoryToken(User));
    channelRepository = moduleRef.get(getRepositoryToken(Channel));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await clearTestTables(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('existsByEmail', () => {
    it('should return true when email exists and false when it does not', async () => {
      await usersService.createUserWithChannel(
        'exists@example.com',
        'hashed-password',
      );

      expect(await usersService.existsByEmail('exists@example.com')).toBe(true);
      expect(await usersService.existsByEmail('  EXISTS@Example.com  ')).toBe(
        true,
      );
      expect(await usersService.existsByEmail('missing@example.com')).toBe(
        false,
      );
    });
  });

  describe('createUserWithChannel', () => {
    it('should create user and channel atomically with sanitized nickname and normalized email', async () => {
      const created = await usersService.createUserWithChannel(
        'Alice.Smith+dev@example.com',
        'hashed-password-1',
      );

      expect(created.id).toBeDefined();
      expect(created.email).toBe('alice.smith+dev@example.com');
      expect(created.is_confirmed).toBe(false);
      expect(created.channel).toBeDefined();
      expect(created.channel.nickname).toBe('alicesmithdev');
      expect(created.channel.name).toBe('alicesmithdev');
      expect(created.channel.description).toBeNull();
      expect(created.channel.user_id).toBe(created.id);

      const persistedUser = await userRepository.findOneBy({
        id: created.id,
      });
      expect(persistedUser).not.toBeNull();
      expect(persistedUser?.email).toBe('alice.smith+dev@example.com');
      expect(persistedUser?.is_confirmed).toBe(false);

      const persistedChannel = await channelRepository.findOneBy({
        user_id: created.id,
      });
      expect(persistedChannel).not.toBeNull();
      expect(persistedChannel?.nickname).toBe('alicesmithdev');
    });

    it('should resolve nickname collision by appending a random suffix', async () => {
      const first = await usersService.createUserWithChannel(
        'alice@one.com',
        'hashed-1',
      );
      const second = await usersService.createUserWithChannel(
        'alice@two.com',
        'hashed-2',
      );

      expect(first.channel.nickname).toBe('alice');
      expect(second.channel.nickname).toMatch(/^alice_[a-z0-9]{3}$/);
      expect(second.channel.name).toBe(second.channel.nickname);

      const channelCount = await channelRepository.count();
      expect(channelCount).toBe(2);
    });

    it('should translate PostgreSQL duplicate email error to EmailAlreadyExistsException', async () => {
      await usersService.createUserWithChannel(
        'duplicate@example.com',
        'hashed-1',
      );

      await expect(
        usersService.createUserWithChannel('duplicate@example.com', 'hashed-2'),
      ).rejects.toThrow(EmailAlreadyExistsException);
    });

    it('should treat mixed-case and whitespace-padded emails as duplicate and throw EmailAlreadyExistsException', async () => {
      await usersService.createUserWithChannel('alice@example.com', 'hashed-1');

      await expect(
        usersService.createUserWithChannel('  Alice@Example.com  ', 'hashed-2'),
      ).rejects.toThrow(EmailAlreadyExistsException);
    });

    it('should roll back user row if channel creation fails', async () => {
      const invalidChannel = new Channel();
      invalidChannel.name = 'x'.repeat(100); // exceeds varchar(50)
      invalidChannel.nickname = 'valid_nick';
      invalidChannel.description = null;

      jest
        .spyOn(channelRepository, 'create')
        .mockReturnValueOnce(invalidChannel);

      await expect(
        usersService.createUserWithChannel('rollback@example.com', 'hashed'),
      ).rejects.toThrow();

      expect(await userRepository.count()).toBe(0);
      expect(await channelRepository.count()).toBe(0);
    });

    it('should participate in an external EntityManager transaction and roll back when outer transaction fails', async () => {
      await expect(
        dataSource.transaction(async (manager) => {
          await usersService.createUserWithChannel(
            'outer-tx@example.com',
            'hashed-password',
            manager,
          );
          throw new Error('Outer transaction failure');
        }),
      ).rejects.toThrow('Outer transaction failure');

      expect(await userRepository.count()).toBe(0);
      expect(await channelRepository.count()).toBe(0);
    });

    it('should resolve nickname collision via savepoint inside an external transaction without aborting it', async () => {
      await usersService.createUserWithChannel('outer@one.com', 'hashed-1');

      const second = await dataSource.transaction((manager) =>
        usersService.createUserWithChannel(
          'outer@two.com',
          'hashed-2',
          manager,
        ),
      );

      expect(second.channel.nickname).toMatch(/^outer_[a-z0-9]{3}$/);
      expect(second.channel.name).toBe(second.channel.nickname);
      expect(await userRepository.count()).toBe(2);
      expect(await channelRepository.count()).toBe(2);
    });
  });

  describe('findByEmail', () => {
    it('should return user including password and channel when found (case-insensitive)', async () => {
      await usersService.createUserWithChannel(
        '  Lookup@Example.com  ',
        'argon2-hash-value',
      );

      const found = await usersService.findByEmail('LOOKUP@EXAMPLE.COM');

      expect(found).not.toBeNull();
      expect(found?.email).toBe('lookup@example.com');
      expect(found?.password).toBe('argon2-hash-value');
      expect(found?.channel?.nickname).toBe('lookup');
    });

    it('should return null when user does not exist', async () => {
      await usersService.createUserWithChannel(
        'existing@example.com',
        'argon2-hash-value',
      );

      const found = await usersService.findByEmail('missing@example.com');
      expect(found).toBeNull();
    });
  });

  describe('markEmailConfirmed', () => {
    it('should set is_confirmed to true without EntityManager', async () => {
      const created = await usersService.createUserWithChannel(
        'confirm-direct@example.com',
        'hashed-password',
      );

      await usersService.markEmailConfirmed(created.id);

      const persistedUser = await userRepository.findOneBy({ id: created.id });
      expect(persistedUser?.is_confirmed).toBe(true);
    });

    it('should set is_confirmed to true using provided EntityManager inside a transaction', async () => {
      const created = await usersService.createUserWithChannel(
        'confirm-tx@example.com',
        'hashed-password',
      );

      await dataSource.transaction((manager) =>
        usersService.markEmailConfirmed(created.id, manager),
      );

      const persistedUser = await userRepository.findOneBy({ id: created.id });
      expect(persistedUser?.is_confirmed).toBe(true);
    });

    it('should roll back is_confirmed update when outer EntityManager transaction fails', async () => {
      const created = await usersService.createUserWithChannel(
        'confirm-rollback@example.com',
        'hashed-password',
      );

      await expect(
        dataSource.transaction(async (manager) => {
          await usersService.markEmailConfirmed(created.id, manager);
          throw new Error('Outer transaction failure');
        }),
      ).rejects.toThrow('Outer transaction failure');

      const persistedUser = await userRepository.findOneBy({ id: created.id });
      expect(persistedUser?.is_confirmed).toBe(false);
    });
  });

  describe('findById', () => {
    it('should return persisted user without password when found by id', async () => {
      const created = await usersService.createUserWithChannel(
        'find-by-id@example.com',
        'hashed-password',
      );

      const found = await usersService.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.email).toBe('find-by-id@example.com');
      expect(found?.password).toBeUndefined();
    });

    it('should return null when user id does not exist', async () => {
      const found = await usersService.findById(
        '00000000-0000-0000-0000-000000000000',
      );

      expect(found).toBeNull();
    });
  });

  describe('updatePassword', () => {
    it('should update persisted password hash without EntityManager', async () => {
      const created = await usersService.createUserWithChannel(
        'pw-direct@example.com',
        'old-hashed-password',
      );

      await usersService.updatePassword(created.id, 'new-hashed-password');

      const found = await usersService.findByEmail('pw-direct@example.com');
      expect(found?.password).toBe('new-hashed-password');
    });

    it('should update persisted password hash using provided EntityManager inside a transaction', async () => {
      const created = await usersService.createUserWithChannel(
        'pw-tx@example.com',
        'old-hashed-password',
      );

      await dataSource.transaction((manager) =>
        usersService.updatePassword(created.id, 'new-hashed-password', manager),
      );

      const found = await usersService.findByEmail('pw-tx@example.com');
      expect(found?.password).toBe('new-hashed-password');
    });

    it('should roll back password update when outer EntityManager transaction fails', async () => {
      const created = await usersService.createUserWithChannel(
        'pw-rollback@example.com',
        'old-hashed-password',
      );

      await expect(
        dataSource.transaction(async (manager) => {
          await usersService.updatePassword(
            created.id,
            'new-hashed-password',
            manager,
          );
          throw new Error('Outer transaction failure');
        }),
      ).rejects.toThrow('Outer transaction failure');

      const found = await usersService.findByEmail('pw-rollback@example.com');
      expect(found?.password).toBe('old-hashed-password');
    });
  });
});
