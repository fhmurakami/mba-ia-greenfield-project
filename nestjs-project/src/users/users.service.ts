import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { EmailAlreadyExistsException } from '../common/exceptions/domain.exception';
import { Channel } from './entities/channel.entity';
import { User } from './entities/user.entity';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';

interface PostgresDriverError {
  code?: string;
  detail?: string;
  constraint?: string;
}

const PG_UNIQUE_VIOLATION = '23505';
const EMAIL_COLUMN = 'email';
const NICKNAME_COLUMN = 'nickname';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(
  error: unknown,
  column: 'email' | 'nickname',
): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error.driverError as PostgresDriverError | undefined;
  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    (driverError.detail?.includes(`(${column})=`) ?? false)
  );
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly dataSource: DataSource,
  ) {}

  async existsByEmail(email: string): Promise<boolean> {
    return this.userRepository.existsBy({ email: normalizeEmail(email) });
  }

  async createUserWithChannel(
    email: string,
    hashedPassword: string,
    manager?: EntityManager,
  ): Promise<User> {
    const normalizedEmail = normalizeEmail(email);
    const emailPrefix = normalizedEmail.split('@')[0] ?? '';
    const baseNickname = sanitizeNickname(emailPrefix);

    const runInTransaction = async (
      txManager: EntityManager,
    ): Promise<User> => {
      const user = this.userRepository.create({
        email: normalizedEmail,
        password: hashedPassword,
      });

      let savedUser: User;
      try {
        savedUser = await txManager.save(User, user);
      } catch (error: unknown) {
        if (isUniqueViolation(error, EMAIL_COLUMN)) {
          throw new EmailAlreadyExistsException();
        }
        throw error;
      }

      const maxRetries = 5;
      let savedChannel: Channel | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const candidateNickname =
          attempt === 0 ? baseNickname : appendRandomSuffix(baseNickname);

        try {
          savedChannel = await txManager.transaction(async (subManager) => {
            const channel = this.channelRepository.create({
              name: candidateNickname,
              nickname: candidateNickname,
              description: null,
              user_id: savedUser.id,
            });
            return subManager.save(Channel, channel);
          });
          break;
        } catch (error: unknown) {
          if (
            isUniqueViolation(error, NICKNAME_COLUMN) &&
            attempt < maxRetries
          ) {
            continue;
          }
          throw error;
        }
      }

      if (!savedChannel) {
        throw new Error('Failed to create channel after maximum retries');
      }

      savedUser.channel = savedChannel;
      return savedUser;
    };

    return manager
      ? runInTransaction(manager)
      : this.dataSource.transaction(runInTransaction);
  }

  async findByEmail(email: string): Promise<User | null> {
    const normalizedEmail = normalizeEmail(email);
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .leftJoinAndSelect('user.channel', 'channel')
      .where('user.email = :email', { email: normalizedEmail })
      .getOne();
  }
}
