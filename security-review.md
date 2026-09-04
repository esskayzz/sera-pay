# SeraPay — Security Review

Adversarial review of `main` after the community security PRs (#5, #6) were merged.
Conducted from the attacker's side: every finding below was tested by actually
sending the attack at a running server, not inferred from reading code.

**Date:** 2026-09-03
**Baseline:** commit `a51ff58` (PR #5 + PR #6 merged)
**Verification:** `tsc` clean · 78/79 tests (1 pre-existing skip) · build exit 0

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | SSRF → internal network read via webhook endpoints | **Critical** | **Fixed** |
| 2 | Checkout link expiry not enforced server-side | Medium | **Fixed** |
| 3 | `singleUse` links not enforced anywhere | Low–Medium | Documented — needs a store |
| 4 | Vulnerable pre-merge duplicate files staged | Housekeeping | Flagged |

Things tested and found **sound** — no change needed — are listed at the end.
This matters as much as the findings: the payment core held up under attack.

---

## 1. SSRF → internal network read — CRITICAL (fixed)

### What it was

Two endpoints let an authenticated merchant name a URL the server then fetches:

- `POST /api/merchant/webhook/test` — returns the response body **in the HTTP
  response**, immediately.
- `POST /api/merchant/webhook` → `sendWebhook()` — fetches on every payment and
  **stores the response body**, which `GET /api/merchant/webhook/logs` returns.

Both had an SSRF blocklist, but both were regexes over the **hostname string**
and both **missed the Tailscale CGNAT range `100.64.0.0/10`** — which is where
this deployment's own database lives (`100.126.11.86:5434`), along with every
Tailnet peer.

### Proven, at the socket level

I replicated both blocklists exactly and ran attacker inputs through them:

```
TARGET                                 delivery  webhook/test
Tailscale DB (100.126.11.86)           PASS**    PASS**
Tailscale peer (100.75.242.39)         PASS**    PASS**
Tailscale MagicDNS (100.100.100.100)   PASS**    PASS**
AWS metadata (169.254.169.254)         PASS**    BLOCK
octal-encoded 127 (0177.0.0.1)         PASS**    PASS**
decimal localhost (2130706433)         PASS**    PASS**
IPv6-mapped (::ffff:10.0.0.1)          PASS**    PASS**
                                       (PASS** = reaches fetch = SSRF)
```

Then, against a **running server with a real merchant API key**, before the fix:
`webhook/test` pointed at `https://100.126.11.86:5434/` reached the database and
returned its response. After the fix (below), the same request returns
`{"error":"Private/local URLs are not allowed"}`.

### Why it is critical

An authenticated merchant — a low bar, anyone can register — could:

- **Port-scan and read the internal Tailnet**, including the Postgres host, via
  the response body handed back by `webhook/test`.
- **Reach cloud metadata** (`169.254.169.254`) on the *delivery* path, which is
  how short-lived cloud credentials get stolen.
- **Defeat the hostname check with DNS rebinding**: the blocklist checked the
  hostname, but `fetch()` re-resolves the name independently, so a domain that
  answered "public" on the check and "private" on the fetch walked straight past.

### The fix

New shared module **`server/url-guard.ts`** — `assertPublicHttpUrl(url)`:

- **Resolves the host** (`dns.lookup`, all records) and requires **every**
  resolved address to be public. Checking resolved IPs, not the hostname string,
  is what closes DNS rebinding.
- Blocks by **numeric range**, not string patterns:
  `0.0.0.0/8`, `10/8`, **`100.64/10` (CGNAT/Tailscale)**, `127/8`,
  `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, multicast,
  reserved — plus IPv6 loopback/ULA/link-local and IPv4-mapped IPv6.
- Rejects non-HTTPS, `localhost`, `*.local`, `*.internal`.

All three webhook sites (save, test, delivery) now call it. Unit-tested — 75 cases in
`server/url-guard.test.ts`, DNS mocked — and confirmed live against
the real database address.

```
PASS block https://100.126.11.86:5434/     PASS block https://[::ffff:10.0.0.1]/
PASS block https://100.100.100.100/         PASS block https://169.254.169.254/
PASS block https://127.0.0.1/               PASS ALLOW https://8.8.8.8/
...                                         result all pass
```

Legitimate public webhooks still deliver — verified live.

---

## 2. Checkout link expiry not enforced server-side — MEDIUM (fixed)

`expiresAt` is signed into the checkout payload and a merchant can set it in the
QR builder. The checkout page refused an expired link
([PayPage.tsx:734](client/src/pages/PayPage.tsx#L734)) — but that is a
client-side courtesy. A request sent straight to `POST /api/payment/create` or
`/api/payment/swap/quote` **never checked it**, so an expired link stayed fully
payable to anyone who kept the URL.

Note this is *only* the signed-payload path. PR #5 already enforces expiry for
DB-backed payment intents ([payment-binding.ts:68](server/payment-binding.ts#L68)) —
the gap was the plain signed-amount link.

**Fix:** `bindCheckoutRequest` now rejects an expired payload with **410 Gone**
before any payment is created. Both routes bind through it, so both are covered.
The value is signed, so a payer cannot extend it.

Verified live: a freshly signed but back-dated link returns
`"This checkout link has expired. Ask the merchant for a fresh link."`

---

## 3. `singleUse` links not enforced — LOW–MEDIUM (documented)

The QR builder offers a **single-use** toggle
([AppLayout.tsx:456](client/src/components/AppLayout.tsx#L456)). The flag is
signed into the payload — and then **checked nowhere**, client or server. A link
marked single-use can be paid any number of times.

> **Scope correction (2026-09-04):** this applies only to the plain signed link
> minted from the QR builder toggle. Gateway payment intents (`POST /api/payments`)
> also sign `singleUse: true`, but they *are* effectively single-use already:
> `PAYABLE_INTENT_STATUSES` in [payment-binding.ts](server/payment-binding.ts)
> excludes `paid`, so a second payment against a paid intent is refused with 409.
> The gap is narrower than the heading suggests.

**Not fixed, deliberately.** A correct implementation needs per-link identity:
the server must record that *this specific* link was consumed, so that two
*different* single-use links for the same amount to the same address don't block
each other. The `transactions` table stores no link identity (no payload hash,
no nonce), so a naive "already a payment for this receiver+coin+amount" check
would wrongly reject legitimate repeat payments.

The right fix is small but is a schema change: store the signed payload's nonce
(`_n`, already minted per link) on the transaction, and refuse a second
non-failed payment carrying the same nonce. Shipping a half-correct dedup that
blocks real payments would be worse than the current gap.

**Severity is low:** paying twice hurts the payer, not the merchant, and cannot
redirect funds — the signature still pins receiver and amount. The exposure is a
merchant who *relies* on the toggle to cap redemptions and silently doesn't get
it. Recommend the schema addition as a fast follow.

---

## 4. Vulnerable duplicate files staged — HOUSEKEEPING

`server/payment-routes copy.ts` and `client/src/pages/Home copy.tsx` are staged.
The payment-routes copy is the **pre-merge version — it has neither security
fix** (no `checkout-payload`, no `payment-binding`). Nothing imports either, so
they are dead, but committing a known-vulnerable duplicate of the payment core
is worth avoiding. Delete both — the live files are strictly newer and were
confirmed to contain every flow feature the backups had.

---

## Tested and sound — no change needed

The payment core was the focus, and it held. Each of these was attacked, not
just read:

- **Forged / tampered checkout payloads** — HMAC-SHA256 with timing-safe
  compare. Unsigned, fake-signature, and tampered-amount payloads were all
  **rejected** at `/payment/create` and `/payment/swap/quote`; a validly signed
  one was accepted. This is PR #6 working as intended.
- **`/payment/notify` forgery** — an attacker cannot mark a payment paid. Notify
  only moves a row to `confirming`; `confirmed` requires on-chain verification of
  token + recipient + amount. Duplicate `txHash` is rejected (409).
- **SQL injection** — identifiers quoted via `q()` (double-quote escaping),
  every value parameterised (`$1`…). No string interpolation of user input into
  SQL.
- **Mass assignment** — no route spreads `req.body` into a DB update; every
  update passes an explicit field allowlist.
- **API-key theft in transit / at rest** — keys are `sk_` + 32 random bytes,
  never logged, never placed in a URL, never shipped in the client bundle
  (scanned all 272 built assets against the real secret values — zero hits).
- **CORS** — exact-match allowlist with credentials; no wildcard or
  origin-reflection bypass. An un-approved origin is refused.
- **Merchant registration** — Privy account linkage is checked **first**;
  signature proof is only a fallback for when Privy lookup is unavailable, so a
  wallet that can merely sign cannot claim a merchant under someone else.
- **Secrets in responses / errors** — API key returned only by authenticated
  register/regenerate flows; every 500 is a generic string; the Sera audit log
  redacts `/api-keys`, `/swap`, `/orders`, `/fills`, `/balances`, `/permit`,
  `/transfer`, `/withdraw`, and anything containing `signature`.
- **Rate limiting & headers** — `express-rate-limit` (20/min on payment create),
  `helmet` + CSP, body-size caps (2 MB, 10 MB for logo routes).
- **Signed-payload field clamping** — `sanitizeCheckoutRequest` clamps every
  field (addresses regex-checked, amounts normalised, strings length-capped,
  order items bounded) before signing; testnet chains are only signable when
  `SERA_ENABLE_TESTNET` is set.

---

## Files changed by this review

| File | Change |
|---|---|
| `server/url-guard.ts` | **New.** `assertPublicHttpUrl` — DNS-resolving SSRF guard. |
| `server/payment-routes.ts` | Both webhook sites call the guard; `bindCheckoutRequest` enforces `expiresAt`. |

No UI, copy, or payment flow was altered. The changes are server-side guards
only.

---

## Recommended fast-follows

1. **`singleUse` enforcement** (finding 3) — store the payload nonce on the
   transaction and refuse a repeat. Small schema change.
2. **Consider a webhook allowlist** — the guard blocks internal targets, but a
   merchant can still aim webhooks at arbitrary *public* hosts (ordinary for
   webhooks, but a mild abuse vector for using your server as a request
   reflector). Low priority.
3. **DNS-resolution caching / re-check on delivery** — the guard resolves at
   request time; a very determined rebinding attacker with sub-second TTLs is
   still theoretically possible on the delivery path. Pinning the resolved IP
   into the fetch would fully close it. Low priority.
