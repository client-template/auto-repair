# Security Audit Report

**Date:** 2026-04-27
**Method:** Dual-agent simulation (Red Team penetration tester + Blue Team security engineer)
**Scope:** Full codebase — Worker API, client JS, HTML, config, headers, content JSON

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 5 |
| MEDIUM | 7 |
| LOW | 6 |
| **Total** | **19** |

---

## Recommended Fix Priority

```
1. #1   Token no longer contains password          (CRITICAL — do first)
2. #2   config.js → "/api", CSP → remove ext URL  (HIGH — 2 min fix)
3. #4   esc(String(s.value)) in data-target        (HIGH — 1 line fix)
4. #5   Content validation allowlist on Worker     (HIGH — 15 min)
5. #7   CORS default-deny                          (MEDIUM — prevents accidents)
6. #8   Require application/json                   (MEDIUM — 3 lines)
7. #9   Token generation counter for revocation    (MEDIUM — 30 min)
8. #10  sessionStorage over localStorage           (MEDIUM — find/replace)
```

---

## CRITICAL

### #1 — Token Embeds Raw Password in HMAC Payload

**Severity:** CRITICAL
**File:** `worker/src/index.js` lines 148-158

**What:** `createToken()` signs `${password}:${now}` — the actual plaintext password is baked into the HMAC payload. If `TOKEN_SECRET` is not set separately (the code falls back to `PASSWORD` as signing key on line 144), then knowing the password is sufficient to forge arbitrary tokens offline without hitting the login endpoint at all.

**Attack scenario:** If an attacker obtains the PASSWORD (shoulder-surfing, social engineering, leaked env), they can forge valid tokens with any timestamp, completely bypassing rate limiting.

**Vulnerable code:**
```javascript
async function createToken(password, env) {
  const now = Date.now();
  const data = `${password}:${now}`;
  const encoder = new TextEncoder();
  const secret = getSigningKey(env); // Falls back to env.PASSWORD
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${now}.${hex}`;
}
```

**Patched code:**
```javascript
async function createToken(env) {
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const data = `session:${nonce}:${now}`;
  const encoder = new TextEncoder();
  const secret = getSigningKey(env);
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${now}.${nonce}.${hex}`;
}
```

Also update `verifyToken`:
```javascript
async function verifyToken(token, env) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [timestampStr, nonce, hex] = parts;
  if (!timestampStr || !nonce || !hex) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || Date.now() - timestamp > TOKEN_TTL) return false;

  const secret = getSigningKey(env);
  const data = `session:${nonce}:${timestamp}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return await timingSafeEqual(hex, expected);
}
```

Update the call site (line 274):
```javascript
const token = await createToken(env);
```

**Why the patch works:** Token no longer contains or depends on the password value. It uses a random nonce making each token unique. The password is only checked at login time, never embedded in the token.

---

## HIGH

### #2 — Hardcoded Test Worker URL in config.js and _headers CSP

**Severity:** HIGH
**Files:** `site/js/config.js` line 8, `site/_headers` line 7

**What:** `config.js` contains the live test Worker URL committed to the repository. Anyone who clones this repo gets the exact endpoint to attack. The `_headers` CSP also hardcodes this URL — when deployed to a real client domain, the CSP will break unless updated, meaning deployments will likely just remove or weaken the CSP.

**Attack scenario:** Attacker sees the URL and brute-forces the login endpoint, enumerates content, probes for weaknesses.

**Vulnerable code (config.js):**
```javascript
const API_BASE = "https://auto-repair-api.getyoursitelive.workers.dev/api";
```

**Patched code (config.js):**
```javascript
/**
 * API_BASE — MUST be changed per client deployment.
 *
 * When Pages and Worker share the same domain (via Worker routes),
 * set API_BASE = "/api". When they're on separate subdomains
 * (e.g. testing), use the full Worker URL.
 *
 * DEFAULT: relative path (works when Worker route is on same domain).
 */
const API_BASE = "/api";
```

**Vulnerable CSP (_headers):**
```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://auto-repair-api.getyoursitelive.workers.dev data:; connect-src 'self' https://auto-repair-api.getyoursitelive.workers.dev; form-action 'self'; base-uri 'self'; frame-ancestors 'none'
```

**Patched CSP (_headers):**
```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'
```

**Why the patch works:** Using `/api` (relative) means the site talks to whatever domain it's hosted on. The CSP no longer whitelists a third-party origin.

---

### #3 — Token Signing Key Falls Back to Login Password

**Severity:** HIGH
**File:** `worker/src/index.js` lines 144-145

**What:** `getSigningKey()` returns `env.TOKEN_SECRET || env.PASSWORD`. If the deployer forgets to set TOKEN_SECRET (which is optional), the login password IS the HMAC signing key. Compromising one compromises the other.

**Attack scenario:** Attacker cracks the password (only 5-attempt rate limit per IP, bypassable with distributed IPs), simultaneously gets the signing key, and can forge tokens indefinitely.

**Vulnerable code:**
```javascript
function getSigningKey(env) {
  return env.TOKEN_SECRET || env.PASSWORD;
}
```

**Patched code:**
```javascript
function getSigningKey(env) {
  if (!env.TOKEN_SECRET) {
    throw new Error("TOKEN_SECRET must be configured. Do not reuse PASSWORD as signing key.");
  }
  return env.TOKEN_SECRET;
}
```

**Why the patch works:** Fails loudly if TOKEN_SECRET is missing, preventing accidental reuse of the login password as a cryptographic key.

---

### #4 — Unescaped `data-target` Attribute (Stored XSS)

**Severity:** HIGH
**File:** `site/js/app.js` line 226

**What:** The `renderStats` function injects `s.value` directly into an HTML attribute without `esc()`. If `s.value` contains `" onmouseover="alert(1)`, it breaks out of the attribute.

**Attack scenario:** Authenticated attacker (or someone with a stolen token) stores a malicious stats value. Every visitor to the site triggers the XSS.

**Vulnerable code:**
```javascript
<div class="stat-value" data-target="${s.value}" data-suffix="${esc(s.suffix)}" ${E("stats." + i + ".value")}>0${esc(s.suffix)}</div>
```

**Patched code:**
```javascript
<div class="stat-value" data-target="${esc(String(s.value))}" data-suffix="${esc(s.suffix)}" ${E("stats." + i + ".value")}>0${esc(s.suffix)}</div>
```

**Why the patch works:** `esc()` encodes quotes, preventing attribute breakout regardless of stored content.

---

### #5 — No Server-Side Content Structure Validation

**Severity:** HIGH
**File:** `worker/src/index.js` lines 232-239

**What:** POST /api/content accepts any valid JSON and stores it verbatim. No schema validation. An attacker with a valid token can inject arbitrary keys, craft content that bypasses rendering safety, or simply destroy the site.

**Attack scenario:** Attacker with stolen token POSTs `{"__proto__":{"isAdmin":true}}` or replaces entire content with malicious payloads.

**Vulnerable code:**
```javascript
let body;
try {
  body = JSON.parse(rawBody);
} catch {
  return errorResponse("Invalid JSON", 400, request, env);
}

await env.CONTENT.put(CONTENT_KEY, JSON.stringify(body));
```

**Patched code:**
```javascript
let body;
try {
  body = JSON.parse(rawBody);
} catch {
  return errorResponse("Invalid JSON", 400, request, env);
}

// Basic structure validation
if (typeof body !== "object" || body === null || Array.isArray(body)) {
  return errorResponse("Content must be a JSON object", 400, request, env);
}

if (!body.businessInfo || typeof body.businessInfo !== "object") {
  return errorResponse("Content must include a valid businessInfo object", 400, request, env);
}

// Reject unknown top-level keys (allowlist)
const ALLOWED_KEYS = new Set([
  "slug", "category", "theme", "businessInfo", "hero", "about", "stats",
  "services", "deals", "pricing", "team", "testimonials", "faqs",
  "emergency", "contact", "footer", "visibility", "sectionTitles", "navLabels"
]);
const unknownKeys = Object.keys(body).filter(k => !ALLOWED_KEYS.has(k));
if (unknownKeys.length > 0) {
  return errorResponse(`Unknown fields: ${unknownKeys.join(", ")}`, 400, request, env);
}

await env.CONTENT.put(CONTENT_KEY, JSON.stringify(body));
```

**Why the patch works:** Validates structure, requires minimum valid content, and prevents arbitrary key injection.

---

### #6 — Auth Token in localStorage (XSS = Full Account Takeover)

**Severity:** HIGH
**Files:** `site/js/login.js` line 15, `site/js/editsite.js` line 24, `site/js/mysite.js` line 14

**What:** Session token stored in `localStorage` is accessible to any JavaScript on the same origin. If any XSS is found, the attacker gets the token for up to 7 days of admin access.

**Attack scenario:** Attacker exploits any XSS (browser extension, CSP bypass, stored XSS via #4), calls `localStorage.getItem("site_token")`, and exfiltrates it.

**Vulnerable code:**
```javascript
localStorage.setItem("site_token", data.token);
```

**Patched code (short-term mitigation — switch to sessionStorage):**

login.js:
```javascript
sessionStorage.setItem("site_token", data.token);
```

editsite.js:
```javascript
function getToken() { return AUTH_TOKEN || sessionStorage.getItem("site_token"); }
function setToken(t) { AUTH_TOKEN = t; sessionStorage.setItem("site_token", t); }
function clearToken() { AUTH_TOKEN = null; sessionStorage.removeItem("site_token"); }
```

mysite.js:
```javascript
function getToken() { return AUTH_TOKEN || sessionStorage.getItem("site_token"); }
function setToken(t) { AUTH_TOKEN = t; sessionStorage.setItem("site_token", t); }
function logout() { sessionStorage.removeItem("site_token"); window.location.href = "/admin/login.html"; }
```

**Why the patch works:** `sessionStorage` is cleared when the browser tab closes, reducing the window for token theft from 7 days to one session. The ideal fix (HttpOnly cookies) requires significant Worker refactoring.

---

## MEDIUM

### #7 — CORS Falls Back to Wildcard When ALLOWED_ORIGIN Not Set

**Severity:** MEDIUM
**File:** `worker/src/index.js` lines 37-44

**What:** If `env.ALLOWED_ORIGIN` is not configured, CORS is set to `*`. Cross-origin requests from any domain are accepted, enabling attacks on authenticated endpoints.

**Attack scenario:** Deployer forgets to set ALLOWED_ORIGIN. Attacker hosts page on `evil.com` making requests to the Worker using a stolen token.

**Vulnerable code:**
```javascript
function getCorsOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  if (allowed === "*") return "*";
  return origin === allowed ? allowed : "null";
}
```

**Patched code:**
```javascript
function getCorsOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN;

  if (!allowed) {
    // In development, allow localhost
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
      return origin;
    }
    // Same-origin requests (no Origin header) — allow
    return origin ? "null" : "*";
  }

  return origin === allowed ? allowed : "null";
}
```

**Why the patch works:** Without `ALLOWED_ORIGIN`, cross-origin requests from non-localhost origins are denied.

---

### #8 — No Content-Type Validation on POST /api/content

**Severity:** MEDIUM
**File:** `worker/src/index.js` lines 217-240

**What:** The endpoint never validates that the request has `Content-Type: application/json`. While Bearer token provides CSRF protection, this is defense-in-depth.

**Patched code (add after auth check):**
```javascript
const ct = request.headers.get("Content-Type") || "";
if (!ct.includes("application/json")) {
  return errorResponse("Content-Type must be application/json", 415, request, env);
}
```

**Why the patch works:** Rejects non-JSON requests early. Simple HTML forms can only submit `application/x-www-form-urlencoded` or `multipart/form-data`, blocking form-based attacks.

---

### #9 — 7-Day Token With No Revocation Mechanism

**Severity:** MEDIUM
**File:** `worker/src/index.js` line 22

**What:** Tokens are valid for 7 days. No token revocation, no logout endpoint that invalidates server-side, no "sign out everywhere". If a token is compromised, it remains valid for up to a week.

**Patched code:**
```javascript
const TOKEN_GENERATION_KEY = "token_generation";

async function getTokenGeneration(env) {
  const gen = await env.CONTENT.get(TOKEN_GENERATION_KEY);
  return gen || "0";
}

// Include generation in token creation
async function createToken(env) {
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const generation = await getTokenGeneration(env);
  const data = `session:${generation}:${nonce}:${now}`;
  // ... sign as before ...
  return `${now}.${generation}.${nonce}.${hex}`;
}

// Verify generation matches current
async function verifyToken(token, env) {
  // ... parse parts ...
  const currentGen = await getTokenGeneration(env);
  if (generation !== currentGen) return false;
  // ... verify HMAC ...
}

// New endpoint: POST /api/invalidate-sessions
if (path === "/api/invalidate-sessions" && request.method === "POST") {
  const authErr = await requireAuth(request, env);
  if (authErr) return authErr;
  const current = parseInt(await getTokenGeneration(env) || "0", 10);
  await env.CONTENT.put(TOKEN_GENERATION_KEY, String(current + 1));
  return json({ ok: true, message: "All sessions invalidated" }, 200, request, env);
}
```

**Why the patch works:** Incrementing the generation counter in KV instantly invalidates all previously-issued tokens without needing to store individual token IDs.

---

### #10 — Public Content Endpoint Exposes Hidden Sections

**Severity:** MEDIUM
**File:** `worker/src/index.js` lines 210-213

**What:** GET /api/content requires no authentication. All stored content is public, including hidden sections (`visibility: false`), internal config, and draft content the owner doesn't want visible.

**Patched code:**
```javascript
if (path === "/api/content" && request.method === "GET") {
  const data = await env.CONTENT.get(CONTENT_KEY, "json");
  if (!data) return errorResponse("No content found", 404, request, env);

  const token = getToken(request);
  const isAdmin = token ? await verifyToken(token, env) : false;
  if (!isAdmin) {
    const publicData = { ...data };
    delete publicData.slug;
    return json(publicData, 200, request, env);
  }
  return json(data, 200, request, env);
}
```

**Why the patch works:** Public visitors no longer see internal-only fields. The editor (authenticated) still gets the full payload.

---

### #11 — MIME Type Validation Trusts Client-Provided Metadata

**Severity:** MEDIUM
**File:** `worker/src/index.js` lines 296-299

**What:** Upload endpoint checks `file.type` which is client-provided. An attacker can set this to any allowed type while uploading a different file format.

**Vulnerable code:**
```javascript
const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
if (!allowedTypes.includes(file.type)) { // file.type is client-controlled
```

**Patched code (also fix extension derivation at line 307):**
```javascript
// Derive extension from validated MIME type, not user-provided filename
const MIME_TO_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const ext = MIME_TO_EXT[file.type] || "jpg";
```

**Why the patch works:** Extension is derived from the already-validated MIME type, removing user input from the file path. (Note: full fix would also validate magic bytes of the uploaded file content.)

---

### #12 — Prototype Pollution in `setNestedValue()`

**Severity:** MEDIUM
**Files:** `site/js/editsite.js` lines 320-328, `site/js/mysite.js` lines 557-562

**What:** `setNestedValue()` creates intermediate objects along a path without checking for dangerous keys like `__proto__`, `constructor`, or `prototype`.

**Vulnerable code:**
```javascript
function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (!o[k]) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}
```

**Patched code:**
```javascript
function setNestedValue(obj, path, value) {
  const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);
  const keys = path.split(".");
  const last = keys.pop();
  if (BLOCKED.has(last)) return;
  const target = keys.reduce((o, k) => {
    if (BLOCKED.has(k)) return o;
    if (!o[k]) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}
```

**Why the patch works:** Blocks dangerous property names that could pollute the Object prototype.

---

### #13 — Rate Limiting Bypassable Without Cloudflare Proxy

**Severity:** MEDIUM
**File:** `worker/src/index.js` lines 92-94

**What:** Rate limiting uses `CF-Connecting-IP` header. If the Worker is accessed directly (not through Cloudflare's proxy, e.g., during local dev), an attacker can manipulate this header. The fallback `"unknown"` means all requests without this header share one bucket.

**Vulnerable code:**
```javascript
function getClientIP(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
```

**Recommendation:** This is an infrastructure requirement rather than a code fix. Document that the Worker MUST run behind Cloudflare's proxy in production. Optionally add a secondary check:

```javascript
function getClientIP(request) {
  // CF-Connecting-IP is set by Cloudflare's proxy and cannot be spoofed
  // when the Worker is accessed through Cloudflare's edge network.
  // In dev mode (wrangler dev), fall back to X-Real-IP or request IP.
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Real-IP")
    || "unknown";
}
```

---

## LOW

### #14 — No CSRF Protection on State-Changing Endpoints

**Severity:** LOW
**File:** `worker/src/index.js` (all POST endpoints)

**What:** All POST endpoints rely solely on the Bearer token. No CSRF token exists. However, since auth is in localStorage (not cookies), browsers don't auto-send credentials on cross-origin requests.

**Recommendation:** Informational only. Bearer token auth inherently prevents CSRF because the token must be explicitly attached to requests. This would become a concern only if auth moves to cookies.

---

### #15 — KV Namespace ID Committed to Repository

**Severity:** LOW
**File:** `worker/wrangler.toml` line 8

**What:** The KV namespace ID `fa89f89211294ba191c922d863bd7bee` is committed. Not directly exploitable without Cloudflare account access, but aids targeted attacks.

**Patched code:**
```toml
id = "" # Set per-client: run `wrangler kv:namespace create CONTENT` and paste ID here
```

**Why the patch works:** Template ships with empty placeholder. Each deployment fills in its own ID.

---

### #16 — Content-Length Header Can Be Spoofed to Bypass First Size Check

**Severity:** LOW
**File:** `worker/src/index.js` lines 222-224

**What:** First size check uses `Content-Length` header (spoofable/omittable). The second check on the actual body length catches this. The first check is misleading defense-in-depth.

**Recommendation:** Keep both checks. The first is a fast-fail for well-behaved clients. The second is the actual enforcement. No code change needed.

---

### #17 — `esc()` Does Not Sanitize URLs in `href` Attributes

**Severity:** LOW
**File:** `site/js/app.js` lines 91, 413, 491

**What:** `esc()` prevents HTML injection but doesn't prevent `javascript:` protocol URLs in `href` attributes. Currently safe because all `href` values are prefixed with `tel:`, `mailto:`, or `https://`.

**Recommendation:** No immediate fix needed. If user-controlled `href` values are ever introduced, add a URL sanitizer:

```javascript
function sanitizeUrl(url) {
  const u = url.trim().toLowerCase();
  if (u.startsWith("javascript:") || u.startsWith("data:") || u.startsWith("vbscript:")) {
    return "#";
  }
  return url;
}
```

---

### #18 — Login Error Message Reflects Server Error Verbatim

**Severity:** LOW
**File:** `site/js/login.js` line 18

**What:** Error message from the server is displayed directly. While `textContent` prevents XSS, server error messages (rate limit details, retry times) leak implementation details.

**Vulnerable code:**
```javascript
errorEl.textContent = err.message;
```

**Patched code:**
```javascript
if (err.message.includes("Too many login attempts")) {
  errorEl.textContent = err.message;
} else {
  errorEl.textContent = "Invalid password. Please try again.";
}
```

**Why the patch works:** Prevents leaking specific error details while still showing useful rate-limit feedback.

---

### #19 — Booking Form Silently Discards Submissions

**Severity:** LOW (functional, not security)
**File:** `site/js/app.js` lines 630-637

**What:** The booking form calls `e.preventDefault()`, hides the form, and shows a success message but never sends data anywhere. Customer submissions are silently lost.

**Recommendation:** Either remove the form, clearly mark it as non-functional, or connect it to an endpoint (email webhook, KV storage, etc.).

---

## Architecture Notes

### What's Already Done Well

- Timing-safe password comparison (HMAC-based, not string equality)
- Rate limiting on login (5 attempts / 15 min)
- Security headers on all responses (X-Frame-Options, CSP, X-Content-Type-Options)
- SVG removed from upload allow-list (XSS vector)
- All inline scripts extracted; CSP `script-src 'self'`
- 512KB payload limit on POST /api/content
- CORS locked to ALLOWED_ORIGIN when configured

### Remaining Architectural Gaps

| Gap | Effort | Impact |
|-----|--------|--------|
| HttpOnly cookie auth (replaces localStorage) | Large refactor | Eliminates XSS token theft |
| Content schema validation | Medium | Prevents stored XSS and data corruption |
| File magic byte validation on upload | Small | Prevents MIME spoofing |
| Server-side HTML sanitization of content values | Medium | Defense-in-depth against stored XSS |
| Automated deployment script (config.js, wrangler.toml) | Medium | Prevents hardcoded-URL deployment accidents |
