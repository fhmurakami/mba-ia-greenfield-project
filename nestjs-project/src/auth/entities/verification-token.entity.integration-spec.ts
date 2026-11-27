import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import {
  clearTestTables,
  createTestDataSource,
} from '../../../test/create-test-data-source';
import { Channel } from '../../users/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './verification-token.entity';

describe('VerificationToken entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let verificationTokenRepository: Repository<VerificationToken>;

  beforeAll(async () => {
    dataSource = await createTestDataSource([User, Channel, VerificationToken]);
    userRepository = dataSource.getRepository(User);
    verificationTokenRepository = dataSource.getRepository(VerificationToken);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await clearTestTables(dataSource);
  });

  it('should persist email_confirmation and password_reset tokens, query by token_hash, and update used_at', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'verify@example.com',
        password: 'hashed-password',
      }),
    );

    const confirmationToken = await verificationTokenRepository.save(
      verificationTokenRepository.create({
        token_hash: 'sha256-confirm-hash',
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: user.id,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    );

    const resetToken = await verificationTokenRepository.save(
      verificationTokenRepository.create({
        token_hash: 'sha256-reset-hash',
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: user.id,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    expect(confirmationToken.id).toBeDefined();
    expect(confirmationToken.used_at).toBeNull();
    expect(confirmationToken.created_at).toBeInstanceOf(Date);
    expect(resetToken.type).toBe('password_reset');

    const found = await verificationTokenRepository.findOne({
      where: { token_hash: 'sha256-confirm-hash' },
      relations: { user: true },
    });

    expect(found).not.toBeNull();
    expect(found?.type).toBe('email_confirmation');
    expect(found?.user.id).toBe(user.id);

    confirmationToken.used_at = new Date();
    const updated = await verificationTokenRepository.save(confirmationToken);
    expect(updated.used_at).toBeInstanceOf(Date);
  });

  it('should reject invalid enum values for type', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'invalid-enum@example.com',
        password: 'hashed-password',
      }),
    );

    await expect(
      verificationTokenRepository.save(
        verificationTokenRepository.create({
          token_hash: 'invalid-enum-hash',
          type: 'invalid_type' as VerificationTokenType,
          user_id: user.id,
          expires_at: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce expires_at not-null constraint', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'missing-verify-exp@example.com',
        password: 'hashed-password',
      }),
    );

    await expect(
      verificationTokenRepository.save(
        verificationTokenRepository.create({
          token_hash: 'missing-exp-hash',
          type: VerificationTokenType.EMAIL_CONFIRMATION,
          user_id: user.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce user_id foreign key constraint and cascade on user deletion', async () => {
    await expect(
      verificationTokenRepository.save(
        verificationTokenRepository.create({
          token_hash: 'orphan-verify-hash',
          type: VerificationTokenType.PASSWORD_RESET,
          user_id: randomUUID(),
          expires_at: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();

    const user = await userRepository.save(
      userRepository.create({
        email: 'cascade-verify@example.com',
        password: 'hashed-password',
      }),
    );
    await verificationTokenRepository.save(
      verificationTokenRepository.create({
        token_hash: 'cascade-verify-hash',
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: user.id,
        expires_at: new Date(Date.now() + 60_000),
      }),
    );

    await userRepository.delete({ id: user.id });

    const remaining = await verificationTokenRepository.findBy({
      user_id: user.id,
    });
    expect(remaining).toHaveLength(0);
  });

  it('should have indexes on token_hash and (user_id, type)', async () => {
    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'verification_tokens'`,
    );
    const definitions = indexes.map((row) => row.indexdef);

    expect(definitions.some((def) => def.includes('(token_hash)'))).toBe(true);
    expect(definitions.some((def) => def.includes('(user_id, type)'))).toBe(
      true,
    );
  });
});
