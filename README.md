# Headline Agentur Website + Backend

Professional website and backend platform for Headline Agentur, including lead management, live chat, user accounts, document handling, and admin operations.

## Tech Stack
- Node.js
- Express
- EJS
- PostgreSQL

## Core Features
- Public website routes:
  - `/index.php`
  - `/Unternehmen`
  - `/Fachgebiete`
  - `/Bewerbung`
  - `/Kontakt`
  - `/Datenschutz`
  - `/Impressum`
- Lead capture and storage (Kontakt + Bewerbung)
- Live chat with onboarding flow and file attachments
- User registration, login, profile management, and document uploads
- Admin backend:
  - Login at `/admin666/login`
  - Lead pipeline and detail views
  - Chat management
  - User management with detail view and document visibility
  - Bewerbung Fakten management
  - CSV export (`/admin666/leads-export.csv`)

## Local Setup
1. Create `.env` from `.env.example`.
2. Ensure PostgreSQL is running and `DATABASE_URL` points to your database.
3. Install packages:
   ```bash
   npm install
   ```
4. Run database initialization:
   ```bash
   npm start
   ```
5. Start development server:
   ```bash
   npm run dev
   ```

## Required Environment Variables
- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `PORT`
- `NODE_ENV`

## Optional SMTP (Kontakt notifications)
- `SMTP_HOST`
- `SMTP_PORT` (default `465`)
- `SMTP_SECURE` (`true` for SSL/465)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_TLS_REJECT_UNAUTHORIZED` (default `true`)
- `MAIL_FROM`
- `MAIL_TO`

## Deployment Notes
- Platform-ready for Railway or any Node hosting.
- Start command: `npm start`
- Health endpoint: `/health`
- Configure all environment variables in your hosting provider.

## Security
- CSRF protection
- Rate limiting on sensitive endpoints
- Honeypot spam protection
- Helmet middleware
- Session cookie hardening
