/**
 * How a customer's wallet will *label* a token in a payment request.
 *
 * An EIP-681 URI carries only `<contract>@<chain>/transfer?address=&uint256=`.
 * There is no field for the symbol or decimals, so a wallet has to work out the
 * asset's name by itself. It does that from its own token list, not from the
 * QR — which is why two correct URIs can render very differently:
 *
 *   IDRT  -> "No IDRT balance"        (wallet ships IDRT in its bundled list)
 *   CNGN  -> "Unknown" / "Add a currency"  (wallet has never heard of CNGN)
 *
 * Both URIs are correct. The difference is entirely wallet-side, and it is the
 * single most common support complaint from merchants, so we surface it in the
 * currency picker instead of letting them discover it at the counter.
 *
 * Tiers, in the order a wallet resolves them:
 *   universal — in a wallet's *bundled* list. Named even at zero balance.
 *   detected  — in the broad token APIs wallets use for balance auto-detection.
 *               Named once the customer actually holds it (the real-world case)
 *               or imports it by address.
 *   unlisted  — in no list anywhere. Renders as "Unknown" in every wallet, for
 *               every customer, always. These are the ones worth avoiding.
 */

export type WalletRecognition = "universal" | "detected" | "unlisted" | "unknown";

/**
 * Bundled lists ship inside the wallet binary, so they resolve offline and at
 * zero balance. MetaMask's contract-metadata is the canonical one and is also
 * vendored by several other wallets.
 */
const BUNDLED_LIST_URLS = [
  "https://raw.githubusercontent.com/MetaMask/contract-metadata/master/contract-map.json",
];

/**
 * Detection lists are fetched at runtime by the wallet and are far broader.
 * A token here gets a proper name once the account holds it.
 */
const DETECTION_LIST_URLS = [
  "https://token.api.cx.metamask.io/tokens/1",
  "https://tokens.coingecko.com/uniswap/all.json",
];

/**
 * The curated catalogs wallet SPEND lists are assembled from — a different
 * gate from the naming tiers above, and the one that decides whether a
 * scanner will let the customer PAY. Measured, not assumed: scanning the same
 * ERC-681 request, OKX pays USDC/USDT/XSGD — the tokens present in all of
 * these lists — and refuses tokens missing from any of them ("No ZARP added
 * to your wallet") even when the customer holds the token. Naming does not
 * imply spendability: a token can be named by a bundled list yet still be
 * refused at the send screen.
 *
 * Each entry lists a primary URL plus mirrors; the first that answers wins.
 */
const CURATED_SPEND_LIST_URLS: string[][] = [
  ["https://tokens.uniswap.org"],
  ["https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/tokenlist.json"],
  ["https://tokens.1inch.eth.link", "https://tokens.1inch.eth.limo"],
];

const REFRESH_MS = 12 * 60 * 60 * 1000;

interface Snapshot {
  bundled: Set<string>;
  detected: Set<string>;
  /**
   * Addresses present in EVERY curated spend catalog — the measured predictor
   * of "a scanned request reaches a payable confirm screen". null while any
   * catalog is unreachable: a partial fetch would demote well-supported tokens
   * for no reason, so no data beats wrong data.
   */
  spendable: Set<string> | null;
  fetchedAt: number;
}

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot | null> | null = null;

function addressesFrom(payload: unknown): string[] {
  // contract-map.json is an object keyed by address; token lists are either a
  // bare array or { tokens: [...] }.
  if (Array.isArray(payload)) {
    return payload.map((entry) => String((entry as { address?: string })?.address ?? ""));
  }
  if (payload && typeof payload === "object") {
    const tokens = (payload as { tokens?: unknown }).tokens;
    if (Array.isArray(tokens)) {
      return tokens
        .filter((entry) => {
          const chainId = (entry as { chainId?: number })?.chainId;
          return chainId === undefined || chainId === 1;
        })
        .map((entry) => String((entry as { address?: string })?.address ?? ""));
    }
    return Object.keys(payload as Record<string, unknown>);
  }
  return [];
}

async function fetchList(url: string): Promise<string[]> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return [];
    return addressesFrom(await response.json());
  } catch {
    // A list being unreachable must never take the currency picker down; the
    // caller degrades to "unknown" and the picker simply shows no badge.
    return [];
  }
}

async function fetchListWithMirrors(urls: string[]): Promise<string[]> {
  for (const url of urls) {
    const addresses = await fetchList(url);
    if (addresses.length > 0) return addresses;
  }
  return [];
}

async function loadSnapshot(): Promise<Snapshot | null> {
  const [bundledLists, detectionLists, curatedLists] = await Promise.all([
    Promise.all(BUNDLED_LIST_URLS.map(fetchList)),
    Promise.all(DETECTION_LIST_URLS.map(fetchList)),
    Promise.all(CURATED_SPEND_LIST_URLS.map(fetchListWithMirrors)),
  ]);

  const bundled = new Set<string>();
  for (const list of bundledLists) {
    for (const address of list) {
      if (address) bundled.add(address.toLowerCase());
    }
  }
  const detected = new Set<string>();
  for (const list of detectionLists) {
    for (const address of list) {
      if (address) detected.add(address.toLowerCase());
    }
  }

  // Spendability demands every catalog: intersection over a missing list would
  // mark genuinely supported tokens unpayable, so an incomplete fetch yields
  // "unknown" instead.
  let spendable: Set<string> | null = null;
  if (curatedLists.every((list) => list.length > 0)) {
    const sets = curatedLists.map((list) => new Set(list.filter(Boolean).map((address) => address.toLowerCase())));
    spendable = new Set(Array.from(sets[0]).filter((address) => sets.every((set) => set.has(address))));
  }

  // Every source failed — treat as no data rather than declaring the whole
  // registry "unlisted", which would wrongly warn merchants off every currency.
  if (bundled.size === 0 && detected.size === 0) return null;
  return { bundled, detected, spendable, fetchedAt: Date.now() };
}

function refresh(): Promise<Snapshot | null> {
  if (!inflight) {
    inflight = loadSnapshot()
      .then((next) => {
        if (next) snapshot = next;
        return snapshot;
      })
      .catch(() => snapshot)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Returns a lookup for the given chain. Only Ethereum mainnet is meaningful —
 * no wallet ships a token list for a testnet, which is itself a reason test-mode
 * QRs always render as "Unknown".
 */
export async function getWalletRecognition(chainId: number): Promise<(address: string) => WalletRecognition> {
  if (chainId !== 1) return () => "unknown";

  const stale = !snapshot || Date.now() - snapshot.fetchedAt > REFRESH_MS;
  // Never await. This runs inside GET /sera/tokens, which the currency picker
  // blocks on — if that endpoint stalls, no merchant can take a payment at all.
  // A cosmetic badge must never be able to do that, so a cold cache simply
  // yields "unknown" (no badge) and the warmed data appears on a later request.
  if (stale) void refresh();

  const current = snapshot;
  if (!current) return () => "unknown";
  return classifierFor(current);
}

/**
 * Whether a catalog-gated wallet scanner is known to let the customer SPEND
 * this token from a scanned request. Same never-await contract as the
 * recognition lookup above. Returns null when unproven — callers must treat
 * null as "route around the scanner", never as approval.
 */
export async function getWalletScanPayability(chainId: number): Promise<(address: string) => boolean | null> {
  if (chainId !== 1) return () => null;

  const stale = !snapshot || Date.now() - snapshot.fetchedAt > REFRESH_MS;
  if (stale) void refresh();

  const spendable = snapshot?.spendable;
  if (!spendable) return () => null;
  return (address: string) => spendable.has(String(address || "").toLowerCase());
}

function classifierFor(current: Snapshot) {
  return (address: string): WalletRecognition => {
    const key = String(address || "").toLowerCase();
    if (current.bundled.has(key)) return "universal";
    if (current.detected.has(key)) return "detected";
    return "unlisted";
  };
}

// Start fetching as the server boots so the very first currency picker already
// carries badges, instead of the first merchant of the day paying the cold-start
// cost and seeing none. Fire-and-forget: failure is already handled downstream.
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  refresh().catch(() => undefined);
}
