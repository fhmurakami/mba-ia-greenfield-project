import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';
import { REFRESH_GRACE_PERIOD_MS } from './auth.constants';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

@Injectable()
export class AuthService {
  private readonly rotatedTokenGraceCache = new Map<
    string,
    { rawToken: string; expiresAtMs: number }
  >();

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

    const accessToken = this.signAccessToken(user.id, user.email);
    const { rawToken: refreshToken, entity: refreshTokenEntity } =
      this.buildRefreshToken(user.id, randomUUID());
    await this.refreshTokenRepository.save(refreshTokenEntity);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  async refresh(
    rawToken: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const tokenHash = this.hashToken(rawToken);

    const storedToken = await this.refreshTokenRepository.findOne({
      where: { token_hash: tokenHash },
    });

    if (!storedToken) {
      throw new InvalidTokenException();
    }

    if (storedToken.expires_at.getTime() <= nowMs) {
      throw new TokenExpiredException();
    }

    this.verifyRefreshJwt(rawToken, storedToken);

    if (storedToken.revoked_at !== null) {
      return this.handleRevokedRefreshToken(storedToken, rawToken, nowMs);
    }

    const user = await this.usersService.findById(storedToken.user_id);
    if (!user) {
      throw new InvalidTokenException();
    }

    const rotated = await this.dataSource.transaction(async (manager) => {
      const updateResult = await manager.update(
        RefreshToken,
        { id: storedToken.id, revoked_at: IsNull() },
        { revoked_at: now },
      );

      if (updateResult.affected === 0) {
        return null;
      }

      const { rawToken: newRefreshToken, entity: newRefreshTokenEntity } =
        this.buildRefreshToken(user.id, storedToken.family);

      this.cacheRotatedRefreshToken(
        newRefreshTokenEntity.token_hash,
        newRefreshToken,
        nowMs,
      );

      try {
        await manager.save(RefreshToken, newRefreshTokenEntity);
      } catch (error: unknown) {
        this.rotatedTokenGraceCache.delete(newRefreshTokenEntity.token_hash);
        throw error;
      }

      return {
        access_token: this.signAccessToken(user.id, user.email),
        refresh_token: newRefreshToken,
      };
    });

    if (rotated) {
      return rotated;
    }

    const reloadedToken = await this.refreshTokenRepository.findOne({
      where: { id: storedToken.id },
    });
    if (!reloadedToken || reloadedToken.revoked_at === null) {
      throw new InvalidTokenException();
    }

    return this.handleRevokedRefreshToken(reloadedToken, rawToken, Date.now());
  }

  async logout(userId: string): Promise<void> {
    await this.revokeUserRefreshTokens(userId, new Date(Date.now()));
  }

  async forgotPassword(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(normalizedEmail);

    if (!user) {
      return;
    }

    const nowMs = Date.now();
    const now = new Date(nowMs);

    const rawToken = await this.dataSource.transaction(async (manager) => {
      await manager.update(
        VerificationToken,
        {
          user_id: user.id,
          type: VerificationTokenType.PASSWORD_RESET,
          used_at: IsNull(),
        },
        { used_at: now },
      );

      return this.createVerificationToken(
        manager,
        user.id,
        VerificationTokenType.PASSWORD_RESET,
        this.auth.passwordResetTokenExpirationHours,
        nowMs,
      );
    });

    await this.mailService.sendPasswordResetEmail(
      user.email,
      user.channel.name,
      rawToken,
    );
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const nowMs = Date.now();
    const now = new Date(nowMs);

    const verificationToken = await this.verificationTokenRepository.findOne({
      where: {
        token_hash: tokenHash,
        type: VerificationTokenType.PASSWORD_RESET,
      },
    });

    if (!verificationToken || verificationToken.used_at !== null) {
      throw new InvalidTokenException();
    }

    if (verificationToken.expires_at.getTime() <= nowMs) {
      throw new TokenExpiredException();
    }

    const hashedPassword = await argon2.hash(newPassword);

    await this.dataSource.transaction(async (manager) => {
      const updateResult = await manager.update(
        VerificationToken,
        { id: verificationToken.id, used_at: IsNull() },
        { used_at: now },
      );

      if (updateResult.affected === 0) {
        throw new InvalidTokenException();
      }

      await this.usersService.updatePassword(
        verificationToken.user_id,
        hashedPassword,
        manager,
      );

      await this.revokeUserRefreshTokens(
        verificationToken.user_id,
        now,
        manager,
      );
    });
  }

  private async revokeUserRefreshTokens(
    userId: string,
    revokedAt: Date,
    manager?: EntityManager,
  ): Promise<void> {
    const criteria = { user_id: userId, revoked_at: IsNull() };
    const partialEntity = { revoked_at: revokedAt };

    await (manager
      ? manager.update(RefreshToken, criteria, partialEntity)
      : this.refreshTokenRepository.update(criteria, partialEntity));
  }

  private async handleRevokedRefreshToken(
    storedToken: RefreshToken,
    fallbackRawToken: string,
    nowMs: number,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const elapsedMs = nowMs - storedToken.revoked_at!.getTime();

    if (elapsedMs > REFRESH_GRACE_PERIOD_MS) {
      await this.refreshTokenRepository.update(
        { family: storedToken.family, revoked_at: IsNull() },
        { revoked_at: new Date(nowMs) },
      );
      throw new TokenReuseDetectedException();
    }

    const latestActiveToken = await this.refreshTokenRepository.findOne({
      where: {
        family: storedToken.family,
        revoked_at: IsNull(),
      },
      order: { created_at: 'DESC' },
    });

    if (!latestActiveToken) {
      throw new InvalidTokenException();
    }

    if (latestActiveToken.expires_at.getTime() <= nowMs) {
      throw new TokenExpiredException();
    }

    const user = await this.usersService.findById(storedToken.user_id);
    if (!user) {
      throw new InvalidTokenException();
    }

    const cachedRefreshToken = this.getCachedRefreshToken(
      latestActiveToken.token_hash,
      nowMs,
    );

    return {
      access_token: this.signAccessToken(user.id, user.email),
      refresh_token: cachedRefreshToken ?? fallbackRawToken,
    };
  }

  private signAccessToken(userId: string, email: string): string {
    return this.jwtService.sign(
      { sub: userId, email },
      {
        expiresIn: this.auth.jwtAccessExpiration,
      },
    );
  }

  private buildRefreshToken(
    userId: string,
    family: string,
  ): { rawToken: string; entity: RefreshToken } {
    const tokenId = randomUUID();
    const rawToken = this.jwtService.sign(
      { sub: userId, family, jti: tokenId },
      {
        secret: this.auth.jwtRefreshSecret,
        expiresIn: this.auth.jwtRefreshExpiration,
      },
    );

    const decodedRefresh = this.jwtService.decode<{ exp?: number } | null>(
      rawToken,
    );
    if (!decodedRefresh || typeof decodedRefresh.exp !== 'number') {
      throw new Error('Refresh token is missing exp claim');
    }

    const tokenHash = this.hashToken(rawToken);
    const entity = this.refreshTokenRepository.create({
      token_hash: tokenHash,
      family,
      user_id: userId,
      expires_at: new Date(decodedRefresh.exp * 1000),
      revoked_at: null,
    });

    return { rawToken, entity };
  }

  private verifyRefreshJwt(rawToken: string, storedToken: RefreshToken): void {
    let payload: { sub?: unknown; family?: unknown };
    try {
      payload = this.jwtService.verify<{ sub?: unknown; family?: unknown }>(
        rawToken,
        {
          secret: this.auth.jwtRefreshSecret,
          ignoreExpiration: true,
        },
      );
    } catch {
      throw new InvalidTokenException();
    }

    if (
      payload.sub !== storedToken.user_id ||
      payload.family !== storedToken.family
    ) {
      throw new InvalidTokenException();
    }
  }

  private cacheRotatedRefreshToken(
    tokenHash: string,
    rawToken: string,
    nowMs: number,
  ): void {
    for (const [key, entry] of this.rotatedTokenGraceCache.entries()) {
      if (nowMs > entry.expiresAtMs) {
        this.rotatedTokenGraceCache.delete(key);
      }
    }

    this.rotatedTokenGraceCache.set(tokenHash, {
      rawToken,
      expiresAtMs: nowMs + REFRESH_GRACE_PERIOD_MS,
    });
  }

  private getCachedRefreshToken(
    tokenHash: string,
    nowMs: number,
  ): string | undefined {
    const entry = this.rotatedTokenGraceCache.get(tokenHash);
    if (!entry) {
      return undefined;
    }

    if (nowMs > entry.expiresAtMs) {
      this.rotatedTokenGraceCache.delete(tokenHash);
      return undefined;
    }

    return entry.rawToken;
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
