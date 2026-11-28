import type { Request } from 'express';

export interface JwtPayload {
  sub: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  family: string;
  jti: string;
  iat?: number;
  exp?: number;
}

export type AuthenticatedRequest = Request & {
  user?: JwtPayload;
};
