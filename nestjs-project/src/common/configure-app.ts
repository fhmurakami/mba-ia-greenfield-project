import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { DomainExceptionFilter } from './filters/domain-exception.filter';
import { ValidationExceptionFilter } from './filters/validation-exception.filter';

/**
 * Applies the global validation pipe and exception filters shared by
 * production bootstrap and HTTP E2E test applications.
 */
export function configureApp<TServer = unknown>(
  app: INestApplication<TServer>,
): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
}
