import { MailerService } from '@nestjs-modules/mailer';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from '../config/app.config';
import { MAIL_SUBJECTS, MAIL_TEMPLATES } from './mail.constants';

@Injectable()
export class MailService {
  constructor(
    private readonly mailerService: MailerService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  async sendConfirmationEmail(
    email: string,
    name: string,
    token: string,
  ): Promise<void> {
    const confirmationUrl = `${this.app.baseUrl}/auth/confirm-email?token=${encodeURIComponent(token)}`;

    await this.mailerService.sendMail({
      to: email,
      subject: MAIL_SUBJECTS.CONFIRMATION,
      template: MAIL_TEMPLATES.CONFIRMATION,
      context: {
        name,
        confirmationUrl,
      },
    });
  }

  async sendPasswordResetEmail(
    email: string,
    name: string,
    token: string,
  ): Promise<void> {
    const resetUrl = `${this.app.baseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;

    await this.mailerService.sendMail({
      to: email,
      subject: MAIL_SUBJECTS.PASSWORD_RESET,
      template: MAIL_TEMPLATES.PASSWORD_RESET,
      context: {
        name,
        resetUrl,
      },
    });
  }
}
