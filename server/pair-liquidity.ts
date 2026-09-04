/**
 * Which currency pairs can actually be priced right now.
 *
 * A pair appearing in GET /markets does NOT mean it can be quoted: AUDD/USDT is
 * published with `min_ask_amount 0.2` yet POST /swap/quote answers
 * `no_liquidity` at every size. Offering such a pair in the picker only leads a
 * merchant to "Live rates unavailable" after they have already chosen it.
 *
 * So viability is measured, not assumed:
 *   - a slow background sweep probes each published market with a real quote,
 *   - and every live /api/rates call feeds its own result back in, so the map
 *     keeps improving between sweeps.
 *
 * Everything here degrades to "unknown", never to "hide": while the map is
 * cold, callers must show every token rather than hide the whole registry.
 */

import { callSeraApi, getSeraMarkets, SeraApiError, type SeraMarket } from "./sera-api";

export interface PairSnapshot {
  /** symbol -> counterpart symbols that produced a usable quote */
  pairs: Record<string, string[]>;
  checkedAt: number | null;
  /** false while the first sweep is still running */
  complete: boolean;
}

const REFRESH_MS = 6 * 60 * 60 * 1000;

/*
  Off unless explicitly switched on.

  The sweep asks Sera for a real quote on every published market, which is a lot
  of requests against a shared rate limit for a map that only decides which
  tokens to grey out. Left running automatically it managed to get this IP
  429'd by Cloudflare, and a 429 does not stay contained: /tokens and /rates
  fail with it too, so the whole picker empties out. Hiding a few dead pairs is
  not worth risking that, so the sweep stays off until someone turns it on
  deliberately with SERA_PAIR_SWEEP=true and watches what it does.
*/
const SWEEP_ENABLED = process.env.SERA_PAIR_SWEEP === "true";

/*
  Sera documents 5 req/s for trade endpoints. The gap used to sit between
  markets rather than between requests, while each market could fire two
  quotes (one per direction) — so two workers actually issued closer to eight
  requests a second, above the published limit rather than below it. One
  request at a time, spaced, keeps the real rate near 3/s with no arithmetic to
  get wrong.
*/
const PROBE_CONCURRENCY = 1;
const PROBE_GAP_MS = 320;

/** Long enough that a rate-limited sweep cannot immediately start another. */
const RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

let lastRequestAt = 0;
async function throttle() {
  const wait = PROBE_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/** Raised to unwind the sweep the moment Sera starts refusing us. */
class RateLimited extends Error {}

const viable = new Map<string, Set<string>>();
const dead = new Map<string, Set<string>>();
let checkedAt: number | null = null;
let complete = false;
let sweeping = false;

function keyOf(symbol: string): string {
  return String(symbol || "").trim().toUpperCase();
}

function record(map: Map<string, Set<string>>, a: string, b: string) {
  const from = keyOf(a);
  const to = keyOf(b);
  if (!from || !to) return;
  if (!map.has(from)) map.set(from, new Set());
  map.get(from)!.add(to);
}

function forget(map: Map<string, Set<string>>, a: string, b: string) {
  map.get(keyOf(a))?.delete(keyOf(b));
}

/**
 * Feedback from a real pricing attempt. Cheap, and it corrects the map the
 * moment reality diverges from the last sweep.
 */
export function notePairResult(from: string, to: string, priceable: boolean) {
  if (priceable) {
    record(viable, from, to);
    record(viable, to, from);
    forget(dead, from, to);
    forget(dead, to, from);
    return;
  }
  record(dead, from, to);
  record(dead, to, from);
  forget(viable, from, to);
  forget(viable, to, from);
}

export function getPairSnapshot(): PairSnapshot {
  const pairs: Record<string, string[]> = {};
  for (const [from, counterparts] of viable) {
    const usable = Array.from(counterparts).filter((to) => !dead.get(from)?.has(to));
    if (usable.length) pairs[from] = usable.sort();
  }
  return { pairs, checkedAt, complete };
}

async function probeQuote(market: SeraMarket, seraClockOffsetSec: number, baseUrl?: string): Promise<boolean> {
  // Derive the deadline per probe. A sweep runs for minutes, so a timestamp
  // captured once at the start goes stale mid-sweep and every later quote is
  // rejected for an expired deadline — which reads identically to "no
  // liquidity" and would mark the whole registry dead.
  const seraNowSec = Math.floor(Date.now() / 1000) + seraClockOffsetSec;
  const attempt = async (fromAddress: string, toAddress: string, amountRaw: string) => {
    await throttle();
    try {
      const raw = await callSeraApi<any>({
        baseUrl,
        path: "/swap/quote",
        method: "POST",
        authMode: "none",
        timeoutMs: 12_000,
        body: {
          from_token: fromAddress,
          to_token: toAddress,
          from_amount: amountRaw,
          owner_address: "0x0000000000000000000000000000000000000001",
          recipient: "0x0000000000000000000000000000000000000001",
          expiration: seraNowSec + 180,
          gas_mode: "pay_more",
        },
      });
      const quote = raw?.quote ?? raw;
      const routeParams = quote?.route_params ?? quote?.routeParams;
      const output = routeParams?.minOutputAmount;
      return Boolean(output) && BigInt(String(output)) > 0n;
    } catch (error) {
      // A 429 says nothing about this pair, only about how fast we are asking.
      // Treating it as "no liquidity" would mark the registry dead wholesale.
      if (error instanceof SeraApiError && (error.status === 429 || error.status === 403)) {
        throw new RateLimited(`Sera rate limited the liquidity sweep (${error.status})`);
      }
      return false;
    }
  };

  const askRaw = String(market.min_ask_amount_raw || "0");
  const bidRaw = String(market.min_bid_quote_amount_raw || "0");
  if (askRaw !== "0" && await attempt(market.base_address, market.quote_address, askRaw)) return true;
  if (bidRaw !== "0" && await attempt(market.quote_address, market.base_address, bidRaw)) return true;
  return false;
}

async function sweep(baseUrl?: string) {
  if (sweeping) return;
  sweeping = true;
  try {
    const [{ markets }, timeResponse] = await Promise.all([
      getSeraMarkets(baseUrl),
      callSeraApi<{ timestamp?: number }>({ baseUrl, path: "/system/time", authMode: "none" }),
    ]);
    const seraNowSec = Number(timeResponse?.timestamp);
    if (!Array.isArray(markets) || !Number.isInteger(seraNowSec)) return;
    const seraClockOffsetSec = seraNowSec - Math.floor(Date.now() / 1000);

    const queue = markets.filter((market) => market?.base_symbol && market?.quote_symbol);
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const market = queue[cursor++];
        const priceable = await probeQuote(market, seraClockOffsetSec, baseUrl);
        notePairResult(market.base_symbol, market.quote_symbol, priceable);
      }
    };

    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
    checkedAt = Date.now();
    complete = true;
  } catch (error) {
    // A failed sweep leaves the previous map in place. Never clear it: a stale
    // map is far better than hiding every token because Sera blipped.
    if (error instanceof RateLimited) {
      // Stand well back rather than retrying into the limit.
      checkedAt = Date.now() - REFRESH_MS + RATE_LIMIT_BACKOFF_MS;
      console.warn("[pair-liquidity] sweep stopped", { reason: error.message });
    }
  } finally {
    sweeping = false;
  }
}

export function refreshPairLiquidity(baseUrl?: string) {
  // The flag has to gate the work itself, not just the background timer.
  // GET /api/sera/pairs calls this on demand and the currency picker hits that
  // route on every page load — so with the check only on the timer, the sweep
  // this flag exists to hold back ran anyway, from the first visitor.
  if (!SWEEP_ENABLED) return;
  if (checkedAt !== null && Date.now() - checkedAt < REFRESH_MS) return;
  void sweep(baseUrl);
}

// Warm in the background so the first merchant of the day already gets a map.
// Delayed so it never competes with server start-up.
if (SWEEP_ENABLED && process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  const timer = setTimeout(() => refreshPairLiquidity(), 20_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  const interval = setInterval(() => refreshPairLiquidity(), REFRESH_MS);
  if (typeof interval === "object" && "unref" in interval) interval.unref();
}
