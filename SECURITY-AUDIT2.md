# Security Audit — Remaining Findings

**Date:** 2026-04-27
**Source:** Follow-up to the 19-finding dual-agent security audit (`SECURITY-AUDIT1.md`)
**Scope:** Two deployment-safety issues flagged as remaining from the first scan

---

## Summary

| # | Severity | Finding | File(s) | Status |
|---|----------|---------|---------|--------|
| #2 | HIGH | Hardcoded test Worker URL in config.js and _headers CSP | `site/js/config.js:8`, `site/_headers:7` | NOT FIXED |
| #15 | LOW | KV namespace ID committed to repository | `worker/wrangler.toml:9` | NOT FIXED |

Both issues share the same root cause: **template ships with environment-specific values baked in instead of safe defaults.** Every client deployment requires manual editing that's easy to forget.

---

## #2 — Hardcoded Test Worker URL in config.js and _headers CSP

**Severity:** HIGH
**Files:** `site/js/config.js` line 8, `site/_headers` line 7

### What's wrong

`config.js` contains the live test Worker URL committed to the repository:

```javascript
// site/js/config.js line 8 — CURRENT (vulnerable)
const API_BASE = "https://auto-repair-api.getyoursitelive.workers.dev/api";
```

The `_headers` CSP also hardcodes this URL:

```
// site/_headers line 7 — CURRENT (vulnerable)
Content-Security-Policy: ... img-src 'self' https://auto-repair-api.getyoursitelive.workers.dev data:; connect-src 'self' https://auto-repair-api.getyoursitelive.workers.dev; ...
```

### Why this is HIGH severity

1. **Endpoint exposure:** Anyone who clones this repo gets the exact Worker URL to attack — brute-force login, enumerate content, probe for weaknesses.
2. **Deployment footgun:** Every client deployment requires manually editing both files. If forgotten, the client's site silently talks to the test Worker — wrong data, wrong auth, leaks client content to test infrastructure.
3. **CSP breakage:** When deployed to a real client domain, the CSP whitelists our test Worker URL instead of the client's own domain. Deployments will either break (blocked requests) or the deployer will weaken/remove the CSP entirely.

### Attack scenario

- Attacker clones the public repo or views `config.js` in browser DevTools
- Gets `https://auto-repair-api.getyoursitelive.workers.dev/api`
- Brute-forces `/api/login` (rate limit is per-IP, bypassable with distributed IPs)
- Enumerates content via unauthenticated `GET /api/content`
- If a client deployment forgot to change `config.js`, attacker can see that client's admin traffic hitting the test Worker

### Exact files to change

**File 1: `site/js/config.js`**

Current (line 8):
```javascript
const API_BASE = "https://auto-repair-api.getyoursitelive.workers.dev/api";
```

Fixed:
```javascript
/**
 * API_BASE — relative path works when Worker route is on the same domain.
 *
 * Production: Worker route on client's domain → "/api" just works.
 * Local dev: site on :3000, Worker on :8787 → override in browser console
 *   or proxy /api through your local dev server.
 */
const API_BASE = "/api";
```

**File 2: `site/_headers`**

Current (line 7):
```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://auto-repair-api.getyoursitelive.workers.dev data:; connect-src 'self' https://auto-repair-api.getyoursitelive.workers.dev; form-action 'self'; base-uri 'self'; frame-ancestors 'none'
```

Fixed (remove the two `https://auto-repair-api.getyoursitelive.workers.dev` references):
```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'
```

### Why the fix works

Using `/api` (relative) means the site talks to whatever domain it's hosted on. No per-client URL editing needed. The CSP no longer whitelists a third-party origin, so it works on any client domain without modification. Production deployments use Cloudflare Worker routes on the client's own domain, so `/api/*` routes to the Worker automatically.

### Impact on local development

Local dev currently works because `config.js` points to the remote test Worker. After this fix:
- **Option A (recommended):** Run Worker locally with `wrangler dev --port 8787` and proxy `/api` through the static file server.
- **Option B:** Temporarily override in browser console: `window.API_BASE = "http://localhost:8787/api"` during development.
- **Option C:** Use a `.env.local`-style `config.local.js` override that's `.gitignore`d.

---

## #15 — KV Namespace ID Committed to Repository

**Severity:** LOW
**File:** `worker/wrangler.toml` line 9

### What's wrong

The KV namespace ID for the test environment is committed to the template:

```toml
# worker/wrangler.toml lines 6-9 — CURRENT (vulnerable)
[[kv_namespaces]]
binding = "CONTENT"
# Per-client: run `wrangler kv:namespace create CONTENT` and replace this ID
id = "fa89f89211294ba191c922d863bd7bee"
```

### Why this matters

1. **Information leak:** The namespace ID `fa89f89211294ba191c922d863bd7bee` is specific to our Cloudflare account. Not directly exploitable without account access, but aids reconnaissance and targeted attacks.
2. **Deployment footgun:** If a deployer forgets to replace this ID, `wrangler deploy` will either:
   - Succeed and bind to OUR namespace (if they have access) — client content goes to the wrong place
   - Fail with a confusing error about namespace not found
3. **Silent misconfiguration:** Unlike a missing secret (which errors immediately), a wrong namespace ID can silently succeed if the account has access, causing data cross-contamination between client sites.

### Exact file to change

**File: `worker/wrangler.toml`**

Current (lines 6-9):
```toml
[[kv_namespaces]]
binding = "CONTENT"
# Per-client: run `wrangler kv:namespace create CONTENT` and replace this ID
id = "fa89f89211294ba191c922d863bd7bee"
```

Fixed:
```toml
[[kv_namespaces]]
binding = "CONTENT"
# REQUIRED: Run `wrangler kv:namespace create CONTENT` and paste the ID here.
# Leaving this empty will cause `wrangler deploy` to fail — this is intentional.
id = ""
```

### Why the fix works

An empty `id` causes `wrangler deploy` to fail immediately with a clear error, forcing the deployer to create their own namespace first. This is the correct behavior for a template — it's impossible to accidentally deploy against the wrong namespace.

### Also consider for `worker/wrangler.toml` line 1

The Worker name is also test-specific:

```toml
name = "auto-repair-api"
```

This should be documented as requiring a per-client change (e.g., `name = "CLIENT_NAME-api"`), though it's not a security issue — just a deployment hygiene item.

---

## How to apply both fixes

```bash
# Fix #2 — config.js: replace hardcoded URL with relative path
sed -i '' 's|const API_BASE = "https://auto-repair-api.getyoursitelive.workers.dev/api";|const API_BASE = "/api";|' site/js/config.js

# Fix #2 — _headers: remove hardcoded Worker URL from CSP
sed -i '' 's| https://auto-repair-api.getyoursitelive.workers.dev||g' site/_headers

# Fix #15 — wrangler.toml: empty the namespace ID
sed -i '' 's|id = "fa89f89211294ba191c922d863bd7bee"|id = ""|' worker/wrangler.toml
```

After applying, verify:
- `site/js/config.js` contains `const API_BASE = "/api";`
- `site/_headers` CSP has no `workers.dev` references
- `worker/wrangler.toml` has `id = ""`
- `wrangler deploy` fails with namespace error (expected — confirms the guard works)
