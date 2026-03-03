# TASK.md

## Project Goal
Rebuild the website to closely match the structure and style of `https://major-agentur.de/index.php`, add a real backend, and manage all form leads in admin.

## Status Overview
- [x] Local app runs on `localhost`
- [x] Local PostgreSQL setup works
- [x] Frontend + backend integrated
- [x] Admin available at `/admin666`

## Core Requirements
- [x] Same core page structure and route flow implemented
- [x] Visual style kept close to reference with incremental refinements
- [x] Persistent lead capture implemented
- [x] Admin backend to view/manage leads implemented

## Pages (Routing)
- [x] `/` and `/index.php`
- [x] `/Unternehmen`
- [x] `/Fachgebiete`
- [x] `/Bewerbung`
- [x] `/Kontakt`
- [x] `/Datenschutz`
- [x] `/Impressum`

## Forms
- [x] Bewerbung form submission
- [x] Kontakt form submission
- [x] Footer newsletter lead capture
- [x] Full submitted form payload stored per lead (`form_payload`)
- [x] Admin detail shows form fields in frontend form sequence

## Backend Endpoints
### Public
- [x] `POST /api/leads/contact`
- [x] `POST /api/leads/application`
- [x] `POST /api/leads/newsletter`

### Admin (implemented under `/admin666`)
- [x] `GET /admin666/leads` (all leads)
- [x] `GET /admin666/leads/contact` (contact tab)
- [x] `GET /admin666/leads/application` (application tab)
- [x] `GET /admin666/leads/:id`
- [x] `POST /admin666/leads/:id/status`
- [x] `POST /admin666/leads/:id/notes`
- [x] `GET /admin666/leads-export.csv`
- [x] `POST /admin666/login`
- [x] `POST /admin666/logout`

## Data Model
### leads
- [x] `id`, `type`, `full_name`, `email`, `phone`, `message`, `birth_date`, `source_page`, `status`, `created_at`, `updated_at`
- [x] `form_payload` (JSONB) for full raw form values

### lead_notes
- [x] `id`, `lead_id`, `note`, `created_by`, `created_at`

### admin_users
- [x] table exists in schema (legacy/optional for current auth mode)

## Admin Dashboard
- [x] Login screen
- [x] Sidebar tabs (All, Bewerbung, Kontakt)
- [x] Lead list + filters (type/status/source/search)
- [x] Lead detail view
- [x] Status update
- [x] Internal notes
- [x] CSV export
- [x] Logout

## Security and Reliability
- [x] Server-side validation (basic required fields)
- [x] Honeypot anti-spam
- [x] Rate limiting on lead endpoints
- [x] CSRF protection on form posts
- [x] Error handling and health endpoint (`/health`)

## Deployment / Environment
- [x] Railway-oriented app structure
- [x] `.env` / `.env.example` updated (`ADMIN_USERNAME`, `ADMIN_PASSWORD`)
- [x] README setup instructions available
- [ ] Railway deployment execution in a live Railway environment
- [ ] Final production env hardening (real secrets, cookie secure settings, TLS assumptions)

## Acceptance Criteria Tracking
- [x] Listed pages available
- [x] Forms submit and persist to Postgres
- [x] Admin can log in and manage leads
- [x] Leads survive app restart (DB persistence)
- [ ] Final parity QA against `major-agentur.de` page-by-page checklist
- [ ] Lighthouse/performance/accessibility pass + documented results

## Remaining Work (Open)
- [ ] Add date-range filter in admin list (currently type/status/source/search)
- [ ] Optional notification hooks (email/Slack)
- [ ] Optional status history audit trail table (currently status + timestamps only)
- [ ] Railway production deployment + verification
- [ ] Final QA sweep (cross-browser/mobile + content parity)

## Deliverables
- [x] Working codebase with frontend + backend + DB schema
- [x] Schema bootstrap (`db/init.sql`)
- [x] `README.md` with local run steps
- [x] Seed/admin setup done for local testing
- [ ] Final parity checklist document
