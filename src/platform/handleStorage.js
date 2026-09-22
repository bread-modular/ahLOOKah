// Structured-clone handles belong in IndexedDB, never JSON/localStorage.
export function createHandleStorage(database) {
  return async function storage(key, value) {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(database, 1);
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
  };
}
