const rawClientId = import.meta.env.VITE_PRIVY_CLIENT_ID || "";
// Trimmed: a trailing space or newline pasted into .env would otherwise be sent
// to the relay as part of the project id and rejected as unknown.
const rawWalletConnectProjectId = String(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "").trim();

export const privyConfig = {
  appId: import.meta.env.VITE_PRIVY_APP_ID || "",
  clientId: import.meta.env.DEV && import.meta.env.VITE_PRIVY_USE_CLIENT_ID_IN_DEV !== "true" ? "" : rawClientId,
  /**
   * OPTIONAL override for the WalletConnect project the QR relay attributes
   * pairings to. Privy resolves it as
   *
   *   this value  ??  the Privy dashboard's project id  ??  a default in the SDK
   *
   * Leave it EMPTY unless you have a specific reason. This app's Privy dashboard
   * value is null, so pairings ride the SDK default — and that is fine:
   * wallet.sera.cx runs the *same* Privy app on the same SDK default, which
   * rules the shared project out as the cause of the OKX failure. Privy's
   * React SDK 3.37.0 specifically fixed OKX mobile WalletConnect logins whose
   * registry universal link failed when the pairing URI was appended. Keep
   * @privy-io/react-auth at 3.37.0 or newer (see package.json).
   *
   * Only set VITE_WALLETCONNECT_PROJECT_ID if you want pairing analytics under
   * your own Reown project (https://cloud.reown.com). It is a VITE_ var, so it
   * is baked in at build time — rebuild, don't just restart.
   */
  walletConnectCloudProjectId: rawWalletConnectProjectId,
};

/*
  Only complain about a value that is present but malformed — a wrong id WOULD
  break pairing, whereas an empty one is the normal, working configuration.
  Reown project ids are 32 hex characters.
*/
if (
  typeof console !== "undefined" &&
  privyConfig.walletConnectCloudProjectId &&
  !/^[0-9a-f]{32}$/i.test(privyConfig.walletConnectCloudProjectId)
) {
  console.warn(
    `[privy] VITE_WALLETCONNECT_PROJECT_ID is set but does not look like a Reown project id (expected 32 hex chars, got ${privyConfig.walletConnectCloudProjectId.length}) — the relay will reject it and QR wallet logins will fail. Unset it to use Privy's default.`,
  );
}

export function isPrivyConfigured() {
  return Boolean(privyConfig.appId);
}

export function getPrivyConfigError() {
  if (!privyConfig.appId) return "Missing VITE_PRIVY_APP_ID.";
  return null;
}
