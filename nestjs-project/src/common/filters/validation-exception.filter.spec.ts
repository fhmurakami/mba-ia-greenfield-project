import {
  ArgumentsHost,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ValidationExceptionFilter } from './validation-exception.filter';

class SampleDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

describe('ValidationExceptionFilter', () => {
  let filter: ValidationExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ValidationExceptionFilter();
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

  it('normalizes an array of field errors into VALIDATION_ERROR shape', () => {
    const exception = new BadRequestException([
      'email must be an email',
      'password must be longer than or equal to 8 characters',
    ]);

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
    });
  });

  it('normalizes a single string message property into a string array', () => {
    const exception = new BadRequestException({
      statusCode: 400,
      message: 'Malformed JSON body',
      error: 'Bad Request',
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: ['Malformed JSON body'],
    });
  });

  it('normalizes a raw string exception response into a string array', () => {
    const exception = new BadRequestException('Unexpected request body');

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: ['Unexpected request body'],
    });
  });

  describe('with ValidationPipe (whitelist, forbidNonWhitelisted, transform)', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    it('formats invalid DTO field errors via ValidationExceptionFilter', async () => {
      let caughtError: BadRequestException | undefined;

      try {
        await pipe.transform(
          { email: 'not-an-email', password: 'short' },
          { type: 'body', metatype: SampleDto },
        );
      } catch (error) {
        caughtError = error as BadRequestException;
      }

      expect(caughtError).toBeInstanceOf(BadRequestException);
      filter.catch(caughtError!, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: [
          'email must be an email',
          'password must be longer than or equal to 8 characters',
        ],
      });
    });

    it('rejects unknown properties and formats the error', async () => {
      let caughtError: BadRequestException | undefined;

      try {
        await pipe.transform(
          { email: 'user@example.com', password: 'password123', extra: 'nope' },
          { type: 'body', metatype: SampleDto },
        );
      } catch (error) {
        caughtError = error as BadRequestException;
      }

      expect(caughtError).toBeInstanceOf(BadRequestException);
      filter.catch(caughtError!, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: ['property extra should not exist'],
      });
    });

    it('transforms a valid payload into a SampleDto instance', async () => {
      const result = (await pipe.transform(
        { email: 'user@example.com', password: 'password123' },
        { type: 'body', metatype: SampleDto },
      )) as unknown;

      expect(result).toBeInstanceOf(SampleDto);
      expect(result).toEqual({
        email: 'user@example.com',
        password: 'password123',
      });
    });
  });
});
