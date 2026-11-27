import { appendRandomSuffix, sanitizeNickname } from './nickname.util';

describe('nickname.util', () => {
  describe('sanitizeNickname', () => {
    it('should lowercase and strip characters outside [a-z0-9_]', () => {
      expect(sanitizeNickname('Alice.Bob+Tag-99!')).toBe('alicebobtag99');
    });

    it('should preserve underscores and digits', () => {
      expect(sanitizeNickname('Dev_User_01')).toBe('dev_user_01');
    });

    it('should return user_ followed by 8 alphanumeric chars when cleaned prefix is empty', () => {
      expect(sanitizeNickname('')).toMatch(/^user_[a-z0-9]{8}$/);
      expect(sanitizeNickname('...---+++')).toMatch(/^user_[a-z0-9]{8}$/);
    });

    it('should truncate long prefixes to 46 characters to reserve space for suffix', () => {
      const longPrefix = 'a'.repeat(60);
      const result = sanitizeNickname(longPrefix);
      expect(result).toHaveLength(46);
      expect(result).toBe('a'.repeat(46));
    });
  });

  describe('appendRandomSuffix', () => {
    it('should append an underscore and 3 lowercase alphanumeric characters', () => {
      const result = appendRandomSuffix('alice');
      expect(result).toMatch(/^alice_[a-z0-9]{3}$/);
      expect(result.length).toBeLessThanOrEqual(50);
    });

    it('should keep total length at most 50 characters even for 46+ char inputs', () => {
      const maxBase = 'b'.repeat(46);
      const result46 = appendRandomSuffix(maxBase);
      expect(result46).toHaveLength(50);
      expect(result46).toMatch(new RegExp(`^${maxBase}_[a-z0-9]{3}$`));

      const overLimit = 'c'.repeat(50);
      const result50 = appendRandomSuffix(overLimit);
      expect(result50).toHaveLength(50);
      expect(result50).toMatch(new RegExp(`^${'c'.repeat(46)}_[a-z0-9]{3}$`));
    });
  });
});
