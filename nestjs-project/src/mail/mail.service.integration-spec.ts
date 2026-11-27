import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  clearMailpitMessages,
  getMailpitMessage,
  getMailpitMessages,
} from '../../test/mailpit';
import appConfig from '../config/app.config';
import mailConfig from '../config/mail.config';
import { MAIL_SUBJECTS } from './mail.constants';
import { MailModule } from './mail.module';
import { MailService } from './mail.service';

interface MailpitAddress {
  Name: string;
  Address: string;
}

interface MailpitMessageSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

interface MailpitMessageDetail {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  HTML: string;
}

describe('MailService (integration)', () => {
  jest.setTimeout(15000);

  let moduleRef: TestingModule;
  let mailService: MailService;
  const app = appConfig();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, mailConfig],
        }),
        MailModule,
      ],
    }).compile();

    mailService = moduleRef.get(MailService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await clearMailpitMessages();
  });

  describe('sendConfirmationEmail', () => {
    it('should deliver email with correct recipient, sender, and subject', async () => {
      await mailService.sendConfirmationEmail(
        'alice@example.com',
        'alice',
        'confirm-token-abc123',
      );

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      const summary = messages[0];
      expect(summary.To[0].Address).toBe('alice@example.com');
      expect(summary.From.Name).toBe('StreamTube');
      expect(summary.From.Address).toBe('noreply@streamtube.com');
      expect(summary.Subject).toBe(MAIL_SUBJECTS.CONFIRMATION);
    });

    it('should render body with user name and confirmation link', async () => {
      await mailService.sendConfirmationEmail(
        'alice@example.com',
        'alice',
        'confirm-token-abc123',
      );

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      const detail = (await getMailpitMessage(
        messages[0].ID,
      )) as MailpitMessageDetail;

      expect(detail.HTML).toContain('alice');
      expect(detail.HTML).toContain('confirm-token-abc123');
      expect(detail.HTML).toContain(
        `${app.baseUrl}/auth/confirm-email?token=confirm-token-abc123`,
      );
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('should deliver email with correct recipient, sender, and subject', async () => {
      await mailService.sendPasswordResetEmail(
        'bob@example.com',
        'bob_channel',
        'reset-token-xyz789',
      );

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      const summary = messages[0];
      expect(summary.To[0].Address).toBe('bob@example.com');
      expect(summary.From.Name).toBe('StreamTube');
      expect(summary.From.Address).toBe('noreply@streamtube.com');
      expect(summary.Subject).toBe(MAIL_SUBJECTS.PASSWORD_RESET);
    });

    it('should render body with user name, reset link, and expiry notice', async () => {
      await mailService.sendPasswordResetEmail(
        'bob@example.com',
        'bob_channel',
        'reset-token-xyz789',
      );

      const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
      expect(messages).toHaveLength(1);
      const detail = (await getMailpitMessage(
        messages[0].ID,
      )) as MailpitMessageDetail;

      expect(detail.HTML).toContain('bob_channel');
      expect(detail.HTML).toContain('reset-token-xyz789');
      expect(detail.HTML).toContain(
        `${app.baseUrl}/auth/reset-password?token=reset-token-xyz789`,
      );
      expect(detail.HTML.toLowerCase()).toContain('expire');
    });
  });
});
