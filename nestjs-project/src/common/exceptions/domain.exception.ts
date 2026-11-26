/**
 * Base class for domain-level exceptions thrown by application services.
 * Mapped to standardized HTTP error responses by {@link DomainExceptionFilter}.
 */
export abstract class DomainException extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor(message = 'Email is already registered') {
    super(message, 'EMAIL_ALREADY_EXISTS', 409);
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor(message = 'Invalid email or password') {
    super(message, 'INVALID_CREDENTIALS', 401);
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor(message = 'Email not confirmed') {
    super(message, 'EMAIL_NOT_CONFIRMED', 403);
  }
}

export class InvalidTokenException extends DomainException {
  constructor(message = 'Invalid or already used token') {
    super(message, 'INVALID_TOKEN', 401);
  }
}

export class TokenExpiredException extends DomainException {
  constructor(message = 'Token has expired') {
    super(message, 'TOKEN_EXPIRED', 401);
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor(message = 'Token reuse detected — all sessions revoked') {
    super(message, 'TOKEN_REUSE_DETECTED', 401);
  }
}
