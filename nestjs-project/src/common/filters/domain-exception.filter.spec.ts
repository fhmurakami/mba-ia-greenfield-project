import { ArgumentsHost } from '@nestjs/common';
import {
  DomainException,
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../exceptions/domain.exception';
import { DomainExceptionFilter } from './domain-exception.filter';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it.each<{
    name: string;
    exception: DomainException;
    statusCode: number;
    error: string;
    message: string;
  }>([
    {
      name: 'EmailAlreadyExistsException',
      exception: new EmailAlreadyExistsException(),
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    },
    {
      name: 'InvalidCredentialsException',
      exception: new InvalidCredentialsException(),
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    },
    {
      name: 'EmailNotConfirmedException',
      exception: new EmailNotConfirmedException(),
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: 'Email not confirmed',
    },
    {
      name: 'InvalidTokenException',
      exception: new InvalidTokenException(),
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: 'Invalid or already used token',
    },
    {
      name: 'TokenExpiredException',
      exception: new TokenExpiredException(),
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: 'Token has expired',
    },
    {
      name: 'TokenReuseDetectedException',
      exception: new TokenReuseDetectedException(),
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: 'Token reuse detected — all sessions revoked',
    },
  ])(
    'maps $name to $statusCode with error code $error',
    ({ exception, statusCode, error, message }) => {
      filter.catch(exception, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(statusCode);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode,
        error,
        message,
      });
    },
  );
});
