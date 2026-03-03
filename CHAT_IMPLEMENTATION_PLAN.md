# CHAT_IMPLEMENTATION_PLAN.md

## Goal
- Remove the floating "go to top" button from the frontend.
- Add a website chat widget where visitors can message admin.
- Add admin-side chat management and reply capability in `/admin666`.
- Support file attachments in chat (images, documents, etc.).

## Scope (v1)
- One-to-one support chat between visitor and admin.
- Anonymous visitor session-based chat (no login for visitor).
- Admin can view chat list, open chat, reply, attach files, and mark status.
- Visitor can send text + attachments from the chat widget.

## Functional Requirements

### 1. Frontend
- Remove current floating go-to-top button.
- Add floating "Chat" launcher button (bottom-right).
- On click: open chat panel (messages + input + send button + file attach button).
- Visitor can:
  - start new chat
  - send text messages
  - attach one or more files (configurable max count/size)
  - reload page and continue same chat (session token/local storage)
- Show message direction (visitor/admin), time, and delivery state.
- Render attachments in thread:
  - image preview thumbnail
  - file name, size, and download/open link

### 2. Backend API
- `POST /api/chat/start`
  - creates chat session, returns `chat_id` + `chat_token`
- `GET /api/chat/:chatId/messages`
  - visitor fetches messages (token-protected)
- `POST /api/chat/:chatId/messages`
  - visitor sends message and optional attachments (token-protected)
- `POST /api/admin/chats/:chatId/messages`
  - admin replies and optional attachments
- `GET /api/admin/chats`
  - admin list chats (filter by status/date/search)
- `GET /api/admin/chats/:chatId`
  - admin gets chat detail + messages + attachments
- `PATCH /api/admin/chats/:chatId`
  - update status (`open`, `pending`, `closed`)
- `GET /api/chat/files/:fileId`
  - secure file fetch (visitor token/admin session check)

### 3. Admin UI (`/admin666`)
- Add sidebar item: `Chats`.
- Chat list page:
  - visitor name/email if provided
  - last message preview
  - unread count
  - status
  - updated timestamp
- Chat detail page:
  - threaded message view
  - attachments preview/download
  - reply form with file upload
  - status control

## Data Model

### `chats`
- `id` UUID PK
- `visitor_name` TEXT NULL
- `visitor_email` TEXT NULL
- `visitor_phone` TEXT NULL
- `chat_token_hash` TEXT NOT NULL
- `status` TEXT NOT NULL DEFAULT `open` (`open|pending|closed`)
- `source_page` TEXT NULL
- `last_message_at` TIMESTAMPTZ
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

### `chat_messages`
- `id` UUID PK
- `chat_id` UUID FK -> `chats(id)` ON DELETE CASCADE
- `sender_type` TEXT NOT NULL (`visitor|admin`)
- `sender_label` TEXT NULL
- `message` TEXT NULL (allow attachment-only message)
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

### `chat_attachments`
- `id` UUID PK
- `chat_message_id` UUID FK -> `chat_messages(id)` ON DELETE CASCADE
- `original_name` TEXT NOT NULL
- `mime_type` TEXT NOT NULL
- `size_bytes` BIGINT NOT NULL
- `storage_path` TEXT NOT NULL
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()

### Optional (phase 2)
- `chat_events` for read receipts/status history

## Storage Strategy
- v1 local: store files under `/uploads/chat/` with randomized filenames.
- production/Railway: use object storage (S3-compatible) and store object key in `storage_path`.
- never trust extension alone; use MIME + extension allowlist.

## File Policy (v1)
- Allowed examples:
  - images: `jpg`, `jpeg`, `png`, `webp`
  - docs: `pdf`, `doc`, `docx`, `txt`
- Max file size: 10 MB per file.
- Max files per message: 3.
- Block executable/script types.

## Security and Abuse Controls
- Reuse CSRF on form posts where applicable.
- Token-gate visitor chat endpoints (`chat_token`, hashed at rest).
- Rate limit chat start/send/upload endpoints.
- Validate message length and file count/size/type server-side.
- Serve attachments through guarded route, not raw public folder.
- Optional virus scanning hook (phase 2).

## UX Notes
- Keep current site style.
- Chat panel should be compact and mobile-friendly.
- Add subtle unread badge on chat launcher.
- Attachments appear as chips/cards in chat bubble.
- For admin: practical, information-dense layout over decorative UI.

## Delivery Phases

### Phase 1: Foundation
- Remove go-to-top button.
- DB migration for `chats`, `chat_messages`, `chat_attachments`.
- File upload plumbing + secure file-serving route.
- Backend chat APIs (start/send/fetch + admin endpoints).

### Phase 2: Frontend Widget
- Add launcher + panel UI.
- Add file picker + upload state in widget.
- Wire to start/send/fetch APIs.
- Persist visitor chat session in local storage.

### Phase 3: Admin Integration
- Add `Chats` tab in `/admin666` sidebar.
- Build chat list and chat detail/reply pages.
- Add admin attachment upload + preview/download.
- Status management and unread indicators.

### Phase 4: Hardening + QA
- Rate limit tuning.
- Upload failure/retry UX.
- Cross-device testing.
- Seed demo chats with attachments.

## Acceptance Criteria
- Go-to-top button is removed.
- Visitor can chat from any page using launcher.
- Visitor can upload allowed files and see them in thread.
- Admin can read/reply and download attachments from `/admin666`.
- Messages and attachments persist in Postgres/storage and survive restart.
- Chat list/status updates function correctly.

## Open Decisions
- Should visitors provide name/email before first message, or optional?
- Do we need realtime (WebSocket/SSE) now, or polling is enough for v1?
- Should admin get browser/audio notification for new messages?
- Keep uploaded files forever or add retention policy?

## Recommended v1 Choices
- Visitor details optional (ask gently after first message).
- Polling every 5-10s (simpler and stable for first release).
- No realtime push in v1; add in v2 if needed.
- Keep files for 90 days (configurable), then cleanup job.
