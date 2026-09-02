# Low-Asset Token Fix — Working Log

Living document. Every attempt gets recorded here with its result. **Never retry
anything already marked FAILED.** Add new attempts to the bottom of §3.

---

## 1. THE GOAL

> A customer holding a low-liquidity stablecoin (MYRT, IDRT, …) scans the merchant's
> QR with their normal wallet app and pays — the wallet **recognises the token**
> and **shows the amount the merchant set**.

Concretely, all of these must be true:

| # | Requirement |
|---|---|
| G1 | Wallet **recognises** the token. Never "No MYRT added to your wallet". |
| G2 | The **merchant's preset amount** is carried. Customer does not type it. |
| G3 | The **correct token** is paid. Never a substituted or defaulted coin. |
| G4 | Works by **scanning the QR directly** in the wallet app. |
| G5 | Target wallets: **OKX and Binance first**. MetaMask is not the audience. |

### Explicitly NOT acceptable (already rejected)

- Redirecting the scan to a web checkout page instead of paying in-wallet.
- Any flow where the wallet defaults to a different token (ask 1 → pay 3).
- Dropping the preset amount to gain recognition, or vice versa.
- Adding explanatory captions, warning boxes or UI to the approved design to
  paper over a failure. **Design is boss-approved — do not modify it.**

---

## 2. VERIFIED FACTS

Do not re-investigate these. All confirmed against live sources.

| Fact | Evidence |
|---|---|
| **MYRT is already in OKX's catalog** — identical flags to XSGD which works: `isDefault=1, isSubscribe=1, isAuth=1, isCustomToken=0, displayToken=true` | `GET web3.okx.com/priapi/v1/dx/trade/multi/tokens/single/search?chainId=1&inputContent=0x3fc98a…` |
| Only difference vs XSGD is **market data**: MYRT liquidity **$14.99**, tag `lowLiquidity` · XSGD **$58,946**, tag `communityRecognized` | same endpoint |
| OKX's **own** Receive QR is `ethereum:<address>` — no token, no amount, no `@chainId` | decompiled OKX extension: `` const r = `ethereum:${l}` `` |
| **No EIP-681 parsing code** found anywhere in the OKX extension bundle | decompiled extension, full-text search |
| OKX's refusal **names the token** ("No MYRT…") → the mobile app *does* resolve the contract | user device test |
| OKX add-token state is **server-side per user** (`POST /tokenAdd` with `userUniqueId`); gate is `!selected && !isCustomToken && !isSubscribe` | decompiled extension |
| Sera registry uses **canonical** contract addresses (IDRT/BRZ/CADC/XSGD all match CoinGecko) — no wrapped-token bug | CoinGecko contract API |
| SeraPay's emitted URI is **byte-identical** to the format verified payable in MetaMask | local `buildWalletPaymentUri` vs MetaMask source |
| MetaMask Mobile builds transfer calldata from EIP-681 with **no catalog lookup** — payable for unlisted tokens | `metamask-mobile@e0901fa` `handleEthereumUrl.ts`, `deeplink.ts` |
| **No ERC/EIP/CAIP embeds token metadata in a scannable QR** — none exists in any status | full ERC index sweep |

---

## 3. ATTEMPTS

### ❌ A1 — EIP-681 URI variants (30+)
Checksummed addresses, no chain, hex chain, `pay-` prefix, reversed params,
scientific notation, `value=`, gas hints.
**Result:** OKX refuses every variant for uncatalogued tokens.
**Reason:** The gate is not URI syntax. *(Tested by owner pre-project.)*

### ❌ A2 — Embed symbol/decimals in the QR
**Result:** Impossible. No ERC defines it; the 2018 AddToken-URI PR died unmerged.
**Reason:** EIP-681 grammar has no metadata field, and EIP-747's security model
shows wallets would distrust QR-supplied metadata anyway.

### ❌ A3 — Pre-add token / hold token, then scan
**Result:** ZARP refused **while held and visible** in the wallet.
**Reason:** Holdings list ≠ scanner's list. *(Measured, recorded in repo.)*

### ❌ A4 — ERC-7811 `wallet_getAssets`
**Result:** Irrelevant to scanning.
**Reason:** Page↔wallet RPC. A camera scan involves no page.

### ❌ A5 — Recipient-only QR `ethereum:0xMERCHANT@1`
**Result:** OKX opened Send defaulted to **USDG**; another wallet errored
*"Network with chain ID 1 not found"*; MetaMask defaulted to ETH.
**Reason:** Names no token → each wallet guesses. Violates **G2** and **G3**.
**Reverted.**

### ❌ A6 — Route unlisted tokens to the web checkout link
**Result:** Rejected by owner.
**Reason:** Violates **G4**. Not the product.

### ❌ A7 — Token-list submissions (Trust / Uniswap / CoinGecko / 1inch)
**Result:** Invalidated before submission.
**Reason:** MYRT is **already** in OKX's catalog with XSGD's exact flags — the
listing theory targeted the wrong gate entirely. Generated packages deleted.

### ❌ A8 — Canonical vs wrapped address theory
**Result:** Disproven. Sera addresses match CoinGecko canonical.

### ❌ A9 — CAIP-358 / WalletConnect Pay
**Result:** Cannot carry these tokens, ever.
**Reason:** Curated fixed token list; docs state merchants cannot request
arbitrary ERC-20s.

### ❌ A10 — ERC-7856 `cspr://`
**Result:** No wallet recognises the scheme.

### ⚠️ A11 — Contract-address helper row on the QR page
**Result:** Removed at owner's instruction.
**Reason:** Modified approved design. **Do not re-add UI.**

### ✅ A12 — MetaMask Mobile, current QR
**Result:** WORKS — source-verified payable, prefilled, no catalog lookup.
**Limitation:** Wrong audience (**G5**). Keep as-is; do not break it.

---

## 4. OPEN CANDIDATES — not yet tested

| ID | Candidate | Test | Blocks on |
|---|---|---|---|
| **C1** | Add MYRT to the OKX **asset list** (Asset Management → search by contract), then scan the normal QR | 20 min on device | owner device test |
| **C2** | **Liquidity threshold** — does raising the MYRT pool above some bar flip `lowLiquidity` → unlock the scanner? Only measured difference vs working tokens. | raise pool depth, re-query OKX API | Sera / market maker |
| **C3** | OKX **mobile** vs extension EIP-681 handling — refusal names the token, so mobile parses more than the extension does | decompile OKX Android APK | research |
| **C4** | Per-wallet native grammars: Trust `link.trustwallet.com/send?asset=c60_t0x…`, Bitget `bkcode.vip?action=send&contract=…`, TokenPocket `tpoutside://` (carries symbol+decimals **in the QR**) | device tests | owner device test |
| **C5** | Binance Web3 Wallet — no documented deeplink; behaviour unknown | device test | owner device test |

**C2 is the strongest untested lead**: it is the *only* measured difference
between MYRT (refused) and XSGD (works).

---

## 5. RULES FOR THIS WORK

1. Never retry a ❌ attempt.
2. Never modify the approved UI/design to work around a failure.
3. Never add captions, banners or explanatory copy.
4. Record every new attempt in §3 with its result and reason before moving on.
5. If something cannot be fixed, log it — do not substitute a different feature.

---

*Last updated: 2 Sep 2026*
