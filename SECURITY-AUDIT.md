# MPNext Security Audit Report

**Date:** 2026-04-12
**Scope:** Full application security audit — dependencies, authentication, authorization, injection, configuration, data exposure
**Methodology:** 35+ parallel automated security analysis agents covering every source file, dependency, and configuration

---

## Executive Summary

This audit identified **62 unique findings** across the MPNext application. The most critical issues are:

1. **OData filter injection** in contact search (user input directly interpolated into API filters)
2. **Missing authentication** on two server actions exposing PII without login
3. **No security headers** configured (no CSP, HSTS, X-Frame-Options)
4. **Open redirect** on the sign-in page via unvalidated `callbackUrl`
5. **Incomplete `.gitignore`** that could allow `.env` files with secrets to be committed

The application has a solid architectural foundation (server actions, layered auth, TypeScript strict mode), but several gaps need to be addressed before production deployment.

---

## Findings Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| **CRITICAL** | 5 | OData injection, code injection in type generator, missing auth |
| **HIGH** | 12 | Open redirect, IDOR, proxy bypass, .gitignore gaps, no security headers, debug in prod |
| **MEDIUM** | 18 | PII logging, no rate limiting, token handling, cookie config, broad OAuth scope |
| **LOW** | 14 | Dependency misplacement, verbose logging, env var validation, fallback URLs |
| **INFO** | 13 | Positive findings, architectural observations |

---

## CRITICAL Findings

### C1. OData Filter Injection in Contact Search

**Files:** `src/services/contactService.ts:57`, `src/components/contact-lookup/actions.ts:13`

User-supplied search terms are interpolated directly into OData `$filter` expressions with no sanitization:

```typescript
filter: `First_Name LIKE '%${search}%' OR Last_Name LIKE '%${search}%' OR ...`
```

An attacker can inject arbitrary filter clauses by including single quotes (e.g., `' OR 1=1 OR '`), potentially exfiltrating all contacts or accessing restricted columns.

**Impact:** Full contact database enumeration, data exfiltration.

**Fix:** Create and apply an OData sanitization utility:

```typescript
function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}
```

### C2. OData Filter Injection in GUID Lookups

**Files:** `src/services/contactService.ts:73`, `src/services/userService.ts:63`

GUID parameters are interpolated directly into filter strings without format validation:

```typescript
filter: `Contact_GUID = '${contactGuid}'`
filter: `User_GUID = '${id}'`
```

**Fix:** Validate GUID format before interpolation:

```typescript
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!GUID_REGEX.test(guid)) throw new Error('Invalid GUID format');
```

### C3. Missing Authentication on `searchContacts` Server Action

**File:** `src/components/contact-lookup/actions.ts:6-19`

This server action queries Ministry Platform contacts (names, emails, phones) with **no session verification**. Every other server action in the codebase calls `auth.api.getSession()` — this one does not. Server actions are callable via HTTP POST by any client.

**Impact:** Unauthenticated contact enumeration and PII exposure.

**Fix:** Add session check matching all other actions:

```typescript
const session = await auth.api.getSession({ headers: await headers() });
if (!session?.user?.id) throw new Error('Authentication required');
```

### C4. Missing Authentication + IDOR on `getCurrentUserProfile`

**File:** `src/components/shared-actions/user.ts:11-15`

Accepts an arbitrary user GUID parameter and returns full profile data (name, email, phone, roles, groups) with no authentication or authorization check. Any client can fetch any user's profile.

**Impact:** User profile enumeration, privilege reconnaissance via exposed roles/groups.

**Fix:** Derive user GUID from the server-side session instead of accepting it as a parameter.

### C5. Code Injection in Type Generation Script

**File:** `src/lib/providers/ministry-platform/scripts/generate-types.ts:163-165`

The `formatFieldName` function wraps field names in double quotes but does not escape embedded double quotes. A malicious column name from the API could inject arbitrary TypeScript code into generated files.

**Impact:** Arbitrary code execution when generated files are imported (requires compromised API or MITM).

**Fix:** Escape quotes and special characters in `formatFieldName`:

```typescript
const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
return `"${escaped}"`;
```

---

## HIGH Findings

### H1. Open Redirect via `callbackUrl`

**File:** `src/app/signin/page.tsx:9,20`

The `callbackUrl` query parameter is used directly in `window.location.href` with no validation. An attacker can craft `/signin?callbackUrl=https://evil.com` to redirect users after authentication.

**Fix:** Validate that `callbackUrl` is a relative path:

```typescript
const safe = url.startsWith('/') && !url.startsWith('//') ? url : '/';
```

### H2. Proxy Only Checks Cookie Existence, Not Validity

**File:** `src/proxy.ts:14-18`

The proxy calls `getSessionCookie(request)` but only checks if the cookie exists — it does not verify JWT signature, expiration, or validity. An expired or forged cookie passes the check.

**Mitigation:** `AuthWrapper` in the `(web)` layout validates sessions server-side. Document that the proxy is a performance optimization, not a security boundary.

### H3. All `/api` Routes Blanket-Allowed Without Auth

**File:** `src/proxy.ts:8`

`pathname.startsWith('/api')` exempts all API routes from authentication. Currently only `/api/auth/[...all]` exists, but future routes would be unprotected by default.

**Fix:** Narrow to `pathname.startsWith('/api/auth')`.

### H4. `.env` Files Not Properly Gitignored

**File:** `.gitignore:412`

Only `.env.local` is gitignored. Files named `.env`, `.env.development`, `.env.production` are **not** excluded. A developer creating `.env` with real secrets could accidentally commit them.

**Fix:**

```
.env
.env.*
!.env.example
```

### H5. No Security Headers Configured

**File:** `next.config.ts`

The Next.js config has no `headers()` function. Missing headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.

**Fix:** Add comprehensive security headers to `next.config.ts` and set `poweredByHeader: false`.

### H6. OAuth Tokens Stored in Browser Cookie

**File:** `src/lib/auth.ts:20`

`storeAccountCookie: true` puts OAuth access/refresh tokens (with `scopes/all` access) into browser cookies. XSS could exfiltrate these tokens.

**Fix:** Evaluate server-side token storage via a database adapter. Verify cookie flags (HttpOnly, Secure, SameSite).

### H7. PKCE Disabled for OAuth Flow

**File:** `src/lib/auth.ts:44`

`pkce: false` — the OAuth flow is vulnerable to authorization code interception. The auth reference notes "MP doesn't support PKCE."

**Fix:** Enable PKCE if MP now supports it. If not, document as accepted risk and enforce strict redirect URI matching on the MP OAuth client.

### H8. No Authorization Enforcement (IDOR on Contact Logs)

**File:** `src/components/contact-logs/actions.ts:87-203`

`updateContactLog`, `deleteContactLog`, and `getContactLogById` authenticate the user but do not verify they own the record. Any authenticated user can modify/delete any contact log by ID.

**Fix:** Verify record ownership (e.g., `Made_By` matches current user) before allowing modifications.

### H9. Debug Components Ship in Production

**Files:** `src/components/user-tools-debug/`, `src/components/tool/tool-params-debug.tsx`

These components expose internal tool paths, authorization data, and query parameters. Comments say "Remove before production" but no `NODE_ENV` guard exists.

**Fix:** Wrap with `process.env.NODE_ENV === 'development'` or remove entirely.

### H10. Excessive Console Logging of PII

**Files:** Multiple services, actions, and provider files (30+ locations)

Full record payloads (names, emails, phones, notes) and API request/response bodies are logged via `console.log` with no environment gating.

**Fix:** Remove verbose logging or gate behind `NODE_ENV === 'development'`. Use structured logging with PII redaction.

### H11. `emailVerified` Hardcoded to `true`

**File:** `src/lib/auth.ts:74`

The `getUserInfo` callback sets `emailVerified: true` for all users regardless of the OIDC provider's actual claim.

**Fix:** Use `profile.email_verified` from the OIDC response.

### H12. No Token Response Validation

**File:** `src/lib/providers/ministry-platform/auth/client-credentials.ts:24`

The OAuth token response is used as `any` with no validation that `access_token` exists or is a string.

**Fix:** Validate token response shape before use.

---

## MEDIUM Findings

### M1. No Rate Limiting Anywhere

No rate limiting exists on auth endpoints, server actions, or the API client. Brute force, enumeration, and DoS attacks are unmitigated.

### M2. Token `expires_in` Ignored

**File:** `src/lib/providers/ministry-platform/client.ts:5,52`

Token lifetime is hardcoded to 5 minutes, ignoring the server's `expires_in` value.

### M3. Token Refresh Race Condition

**File:** `src/lib/providers/ministry-platform/client.ts:37-59`

No mutex on `ensureValidToken()` — concurrent requests trigger duplicate token refreshes.

### M4. No Database Adapter for Sessions

Better Auth runs with in-memory adapter. Sessions are lost on restart and cannot be revoked.

### M5. No Explicit Cookie Security Attributes

**File:** `src/lib/auth.ts`

No explicit `httpOnly`, `secure`, `sameSite` configuration on session cookies.

### M6. Overly Broad OAuth Scope

**File:** `src/lib/providers/ministry-platform/auth/client-credentials.ts:9`

Requests `dataplatform/scopes/all` — maximum possible access. If a token leaks, the blast radius is the entire MP instance.

### M7. PII Exposed in Client-Side React Context

**File:** `src/contexts/user-context.tsx`

Full `MPUserProfile` (email, phone, roles, groups) stored in React state, accessible via DevTools.

### M8. Communication Service Abuse Potential

**File:** `src/lib/providers/ministry-platform/services/communication.service.ts`

`sendMessage()` accepts arbitrary `FromAddress` and `ToAddresses` with no validation — could be abused for spam/phishing.

### M9. File Service Missing URL Encoding

**File:** `src/lib/providers/ministry-platform/services/file.service.ts`

`table`, `recordId`, `uniqueFileId` interpolated into URL paths without `encodeURIComponent()`.

### M10. No File Upload Validation

No file type, size, or name validation on uploads via `FileService`.

### M11. Error Messages Leak Internal Details

**File:** `src/lib/providers/ministry-platform/utils/http-client.ts:31`

API error responses (potentially containing table names, SQL fragments) propagate to clients.

### M12. `.env.local` Written Without Restrictive Permissions

**File:** `scripts/setup.ts:272,612`

`fs.writeFileSync` uses default permissions (typically `0644` — world-readable).

### M13. No `trustedOrigins` in Better Auth Config

Better Auth's `trustedOrigins` is not configured, potentially accepting requests from any origin.

### M14. Logout Missing `id_token_hint`

**File:** `src/components/user-menu/actions.ts:18-21`

OIDC logout URL lacks `id_token_hint`, so the IdP may not terminate the correct session.

### M15. Roles/Groups Exposed to Client

Full role and group names sent to client enable authorization model reconnaissance.

### M16. `searchContactLogs` Can Return All Logs

**File:** `src/services/contactLogService.ts:72-88`

`contactId` is optional — omitting it returns all contact logs across the organization.

### M17. Non-Null Assertions on Required Environment Variables

**Files:** `src/lib/auth.ts:6,37,38`, `src/lib/providers/ministry-platform/client.ts:26`

`process.env.VAR!` produces cryptic runtime errors if vars are missing instead of failing fast.

### M18. N+1 Query in `getContactLogsByContactId`

**File:** `src/components/contact-lookup-details/actions.ts:49-65`

`getContactLogTypes()` called inside a `.map()` loop — one API call per log entry.

---

## LOW Findings

| # | Finding | File |
|---|---------|------|
| L1 | `openai` package unused — remove it | `package.json:39` |
| L2 | `@types/js-cookie` unused and in wrong dep group | `package.json:32` |
| L3 | `dotenv` and `tsx` should be devDependencies | `package.json:36,44` |
| L4 | Hardcoded `http://localhost:3000` fallback in logout | `src/components/user-menu/actions.ts:20` |
| L5 | React Strict Mode not enabled | `next.config.ts` |
| L6 | `X-Powered-By: Next.js` header not disabled | `next.config.ts` |
| L7 | No HTTPS enforcement on MP base URL | `src/lib/providers/ministry-platform/client.ts:26` |
| L8 | Proxy path match too broad (`startsWith('/api')` matches `/api-docs`) | `src/proxy.ts:8` |
| L9 | Token stored in memory without cleanup mechanism | `src/lib/providers/ministry-platform/client.ts:15` |
| L10 | No `robots` meta tag to prevent indexing | `src/app/(web)/layout.tsx` |
| L11 | Verbose proxy logging on every request | `src/proxy.ts:9,17,22` |
| L12 | Client-side console.log exposes data in browser DevTools | Multiple client components |
| L13 | Default client IDs in `.env.example` are real-looking values | `.env.example:13,33` |
| L14 | `parseInt` in `parseToolParams` lacks NaN validation | `src/lib/tool-params.ts:49,65-70` |

---

## Dependency Vulnerabilities (npm audit)

| Package | Severity | Advisory | Status |
|---------|----------|----------|--------|
| **next** 16.0.0-16.2.2 | HIGH | DoS with Server Components (GHSA-q4gf-8mx6-v5v3) | Fix available via `npm audit fix` |
| **kysely** <=0.28.13 | HIGH | SQL Injection (GHSA-8cpq-38p9-67gx) | Transitive via `better-auth` |
| **defu** <=6.1.4 | HIGH | Prototype pollution (GHSA-737v-mqg7-c878) | Transitive via `better-auth` |
| **vite** 7.0.0-7.3.1 | HIGH | Path traversal, file read (3 advisories) | Dev-only (vitest) |
| **picomatch** <=2.3.1 | HIGH | ReDoS, method injection (2 advisories) | Dev-only |
| **brace-expansion** <1.1.13 | MODERATE | DoS via zero-step sequence | Dev/build-only |

**Recommended:** Run `npm audit fix` to resolve all 6 vulnerabilities. The `next` and `kysely`/`defu` (via `better-auth`) issues affect production.

---

## Dependency Hygiene

| Issue | Packages | Action |
|-------|----------|--------|
| Unused production dependency | `openai` | `npm uninstall openai` |
| Unused type package in wrong group | `@types/js-cookie` | `npm uninstall @types/js-cookie` |
| Dev tools in production deps | `dotenv`, `tsx` | Move to `devDependencies` |
| Outdated (within semver range) | `better-auth`, `next`, `react`, `react-dom` + 12 others | Run `npm update` |
| Major version behind (not urgent) | `typescript` (5→6), `eslint` (9→10), `lucide-react` (0→1) | Plan upgrades |

---

## Positive Findings

- No `dangerouslySetInnerHTML`, `eval()`, `innerHTML`, or `new Function()` usage
- No `NEXT_PUBLIC_` variables expose secrets
- Server-only secrets are properly isolated from client bundles
- TypeScript strict mode enabled
- Test setup uses dummy credentials (no real secrets in tests)
- Server actions use `"use server"` directive correctly with built-in CSRF protection
- Better Auth's origin-check middleware is active (CSRF protection on auth endpoints)
- `sanitizeTypeName` in type generator correctly prevents path traversal
- Cookie handling is server-side via Better Auth (no client-side `js-cookie`)
- Radix UI components follow secure shadcn patterns with no XSS vectors

---

## Priority Remediation Plan

### Immediate (before any production deployment)

1. **Fix OData injection** — Create `escapeODataString()` + `validateGuid()` utilities and apply everywhere
2. **Add auth to `searchContacts`** and `getCurrentUserProfile` — 3-line fix per action
3. **Fix `.gitignore`** — Add `.env` and `.env.*` exclusions
4. **Add security headers** to `next.config.ts` (CSP, HSTS, X-Frame-Options, etc.)
5. **Validate `callbackUrl`** in sign-in page to prevent open redirect
6. **Run `npm audit fix`** to resolve known dependency vulnerabilities

### Short-term (first sprint)

7. Add authorization checks to contact log CRUD operations
8. Remove or environment-gate debug components
9. Remove/gate verbose `console.log` statements
10. Add startup environment variable validation
11. Remove unused dependencies (`openai`, `@types/js-cookie`)
12. Move `dotenv`/`tsx` to devDependencies
13. Fix `formatFieldName` in type generator to escape quotes
14. Add GUID format validation to all server actions accepting GUIDs

### Medium-term (roadmap)

15. Configure a persistent database adapter for Better Auth sessions
16. Implement rate limiting (auth endpoints, server actions, search)
17. Add token refresh deduplication (mutex pattern)
18. Reduce client-side PII exposure (minimal DTO for React context)
19. Configure `trustedOrigins` in Better Auth
20. Add security-focused ESLint plugins (`eslint-plugin-security`)
21. Narrow OAuth scope from `scopes/all` to minimum required
22. Implement request concurrency limiting in HTTP client

---

*Report generated by automated security analysis — 35+ parallel agents covering authentication, authorization, injection, configuration, dependencies, data exposure, CSRF, rate limiting, XSS, error handling, and privacy.*
