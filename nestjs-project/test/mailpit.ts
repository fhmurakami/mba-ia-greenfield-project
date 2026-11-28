const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

export async function getMailpitMessages(): Promise<any[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages: any[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<any> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return res.json();
}

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

export interface MailpitMessageDetail {
  ID: string;
  HTML: string;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}

async function extractTokenFromLatestMailpitEmail(
  pattern: RegExp,
  label: string,
): Promise<string> {
  const messages = (await getMailpitMessages()) as MailpitMessageSummary[];
  if (messages.length === 0) {
    throw new Error(`Expected Mailpit message for ${label}, but found none`);
  }

  const detail = (await getMailpitMessage(
    messages[0].ID,
  )) as MailpitMessageDetail;
  const match = pattern.exec(detail.HTML);
  if (!match) {
    throw new Error(`Could not find ${label} token in Mailpit HTML`);
  }

  return match[1];
}

export async function extractConfirmationTokenFromMailpit(): Promise<string> {
  return extractTokenFromLatestMailpitEmail(
    /\/auth\/confirm-email\?token=([a-f0-9]{64})/,
    'email confirmation',
  );
}

export async function extractPasswordResetTokenFromMailpit(): Promise<string> {
  return extractTokenFromLatestMailpitEmail(
    /\/auth\/reset-password\?token=([a-f0-9]{64})/,
    'password reset',
  );
}
