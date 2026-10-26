/** Invalidates asynchronous authentication results when the wallet leaves the foreground. */
export class WalletSessionGuard {
  private generation = 0;
  private foreground = true;
  private readonly cleanups = new Set<() => void>();

  capture(): number { return this.generation; }
  isCurrent(generation: number): boolean { return this.foreground && generation === this.generation; }
  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new Error('Wallet session has expired');
  }
  onInvalidate(cleanup: () => void): () => void {
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }
  invalidate(): void {
    this.generation += 1;
    const cleanups = [...this.cleanups]; this.cleanups.clear();
    for (const cleanup of cleanups) { try { cleanup(); } catch { /* Continue clearing other wallet resources. */ } }
  }
  setForeground(foreground: boolean): void {
    // Leaving the foreground is not a wallet lock, but any authentication
    // started before the transition must be rejected when it resolves later.
    // Incrementing the generation keeps the wallet available after resume
    // while preventing stale biometric/password results from being committed.
    if (this.foreground && !foreground) this.generation += 1;
    this.foreground = foreground;
  }
}
