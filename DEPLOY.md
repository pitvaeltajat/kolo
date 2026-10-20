# Deploy status & remaining steps

## Done (2026-10-20)

- Vercel project **`pitvaeltajats-projects/kolo`**, connected to the GitHub repo
  (pushes to `main` auto-deploy to production).
- Deployed: **https://kolo-gold.vercel.app** (`/login` serves; `/api/*` guards
  return 401 correctly before any DB exists).
- Domain **kolo.pitva.fi** added to the project (pending DNS).
- Production env set: `NEXTAUTH_SECRET`, `CRON_SECRET`, `DEVICE_HMAC_KEY`,
  `AUTH_COOKIE_DOMAIN=.pitva.fi`, `GOOGLE_WORKSPACE_DOMAIN=pitkajarvenvaeltajat.fi`,
  `ACCESS_GROUP=jasenet@pitva.fi`, `GOOGLE_DIRECTORY_SUBJECT=admin@…`,
  `HEATING_CALENDAR_ID`, `HEATING_CALENDAR_SUBJECT`, `NOTIFY_FROM`.
  (The generated `DEVICE_HMAC_KEY` must also go into the Shelly/ESP32 configs —
  `vercel env pull` to retrieve it.)

## Remaining — needs your consoles/creds

### 1. DNS (AWS Route 53 — pitva.fi is there; CLI not authenticated here)

Authenticate AWS, then:

```bash
ZONE=$(aws route53 list-hosted-zones-by-name --dns-name pitva.fi \
  --query 'HostedZones[0].Id' --output text)
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch '{
  "Changes":[{"Action":"UPSERT","ResourceRecordSet":{
    "Name":"kolo.pitva.fi.","Type":"CNAME","TTL":300,
    "ResourceRecords":[{"Value":"cname.vercel-dns.com"}]}}]}'
```

Then `vercel domains verify kolo.pitva.fi` until it goes green.

### 2. Turn OFF deployment protection

Project → Settings → Deployment Protection → **Vercel Authentication: off**
(or Preview-only). Otherwise members hit Vercel's SSO wall instead of our Google
login.

### 3. Postgres

Add a Postgres store (Vercel dashboard → Storage → Neon/Prisma Postgres, free),
which sets `DATABASE_URL`. Then create the schema:

```bash
vercel env pull .env.production.local      # gets DATABASE_URL
npx prisma migrate deploy                   # or `migrate dev` locally first to create the migration
```

(No migration files exist yet — run `npx prisma migrate dev --name init` once
against a dev DB to generate `prisma/migrations/`, commit it, then deploy.)

### 4. Google sign-in (OAuth client)

GCP console → APIs & Services → Credentials → OAuth client ID (Web). Authorised
redirect URI: `https://kolo.pitva.fi/api/auth/callback/google` (and the
`kolo-gold.vercel.app` one while testing). Set `GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET`.

### 5. Service account (group check + calendar + sheets)

A GCP service account with a JSON key → `GOOGLE_WORKSPACE_SA_KEY` (raw or
base64). Then in **admin.google.com → Security → API controls → Domain-wide
delegation**, authorise its client ID for scopes:
`admin.directory.group.member.readonly`, `calendar.events.readonly`,
`spreadsheets`. (gcloud can make the SA + key; the delegation grant is an Admin
console step.)

### 6. MQTT broker — DONE (Mosquitto on Lightsail)

Running as a Docker container `kolo-mosquitto` (`eclipse-mosquitto:2`,
`--restart unless-stopped`) on `pitva-debian-1`, TLS on **8883** with a private
CA + password auth (`allow_anonymous false`). DNS `mqtt.pitva.fi` →
`13.51.186.114`, Lightsail port 8883 opened. Config/certs live in
`/etc/kolo-mosquitto/` on the box. Verified end-to-end with kolo's own `mqtt`
client (TLS + auth + pub/sub round-trip).

Vercel env set: `MQTT_URL=mqtts://mqtt.pitva.fi:8883`, `MQTT_USERNAME=kolo`,
`MQTT_PASSWORD` (generated), `MQTT_CA` (base64 of the private CA). The CA cert
(public, not secret) is in `devices/mqtt-ca.crt` for the Shelly/ESP32 configs.

The password + CA/key also sit in this session's scratchpad
(`mqtt-certs/`). Rotate the password with
`docker run --rm -v /etc/kolo-mosquitto/config:/mosquitto/config eclipse-mosquitto:2 mosquitto_passwd -b /mosquitto/config/passwd kolo <new>`
then `docker restart kolo-mosquitto` and update `MQTT_PASSWORD` on Vercel.

> Note: the instance's public IP isn't a static/attached Lightsail IP, so if it
> is ever *stopped/started* the IP changes and `mqtt.pitva.fi` must be updated
> (a reboot keeps it). Attach a static IP to make it permanent — carefully,
> since that changes the IP and your existing web DNS may point at the current one.

### 7. Optional

`DOOR_LOG_SHEET_ID` + `DOOR_LOG_SHEET_SUBJECT` (Sheet mirror of the door log),
`RESEND_API_KEY` + `NOTIFY_TO` (heartbeat email).

## Cron note (Hobby plan)

Hobby rejects sub-daily crons, so `vercel.json` runs heating/allowlist daily and
heartbeat daily. The recurring heating schedule is pushed 7 days ahead so
regular use is covered; ad-hoc same-day calendar bookings and faster heartbeat
need a Pro plan (then set `*/15` etc.).
