import {
  type ExecutionContext,
  type Type,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import type { JwtPayload } from '../auth.types';
import { Public } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const TEST_ACCESS_SECRET = 'test-access-secret-min-32-chars-long';
const TEST_OTHER_SECRET = 'other-refresh-secret-min-32-chars-long';

class ProtectedTestController {
  protectedRoute(): void {}

  @Public()
  publicRoute(): void {}
}

@Public()
class PublicTestController {
  inheritedPublicRoute(): void {}
}

function getHandler(
  targetClass: Type<unknown>,
  methodName: string,
): (...args: unknown[]) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(
    targetClass.prototype,
    methodName,
  );
  if (!descriptor || typeof descriptor.value !== 'function') {
    throw new Error(`Method ${methodName} not found on ${targetClass.name}`);
  }
  return descriptor.value as (...args: unknown[]) => unknown;
}

function createMockExecutionContext(options: {
  authorization?: string;
  targetClass?: Type<unknown>;
  methodName?: string;
}): {
  context: ExecutionContext;
  request: { headers: { authorization?: string }; user?: JwtPayload };
} {
  const targetClass = options.targetClass ?? ProtectedTestController;
  const methodName = options.methodName ?? 'protectedRoute';
  const handler = getHandler(targetClass, methodName);
  const request: { headers: { authorization?: string }; user?: JwtPayload } = {
    headers: options.authorization
      ? { authorization: options.authorization }
      : {},
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => jest.fn(),
    }),
    getClass: () => targetClass,
    getHandler: () => handler,
    getArgs: () => [],
    getArgByIndex: () => null,
    switchToRpc: () => ({}),
    switchToWs: () => ({}),
    getType: () => 'http',
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_ACCESS_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [JwtAuthGuard, Reflector],
    }).compile();

    guard = moduleRef.get(JwtAuthGuard);
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should allow access and attach decoded payload to request.user for a valid Bearer JWT', async () => {
    const token = jwtService.sign({
      sub: 'user-123',
      email: 'alice@example.com',
    });
    const { context, request } = createMockExecutionContext({
      authorization: `Bearer ${token}`,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(
      expect.objectContaining({
        sub: 'user-123',
        email: 'alice@example.com',
      }),
    );
  });

  it('should accept case-insensitive bearer scheme per RFC 9110', async () => {
    const token = jwtService.sign({
      sub: 'user-123',
      email: 'alice@example.com',
    });
    const { context, request } = createMockExecutionContext({
      authorization: `bearer ${token}`,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(
      expect.objectContaining({
        sub: 'user-123',
        email: 'alice@example.com',
      }),
    );
  });

  it('should throw UnauthorizedException when Authorization header is missing', async () => {
    const { context } = createMockExecutionContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException when Authorization header uses a non-Bearer scheme', async () => {
    const token = jwtService.sign({
      sub: 'user-123',
      email: 'alice@example.com',
    });
    const { context } = createMockExecutionContext({
      authorization: `Basic ${token}`,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException when Authorization header is malformed', async () => {
    for (const header of ['Bearer', 'Bearer ', 'Bearer token extra']) {
      const { context } = createMockExecutionContext({ authorization: header });

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('should throw UnauthorizedException when JWT is expired', async () => {
    const expiredToken = jwtService.sign(
      { sub: 'user-123', email: 'alice@example.com' },
      { expiresIn: '-1s' },
    );
    const { context } = createMockExecutionContext({
      authorization: `Bearer ${expiredToken}`,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException when JWT is signed with another secret or malformed', async () => {
    const wrongSecretToken = jwtService.sign(
      { sub: 'user-123', email: 'alice@example.com' },
      { secret: TEST_OTHER_SECRET },
    );

    for (const invalidToken of [wrongSecretToken, 'not-a-jwt']) {
      const { context } = createMockExecutionContext({
        authorization: `Bearer ${invalidToken}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('should throw UnauthorizedException when JWT payload lacks required sub or email claims', async () => {
    const incompleteToken = jwtService.sign({
      sub: 'user-123',
      family: 'family-uuid',
    });
    const { context } = createMockExecutionContext({
      authorization: `Bearer ${incompleteToken}`,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should bypass verification when route handler is decorated with @Public()', async () => {
    const { context, request } = createMockExecutionContext({
      targetClass: ProtectedTestController,
      methodName: 'publicRoute',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('should bypass verification when controller class is decorated with @Public()', async () => {
    const { context, request } = createMockExecutionContext({
      targetClass: PublicTestController,
      methodName: 'inheritedPublicRoute',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('should bypass verification on @Public() routes even when an invalid Authorization header is present', async () => {
    const { context, request } = createMockExecutionContext({
      authorization: 'Bearer invalid-or-expired-token',
      targetClass: ProtectedTestController,
      methodName: 'publicRoute',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });
});
