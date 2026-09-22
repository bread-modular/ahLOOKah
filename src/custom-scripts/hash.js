// Fingerprint of a script source: SHA-256 of the exact text.
//
// A project file records one fingerprint per script file instead of the code
// itself. On Open Project that answers "is this still the code the project was
// saved with?" — the same text loads on its own, an edited file does not and
// falls back to the explicit OPEN gesture.
export async function sourceHash(text) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof text !== 'string') return null;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // No secure context / no SubtleCrypto: no fingerprint, so nothing can be
    // matched by content and every file keeps the explicit OPEN.
    return null;
  }
}
