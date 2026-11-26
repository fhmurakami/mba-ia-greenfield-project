import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import { Channel } from './entities/channel.entity';
import { User } from './entities/user.entity';
import { UsersModule } from './users.module';

describe('UsersModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    const dbConfig = databaseConfig();
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database,
          autoLoadEntities: true,
          synchronize: false,
        }),
        UsersModule,
      ],
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
