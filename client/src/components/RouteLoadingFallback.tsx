/**
 * The one standard loading screen. Also shown while the merchant workspace is
 * being prepared after sign-in — management's call: no separate "Preparing
 * Your Payment Page" screen there, just the normal loader. AccountSetupScreen
 * still exists for the failure case, where Retry/Disconnect are needed.
 */
export function RouteLoadingFallback() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="flex flex-col items-center text-center">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 rounded-full border-[3px] border-[#00D1A0]/15 border-t-[#00D1A0] animate-spin" />
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-[0_10px_30px_rgba(0,209,160,0.16)]">
            <img src="/icon-512.png" alt="SeraPay" className="h-9 w-9 object-contain" />
          </div>
        </div>
        <p className="mt-4 text-sm font-medium text-muted-foreground">Opening SeraPay</p>
      </div>
    </div>
  );
}
