# Security

## What the API enforces

**Authentication and sessions**
- Passwords are hashed with argon2id. New passwords must be 8–128 characters
  with at least one letter and one number. Login input is length-capped, so
  argon2 can't be fed huge payloads.
- A login for an unknown email still runs an argon2 verify, so response time
  doesn't reveal which emails are registered. A deactivated account gets the
  same `INVALID_CREDENTIALS` answer as a wrong password.
- The session is a JWT (HS256) carrying issuer, audience and max-age claims,
  stored in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production).
  `tokenVersion` revokes sessions ("log out all devices").
- Doctors register with single-use invite codes issued by an admin. Each code
  is stored only as a SHA-256 hash, can be locked to one email, expires, and
  can be revoked. It is claimed atomically, so two registrations can't share
  one. The optional legacy shared code is compared in constant time.
- Password reset links carry a random 256-bit token. Only its hash is stored;
  the token is single-use and expires after 30 minutes. A reset or password
  change signs out every other session. `forgot-password` answers the same way
  whether or not the account exists, and is rate-limited per IP and per
  account.
- Admins can't self-register (`npm run create-admin`), can't change their own
  status or other admins, and deactivating a user revokes their sessions.

**CSRF and the browser boundary**
- State-changing requests are rejected when `Origin` isn't `APP_ORIGIN`, or
  when `Sec-Fetch-Site` is `cross-site`.
- Request bodies must be `application/json` (415 otherwise). This blocks
  form-based CSRF and any multipart file upload.
- No CORS headers are sent, so other sites can't read responses.
- Helmet sends a deny-all CSP with `frame-ancestors 'none'`, HSTS,
  `nosniff`, `no-referrer` and CORP `same-origin`. Every `/api` response is
  `Cache-Control: no-store`.

**Input validation and sanitizing**
- Every route parses its body, query and params with strict Zod schemas, so
  unknown fields such as `role`, `isActive` or `patientId` are rejected.
- Free text (`src/lib/sanitize.js`) is Unicode-normalized, stripped of
  control, zero-width and bidi-override characters, trimmed and length-capped.
  Names allow letters and `. , ' -` only. Time zones must be real IANA zones.
- Mongoose runs with `sanitizeFilter` and `strictQuery`, and schemas use
  `strict: "throw"`. Query operators only appear where the code marks them
  `trusted`, which blocks NoSQL operator injection (`{ "$gt": "" }`).
- Every appointment and time-off query is scoped to the owner. Another user's
  record returns 404, the same as a missing one.

**Abuse and DDoS resistance** (`src/middleware/rateLimits.js`)

| Scope | Limit |
| --- | --- |
| Whole `/api`, per IP | 300/min |
| Login + register, per IP | 5/min |
| Failed logins, per account | 10 per 15 min |
| Registrations, per IP | 20/hour |
| Slot lookups, per IP | 60/min |
| Bookings, per user | 10/min |
| Doctor edits, per user | 20/min |
| Other writes, per user | 30/min |
| Reset emails, per IP / per account | 5 per 15 min / 3 per hour |
| Reset attempts, per IP | 10 per 15 min |
| Wrong current password, per user | 5 per 15 min |

Every 429 carries `Retry-After`. Other caps:
- JSON bodies are limited to 16 KB, and malformed or oversized bodies get a
  400 or 413 instead of a 500.
- Pagination stops at page 1000.
- The server sets request, header and keep-alive timeouts (slowloris) and
  shuts down gracefully on SIGTERM.

**Operations**
- Logs redact cookies, `Set-Cookie`, passwords, hashes and invite codes.
  Email bodies (which can contain reset links) are logged only in development.
- Email templates HTML-escape every inserted value. Nodemailer runs with file
  and URL access disabled.
- Clients get generic 5xx messages; details go only to the logs.
- In production the app refuses to start with the example `JWT_SECRET`, an
  invite code shorter than 16 characters, or a non-https `APP_ORIGIN`.
- `npm run seed` refuses to create demo accounts (which have public
  passwords) when `NODE_ENV=production`.

## Deployment checklist

1. Generate secrets: `openssl rand -base64 48` for `JWT_SECRET`, and
   `openssl rand -hex 16` for `DOCTOR_INVITE_CODE`. Rotate the invite code if
   one was ever committed, shared or shipped in a frontend.
2. Set `TRUST_PROXY` to the number of proxies in front of the API, so rate
   limits see real client IPs.
3. When running more than one instance, give the rate limiters a shared store
   (e.g. `rate-limit-redis`). The default in-memory store is per process.
4. Put a CDN/WAF (Cloudflare, AWS Shield, …) in front for volumetric DDoS.
   An app-level limiter can't absorb a network flood.
5. Use a MongoDB user with access to this database only, require TLS, and keep
   the database off the public internet.
6. Run `npm audit` in CI.

## File uploads

The API accepts no files, and non-JSON bodies are refused. If uploads are
added, they need:
- a dedicated route with a size cap;
- a type check on magic bytes (not the extension or `Content-Type`);
- random storage names, outside the web root or in object storage;
- an antivirus scan (e.g. ClamAV);
- serving with `Content-Disposition: attachment` and `nosniff`.
