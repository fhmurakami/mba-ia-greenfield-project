# Phase 02 — Cadastro, Login e Gerenciamento de Conta — Progress

**Status:** completed
**SIs:** 13/13 completed

### SI-02.1 — Dependencies, Configuration Namespaces, and Docker Compose

- **Status:** completed
- **Tests:** no tests
- **Observations:** none

### SI-02.2 — Global ValidationPipe and Domain Exception Filter

- **Status:** completed
- **Tests:** 2 suites passed (12 tests)
- **Observations:** none

### SI-02.3 — User and Channel Entities

- **Status:** completed
- **Tests:** 3 suites passed (9 tests)
- **Observations:** Updated `nestjs-project/package.json` Jest `testRegex` to `.*\.(integration-)?spec\.ts$` with `maxWorkers: 1` so `*.integration-spec.ts` files are discovered by Jest and run serially against PostgreSQL; renamed `src/users/users.module.spec.ts` to `src/users/users.module.integration-spec.ts` since `UsersModule` compilation connects to PostgreSQL via `TypeOrmModule.forRoot`.

### SI-02.4 — RefreshToken and VerificationToken Entities

- **Status:** completed
- **Tests:** 2 suites passed (9 tests)
- **Observations:** none

### SI-02.5 — Mail Module and Email Templates

- **Status:** completed
- **Tests:** 2 suites passed (5 tests)
- **Observations:** Configured `compilerOptions.assets` in `nestjs-project/nest-cli.json` to copy `mail/templates/**/*.hbs` to `dist/` on build; added `APP_URL` (`appConfig.baseUrl`) injected via `appConfig.KEY` in `MailService` with `/auth/` confirmation and reset routes; centralized templates/subjects in `src/mail/mail.constants.ts` and Mailpit test helpers in `test/mailpit.ts`; `MailerModule.forRootAsync` and `MailService` rely on global `ConfigModule` (`ConfigModule.forRoot({ isGlobal: true, load: [appConfig, mailConfig] })` in tests with `jest.setTimeout(15000)`).

### SI-02.6 — User Registration with Automatic Channel Creation

- **Status:** completed
- **Tests:** 6 suites passed (53 tests)
- **Observations:** `UsersService` (`existsByEmail`, `createUserWithChannel`, `findByEmail`) and `AuthService.register` normalize emails via `trim().toLowerCase()` before duplicate checks, persistence, and sending confirmation emails. `UsersService.createUserWithChannel` accepts an optional external `EntityManager` (used by `AuthService.register` so user, channel, and verification token are persisted atomically in the same `dataSource.transaction(...)` while `mailService.sendConfirmationEmail` runs outside), translates PostgreSQL `23505` `(email)=` violations to `EmailAlreadyExistsException`, and uses a nested `txManager.transaction()` savepoint around each `Channel` insert so `23505` nickname collisions retry with `appendRandomSuffix` without aborting the outer transaction. Context7 docs for `class-validator` served `v0.15.1` (closest to installed `^0.14.4`), with identical `@IsEmail`, `@IsString`, `@MinLength`, and `@MaxLength` decorator signatures and default messages. Extracted reusable DB connection and cleanup helpers into `test/create-test-data-source.ts` (`getTestTypeOrmOptions`, `createTestDataSource`, `clearTestTables`) and split long `it` blocks into focused assertions.

### SI-02.7 — Email Confirmation (Confirm and Resend)

- **Status:** completed
- **Tests:** 3 suites passed (53 tests)
- **Observations:** Implemented `ConfirmEmailDto`, `ResendConfirmationDto`, `AuthService.confirm`, `AuthService.resendConfirmation`, and `POST /auth/confirm-email` + `POST /auth/resend-confirmation` (`204 No Content`). `confirm` validates token existence/`used_at` (`InvalidTokenException`) before `expires_at <= now` (`TokenExpiredException`), atomically consumes the token (`used_at: IsNull()`), and delegates `is_confirmed = true` update to `UsersService.markEmailConfirmed(userId, manager)` inside `dataSource.transaction()`. `resendConfirmation` normalizes email, returns silently for unknown or already-confirmed users, invalidates unused `email_confirmation` tokens and persists a new SHA-256 token atomically via `createVerificationToken`, then sends the confirmation email outside the transaction. Context7 verification: `typeorm@0.3.31` exact docs (`EntityManager.update` + `IsNull()`); `@nestjs/common@^11.0.1` served current NestJS 11 docs (`@HttpCode(HttpStatus.NO_CONTENT)`); `class-validator@^0.14.4` served closest `v0.15.1` (`@IsString`, `@IsNotEmpty`, `@IsEmail`).

### SI-02.8 — Login with Credential Validation and Token Issuance

- **Status:** completed
- **Tests:** 4 suites passed (66 tests)
- **Observations:** Implemented `LoginDto`, configured `JwtModule.registerAsync` (injecting `authConfig.KEY`) and exported `JwtModule` in `AuthModule`, implemented `AuthService.login` (email normalization via `trim().toLowerCase()`, Argon2 verification before `is_confirmed` check so unconfirmed accounts do not leak existence on wrong password, separate `jwtSecret`/`jwtRefreshSecret` signing, `RefreshToken` persistence with `family`/`jti` UUIDs, SHA-256 `token_hash` via shared `hashToken` helper, and `expires_at` derived from decoded refresh JWT `exp`), and added `POST /auth/login` (`200 OK`). Named the module compilation test `src/auth/auth.module.integration-spec.ts` (instead of `.spec.ts`) per `SI-02.3` PostgreSQL test convention and verified `AuthModule` export contract + default `JwtModule` secret configuration in tests. Context7 verification: `@nestjs/jwt@^11.0.2` exact `11.0.2` docs (`JwtModule.registerAsync`, `JwtService.sign`/`verify`/`decode`, casting string expiration to `JwtSignOptions['expiresIn']`), `argon2@^0.41.1` exact `v0.41.1` docs (`argon2.verify(digest, password)`), `class-validator@^0.14.4` closest `v0.15.1`, `@nestjs/common@^11.0.1` NestJS 11.

### SI-02.9 — JWT Access Token Guard

- **Status:** completed
- **Tests:** 2 suites passed (41 tests)
- **Observations:** Implemented `@Public()` (`IS_PUBLIC_KEY`), `@CurrentUser()` (with `JwtPayload`), and `JwtAuthGuard` registered globally via `APP_GUARD` in `AuthModule` so all routes require a valid Bearer access token by default. Extracted shared `JwtPayload` / `AuthenticatedRequest` types into `src/auth/auth.types.ts` and `IS_PUBLIC_KEY` / `BEARER_SCHEME` into `src/auth/auth.constants.ts`, supporting case-insensitive `Bearer` scheme matching per RFC 9110. Decorated `AppController.getHello()` and the existing public routes in `AuthController` (`register`, `confirm-email`, `resend-confirmation`, `login`) individually with `@Public()`. Verified in `jwt-auth.guard.spec.ts` using real `JwtModule.register(...)` and in `test/auth.e2e-spec.ts` using a test-only `TestProtectedController` (`GET /test-protected/me`), asserting `{ statusCode: 401, error: 'Unauthorized', message }` rejections and `@Public()` access even with a stale `Authorization` header. Context7 verification: `@nestjs/jwt@^11.0.2` exact `11.0.2` docs (`jwtService.verifyAsync<JwtPayload>`), `@nestjs/common@^11.0.1` / `@nestjs/core@^11.0.1` served current NestJS 11 docs (`CanActivate`, `Reflector.getAllAndOverride`, `SetMetadata`, `createParamDecorator`, `APP_GUARD`).

### SI-02.10 — Refresh Token Rotation

- **Status:** completed
- **Tests:** 4 suites passed (110 tests)
- **Observations:** Implemented `RefreshTokenDto`, `UsersService.findById`, `REFRESH_GRACE_PERIOD_MS` (`10_000`) in `auth.constants.ts`, `AuthService.refresh` with shared `signAccessToken`/`buildRefreshToken` helpers, and `@Public() @Post('refresh')` (`200 OK`) in `AuthController`. `refresh` hashes the incoming token with SHA-256, validates persistence, expiration, and JWT signature/claims (`sub`, `family`) against `jwtRefreshSecret`, atomically revokes the active token and persists a new token in the same `family` inside `dataSource.transaction()`, handles concurrent rotation races (`affected === 0`) and 10s grace-period retries via `rotatedTokenGraceCache` without creating extra rows or revoking the family, and commits full family revocation outside any throwing transaction before throwing `TokenReuseDetectedException` when reuse occurs past 10s. Compared against commit `9ad00f0c`, preserved transactional rotation, active-family validation during the grace window, active-token grace cache, JWT verification, and `UsersService` encapsulation, and added unit/integration/E2E coverage for grace-period expiry, cache eviction on rollback, DB transaction rollback, unknown token lookup, and `@Public()` refresh with an expired `Authorization` header. Context7 verification: `typeorm@0.3.31` exact docs (`findOne`, `IsNull()`, `EntityManager.update`, `dataSource.transaction`), `@nestjs/jwt@^11.0.2` exact `11.0.2` docs (`JwtService.sign`/`verify`/`decode`), and `class-validator@^0.14.4` served closest `v0.15.1` (`@IsString`, `@IsNotEmpty`).

### SI-02.11 — Logout and Session Revocation

- **Status:** completed
- **Tests:** 3 suites passed (108 tests)
- **Observations:** Implemented `AuthService.logout(userId)` revoking all non-revoked refresh tokens for the user (`{ user_id: userId, revoked_at: IsNull() }` → `{ revoked_at: new Date(Date.now()) }`) and added authenticated `@Post('logout') @HttpCode(HttpStatus.NO_CONTENT)` in `AuthController` (protected by global `JwtAuthGuard`, extracting `@CurrentUser('sub') userId`). Verified that post-logout refresh attempts fail with `INVALID_TOKEN` within the 10s grace window (no active token in family) and `TOKEN_REUSE_DETECTED` beyond 10s, without affecting other users' tokens or prior `revoked_at` timestamps. Compared against commit `9e1a38f9`: kept `Repository.update` with `IsNull()` over `QueryBuilder`, `@CurrentUser('sub')`, and `SI-02.10` active-family grace validation; split logout integration/E2E tests into focused scenarios and added coverage for rotated-family grace-cache non-leakage and idempotent repeat logout. Context7 verification: `typeorm@0.3.31` exact docs (`Repository.update` with `IsNull()`), `@nestjs/common@^11.0.1` served current NestJS 11 docs (`@HttpCode(HttpStatus.NO_CONTENT)`, `createParamDecorator`).

### SI-02.12 — Password Reset (Request and Execute)

- **Status:** completed
- **Tests:** 5 suites passed (174 tests)
- **Observations:** Implemented `ForgotPasswordDto`, `ResetPasswordDto`, `UsersService.updatePassword(userId, hashedPassword, manager?)` (preserving `UsersModule` encapsulation), `AuthService.forgotPassword`, `AuthService.resetPassword`, shared private `AuthService.revokeUserRefreshTokens` (reused by `logout` and `resetPassword`), and `@Public() @Post('forgot-password')` + `@Public() @Post('reset-password')` (`204 No Content`) in `AuthController`. `forgotPassword` normalizes email via `trim().toLowerCase()`, returns silently for unknown emails, invalidates prior unused `password_reset` tokens without affecting `email_confirmation` tokens, and sends the reset email outside the transaction. `resetPassword` validates existence/unused (`InvalidTokenException`) before expiration (`TokenExpiredException`), hashes with Argon2 before opening `dataSource.transaction(...)`, atomically marks the token used (`used_at: IsNull()`), updates the password, and revokes all active refresh tokens. Compared against commit `102d7813`, kept transactional atomicity and conditional `used_at: IsNull()` concurrency guard, `UsersService.updatePassword` encapsulation, email normalization, `IsNull()` updates without `as any`, and real Mailpit verification; split and expanded `SI-02.12` integration and E2E tests for single-scenario isolation, post-reset login, rotated-family grace-cache rejection, unknown/wrong-type tokens, `@Public()` stale-Bearer access, missing `token` validation, and rollback password preservation. Context7 verification: `argon2@^0.41.1` exact `v0.41.1` docs, `typeorm@0.3.31` exact `0.3.31` docs (`IsNull()`, `EntityManager.update`), and `class-validator@^0.14.4` served closest `v0.15.1` docs (`@IsEmail`, `@IsString`, `@IsNotEmpty`, `@MinLength`, `@MaxLength` — identical decorator signatures and default messages).

### SI-02.13 — Rate Limiting on Auth Endpoints

- **Status:** completed
- **Tests:** 2 suites passed (64 tests: 1 in `auth.module.integration-spec.ts`, 63 in E2E) — Full Phase 02 verification: 17 unit/integration suites (173 tests), 2 E2E suites (63 tests)
- **Observations:** Configured `ThrottlerModule.forRoot([{ ttl: AUTH_THROTTLE_TTL_MS, limit: AUTH_THROTTLE_LIMIT }])` (`60_000` ms, `10` req/min) in `AuthModule` and registered `ThrottlerGuard` as `APP_GUARD` before `JwtAuthGuard` so all `/auth/*` routes (including unauthenticated `POST /auth/logout`) enforce per-IP rate limiting prior to JWT verification. Decorated `AppController` and test-only `TestProtectedController` with `@SkipThrottle()` so non-auth routes remain exempt even with global `APP_GUARD` binding. Compared against commit `03d1f617`, preserved `ThrottlerGuard`-first `APP_GUARD` ordering, single-app `throttlerStorage.onApplicationShutdown()` reset in `beforeEach` over `.storage.clear()` (which leaves `hitExpirations` dirty in `@nestjs/throttler@6.8.0`), and split/expanded E2E tests for single-scenario isolation (`GET /` vs `GET /test-protected/me`), authenticated `POST /auth/logout` throttling, `X-Forwarded-For` spoof resistance with `trust proxy` disabled, and per-IP tracking. Context7 verification: `@nestjs/throttler@^6.8.0` exact `v6.8.0` docs (`ThrottlerModule.forRoot`, `APP_GUARD`, `ThrottlerGuard`, `@SkipThrottle()`, `ThrottlerStorage`).

## Out-of-Scope Tasks

- [x] Extract duplicated global pipes/filters configuration between `src/main.ts` and `test/auth.e2e-spec.ts` into a shared bootstrap helper (per `testing-guide-nestjs-project/references/gotchas.md` §2).
- [x] Type `jwtAccessExpiration` and `jwtRefreshExpiration` as `JwtSignOptions['expiresIn']` in `src/config/auth.config.ts` and validate duration format (e.g., `/^\d+[smhd]$/`) in `src/config/env.validation.ts` so invalid expiration strings fail at startup and redundant type assertions in `AuthModule`/`AuthService` are removed.
- [x] Extract duplicated email normalization (`email.trim().toLowerCase()`) between `UsersService` and `AuthService` into a shared utility helper.
- [x] Adopt `JwtPayload` (and a typed `RefreshTokenPayload`) from `src/auth/auth.types.ts` in `AuthService` token signing/decoding and login E2E assertions so JWT payload contracts share a single source of truth.
- [ ] Evaluate whether an authenticated session-inspection endpoint (e.g., `GET /auth/me` as in reference commit `c927802`, or `GET /users/me` in Phase 03) should be formally added to the API contract with an explicit rate-limit policy.
- [ ] Hoist and deduplicate shared E2E/integration auth setup helpers (`registerAndConfirmUser` / `registerConfirmAndLogin`, keeping real Mailpit token extraction) across `describe` blocks in `src/auth/auth.service.integration-spec.ts` and `test/auth.e2e-spec.ts`.
- [ ] Evaluate a global `HttpException` filter to normalize framework error codes (e.g., `UnauthorizedException` -> `UNAUTHORIZED`, `ThrottlerException` -> `TOO_MANY_REQUESTS`) to `UPPER_SNAKE_CASE` alongside `DomainExceptionFilter` and `ValidationExceptionFilter`.
- [ ] Move AuthService's 10-second refresh-token grace-period cache (`rotatedTokenGraceCache`) from an in-memory `Map` to a shared distributed cache (e.g., Redis) if `nestjs-api` is scaled horizontally across multiple replicas.
- [ ] Add a scheduled maintenance job to prune expired `refresh_tokens` and `verification_tokens` rows past their audit/reuse-detection retention window so token tables do not grow unbounded.
- [ ] Evaluate immediate access-token invalidation on logout and password reset (e.g., short-TTL Redis jti denylist or per-user tokens_valid_after timestamp checked in JwtAuthGuard) if stateless JWT access-token validity up to JWT_ACCESS_EXPIRATION is unacceptable for sensitive operations.
- [ ] Extract shared transactional verification-token helpers in `AuthService` (lookup/expiration validation by `VerificationTokenType`, conditional `used_at` consumption, and prior-token invalidation + replacement) to deduplicate `confirm`/`resendConfirmation` (`SI-02.7`) and `resetPassword`/`forgotPassword` (`SI-02.12`).
- [ ] Dispatch confirmation and password-reset emails asynchronously via a background job queue (decoupling HTTP response latency from SMTP delivery and mitigating response-time user enumeration on `forgot-password` and `resend-confirmation`).
- [ ] Scope ThrottlerGuard (or configure tiered global vs auth named throttlers / Redis-backed ThrottlerStorage) before adding non-auth controllers in Phase 03+, since NestJS APP_GUARD applies globally unless controllers opt out with @SkipThrottle() and default ThrottlerStorageService is in-memory per replica.
- [ ] Externalize rate-limit configuration (`THROTTLE_TTL_MS`, `THROTTLE_LIMIT`) into `authConfig` and `envValidationSchema` via `ThrottlerModule.forRootAsync` so limits can be tuned per environment without code changes.
- [ ] Evaluate endpoint-specific `@Throttle()` overrides (stricter limits on `forgot-password`, `resend-confirmation`, and `login`) and explicit Express `trust proxy` configuration when deploying behind a reverse proxy/load balancer so `req.ip` resolves the real client IP instead of the proxy IP.
