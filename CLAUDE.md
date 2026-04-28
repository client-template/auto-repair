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
| **Database** | Cloudflare D1 (SQLite, 650+ rows) | Cloudflare KV (one JSON blob per site) |
| **Images** | Cloudflare R2 (shared bucket) | Cloudflare R2 (client's own bucket) |
| **Auth** | JWT session cookies via jose | HMAC-SHA256 tokens in sessionStorage |
| **Hosting** | Cloudflare Pages (our account) | Cloudflare Pages (client's account) |
| **Editor** | React components, server actions | Vanilla JS, data-attribute-driven |
| **Templates** | `src/lib/templates/` (6 verticals) | Content in KV, seeded from `sample-content.json` |
| **Purpose** | Manage all businesses centrally | One business, fully independent |

**The main platform is where we build and preview sites for prospects.
The client template is what we deploy when they pay.**

## Architecture

```
site/                    Static site (Cloudflare Pages)
  index.html             Welcome/landing page (lists available demo sites)
  autorepair/            Auto repair demo site
    index.html           Public site entry
    config.js            API_BASE + optional SITE_KEY
    mysite/
      login.html         Login page
      index.html         Form-mode admin (12 tabs)
      edit.html           Inline WYSIWYG editor
  barber/                Barber demo site (same structure)
    index.html
    config.js            API_BASE + SITE_KEY = "barber"
    mysite/
      login.html
      index.html
      edit.html
  css/
    themes.css           Theme variables (4 themes)
    styles.css           All site + edit-mode styles
    mysite.css           Form editor styles
  js/
    config.js            Default API_BASE (legacy, kept for compatibility)
    app.js               Site renderer — data-driven with data-edit attributes
    editsite.js          Inline editor — discovers editable elements via data attributes
    mysite.js            Form editor — 12-tab admin panel
    login.js             Login form handler
    boot-public.js       Boot script for public pages
    boot-editor.js       Boot script for inline editor

worker/                  Cloudflare Worker API (~6KB)
  src/index.js           Endpoints: content CRUD, login, upload, auth check, image serve
  wrangler.toml          Worker config (KV + R2 bindings — IDs are placeholders)

sample-content.json      Generated content (seeded to KV)
```

**Zero npm dependencies in the site. Worker has no node_modules.**

## Multi-site support

The Worker supports multiple sites via the `?site=` query param on content endpoints.
Each site's content is stored as a separate KV key (e.g., `"business"` for auto-repair,
`"barber"` for barber). The `ALLOWED_SITES` set in the Worker allowlists valid site keys.

Each subfolder (autorepair/, barber/) has its own `config.js` that sets `SITE_KEY`.
The JS files (app.js, mysite.js, editsite.js) append `?site=SITE_KEY` to API calls
when `SITE_KEY` is defined.

## Local folders

| Folder | Purpose |
|--------|---------|
| `/Users/Shared/client-template-autorepair/` | Source repo (this). Contains site files, worker, and all verticals as subfolders. |
| `/Users/Shared/client-template-barber/` | Standalone generated output for barber vertical (from generation script). |
| `/Users/Shared/CarMechanic/` | Main platform. Contains generation script at `scripts/generate-client-template.js`. |

## Live URLs

| URL | What |
|-----|------|
| `seedreply.com` | Welcome page |
| `seedreply.com/autorepair` | Auto repair demo site |
| `seedreply.com/barber` | Barber demo site |

---

# Deployment Guide: Full Steps from Zero to Live

This is the complete process for deploying a client site. Tested and verified
with seedreply.com (2026-04-28).

## Prerequisites

- `wrangler` CLI (`npx wrangler` works)
- Authenticated to the target Cloudflare account (`npx wrangler login`)
- Node.js + `tsx` available (`npx tsx --version`)

## Step 1: Generate the client template

Run from the CarMechanic project root (`/Users/Shared/CarMechanic/`):

```bash
node scripts/generate-client-template.js \
  "Business Name" \
  "(555) 123-4567" \
  "123 Main Street, City, ST 07011" \
  /Users/Shared/client-template-OUTPUT \
  "https://WORKER-NAME.ACCOUNT.workers.dev/api" \
  auto-repair
```

Arguments:
1. Business name
2. Phone number
3. Full address
4. Output directory
5. Worker API URL (optional — set later if not known yet)
6. Vertical: `auto-repair` or `barber` (defaults to `auto-repair`)

This copies site files from the source template, generates `config.js`,
`_headers`, and `sample-content.json`.

## Step 2: Create Cloudflare resources

On the client's Cloudflare account (or your own for demos):

```bash
# Create KV namespaces
npx wrangler kv namespace create CONTENT
npx wrangler kv namespace create RATE_LIMIT

# Note the IDs printed — you'll need them for wrangler.toml
```

Create an R2 bucket via Cloudflare dashboard (name it `site-uploads` or similar).

## Step 3: Configure wrangler.toml

Edit `worker/wrangler.toml` in the output directory. Paste the actual KV
namespace IDs and R2 bucket name:

```toml
name = "your-worker-name"
main = "src/index.js"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "CONTENT"
id = "paste-content-kv-id-here"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "paste-rate-limit-kv-id-here"

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "site-uploads"
```

## Step 4: Deploy the Worker

```bash
cd worker
npx wrangler deploy
```

Note the Worker URL printed (e.g., `https://your-worker.account.workers.dev`).

## Step 5: Set Worker secrets

```bash
npx wrangler secret put PASSWORD
# Enter the admin password for the site editor

npx wrangler secret put TOKEN_SECRET
# Enter a random string for HMAC token signing (e.g., 32+ character random)

npx wrangler secret put ALLOWED_ORIGIN
# Enter the Pages URL, e.g.: https://your-site.pages.dev
# For multiple origins, comma-separate: https://customdomain.com,https://your-site.pages.dev
```

## Step 6: Update config.js (if Worker URL wasn't known at generation time)

Edit `site/js/config.js` (or the subfolder's `config.js`):

```javascript
const API_BASE = "https://your-worker.account.workers.dev/api";
```

## Step 7: Seed content to KV

```bash
cd worker
npx wrangler kv key put "business" --path ../sample-content.json --binding CONTENT --remote
```

The KV key MUST be `"business"` — that's what the Worker reads (constant
`CONTENT_KEY` in index.js). For multi-site setups, use the site key name
(e.g., `"barber"`) and the Worker's `ALLOWED_SITES` set must include it.

**Common mistake:** Using key `"content"` instead of `"business"`. The Worker
reads from `CONTENT_KEY = "business"`. If you seed with the wrong key name,
the site shows "Site loading... Content not yet configured."

## Step 8: Deploy Pages (static site)

Push the `site/` directory to a GitHub repo, then connect it to Cloudflare Pages:

1. Go to Cloudflare Dashboard → Pages → Create a project
2. Connect to the GitHub repo
3. Set build output directory: `site` (or `.` if the repo root IS the site)
4. Set production branch: `main`
5. Deploy

Or use wrangler:
```bash
cd site
npx wrangler pages deploy . --project-name your-site
```

## Step 9: Set custom domain (optional)

In Cloudflare Pages → your project → Custom domains → Add:
- `customdomain.com`
- `www.customdomain.com`

Update the Worker's `ALLOWED_ORIGIN` secret to include the custom domain.

## Step 10: Verify

1. Visit the site URL — all sections should render
2. Check browser console for errors (CSP, CORS, fetch failures)
3. Try the editor: go to `/mysite/login.html`, sign in, edit content

---

# Troubleshooting

## "Site loading... Content not yet configured."

**Cause:** Content not in KV, or seeded with wrong key name.

**Fix:** Seed with key `"business"`:
```bash
npx wrangler kv key put "business" --path ../sample-content.json --binding CONTENT --remote
```

## CSP errors in browser console

**Cause:** `_headers` file has wrong `connect-src` (doesn't include Worker origin).

**Fix:** Regenerate with the worker-url parameter, or manually edit `site/_headers`:
```
connect-src 'self' https://your-worker.account.workers.dev
```

Also check:
- `style-src` needs `'unsafe-inline' https://fonts.googleapis.com` for Google Fonts
- `frame-src` needs `https://maps.google.com https://www.google.com` for map embed

## CORS errors

**Cause:** Worker's `ALLOWED_ORIGIN` secret doesn't include the site's origin.

**Fix:**
```bash
npx wrangler secret put ALLOWED_ORIGIN
# Enter: https://your-site.pages.dev
# Or comma-separated: https://customdomain.com,https://your-site.pages.dev
```

Then redeploy the Worker (`npx wrangler deploy`).

## Pushed to wrong branch

Cloudflare Pages Production deploys from `main`. If you push to another
branch, it creates a Preview deployment (different URL, not production).

**Fix:** Push to main explicitly:
```bash
git push origin your-branch:main
```

---

# Data-driven inline editor

The inline editor (`editsite.js`) uses ZERO hardcoded selectors. All editing
is declared via HTML attributes in `app.js`:

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `data-edit="json.path"` | Click-to-edit text | `data-edit="hero.headline"` |
| `data-edit-image="json.path"` | Upload/replace image | `data-edit-image="hero.heroImage"` |
| `data-edit-list="json.path"` | Add/remove list items | `data-edit-list="hero.whyBullets"` |
| `data-list-template="..."` | Default for new items | `data-list-template='{"name":"New"}' ` |
| `data-visibility="key"` | Section show/hide toggle | `data-visibility="showStats"` |

**Adding a new editable element = add the attribute in app.js. No editsite.js changes.**

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

## Run scripts

```bash
# Worker (local dev)
cd worker && npx wrangler dev

# Static site (local dev)
cd site && npx serve .

# Deploy worker
cd worker && npx wrangler deploy

# Deploy site to Pages
cd site && npx wrangler pages deploy . --project-name your-site
```

## Known issues / TODO

### Code quality
- [ ] `esc()`, `getNestedValue()`, `setNestedValue()` duplicated across app.js, editsite.js, mysite.js — extract to shared utils.js
- [ ] Luxury and Friendly themes are bare bones — need polish

### Features
- [ ] Favicon + meta tags missing from HTML files
- [ ] No image cropping/resizing on upload
- [ ] **Booking form** — removed from v1 (no Worker handler). Restore when email sending is available.

### Security

All security findings resolved. See **`SECURITY.md`** for full audit history.

---

# Decisions Made

| Date | Decision | Reason |
|------|----------|--------|
| 2026-04-28 | Multi-site via `?site=` query param | Same Worker serves multiple demo verticals; each subfolder has own config.js with SITE_KEY |
| 2026-04-28 | Relative paths in JS redirects | Absolute `/mysite/login.html` broke in subfolders; relative `login.html` works everywhere |
| 2026-04-28 | autorepair + barber as subfolders under one Pages deploy | Simpler than separate Cloudflare projects; shared CSS/JS/Worker |
| 2026-04-27 | Data-driven editor via data attributes | Scales to unlimited verticals without editsite.js changes |
| 2026-04-27 | Wrap text in spans next to SVG icons | contenteditable on parent breaks SVG rendering |
| 2026-04-27 | Skip stats animation in edit mode | Counter animation overwrites contenteditable text |
| 2026-04-27 | sessionStorage for auth tokens (not cookies) | Simpler Worker; token dies on tab close; acceptable risk for admin-only tool |
| 2026-04-27 | KV not D1 for storage | One JSON blob per site; no relational needs; KV is simpler |
| 2026-04-27 | Zero npm deps in site | Client gets plain files; no build step; nothing to break |

# What We've Tried and FAILED

| Date | What | Why it failed |
|------|------|---------------|
| 2026-04-28 | Seeding KV with key `"content"` | Worker reads from `CONTENT_KEY = "business"`. Site showed "loading" until re-seeded with correct key. |
| 2026-04-28 | Pushing to `client-template` branch for production | Cloudflare Pages Production deploys from `main`. Push went to Preview, not Production. |
| 2026-04-28 | `connect-src 'self'` in CSP with cross-origin Worker | Browser blocked fetch to Worker URL. Must include Worker origin in connect-src. |
| 2026-04-27 | contenteditable on elements with SVG children | Editing tries to modify the SVG; text cursor jumps; breaks rendering |
| 2026-04-27 | Hardcoded CSS selectors in editor.js | Broke every time app.js markup changed; didn't scale to new verticals |

---

# Change Log

## 2026-04-28 — Multi-site support, barber vertical, folder reorganization

- Auto repair moved from root to `/autorepair` subfolder
- Barber demo added at `/barber` subfolder
- Root page is now a simple "Welcome to Client Sites"
- Worker updated: `?site=` param on content GET/POST, `ALLOWED_SITES` allowlist
- JS redirects changed from absolute to relative paths (works in any subfolder)
- `loadContent()` / save functions pass `SITE_KEY` if defined in config.js
- Local folder renamed: `client-template` → `client-template-autorepair`
- Generation script in CarMechanic reads from platform TypeScript templates via `extract-template.ts`

## 2026-04-27 — Security hardening + path rename + infra cleanup

- Rewrote `timingSafeEqual` to HMAC-based fixed-length comparison
- Added `TOKEN_SECRET`, rate limiting, CORS lock, CSP headers
- Extracted all inline scripts to external files
- SVG removed from upload allow-list
- Renamed `/admin` → `/mysite` across all files
- Renamed `admin.js` → `mysite.js`, `editor.js` → `editsite.js`

## 2026-04-27 — Data-driven editor refactor + full audit

- Rewrote editsite.js from ~700 lines of hardcoded selectors to ~350 lines of data-driven code
- Every text element has `data-edit="json.path"` attribute
- SVG+text conflicts fixed, stats/testimonial animation disabled in edit mode
