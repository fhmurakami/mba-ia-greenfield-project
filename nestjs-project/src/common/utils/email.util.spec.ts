import { normalizeEmail } from './email.util';

describe('email.util', () => {
  describe('normalizeEmail', () => {
    it('should trim surrounding whitespace and convert to lowercase', () => {
      expect(normalizeEmail('  Alice.Creator@Example.COM \n')).toBe(
        'alice.creator@example.com',
      );
    });

    it('should return already normalized emails unchanged', () => {
      expect(normalizeEmail('user@example.com')).toBe('user@example.com');
    });
  });
});
