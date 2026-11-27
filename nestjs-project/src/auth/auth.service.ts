import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
} from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(VerificationToken)
    private readonly verificationTokenRepository: Repository<VerificationToken>,
    private readonly dataSource: DataSource,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  async register(dto: RegisterDto): Promise<{ id: string; email: string }> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const emailExists = await this.usersService.existsByEmail(normalizedEmail);
    if (emailExists) {
      throw new EmailAlreadyExistsException();
    }

    const hashedPassword = await argon2.hash(dto.password);

    const { user, rawToken } = await this.dataSource.transaction(
      async (manager) => {
        const createdUser = await this.usersService.createUserWithChannel(
          normalizedEmail,
          hashedPassword,
          manager,
        );

        const token = await this.createVerificationToken(
          manager,
          createdUser.id,
          VerificationTokenType.EMAIL_CONFIRMATION,
          this.auth.confirmationTokenExpirationHours,
        );

        return { user: createdUser, rawToken: token };
      },
    );

    await this.mailService.sendConfirmationEmail(
      user.email,
      user.channel.name,
      rawToken,
    );

    return {
      id: user.id,
      email: user.email,
    };
  }

  async confirm(token: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const now = new Date(Date.now());

    const verificationToken = await this.verificationTokenRepository.findOne({
      where: {
        token_hash: tokenHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
      },
    });

    if (!verificationToken || verificationToken.used_at !== null) {
      throw new InvalidTokenException();
    }

    if (verificationToken.expires_at.getTime() <= now.getTime()) {
      throw new TokenExpiredException();
    }

    await this.dataSource.transaction(async (manager) => {
      const updateResult = await manager.update(
        VerificationToken,
        { id: verificationToken.id, used_at: IsNull() },
        { used_at: now },
      );

      if (updateResult.affected === 0) {
        throw new InvalidTokenException();
      }

      await this.usersService.markEmailConfirmed(
        verificationToken.user_id,
        manager,
      );
    });
  }

  async resendConfirmation(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(normalizedEmail);

    if (!user || user.is_confirmed) {
      return;
    }

    const nowMs = Date.now();
    const now = new Date(nowMs);

    const rawToken = await this.dataSource.transaction(async (manager) => {
      await manager.update(
        VerificationToken,
        {
          user_id: user.id,
          type: VerificationTokenType.EMAIL_CONFIRMATION,
          used_at: IsNull(),
        },
        { used_at: now },
      );

      return this.createVerificationToken(
        manager,
        user.id,
        VerificationTokenType.EMAIL_CONFIRMATION,
        this.auth.confirmationTokenExpirationHours,
        nowMs,
      );
    });

    await this.mailService.sendConfirmationEmail(
      user.email,
      user.channel.name,
      rawToken,
    );
  }

  async login(
    dto: LoginDto,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(normalizedEmail);
    if (!user) {
      throw new InvalidCredentialsException();
    }

    const isPasswordValid = await argon2.verify(user.password, dto.password);
    if (!isPasswordValid) {
      throw new InvalidCredentialsException();
    }

    if (!user.is_confirmed) {
      throw new EmailNotConfirmedException();
    }

    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email },
      {
        expiresIn: this.auth.jwtAccessExpiration as JwtSignOptions['expiresIn'],
      },
    );

    const family = randomUUID();
    const tokenId = randomUUID();
    const refreshToken = this.jwtService.sign(
      { sub: user.id, family, jti: tokenId },
      {
        secret: this.auth.jwtRefreshSecret,
        expiresIn: this.auth
          .jwtRefreshExpiration as JwtSignOptions['expiresIn'],
      },
    );

    const decodedRefresh = this.jwtService.decode<{ exp?: number } | null>(
      refreshToken,
    );
    if (!decodedRefresh || typeof decodedRefresh.exp !== 'number') {
      throw new Error('Refresh token is missing exp claim');
    }

    const tokenHash = this.hashToken(refreshToken);
    const refreshTokenEntity = this.refreshTokenRepository.create({
      token_hash: tokenHash,
      family,
      user_id: user.id,
      expires_at: new Date(decodedRefresh.exp * 1000),
      revoked_at: null,
    });
    await this.refreshTokenRepository.save(refreshTokenEntity);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private async createVerificationToken(
    manager: EntityManager,
    userId: string,
    type: VerificationTokenType,
    expirationHours: number,
    nowMs: number = Date.now(),
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(nowMs + expirationHours * 60 * 60 * 1000);

    const verificationToken = this.verificationTokenRepository.create({
      token_hash: tokenHash,
      type,
      user_id: userId,
      expires_at: expiresAt,
      used_at: null,
    });
    await manager.save(VerificationToken, verificationToken);

    return rawToken;
  }
}
