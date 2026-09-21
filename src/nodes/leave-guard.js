// One confirmation copy for abandoning an in-memory graph draft. Back to Main,
// replacing the open graph, and Reload from Disk all use this single guard so a
// dirty graph can never be silently dropped.
export const DISCARD_MESSAGE = 'Discard unsaved changes to this draft?';

export function confirmDiscard() {
  return window.confirm(DISCARD_MESSAGE);
}
