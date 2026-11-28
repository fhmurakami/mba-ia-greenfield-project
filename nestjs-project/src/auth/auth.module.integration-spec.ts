import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  getOptionsToken,
  getStorageToken,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getTestTypeOrmOptions } from '../../test/create-test-data-source';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import { AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS } from './auth.constants';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { VerificationToken } from './entities/verification-token.entity';

const AUTH_EXPORTS_CONSUMER = Symbol('AUTH_EXPORTS_CONSUMER');

describe('AuthModule (integration)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, databaseConfig, authConfig, mailConfig],
        }),
        TypeOrmModule.forRoot(getTestTypeOrmOptions()),
        AuthModule,
      ],
      providers: [
        {
          provide: AUTH_EXPORTS_CONSUMER,
          inject: [AuthService, JwtService],
          useFactory: (authService: AuthService, jwtService: JwtService) => ({
            authService,
            jwtService,
          }),
        },
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile successfully, wire repositories, and export AuthService and JwtModule', () => {
    expect(moduleRef).toBeDefined();

    const exported = moduleRef.get<{
      authService: AuthService;
      jwtService: JwtService;
    }>(AUTH_EXPORTS_CONSUMER);
    const refreshTokenRepo = moduleRef.get<Repository<RefreshToken>>(
      getRepositoryToken(RefreshToken),
    );
    const verificationTokenRepo = moduleRef.get<Repository<VerificationToken>>(
      getRepositoryToken(VerificationToken),
    );
    const throttlerStorage = moduleRef.get<ThrottlerStorage>(getStorageToken());
    const throttlerOptions =
      moduleRef.get<ThrottlerModuleOptions>(getOptionsToken());

    expect(exported.authService).toBeDefined();
    expect(exported.jwtService).toBeDefined();
    expect(refreshTokenRepo).toBeDefined();
    expect(verificationTokenRepo).toBeDefined();
    expect(throttlerStorage).toBeDefined();
    expect(throttlerOptions).toEqual([
      { ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT },
    ]);
  });
});
