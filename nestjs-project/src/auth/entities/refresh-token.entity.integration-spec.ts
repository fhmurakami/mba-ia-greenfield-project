import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import {
  clearTestTables,
  createTestDataSource,
} from '../../../test/create-test-data-source';
import { Channel } from '../../users/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { RefreshToken } from './refresh-token.entity';

describe('RefreshToken entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let refreshTokenRepository: Repository<RefreshToken>;

  beforeAll(async () => {
    dataSource = await createTestDataSource([User, Channel, RefreshToken]);
    userRepository = dataSource.getRepository(User);
    refreshTokenRepository = dataSource.getRepository(RefreshToken);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await clearTestTables(dataSource);
  });

  it('should persist refresh token linked to user, query by token_hash, and update revoked_at', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'refresh@example.com',
        password: 'hashed-password',
      }),
    );

    const family = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const saved = await refreshTokenRepository.save(
      refreshTokenRepository.create({
        token_hash: 'sha256-refresh-token-hash',
        family,
        user_id: user.id,
        expires_at: expiresAt,
      }),
    );

    expect(saved.id).toBeDefined();
    expect(saved.family).toBe(family);
    expect(saved.revoked_at).toBeNull();
    expect(saved.created_at).toBeInstanceOf(Date);

    const found = await refreshTokenRepository.findOne({
      where: { token_hash: 'sha256-refresh-token-hash' },
      relations: { user: true },
    });

    expect(found).not.toBeNull();
    expect(found?.user_id).toBe(user.id);
    expect(found?.user.email).toBe('refresh@example.com');

    const revokedAt = new Date();
    saved.revoked_at = revokedAt;
    const updated = await refreshTokenRepository.save(saved);
    expect(updated.revoked_at).toBeInstanceOf(Date);
  });

  it('should enforce expires_at not-null constraint', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'missing-exp@example.com',
        password: 'hashed-password',
      }),
    );

    await expect(
      refreshTokenRepository.save(
        refreshTokenRepository.create({
          token_hash: 'hash-without-expiry',
          family: randomUUID(),
          user_id: user.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce user_id foreign key constraint and cascade on user deletion', async () => {
    await expect(
      refreshTokenRepository.save(
        refreshTokenRepository.create({
          token_hash: 'orphan-hash',
          family: randomUUID(),
          user_id: randomUUID(),
          expires_at: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();

    const user = await userRepository.save(
      userRepository.create({
        email: 'cascade-refresh@example.com',
        password: 'hashed-password',
      }),
    );
    await refreshTokenRepository.save(
      refreshTokenRepository.create({
        token_hash: 'cascade-hash',
        family: randomUUID(),
        user_id: user.id,
        expires_at: new Date(Date.now() + 60_000),
      }),
    );

    await userRepository.delete({ id: user.id });

    const remaining = await refreshTokenRepository.findBy({
      user_id: user.id,
    });
    expect(remaining).toHaveLength(0);
  });

  it('should have indexes on token_hash, (family, revoked_at), and user_id', async () => {
    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'refresh_tokens'`,
    );
    const definitions = indexes.map((row) => row.indexdef);

    expect(definitions.some((def) => def.includes('(token_hash)'))).toBe(true);
    expect(
      definitions.some((def) => def.includes('(family, revoked_at)')),
    ).toBe(true);
    expect(definitions.some((def) => def.includes('(user_id)'))).toBe(true);
  });
});
