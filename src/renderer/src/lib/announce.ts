/** Screen-reader announcements via two live regions mounted once in AppShell. */
let last = '';
export function announce(message: string, politeness: 'polite' | 'assertive' = 'polite'): void {
  const el = document.getElementById(politeness === 'polite' ? 'bt-status' : 'bt-alert');
  if (!el) return;
  // Repeated identical messages must re-announce: clear, then set after a tick.
  el.textContent = '';
  const text = message === last ? `${message}${String.fromCharCode(160)}` : message;
  last = message;
  setTimeout(() => { el.textContent = text; }, 50);
}
