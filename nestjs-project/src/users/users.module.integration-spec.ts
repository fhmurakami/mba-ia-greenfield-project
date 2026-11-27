import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getTestTypeOrmOptions } from '../../test/create-test-data-source';
import { Channel } from './entities/channel.entity';
import { User } from './entities/user.entity';
import { UsersModule } from './users.module';

describe('UsersModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(getTestTypeOrmOptions()), UsersModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile successfully and export User and Channel repositories', () => {
    expect(moduleRef).toBeDefined();

    const userRepo = moduleRef.get<Repository<User>>(getRepositoryToken(User));
    const channelRepo = moduleRef.get<Repository<Channel>>(
      getRepositoryToken(Channel),
    );

    expect(userRepo).toBeDefined();
    expect(channelRepo).toBeDefined();
  });
});
