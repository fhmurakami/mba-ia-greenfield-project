# Phase 02 — Cadastro, Login e Gerenciamento de Conta — Progress

**Status:** in_progress
**SIs:** 9/13 completed

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

- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-02.11 — Logout and Session Revocation

- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-02.12 — Password Reset (Request and Execute)

- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-02.13 — Rate Limiting on Auth Endpoints

- **Status:** pending
- **Tests:** pending
- **Observations:** none

## Out-of-Scope Tasks

- [ ] Extract duplicated global pipes/filters configuration between `src/main.ts` and `test/auth.e2e-spec.ts` into a shared bootstrap helper (per `testing-guide-nestjs-project/references/gotchas.md` §2).
- [ ] Type `jwtAccessExpiration` and `jwtRefreshExpiration` as `JwtSignOptions['expiresIn']` in `src/config/auth.config.ts` and validate duration format (e.g., `/^\d+[smhd]$/`) in `src/config/env.validation.ts` so invalid expiration strings fail at startup and redundant type assertions in `AuthModule`/`AuthService` are removed.
- [ ] Extract duplicated email normalization (`email.trim().toLowerCase()`) between `UsersService` and `AuthService` into a shared utility helper.
- [ ] Adopt `JwtPayload` (and a typed `RefreshTokenPayload`) from `src/auth/auth.types.ts` in `AuthService` token signing/decoding and login E2E assertions so JWT payload contracts share a single source of truth.
- [ ] Evaluate whether an authenticated session-inspection endpoint (e.g., `GET /auth/me` as in reference commit `c927802`, or `GET /users/me` in Phase 03) should be formally added to the API contract with an explicit rate-limit policy.
- [ ] Hoist and deduplicate shared E2E auth setup helpers (`registerAndConfirmUser` / `registerConfirmAndLogin`, keeping real Mailpit token extraction) across `describe` blocks in `test/auth.e2e-spec.ts`.
- [ ] Evaluate a global `HttpException` filter to normalize framework error codes (e.g., `UnauthorizedException` -> `UNAUTHORIZED`, `ThrottlerException` -> `TOO_MANY_REQUESTS`) to `UPPER_SNAKE_CASE` alongside `DomainExceptionFilter` and `ValidationExceptionFilter`.
