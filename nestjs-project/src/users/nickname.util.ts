import { randomInt } from 'node:crypto';

const ALPHANUMERIC_LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_NICKNAME_LENGTH = 50;
const SUFFIX_RESERVE = 4; // '_' + 3 alphanumeric chars
const MAX_BASE_LENGTH = MAX_NICKNAME_LENGTH - SUFFIX_RESERVE;

function randomAlphanumeric(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC_LOWER[randomInt(ALPHANUMERIC_LOWER.length)];
  }
  return result;
}

export function sanitizeNickname(emailPrefix: string): string {
  const cleaned = emailPrefix
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, MAX_BASE_LENGTH);

  if (cleaned.length === 0) {
    return `user_${randomAlphanumeric(8)}`;
  }

  return cleaned;
}

export function appendRandomSuffix(nickname: string): string {
  const base = nickname.slice(0, MAX_BASE_LENGTH);
  return `${base}_${randomAlphanumeric(3)}`;
}
