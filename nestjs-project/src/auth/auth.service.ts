import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EmailAlreadyExistsException } from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
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
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(
      Date.now() + this.auth.confirmationTokenExpirationHours * 60 * 60 * 1000,
    );

    const user = await this.dataSource.transaction(async (manager) => {
      const createdUser: User = await this.usersService.createUserWithChannel(
        normalizedEmail,
        hashedPassword,
        manager,
      );

      const verificationToken = this.verificationTokenRepository.create({
        token_hash: tokenHash,
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: createdUser.id,
        expires_at: expiresAt,
        used_at: null,
      });
      await manager.save(VerificationToken, verificationToken);

      return createdUser;
    });

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
}
