import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Normalizes `BadRequestException` responses (including `ValidationPipe` errors)
 * into `{ statusCode: 400, error: 'VALIDATION_ERROR', message: string[] }`.
 */
@Catch(BadRequestException)
export class ValidationExceptionFilter implements ExceptionFilter<BadRequestException> {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const messages = this.extractMessages(exception);

    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'VALIDATION_ERROR',
      message: messages,
    });
  }

  private extractMessages(exception: BadRequestException): string[] {
    const exceptionResponse = exception.getResponse();

    if (typeof exceptionResponse === 'string') {
      return [exceptionResponse];
    }

    if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse
    ) {
      const rawMessage = exceptionResponse.message;

      if (Array.isArray(rawMessage)) {
        return rawMessage.map((item) => String(item));
      }

      if (typeof rawMessage === 'string') {
        return [rawMessage];
      }
    }

    return [exception.message];
  }
}
