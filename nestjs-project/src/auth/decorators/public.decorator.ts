import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth.constants';

export { IS_PUBLIC_KEY } from '../auth.constants';

/**
 * Marks a route handler or controller as public so {@link JwtAuthGuard} bypasses JWT verification.
 */
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);
