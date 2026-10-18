// The game's keys belong to the game unless a text field of the page has the focus.

/** True when the event comes from a field the player is typing in. */
export function isTyping(e: { target: EventTarget | null }): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!t?.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  // A slider or a checkbox has no text to type in.
  return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'file'].includes(t.type ?? '');
}
