# Security Simulation: Red Team vs. Expert

**Date:** 2026-04-27
**Codebase:** Client Site Template (Static HTML/JS + Cloudflare Worker)

---

## Round 1

### [RED TEAM] Stored XSS via Content API — Bypass `esc()` through `href` attribute injection

**Attack:** The `esc()` function sanitizes HTML entities (`<`, `>`, `"`, `'`, `&`), but several `href` attributes in `app.js` construct URLs from user-controlled content without protocol validation. Specifically:

- **Line 87:** `href="${mapsUrl}"` where `mapsUrl` is built from `info.address`. If an admin sets `businessInfo.address` to `javascript:alert(document.cookie)`, the Google Maps link becomes `https://maps.google.com/?q=javascript:alert(...)` — benign because of the `https://` prefix.
- **Line 91:** `href="tel:${esc(info.phone)}"` — `tel:` protocol is fixed, safe.
- **Line 413:** `href="tel:${esc(b.businessInfo.emergencyPhone || b.businessInfo.phone)}"` — same, safe.

**However**, the real attack surface is **line 99-100**:
```js
info.logoUrl
  ? `<img src="${esc(info.logoUrl)}" ...>`
```
And **line 145**:
```js
`<img src="${esc(h.heroImage)}" ...>`
```

The `esc()` escapes `"` to `&quot;` which prevents breaking out of the `src` attribute. But the POST /api/content endpoint allows setting `businessInfo.logoUrl` to any value. If set to a URL like `https://evil.com/tracker.gif`, it loads a tracking pixel on every visitor's page. This is a **content injection** vector — an authenticated admin can inject arbitrary image URLs that execute on every visitor's browser.

**Severity:** Medium
**The real kill shot:** The admin can set `logoUrl` to `data:image/svg+xml,...` containing an SVG with embedded `<script>` tags. The CSP `img-src 'self' data:` in `_headers` **allows `data:` URIs for images**. SVG-as-img doesn't execute scripts (browsers block it), but this is defense-in-depth fragile.

---

### [EXPERT] Defense Assessment

1. **`esc()` on all attribute values** — The `esc()` function properly encodes `<>"'&`, preventing attribute breakout. An attacker can't inject new attributes or close tags.
2. **`data:` SVG in `<img>` tags** — Browsers do NOT execute JavaScript inside SVGs loaded via `<img src>`. This is a well-established browser security boundary. The attack doesn't work.
3. **Tracking pixel** — An authenticated admin has full content control by design. They can already put any image URL in any image field. This is expected behavior for a CMS.
4. **CSP blocks inline scripts** — `script-src 'self'` prevents any injected script from running.

**Verdict:** The `esc()` function and CSP together block XSS. Tracking pixel injection requires admin auth, which is authorized access. However, the `data:` URI allowance in CSP `img-src` is unnecessarily broad.

| Finding | Severity | Status | Action Item |
|---------|----------|--------|-------------|
| `data:` URI in CSP img-src | Low | Needs Fix | Remove `data:` from `img-src` in `_headers` line 8. Change to `img-src 'self' https:;` to restrict images to HTTPS URLs only. Verify no inline data URIs are used in the site. |

---

## Round 2

### [RED TEAM] Token Theft via Referer Leakage on External Links

**Attack:** The topbar renders an external Google Maps link (line 87):
```js
`<a href="${mapsUrl}" target="_blank" rel="noopener">`
```

And the `_headers` file sets `Referrer-Policy: strict-origin-when-cross-origin`. This means when a user clicks the Maps link, the browser sends the **origin** (e.g., `https://clientsite.com`) as the Referer header. This is safe — no path/query leakage.

**But wait** — the inline editor (`editsite.js`) stores the auth token in `sessionStorage` and passes it as a `Bearer` header. The token never appears in the URL. So Referer leakage doesn't expose it.

**Pivoting:** The real attack is **session fixation**. The login flow at `login.js:16` does:
```js
sessionStorage.setItem("site_token", data.token);
window.location.href = "/mysite/edit.html";
```

There's no session rotation or old-token invalidation. If an attacker can somehow pre-set a `sessionStorage` value (impossible cross-origin), or if they can intercept the token (MitM on non-HTTPS), they get persistent access.

**The actual vulnerability:** The `connect-src 'self'` in CSP restricts fetch to same-origin. But `editsite.js` line 76 does:
```js
const res = await fetch(`${API_BASE}/upload`, { ... });
```
Where `API_BASE` is `/api` from config.js. If someone deploys with `API_BASE` set to a full URL (e.g., `https://worker.clientsite.workers.dev/api`), the CSP `connect-src 'self'` would **block the request** because it's cross-origin. This is a deployment footgun, not a vulnerability per se, but it creates a situation where admins might weaken CSP to make it work.

**Severity:** Medium (deployment misconfiguration risk)

---

### [EXPERT] Defense Assessment

1. **Referer leakage** — `strict-origin-when-cross-origin` only sends the origin, not path. Token is never in URL. No risk.
2. **Session fixation** — `sessionStorage` is origin-scoped and tab-scoped. Cross-origin pre-setting is impossible. Same-origin XSS is blocked by CSP. Not exploitable.
3. **HSTS** — `Strict-Transport-Security: max-age=31536000` forces HTTPS, preventing MitM after first visit.
4. **CSP vs cross-origin API_BASE** — This is a real operational issue. The `_headers` CSP locks `connect-src` to `'self'`, but if someone deploys with a separate Worker domain, API calls fail silently.

**Verdict:** The CSP `connect-src` mismatch with cross-origin Worker deployments is a real issue that causes breakage, not a security vulnerability. But it could lead operators to disable CSP entirely. The `_headers` CSP should document this.

| Finding | Severity | Status | Action Item |
|---------|----------|--------|-------------|
| `data:` URI in CSP img-src | Low | Needs Fix | Remove `data:` from `img-src` in `_headers`. Use `img-src 'self' https:;` |
| CSP `connect-src` mismatch with cross-origin Worker | Low | Needs Fix | Add Worker URL to `connect-src` in `_headers` when deploying cross-origin, or document in CLAUDE.md that `API_BASE=/api` (same-origin) is the only CSP-compatible config. Already noted as TODO #2 in CLAUDE.md. |

---

## Round 3

### [RED TEAM] Denial of Service via KV Namespace Pollution (Rate Limit Keys)

**Attack:** The rate limiter stores keys in the same KV namespace as content:
```js
const key = `ratelimit:login:${ip}`;
await env.CONTENT.put(key, JSON.stringify({...}), { expirationTtl: LOCKOUT_WINDOW });
```

An attacker behind a rotating IP pool (botnet, Tor, cloud functions) can fire login attempts from thousands of IPs. Each attempt creates a KV entry. Cloudflare KV free tier allows **1,000 writes/day**. Paid plans allow more, but KV has **list** operation limits too.

**The real attack:** Each failed login does TWO KV operations: `get` (read rate limit) + `put` (record failure). A successful login does `get` + `delete`. The content save does `put`. If the attacker sends 500 login attempts from 500 IPs, that's 1,000 KV writes — **burning the entire free-tier daily write quota** on rate-limit keys alone. The admin can no longer save content because KV writes are exhausted.

This is a **resource exhaustion** attack that weaponizes the rate limiter against the site owner.

**Severity:** Medium

---

### [EXPERT] Defense Assessment

1. **KV quotas** — This is a valid concern for free-tier Cloudflare accounts. The free tier has 1,000 write operations/day. Rate limit keys with expiration TTL do auto-delete, but the writes still count.
2. **Cloudflare's own protection** — In production, Cloudflare's firewall rules, Bot Management, and rate limiting at the edge (before the Worker runs) can mitigate this. But the template doesn't ship with these configured.
3. **Mitigation options:**
   - Use Cloudflare's built-in rate limiting (Edge) instead of KV-backed
   - Move rate limit to a separate KV namespace so it can't exhaust the content namespace's quota
   - Add a simple Cloudflare WAF rule to limit `/api/login` to N requests/minute at the edge

**Verdict:** Real concern on free tier. The rate limiter KV pollution can't corrupt content (different keys, `ratelimit:` prefix), but it can exhaust write quotas. Edge-level rate limiting is the proper fix.

| Finding | Severity | Status | Action Item |
|---------|----------|--------|-------------|
| `data:` URI in CSP img-src | Low | Needs Fix | Remove `data:` from `img-src` in `_headers`. Use `img-src 'self' https:;` |
| CSP `connect-src` vs cross-origin Worker | Low | Blocked by existing guidance | CLAUDE.md TODO #2 already tracks this. `API_BASE` is now `/api`. |
| KV write quota exhaustion via login spam | Medium | Needs Fix | Document that production deployments MUST enable Cloudflare Edge rate limiting on `/api/login` (5 req/10s per IP). Alternatively, create a separate KV namespace for rate-limit keys to isolate from content writes. |

---

## Round 4

### [RED TEAM] Content Overwrites via Race Condition (Last-Write-Wins)

**Attack:** The inline editor (`editsite.js`) auto-saves on every blur event with an 800ms debounce:
```js
SAVE_TIMEOUT = setTimeout(doSave, 800);
```

`doSave` sends the entire `BUSINESS` object to `POST /api/content`. The Worker does:
```js
await env.CONTENT.put(CONTENT_KEY, JSON.stringify(body));
```

This is a **blind overwrite** with no version check (no ETag, no `If-Match`, no `updatedAt` comparison).

**Scenario:** Admin opens the form editor (`/mysite/`) in Tab A and the inline editor (`/mysite/edit.html`) in Tab B. Both load content at T=0. Admin edits the business name in Tab A and clicks Save. The KV now has v2. Admin edits a hero headline in Tab B (still holding v1 in memory). On blur, Tab B auto-saves — writing v1 + headline change to KV, **silently reverting the business name change from Tab A**.

This is especially dangerous because the inline editor auto-saves without explicit user action. The admin may not realize their form editor changes were lost.

**Severity:** Medium

---

### [EXPERT] Defense Assessment

1. **Single admin** — This system is designed for a single admin per site. The CLAUDE.md states "Single admin password per site." Multi-tab editing by the same person is an edge case, not a multi-user concurrency problem.
2. **No conflict resolution** — Correct, there's no optimistic locking. KV doesn't natively support conditional writes (no ETag on `put`).
3. **Practical risk** — Low in practice. The admin would need to actively edit in two tabs simultaneously. The debounced auto-save reduces the window.
4. **Possible mitigation** — Add a `_version` field (timestamp) to the content. Before save, `GET` the current content, compare versions, warn if stale. Or use KV metadata to store a version counter.

**Verdict:** Valid design limitation, low practical risk for single-admin use. Not worth adding complexity for v1, but should be documented.

| Finding | Severity | Status | Action Item |
|---------|----------|--------|-------------|
| `data:` URI in CSP img-src | Low | Needs Fix | Remove `data:` from `img-src` in `_headers`. Use `img-src 'self' https:;` |
| CSP `connect-src` vs cross-origin Worker | Low | Blocked by existing guidance | CLAUDE.md TODO #2 already tracks this. |
| KV write quota exhaustion via login spam | Medium | Needs Fix | Enable Cloudflare Edge rate limiting on `/api/login` or use separate KV namespace for rate-limit keys. |
| Last-write-wins content overwrite (no OCC) | Low | Accepted Risk | Document in CLAUDE.md Known Issues: "Do not edit in both Form Editor and Inline Editor simultaneously — no conflict detection. Changes from the other tab will be silently overwritten." |

---

## Round 5

### [RED TEAM] Unauthenticated Content Enumeration + Sensitive Field Exposure via GET /api/content

**Attack:** The `GET /api/content` endpoint (worker line 249-262) is **publicly accessible** — no auth required. It returns the full business JSON to any visitor. The only protection is:
```js
if (!isAdmin) {
  const publicData = { ...data };
  delete publicData.slug;
  return json(publicData, 200, request, env);
}
```

This is a **shallow clone** (`{ ...data }`). It strips `slug` but nothing else. The content object contains:
- `businessInfo.email` — admin's email
- `businessInfo.emergencyPhone` — personal phone number
- `contact.extraServiceOptions` — internal service configuration
- Any field the admin types into the CMS

More critically, the shallow clone doesn't deep-clone nested objects. If any server-side code later mutates `data` (the cached KV result), changes would reflect in `publicData` too — but since this is a stateless Worker with no in-memory cache, this isn't exploitable currently.

**The real issue:** An automated scraper can enumerate all client sites deployed with this template by hitting `/api/content` on each domain and fingerprinting the response shape (checking for `businessInfo`, `hero`, `services` keys). This reveals the CMS vendor and structure, enabling targeted attacks.

**Severity:** Low (information disclosure, not a direct exploit)

---

### [EXPERT] Defense Assessment

1. **Public content is by design** — This is a public website. The content rendered on the page IS the content in KV. There's no secret data being exposed — everything in the JSON is already rendered into the HTML.
2. **Email/phone** — Already visible on the public site (topbar, footer). Not a leak.
3. **`slug` stripping** — Already implemented as the one internal field.
4. **Fingerprinting** — Any CMS can be fingerprinted (WordPress, Squarespace, etc). Not a meaningful vulnerability.
5. **Shallow vs deep clone** — Correct that it's shallow, but in a stateless Worker, the KV result is fetched fresh each request. No mutation risk.

**Verdict:** Not a vulnerability. The public content endpoint serves the same data that's rendered on the page. Stripping `slug` is sufficient for the one internal field. Response fingerprinting is unavoidable and not a security concern.

| Finding | Severity | Status | Action Item |
|---------|----------|--------|-------------|
| `data:` URI in CSP img-src | Low | Needs Fix | Remove `data:` from `img-src` in `_headers`. Use `img-src 'self' https:;` |
| CSP `connect-src` vs cross-origin Worker | Low | Blocked by existing guidance | CLAUDE.md TODO #2 already tracks this. |
| KV write quota exhaustion via login spam | Medium | Needs Fix | Enable Cloudflare Edge rate limiting on `/api/login` or use separate KV namespace for rate-limit keys. |
| Last-write-wins content overwrite (no OCC) | Low | Accepted Risk | Document: "Do not edit in both editors simultaneously." |
| Public content endpoint info disclosure | Low | Not a vulnerability | Public website data is public by design. No action needed. |

---

## Summary

| # | Finding | Severity | Status | Priority |
|---|---------|----------|--------|----------|
| 1 | `data:` URI in CSP `img-src` | Low | Needs Fix | P3 |
| 2 | CSP `connect-src` vs cross-origin Worker | Low | Already Tracked | P4 |
| 3 | KV write quota exhaustion via login spam | Medium | Needs Fix | P2 |
| 4 | Last-write-wins race condition | Low | Accepted Risk | P4 |
| 5 | Public content endpoint disclosure | Low | Not Vulnerable | -- |

**Overall assessment:** The codebase has strong security fundamentals. The previous 19-finding audit addressed the critical and high issues effectively. This simulation found no new Critical or High severity vulnerabilities. The remaining findings are operational hardening (edge rate limiting, CSP tightening) rather than exploitable flaws.
