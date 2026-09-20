import { assertFolderReference, confirmFolderReference, missingFolderFiles, referencedFileId, folderReference } from '../platform/folderReferences.js';
import { chooseFolder, requireFolderPermission as permission, scanFolder, linkedFile } from '../platform/folderAccess.js';
import { parseGraph, serializeGraph } from './portability.js';
import { validateGraph, MAX_BYTES } from './model.js';
import { createHandleStorage } from '../platform/handleStorage.js';

export const SUFFIX = '.nodes.json';
const CHANNEL = 'viz2-nodes-disk';
const storage = createHandleStorage('viz2-node-patterns');
const empty = () => ({ folder: null, opened: [] });
const lock = fn => navigator.locks ? navigator.locks.request(CHANNEL, fn) : Promise.reject(new Error('Node pattern writes require Web Locks in desktop Chrome.'));
async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function nodeFileId(folderId, name) { return `nodes-${(await digest(folderId + '/' + name)).slice(0, 40)}`; }
async function read(handle) {
  const file = await handle.getFile();
  if (file.size > MAX_BYTES) throw new Error('Pattern exceeds 200 KB');
  const text = await file.text();
  const data = parseGraph(text);
  validateGraph(data.graph, { complete: true });
  return { ...data, text, hash: await digest(text) };
}
export class NodePatterns {
  constructor({ store = storage } = {}) {
    this.store = store; this.records = []; this.state = empty(); this.errors = [];
    this.listeners = new Set(); this.queue = Promise.resolve(); this.channel = null;
  }
  notify() { for (const listener of this.listeners) listener(); }
  changed() { this.channel?.postMessage({ type: 'changed' }); }
  watch(listener) {
    this.listeners.add(listener);
    if (!this.channel) {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => { this.refresh().catch(() => {}); };
      this.refresh().catch(() => {});
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.channel?.close(); this.channel = null; } };
  }
  refresh() {
    const work = this.queue.then(async () => {
      const records = [], errors = [];
      try {
        this.state = await this.store('handles') || empty();
        const { folder, opened } = this.state;
        assertFolderReference('nodes', folder?.handle);
        const add = async (handle, id, folderId = null) => {
          try { await permission(handle); records.push({ ...await read(handle), id, handle, fileName: handle.name, folderId }); }
          catch (e) { errors.push(`${handle.name}: ${e.message}`); }
        };
        if (folder) {
          try {
            await permission(folder.handle);
            const files = await scanFolder(folder.handle, { accepts: name => name.endsWith(SUFFIX), limit: 64, onLimit: () => errors.push('Folder limit: 64 node patterns') });
            errors.push(...missingFolderFiles('nodes', files.map(file => file.name)));
            for (const { name, handle } of files) {
              await add(handle, referencedFileId('nodes', name, true) || await nodeFileId(folder.id, name), folder.id);
            }
          } catch (e) { errors.push(e.message); }
        }
        for (const entry of opened) {
          if (records.some(r => r.id === entry.id)) continue;
          // A picker-opened file inside the linked folder is represented once.
          let duplicate = false;
          for (const r of records) if (await r.handle.isSameEntry(entry.handle)) { duplicate = true; break; }
          if (!duplicate) await add(entry.handle, entry.id);
        }
      } catch (e) { errors.push(`Storage/reconnect: ${e.message}`); }
      for (const file of folderReference('nodes')?.files || []) {
        if (!file.linked && !records.some(record => record.fileName === file.fileName)) errors.push(`${file.fileName}: Open this individual pattern again to restore access.`);
      }
      // Never revive browser content when disk is missing, invalid or inaccessible.
      if (this.state.folder && !errors.length) {
        const references = records.filter(record => record.folderId).map(record => ({ fileName: record.fileName, id: record.id, linked: true }));
        try { await lock(async () => {
          const current = await this.store('handles');
          if (current?.folder?.id === this.state.folder.id) await this.store('handles', { ...current, references });
        }); } catch (error) { errors.push(`Reference storage: ${error.message}`); }
      }
      this.records = records.sort((a, b) => a.fileName.localeCompare(b.fileName));
      this.errors = errors; this.notify();
      return this.records;
    });
    this.queue = work.catch(() => {}); return work;
  }
  async link() {
    const handle = await chooseFolder({ id: 'viz2-node-patterns', mode: 'readwrite', label: 'Node patterns' });
    assertFolderReference('nodes', handle, true);
    await lock(async () => {
      const state = await this.store('handles') || empty();
      const same = state.folder && await state.folder.handle.isSameEntry(handle);
      await this.store('handles', { folder: { handle, id: same ? state.folder.id : crypto.randomUUID() }, opened: [] });
    });
    confirmFolderReference('nodes');
    await this.refresh(); this.changed();
  }
  async unlink() {
    await lock(async () => {
      const state = await this.store('handles') || empty();
      await this.store('handles', { ...state, folder: null });
    });
    await this.refresh(); this.changed();
  }
  async reconnect() {
    // Permission calls originate in the click handler, never in a background queue.
    try {
      if (this.state.folder) await permission(this.state.folder.handle, 'read', true);
      for (const entry of this.state.opened) await permission(entry.handle, 'read', true);
    } finally { await this.refresh(); this.changed(); }
  }
  async browse() {
    const handle = this.state.folder?.handle;
    assertFolderReference('nodes', handle);
    await permission(handle, 'read', true);
    return scanFolder(handle, { accepts: name => name.endsWith(SUFFIX), limit: 64 });
  }
  async open(name) {
    let handle;
    if (this.state.folder) {
      assertFolderReference('nodes', this.state.folder.handle);
      await permission(this.state.folder.handle, 'read', true);
      handle = await linkedFile(this.state.folder.handle, name, name => name.endsWith(SUFFIX));
    } else {
      if (!globalThis.showOpenFilePicker) throw new Error('Open pattern requires desktop Chrome with File System Access.');
      [handle] = await showOpenFilePicker({ id: 'viz2-node-patterns', multiple: false, types: [{ description: 'Node pattern', accept: { 'application/json': ['.json'] } }] });
    }
    if (!handle) throw new DOMException('Canceled', 'AbortError');
    await permission(handle, 'read', true);
    await read(handle); // Validate before remembering the handle or replacing a draft.
    let id;
    await lock(async () => {
      const state = await this.store('handles') || empty();
      for (const r of this.records) if (await r.handle.isSameEntry(handle)) id = r.id;
      for (const entry of state.opened) if (await entry.handle.isSameEntry(handle)) id = entry.id;
      if (!id) {
        if (state.opened.length >= 64) throw new Error('Maximum 64 opened files. Link Folder to reset the selection.');
        id = referencedFileId('nodes', handle.name, false) || `nodes-${crypto.randomUUID()}`;
        state.opened.push({ id, handle }); await this.store('handles', state);
      }
    });
    await this.refresh(); this.changed();
    for (const record of this.records) if (await record.handle.isSameEntry(handle)) return record;
    throw new Error('Pattern became unavailable on disk. Open it again.');
  }
  async load(id) {
    const record = this.records.find(r => r.id === id);
    if (!record) throw new Error('Pattern no longer available. Refresh folder.');
    await permission(record.handle, 'read', true);
    await read(record.handle);
    await this.refresh(); this.changed();
    const latest = this.records.find(r => r.id === id);
    if (!latest) throw new Error('Pattern became unavailable on disk. Refresh folder.');
    return latest;
  }
  async save(graph, dependencies, current, confirm = globalThis.confirm) {
    validateGraph(graph, { complete: true });
    const text = serializeGraph(graph, dependencies);
    parseGraph(text);
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Pattern exceeds 200 KB');
    const folder = this.state.folder;
    assertFolderReference('nodes', folder?.handle);
    if (!folder) throw new Error('Link a node patterns folder in the main UI first.');
    if (current?.folderId && current.folderId !== folder.id) throw new Error('Linked folder changed. Reopen the pattern from the main library before saving; your draft is retained.');
    await permission(folder.handle, 'readwrite', true);
    const fileName = current?.folderId === folder.id ? current.fileName
      : (graph.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'pattern') + SUFFIX;
    const result = await lock(async () => {
      const latest = await this.store('handles');
      if (latest?.folder?.id !== folder.id) throw new Error('Linked folder changed in another tab. Refresh before saving.');
      let handle, before = null;
      try {
        handle = await folder.handle.getFileHandle(fileName);
        const file = await handle.getFile();
        if (file.size > MAX_BYTES) throw new Error('Existing destination exceeds 200 KB; choose another pattern name.');
        before = await file.text();
      }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      if (current?.folderId === folder.id && before !== current.text) throw new Error('File changed or was deleted on disk. Open it again before saving; your draft has not been changed.');
      if (before !== null && !confirm(`Replace ${fileName} on disk? This also updates the pattern in other tabs, including LIVE if selected.`)) throw new DOMException('Canceled', 'AbortError');
      if (!handle) {
        let count = 0;
        for await (const [name, entry] of folder.handle.entries()) {
          if (entry.kind === 'file' && name.endsWith(SUFFIX) && ++count >= 64) throw new Error('Folder limit: 64 node patterns. Choose another folder.');
        }
        handle = await folder.handle.getFileHandle(fileName, { create: true });
      }
      // Recheck after confirmation. Web Locks serialize cooperating same-origin tabs.
      if (before !== null && await (await handle.getFile()).text() !== before) throw new Error('File changed on disk. Open it again before saving.');
      let writer;
      try { writer = await handle.createWritable(); await writer.write(text); await writer.close(); }
      catch (e) { try { await writer?.abort(); } catch { /* Already closed */ } throw e; }
      return { ...parseGraph(text), text, hash: await digest(text), id: referencedFileId('nodes', fileName, true) || await nodeFileId(folder.id, fileName), handle, fileName, folderId: folder.id };
    });
    await this.refresh(); this.changed(); return result;
  }
}
export const nodePatterns = new NodePatterns();
export const listGraphs = () => nodePatterns.records;
export const watchGraphs = listener => nodePatterns.watch(listener);
