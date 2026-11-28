import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import authConfig from '../config/auth.config';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { VerificationToken } from './entities/verification-token.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    MailModule,
    ThrottlerModule.forRoot([
      {
        ttl: AUTH_THROTTLE_TTL_MS,
        limit: AUTH_THROTTLE_LIMIT,
      },
    ]),
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (auth: ConfigType<typeof authConfig>) => ({
        secret: auth.jwtSecret,
        signOptions: {
          expiresIn: auth.jwtAccessExpiration as JwtSignOptions['expiresIn'],
        },
      }),
    }),
    TypeOrmModule.forFeature([RefreshToken, VerificationToken]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
