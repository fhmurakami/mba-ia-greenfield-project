import { DataSource, Repository } from 'typeorm';
import {
  clearTestTables,
  createTestDataSource,
} from '../../../test/create-test-data-source';
import { Channel } from './channel.entity';
import { User } from './user.entity';

describe('Channel entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    dataSource = await createTestDataSource([User, Channel]);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await clearTestTables(dataSource);
  });

  it('should persist channel with nullable description and one-to-one relation to user', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'owner@example.com',
        password: 'hashed-password',
      }),
    );

    const savedChannel = await channelRepository.save(
      channelRepository.create({
        name: 'Owner Channel',
        nickname: 'owner_channel',
        user_id: user.id,
      }),
    );

    expect(savedChannel.id).toBeDefined();
    expect(savedChannel.description).toBeNull();
    expect(savedChannel.created_at).toBeInstanceOf(Date);
    expect(savedChannel.updated_at).toBeInstanceOf(Date);

    const loaded = await channelRepository.findOne({
      where: { id: savedChannel.id },
      relations: { user: true },
    });

    expect(loaded).not.toBeNull();
    expect(loaded?.user.id).toBe(user.id);
    expect(loaded?.user.email).toBe('owner@example.com');

    savedChannel.description = 'My video channel';
    const updated = await channelRepository.save(savedChannel);
    expect(updated.description).toBe('My video channel');
  });

  it('should enforce unique nickname constraint', async () => {
    const user1 = await userRepository.save(
      userRepository.create({
        email: 'user1@example.com',
        password: 'hashed-password',
      }),
    );
    const user2 = await userRepository.save(
      userRepository.create({
        email: 'user2@example.com',
        password: 'hashed-password',
      }),
    );

    await channelRepository.save(
      channelRepository.create({
        name: 'taken_nick',
        nickname: 'taken_nick',
        user_id: user1.id,
      }),
    );

    await expect(
      channelRepository.save(
        channelRepository.create({
          name: 'taken_nick',
          nickname: 'taken_nick',
          user_id: user2.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce nickname max length of 50 characters', async () => {
    const user1 = await userRepository.save(
      userRepository.create({
        email: 'len50@example.com',
        password: 'hashed-password',
      }),
    );
    const user2 = await userRepository.save(
      userRepository.create({
        email: 'len51@example.com',
        password: 'hashed-password',
      }),
    );

    const validNickname = 'a'.repeat(50);
    const savedValid = await channelRepository.save(
      channelRepository.create({
        name: 'Valid Name',
        nickname: validNickname,
        user_id: user1.id,
      }),
    );
    expect(savedValid.nickname).toHaveLength(50);

    const invalidNickname = 'a'.repeat(51);
    await expect(
      channelRepository.save(
        channelRepository.create({
          name: 'Invalid Name',
          nickname: invalidNickname,
          user_id: user2.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce unique one-to-one user_id constraint', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'single@example.com',
        password: 'hashed-password',
      }),
    );

    await channelRepository.save(
      channelRepository.create({
        name: 'First Channel',
        nickname: 'first_channel',
        user_id: user.id,
      }),
    );

    await expect(
      channelRepository.save(
        channelRepository.create({
          name: 'Second Channel',
          nickname: 'second_channel',
          user_id: user.id,
        }),
      ),
    ).rejects.toThrow();
  });
});
