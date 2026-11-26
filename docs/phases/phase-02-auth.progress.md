# Phase 02 — Cadastro, Login e Gerenciamento de Conta — Progress

**Status:** in_progress
**SIs:** 4/13 completed

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

- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-02.6 — User Registration with Automatic Channel Creation

- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-02.7 — Email Confirmation (Confirm and Resend)

- **Status:** pending
- **Tests:** pending
- **Observations:** none

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
