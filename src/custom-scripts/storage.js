// Structured-clone handles belong in IndexedDB, never JSON/localStorage.
export async function scriptStorage(key, value) {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('viz2-custom-scripts', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('state');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('state', arguments.length > 1 ? 'readwrite' : 'readonly');
      const store = tx.objectStore('state');
      const request = arguments.length > 1 ? store.put(value, key) : store.get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
  } finally { db.close(); }
}
export function supportError() {
  if (!globalThis.isSecureContext) return 'Use HTTPS or localhost to choose a scripts folder.';
  if (typeof globalThis.showDirectoryPicker !== 'function') return 'Custom Scripts requires desktop Chrome with File System Access. No upload fallback is used.';
  return '';
}
export function starterScript(id, name) {
  return `// Trusted JavaScript. Edit this real file, save, then click Reload.\napi.requireVersion(1);\napi.create({\n  id: ${JSON.stringify(id)},\n  name: ${JSON.stringify(name)},\n  params: [{ key: 'size', label: 'Size', min: 10, max: 300, step: 1, default: 100 }],\n  draw({ p, params }) {\n    p.background(10);\n    p.noStroke();\n    p.fill(90, 210, 255);\n    p.circle(p.width / 2, p.height / 2, params.size);\n  }\n});\n`;
}
