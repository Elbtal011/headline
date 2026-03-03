# USER_AUTH_PROFILE_PLAN.md

## Goal
Replace the current `Jetzt bewerben` CTA flow (currently `/Bewerbung`) with a user account flow:
- User registration + login
- User profile management (view/update own data)
- Admin backend `Users` section (list + detail)
- Bot deterrence via simple CAPTCHA on auth
- Secure storage and secure auth/session handling

## Current Baseline
- Header CTA `Jetzt bewerben` points to `/Bewerbung`.
- Existing stack: Node.js + Express + EJS + PostgreSQL + session auth for admin.
- Existing CSRF and rate limiting are already in place and should be reused for auth/profile endpoints.

## Scope (Phase 1)
- Public:
  - `GET /konto/login`
  - `POST /konto/login`
  - `GET /konto/registrieren`
  - `POST /konto/registrieren`
  - `POST /konto/logout`
  - `GET /konto/profil`
  - `POST /konto/profil` (update profile)
- Admin:
  - New sidebar tab: `Users`
  - `GET /admin666/users` (list + search/filter)
  - `GET /admin666/users/:id` (detail)
- Frontend nav:
  - Change CTA `Jetzt bewerben` to `Profil Login` (or similar) and route to `/konto/login`

## Data Model
### New table: `users`
- `id UUID PK`
- `email TEXT UNIQUE NOT NULL`
- `password_hash TEXT NOT NULL`
- `first_name TEXT NOT NULL`
- `last_name TEXT NOT NULL`
- `phone TEXT`
- `birth_date DATE`
- `address_line TEXT`
- `zip TEXT`
- `city TEXT`
- `country TEXT`
- `is_active BOOLEAN NOT NULL DEFAULT TRUE`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### Optional table: `user_security_events`
- `id UUID PK`
- `user_id UUID NULL`
- `event_type TEXT NOT NULL` (login_success, login_failed, password_changed, etc.)
- `ip TEXT`
- `user_agent TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### Migration
- Add `CREATE TABLE IF NOT EXISTS` statements to `db/init.sql`.
- Add indexes:
  - `users(email)`
  - `users(created_at DESC)`

## Authentication Design
- Password hashing: `bcrypt` with strong cost factor.
- Session-based login for users using current session middleware.
- Session keys:
  - `req.session.user` for authenticated user session.
  - Keep separate from existing `req.session.adminUser`.
- Route guards:
  - `requireUser` middleware for `/konto/profil`.
  - Admin-only guards stay unchanged.

## CAPTCHA Plan (Simple + Self-Hosted)
Use first-party text/math CAPTCHA to avoid external dependency for Phase 1:
- On login/register page render:
  - Random math challenge (e.g., `7 + 4 = ?`)
  - Save expected answer hash in session
- On submit:
  - Validate answer before auth logic
  - Rotate challenge each request
- Add attempt throttling:
  - Rate limit login/register routes by IP/session

Optional Phase 2:
- Add Cloudflare Turnstile or hCaptcha behind feature flag.

## Security Requirements
- CSRF on all form POST routes (reuse existing middleware).
- Input validation + normalization:
  - Email format, required names, optional phone pattern.
- Prevent account enumeration:
  - Use generic error messages for login failures.
- Session hardening:
  - `httpOnly`, `sameSite=lax`, `secure` in production.
- Password policy:
  - Min length + common checks.
- Sensitive data:
  - Never store plaintext password.
  - Mask sensitive fields in admin list views where appropriate.

## Admin Users Section
### `GET /admin666/users`
- Columns:
  - Name
  - Email
  - Phone
  - Created at
  - Status
  - Details link
- Filters/search:
  - `q` across name/email/phone
  - `is_active` filter

### `GET /admin666/users/:id`
- Show full profile fields
- Show account metadata (created/updated timestamps)
- Optional: show recent security events

## UI/UX Plan
- Replace CTA label + target in `views/partials/site-header.ejs`.
- Add public EJS templates:
  - `views/pages/account-login.ejs`
  - `views/pages/account-register.ejs`
  - `views/pages/account-profile.ejs`
- Add admin EJS templates:
  - `views/admin/users.ejs`
  - `views/admin/user-detail.ejs`
- Keep styling consistent with existing site/admin theme.

## API/Route Structure
- New router file:
  - `src/routes/account.js` for public auth/profile routes
- Middleware additions:
  - `src/middleware/userAuth.js` (requireUser + optional redirect)
  - `src/middleware/captcha.js` (create/validate challenge)
- Server wiring:
  - Mount account router in `src/server.js`

## Rollout Steps
1. DB schema changes (`users`, optional `user_security_events`).
2. Middleware (`requireUser`, captcha helpers, validators).
3. Auth routes (register/login/logout) + profile routes.
4. Public templates for login/register/profile.
5. Header CTA switch to account login.
6. Admin users routes + templates + sidebar tab.
7. Security pass (rate limits, messages, CSRF checks).
8. End-to-end testing and regression checks.

## Acceptance Criteria
- CTA no longer opens `/Bewerbung`; it opens account login.
- New user can register (with CAPTCHA) and login.
- Logged-in user can view/edit own profile.
- User data persists in PostgreSQL securely (`password_hash` only).
- Admin can open `Users` tab, list users, open detail page.
- CSRF + rate limiting + CAPTCHA active on auth flows.

## Out of Scope (for this phase)
- Password reset by email
- Email verification
- OAuth / social login
- 2FA
- Full audit trail dashboard

## Implementation Notes / Decisions Needed
- Final CTA text:
  - Option A: `Profil Login`
  - Option B: `Konto`
- Required profile fields in registration (minimal vs full form)
- Keep `/Bewerbung` page public in nav or gate it behind login

