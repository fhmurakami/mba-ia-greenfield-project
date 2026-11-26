import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../../config/database.config';
import { Channel } from './channel.entity';
import { User } from './user.entity';

describe('User entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    const dbConfig = databaseConfig();
    dataSource = new DataSource({
      type: 'postgres',
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.database,
      entities: [User, Channel],
      synchronize: false,
    });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE "channels", "users" RESTART IDENTITY CASCADE',
    );
  });

  it('should default is_confirmed to false and auto-populate id, created_at, and updated_at', async () => {
    const user = userRepository.create({
      email: 'alice@example.com',
      password: 'hashed-password',
    });

    const saved = await userRepository.save(user);

    expect(saved.id).toBeDefined();
    expect(saved.is_confirmed).toBe(false);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique email constraint', async () => {
    await userRepository.save(
      userRepository.create({
        email: 'duplicate@example.com',
        password: 'hashed-password-1',
      }),
    );

    await expect(
      userRepository.save(
        userRepository.create({
          email: 'duplicate@example.com',
          password: 'hashed-password-2',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should exclude password from default SELECT queries and return it only with addSelect', async () => {
    const saved = await userRepository.save(
      userRepository.create({
        email: 'secret@example.com',
        password: 'argon2-secret-hash',
      }),
    );

    const foundByFind = await userRepository.find({
      where: { id: saved.id },
    });
    expect(foundByFind).toHaveLength(1);
    expect(foundByFind[0].password).toBeUndefined();

    const foundByFindOneBy = await userRepository.findOneBy({ id: saved.id });
    expect(foundByFindOneBy).not.toBeNull();
    expect(foundByFindOneBy?.password).toBeUndefined();

    const foundWithPassword = await userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.id = :id', { id: saved.id })
      .getOne();

    expect(foundWithPassword).not.toBeNull();
    expect(foundWithPassword?.password).toBe('argon2-secret-hash');
  });

  it('should cascade save channel when assigned on user', async () => {
    const user = userRepository.create({
      email: 'creator@example.com',
      password: 'hashed-password',
      channel: {
        name: 'creator',
        nickname: 'creator',
        description: null,
      },
    });

    const saved = await userRepository.save(user);

    const foundChannel = await dataSource.getRepository(Channel).findOneBy({
      user_id: saved.id,
    });

    expect(foundChannel).not.toBeNull();
    expect(foundChannel?.nickname).toBe('creator');
    expect(foundChannel?.user_id).toBe(saved.id);
  });
});
