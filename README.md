# Dr Sahayak API

Express 5 + MongoDB (Mongoose) backend for the Dr Sahayak appointment system.

## Run it

```bash
cp .env.example .env        # then fill in real values
npm install
npm run seed                # demo doctors, a demo patient and a demo admin (development only)
npm run dev
```

Create a real admin (admins can't self-register):

```bash
ADMIN_EMAIL=ops@hospital.org ADMIN_NAME="Priya Shah" ADMIN_PASSWORD='long-passphrase-1' npm run create-admin
```

## Test it

```bash
npm test
```

The tests start an in-memory MongoDB through `mongodb-memory-server`. If its
binary download is blocked, set `MONGOMS_SYSTEM_BINARY=/path/to/mongod`.

## Environment

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | The SPA's origin, used for CSRF checks and links in emails |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Session signing secret, at least 32 characters |
| `DOCTOR_INVITE_CODE` | Optional legacy shared code. Prefer per-doctor codes from the admin dashboard |
| `SMTP_URL`, `MAIL_FROM` | Outgoing email. Without `SMTP_URL`, emails are logged instead of sent |
| `TRUST_PROXY` | Number of reverse proxies in front of the API |
| `DISABLE_REMINDERS` | `true` to turn off the in-process reminder job |

## API

All routes are under `/api`. Responses look like `{ data, meta? }`, and errors
look like `{ error: { code, message, details?, requestId } }`.

**Auth and account**
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`
- `GET /auth/me`, `PATCH /auth/me` (name, phone, time zone, patient profile)
- `POST /auth/forgot-password`, `POST /auth/reset-password`
- `POST /auth/change-password`

**Doctors**
- `GET /doctors`, `GET /doctors/:id`, `GET /doctors/:id/slots?date=`
- `GET|PUT /doctors/me/availability`, `PATCH /doctors/me/profile`
- `GET|POST /doctors/me/time-off`, `DELETE /doctors/me/time-off/:id`

**Appointments**
- `POST /appointments`, `GET /appointments/my-appointments`, `GET /appointments/:id`
- `PATCH /appointments/:id/status` (cancel, complete, no-show)
- `PATCH /appointments/:id/reschedule` (doctor moves the appointment directly)
- `PUT|DELETE /appointments/:id/reschedule-request` (patient asks or withdraws)
- `POST /appointments/:id/reschedule-request/decision` (doctor approves or rejects)

**Admin** (admin role only)
- `GET /admin/stats`
- `GET /admin/users`, `PATCH /admin/users/:id` (activate or deactivate)
- `GET|POST /admin/invites`, `DELETE /admin/invites/:id` (single-use doctor invite codes)
- `GET /admin/appointments`

**Emails** go out after bookings, cancellations, reschedule requests and
decisions, direct moves and password changes. Reminders go out about 24 hours
before each appointment.

See `SECURITY.md` for the security model and the deployment checklist.
