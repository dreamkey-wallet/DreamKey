/** Let a pending loading state reach the native UI before synchronous crypto. */
export function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => { setTimeout(resolve, 0); });
  });
}
