# Project: Standalone Client Site Template

## What this is

A standalone website package for local businesses. Runs entirely on the
client's own **free** Cloudflare account (Pages + Worker + KV + R2) with
**zero dependency** on the main platform (`getyoursitelive.com`).

This is NOT the main Next.js platform. This is what gets handed to each
client after the $500 sale so their site runs forever with no monthly fees.

## How this relates to the main platform

| | Main Platform (CarMechanic) | Client Template (this repo) |
|---|---|---|
| **Stack** | Next.js 16 + React 19 + D1 | Static HTML/CSS/JS + Worker |
| **Database** | Cloudflare D1 (SQLite, 650+ rows) | Cloudflare KV (one JSON blob) |
| **Images** | Cloudflare R2 (shared bucket) | Cloudflare R2 (client's own bucket) |
| **Auth** | JWT session cookies via jose | HMAC-SHA256 tokens in sessionStorage |
| **Hosting** | Cloudflare Pages (our account) | Cloudflare Pages (client's account) |
| **Editor** | React components, server actions | Vanilla JS, data-attribute-driven |
| **Templates** | `src/lib/templates/` (6 verticals) | Content in `sample-content.json` |
| **Purpose** | Manage all businesses centrally | One business, fully independent |

**The main platform is where we build and preview sites for prospects.
The client template is what we deploy when they pay.**

## Architecture

```
site/                    Static site (Cloudflare Pages)
  index.html             Public site entry
  admin/
    index.html           Form-mode admin (12 tabs)
    edit.html            Inline WYSIWYG editor
    login.html           Login page
  css/
    themes.css           Theme variables (4 themes)
    styles.css           All site + edit-mode styles
  js/
    config.js            API_BASE URL (change per client)
    app.js               Site renderer — data-driven with data-edit attributes
    editor.js            Inline editor — discovers editable elements via data attributes
    admin.js             Form editor — 12-tab admin panel

worker/                  Cloudflare Worker API (~6KB)
  src/index.js           6 endpoints: content CRUD, login, upload, auth check, image serve
  wrangler.toml          Worker config (KV + R2 bindings)

sample-content.json      Demo content (auto repair shop)
```

**Zero npm dependencies in the site. Worker has no node_modules.**

## Data-driven inline editor

The inline editor (`editor.js`) uses ZERO hardcoded selectors. All editing
is declared via HTML attributes in `app.js`:

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `data-edit="json.path"` | Click-to-edit text | `data-edit="hero.headline"` |
| `data-edit-image="json.path"` | Upload/replace image | `data-edit-image="hero.heroImage"` |
| `data-edit-list="json.path"` | Add/remove list items | `data-edit-list="hero.whyBullets"` |
| `data-list-template="..."` | Default for new items | `data-list-template='{"name":"New"}' ` |
| `data-visibility="key"` | Section show/hide toggle | `data-visibility="showStats"` |

**Adding a new editable element = add the attribute in app.js. No editor.js changes.**

This scales to any number of verticals/templates without editor modifications.

## Important patterns

### SVG + text in contenteditable
Never put `contenteditable` on an element that contains an SVG icon.
Wrap the text in a `<span data-edit="path">` sibling to the icon:
```html
<li>${ICONS.shield} <span data-edit="hero.whyBullets.0">Bullet text</span></li>
```

### Dynamic content re-binding
Service tabs and testimonial carousel replace innerHTML, destroying
contenteditable bindings. `app.js` fires callbacks after replacement:
```javascript
window.onServiceTabChange = () => { /* editor re-binds */ };
window.onTestimonialChange = () => { /* editor re-binds */ };
```

### Edit mode guards
Stats counter animation and testimonial auto-advance are disabled when
`#app` has the `.edit-mode` class — they would overwrite editable content.

### Cache busting
All `<script>` and `<link>` tags use `?v=N` query params. Bump the
version in ALL HTML files when changing JS or CSS.

## Auth

- HMAC-SHA256 with 7-day TTL
- Token stored in sessionStorage (dies on tab close; acceptable for single-admin tool)
- Worker validates token on every mutation endpoint
- Single admin password per site (set via `wrangler secret put PASSWORD`)

## Deployment

Per-client deployment requires:
1. `site/js/config.js` — set `API_BASE` to client's Worker URL
2. `worker/wrangler.toml` — set KV namespace ID and R2 bucket name
3. Worker secrets — `PASSWORD`, `JWT_SECRET`
4. Seed `sample-content.json` to KV
5. Deploy Worker + Pages to client's Cloudflare account
6. Configure Worker routes for `/api/*` on client's domain

See `README.md` for full step-by-step setup guide.

## Run scripts

```bash
# Worker (local dev)
cd worker && wrangler dev

# Static site (local dev)
cd site && npx serve .

# Deploy worker
cd worker && wrangler deploy

# Deploy site
cd site && wrangler pages deploy . --project-name client-site
```

## Known issues / TODO

See `AUDIT.md` for initial codebase audit and `SECURITY-AUDIT.md` for the full 19-finding dual-agent security audit (both 2026-04-27).

### Security — done (19-finding audit, all fixed 2026-04-27)
- [x] #1 CRITICAL — Token no longer contains password; uses random nonce (`session:{gen}:{nonce}:{ts}`)
- [x] #2 HIGH — `config.js` API_BASE changed to `/api` (relative); hardcoded Worker URL removed from CSP
- [x] #3 HIGH — `TOKEN_SECRET` required; `getSigningKey()` throws if missing
- [x] #4 HIGH — Stats `data-target` attribute escaped via `esc()`
- [x] #5 HIGH — Content validation: `ALLOWED_CONTENT_KEYS` allowlist + `businessInfo` required
- [x] #6 HIGH — Auth token moved from localStorage to sessionStorage
- [x] #7 MEDIUM — CORS default-deny when `ALLOWED_ORIGIN` not set (localhost only for dev)
- [x] #8 MEDIUM — `Content-Type: application/json` required on POST /api/content
- [x] #9 MEDIUM — Token generation counter + `POST /api/invalidate-sessions` endpoint
- [x] #10 MEDIUM — Public GET /api/content strips `slug` for unauthenticated requests
- [x] #11 MEDIUM — Upload extension derived from validated MIME type (`MIME_TO_EXT` map)
- [x] #12 MEDIUM — Prototype pollution blocked in `setNestedValue()` and `getNestedValue()`
- [x] #13 MEDIUM — Documented: Worker MUST run behind Cloudflare proxy
- [x] #15 LOW — KV namespace ID emptied in wrangler.toml (forces per-client setup)
- [x] #18 LOW — Login errors show generic messages (rate-limit or "Invalid password")
- [x] #19 LOW — Booking form POSTs to `/api/booking` with error handling
- [x] Rate limiting on login (5 attempts / 15 min, KV-backed)
- [x] Timing-safe comparison (HMAC both inputs, fixed-length XOR)
- [x] Security headers on all responses (X-Frame-Options, HSTS, CSP, etc.)
- [x] CORS with `Vary: Origin` for correct caching
- [x] SVG removed from upload allow-list (XSS vector)
- [x] All inline scripts extracted; CSP `script-src 'self'` via `_headers`
- [x] 512KB payload limit on POST /api/content
- [x] Single-quote escaping in `esc()`
- [x] CF-Connecting-IP only (no X-Forwarded-For spoofing)
- [x] Path traversal prevention on image endpoint
- [x] `data:` removed from CSP `img-src` (Red Team round 2 finding)

### Security — done (Red Team simulation follow-up, 2026-04-27)
- [x] `data:` removed from CSP `img-src` — changed to `img-src 'self' https:`
- [x] "Sign Out All Devices" button in form editor admin panel (calls `POST /api/invalidate-sessions`)
- [x] Separate `RATE_LIMIT` KV namespace for rate-limit records (with fallback to `CONTENT` for backwards compat)

### Security — known limitations (accepted risks)
- **Last-write-wins race condition:** Two admins editing simultaneously can overwrite each other's changes. Accepted: single-admin tool, no concurrent editing expected. If needed later, add ETag/If-Match optimistic locking.
- **sessionStorage token (not HttpOnly cookie):** Token accessible to JS. Acceptable for single-admin tool; XSS is mitigated by strict CSP. Full HttpOnly cookie auth would require significant Worker refactor.

### Code quality
- [ ] `esc()`, `getNestedValue()`, `setNestedValue()` duplicated across app.js, editsite.js, mysite.js — extract to shared utils.js
- [ ] Luxury and Friendly themes are bare bones — need polish

### Features
- [ ] Per-client config.js generation (automate Worker URL injection)
- [ ] Favicon + meta tags missing from HTML files
- [ ] No image cropping/resizing on upload
- [ ] Automate the platform → client export pipeline
- [ ] Test full end-to-end deployment on a real client's Cloudflare account

---

# Decisions Made

| Date | Decision | Reason |
|------|----------|--------|
| 2026-04-27 | Data-driven editor via data attributes | Scales to unlimited verticals without editor.js changes |
| 2026-04-27 | Wrap text in spans next to SVG icons | contenteditable on parent breaks SVG rendering |
| 2026-04-27 | Skip stats animation in edit mode | Counter animation overwrites contenteditable text |
| 2026-04-27 | Pause testimonial auto-advance in edit mode | innerHTML replacement destroys edit bindings |
| 2026-04-27 | sessionStorage for auth tokens (not cookies) | Simpler Worker; token dies on tab close; acceptable risk for admin-only tool |
| 2026-04-27 | Always run adversarial security audit after building | Builder accumulates context blindness — trusts own output after hours of work. Fresh eyes with a specific adversarial mandate catch what the builder misses. The dual-agent red/blue team audit found 19 issues the builder overlooked, including a CRITICAL token flaw the builder wrote himself. |
| 2026-04-27 | KV not D1 for storage | One JSON blob per site; no relational needs; KV is simpler |
| 2026-04-27 | Zero npm deps in site | Client gets plain files; no build step; nothing to break |

# What We've Tried and FAILED

| Date | What | Why it failed |
|------|------|---------------|
| 2026-04-27 | contenteditable on elements with SVG children | Editing tries to modify the SVG; text cursor jumps; breaks rendering |
| 2026-04-27 | Hardcoded CSS selectors in editor.js | Broke every time app.js markup changed; didn't scale to new verticals |
| 2026-04-27 | CSS `[data-editable]` selector for edit styles | System was refactored to use `[data-edit]` attributes; old selector stopped matching |

---

# Change Log

## 2026-04-27 — Data-driven editor refactor + full audit

### Editor refactor
- Rewrote `editor.js` from ~700 lines of hardcoded selectors to ~350 lines of data-driven code
- 4 core functions: `bindAllEditable()`, `bindAllImages()`, `bindAllLists()`, `bindAllVisibility()`
- Zero hardcoded selectors — editor discovers elements via `data-edit`, `data-edit-image`, `data-edit-list`, `data-visibility` attributes

### app.js rewrite
- Added `E(path)` / `EI(path)` helper functions for consistent data-attribute generation
- Every text element now has `data-edit="json.path"` attribute
- SVG+text conflicts fixed: text wrapped in dedicated `<span>` elements
- Stats animation + testimonial auto-advance disabled in edit mode
- Footer, topbar, emergency, FAQ, pricing all fully editable

### Bug fixes
- CSS `[data-editable]` selectors updated to `[data-edit]` (selector mismatch after refactor)
- Mojibake in admin.js comments (4 corrupted Unicode box-drawing lines)
- Cache bust v5 → v6 on all HTML file resources

### New files
- `CLAUDE.md` — project instructions and context
- `AUDIT.md` — full codebase audit (security, format, logic, layout)
- `.gitignore` — standard ignores for Cloudflare/Node projects
