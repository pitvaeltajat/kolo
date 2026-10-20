# Deployment runbook

Kolo is a Next.js service deployed to Vercel. The repository is safe to publish:
runtime credentials, database URLs, device keys, and service-account JSON must
live in the deployment environment or a private operator runbook, never here.

## Vercel

1. Link the repository to a Vercel project.
2. Add every variable listed in [`.env.example`](.env.example) that applies to
   the deployment. Mark credentials as **Secret** and set them for Production.
3. Configure the production domain and the matching Google OAuth callback:
   `https://<public-app-host>/api/auth/callback/google`.
4. Keep deployment protection compatible with the application's own Google
   sign-in flow.

Vercel deployments run `npm run build`. The build generates Prisma Client; the
database schema is applied separately from a trusted machine:

```bash
DATABASE_URL='postgresql://…?sslmode=require' npx prisma migrate deploy
```

Never put the real value in a shell history, issue, commit, or pull request.

## Database

Use a dedicated PostgreSQL database and role for Kolo. Do not reuse another
service's database or role. The production connection must use TLS, and the
database endpoint should be restricted by firewall/network policy where the
hosting provider permits it.

The tracked Prisma migrations are the source of truth. A new migration must be
reviewed and committed before applying it to production.

## MQTT and devices

The broker must require TLS and authentication. The broker hostname, username,
password, private CA material, and `DEVICE_HMAC_KEY` are deployment secrets or
device secrets; only the public CA certificate belongs in this repository.

Devices must use the configuration templates in [`devices/`](devices/) and keep
their `secrets.yaml`/device configuration outside Git. Commands and device
reports are HMAC-signed, timestamp-bound, and nonce-protected.

## Google access

Google OAuth credentials and the Workspace service-account key are secrets.
Domain-wide delegation should include only the scopes required by the features
enabled in this deployment. The access group and impersonated admin are policy
configuration, not source code.

## Scheduled work

The schedules in `vercel.json` are intentionally conservative for the Vercel
Hobby plan. Faster schedules require a plan that supports them or an external
trusted scheduler calling the protected cron routes with `CRON_SECRET`.

## Agent/operator notes

- Read the code, schema, tests, and `devices/README.md` before changing a
  protocol or migration.
- Use `.env.example` as the complete variable-name inventory.
- Ask for access to the private deployment runbook when an operation needs a
  host, password, private key, or production credential.
- Do not copy production values into issues, logs, screenshots, or commits.
