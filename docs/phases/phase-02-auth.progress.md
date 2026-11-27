# Phase 02 — Cadastro, Login e Gerenciamento de Conta — Progress

**Status:** in_progress
**SIs:** 7/13 completed

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

- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-02.9 — JWT Access Token Guard

- **Status:** pending
- **Tests:** pending
- **Observations:** none

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
