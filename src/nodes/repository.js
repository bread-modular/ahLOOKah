import { assertFolderReference, missingFolderFiles, referencedFileId, folderReference } from '../platform/folderReferences.js';
import { registerLinkedProjectFolder } from '../platform/project-folders.js';
import { chooseFolder, requireFolderPermission as permission, scanFolder, linkedFile } from '../platform/folderAccess.js';
import { parseGraph, serializeGraph } from './portability.js';
import { validateGraph, MAX_BYTES } from './model.js';
import { createHandleStorage } from '../platform/handleStorage.js';

export const SUFFIX = '.nodes.json';
const CHANNEL = 'viz2-nodes-disk';
const storage = createHandleStorage('viz2-node-patterns');
// `hidden` remembers patterns deleted from the library in this browser (folder
// file names, or picker-opened ids). It is a view filter, never a disk action:
// the source files stay exactly where they are.
const HIDDEN_LIMIT = 256;
// `references` is the library's own folder-file set: the patterns this browser has
// ADDED from the linked directory (file name + id), in the order the folder scan
// reports them. It — together with a saved project's own file references — is the
// only thing a scan may load: a file that merely exists in the directory is never
// pulled into the library by a refresh, exactly like Custom Scripts.
const empty = () => ({ folder: null, opened: [], hidden: [], references: [] });
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
  // Structural validation only: a pattern whose Output is not wired yet is a
  // legitimate, editable state, so it must load exactly like a finished one.
  validateGraph(data.graph);
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
  // Files this browser may load from the linked folder: what the library already
  // added (`state.references`), plus the file names a saved project expects (its
  // folder reference), plus the files a caller is adding right now (`include`, from
  // an explicit Open or Save). Name → id; null means "resolve the id as for a new
  // folder file". Nothing else in the directory is imported by a scan.
  addedFiles(include = null) {
    const added = new Map();
    for (const file of folderReference('nodes')?.files || []) {
      if (file?.linked && file.fileName && !added.has(file.fileName)) added.set(file.fileName, file.id || null);
    }
    for (const file of this.state.references || []) {
      if (file?.fileName && !added.has(file.fileName)) added.set(file.fileName, file.id || null);
    }
    for (const name of include || []) if (!added.has(name)) added.set(name, null);
    return added;
  }
  // `include` names files an explicit Open/Save is adding to the library in this
  // same pass, so the scan is allowed to load them. A plain refresh/reconnect only
  // re-reads what is already added.
  refresh({ include = null } = {}) {
    const work = this.queue.then(async () => {
      const records = [], errors = [];
      let added = null; // The gate this pass used, once the folder was scanned.
      try {
        this.state = await this.store('handles') || empty();
        const { folder, opened } = this.state;
        const hidden = this.state.hidden || [];
        assertFolderReference('nodes', folder?.handle);
        const add = async (handle, id, folderId = null) => {
          try { await permission(handle); records.push({ ...await read(handle), id, handle, fileName: handle.name, folderId }); }
          catch (e) { errors.push(`${handle.name}: ${e.message}`); }
        };
        if (folder) {
          try {
            await permission(folder.handle);
            // Resolve the files this library holds BY NAME. A directory holding more
            // unadded files than the folder cap must still reopen every pattern a
            // project recorded, so no whole-folder listing is involved here (the
            // picker lists the directory; a scan would be capped at 64 files).
            added = this.addedFiles(include);
            const present = [];
            for (const [name, id] of added.entries()) {
              let handle;
              try { handle = await folder.handle.getFileHandle(name); await handle.getFile(); }
              catch { continue; } // Absent or not readable as a file: reported below.
              present.push(name);
              if (hidden.includes(name)) continue;
              await add(handle, id || referencedFileId('nodes', name, true) || await nodeFileId(folder.id, name), folder.id);
            }
            errors.push(...missingFolderFiles('nodes', present));
          } catch (e) { added = null; errors.push(e.message); }
        }
        for (const entry of opened) {
          // A deleted folder pattern is remembered by file name, because that is
          // all the folder scan yields; the same rule retires any stale opened
          // entry for that file so a delete cannot be undone by bookkeeping.
          if (hidden.includes(entry.id) || hidden.includes(entry.handle?.name)) continue;
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
      // Persist the library's folder-file set: everything that loaded, plus any entry
      // the gate still expects but could not be read this pass (missing, corrupt or
      // permission-lapsed), so a restored file comes back and a just-added one is not
      // lost. A failed scan keeps the previous set instead of an empty one.
      if (this.state.folder && added) {
        const library = records.filter(record => record.folderId).map(record => ({ fileName: record.fileName, id: record.id, linked: true }));
        const names = new Set(library.map(entry => entry.fileName));
        const expected = [...added.entries()]
          .filter(([name]) => !names.has(name) && !(this.state.hidden || []).includes(name))
          .map(([fileName, id]) => ({ fileName, linked: true, ...(id ? { id } : {}) }));
        const references = [...library, ...expected];
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
    // An unresolved import requires its expected name; an ordinary relink may
    // deliberately choose a differently named directory instead.
    if (folderReference('nodes')?.needsRelink) assertFolderReference('nodes', handle, true);
    let folderId = null;
    let previousHandle = null;
    await lock(async () => {
      const state = await this.store('handles') || empty();
      previousHandle = state.folder?.handle || null;
      const same = state.folder && await state.folder.handle.isSameEntry(handle);
      // Relinking is an explicit reset: a new directory always gets a new folder id,
      // which retires drafts opened from the previous one ("Linked folder changed"),
      // and file references from another directory can never follow a same-named
      // link. The same directory keeps the library as it is. Either way, linking does
      // NOT list the folder: patterns are added with OPEN (or brought back by their
      // project's own file references).
      folderId = same ? state.folder.id : crypto.randomUUID();
      await this.store('handles', {
        folder: { handle, id: folderId },
        opened: [],
        hidden: same ? (state.hidden || []) : [],
        references: same ? (state.references || []) : [],
      });
    });
    // Remember the directory without changing an older project's identity.
    await registerLinkedProjectFolder('nodes', handle, previousHandle);
    await this.refresh(); this.changed();
  }
  async unlink() {
    await lock(async () => {
      const state = await this.store('handles') || empty();
      await this.store('handles', { ...state, folder: null });
    });
    await this.refresh(); this.changed();
  }
  // New Project is not ordinary Unlink: discard individually opened handles,
  // hidden names and the library's folder-file references along with the folder.
  // The separate remembered-directory registry survives for older project files.
  async resetProject() {
    await lock(async () => {
      await this.store('handles', empty());
      const saved = await this.store('handles');
      if (!saved || saved.folder || !Array.isArray(saved.opened) || saved.opened.length ||
        !Array.isArray(saved.hidden) || saved.hidden.length || saved.references?.length) {
        throw new Error('Node project reset was not persisted.');
      }
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
    const folder = this.state.folder;
    if (folder) {
      assertFolderReference('nodes', folder.handle);
      await permission(folder.handle, 'read', true);
      handle = await linkedFile(folder.handle, name, name => name.endsWith(SUFFIX));
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
      // Opening a deleted pattern explicitly is how it returns to the library.
      state.hidden = (state.hidden || []).filter(value => value !== handle.name);
      for (const r of this.records) if (await r.handle.isSameEntry(handle)) id = r.id;
      for (const entry of state.opened) if (await entry.handle.isSameEntry(handle)) id = entry.id;
      if (!id) {
        // A file inside the linked folder is represented by the folder scan, so
        // it needs no opened entry (and never consumes one of those 64 slots).
        // Folder read permission is already granted above, so that scan sees it.
        if (folder) id = referencedFileId('nodes', handle.name, true) || await nodeFileId(folder.id, handle.name);
        else {
          if (state.opened.length >= 64) throw new Error('Maximum 64 opened files. Link Folder to reset the selection.');
          id = referencedFileId('nodes', handle.name, false) || `nodes-${crypto.randomUUID()}`;
          state.opened.push({ id, handle });
        }
      }
      // One write covers both the opened entry and any hidden-name restore.
      await this.store('handles', state);
    });
    await this.refresh({ include: [handle.name] }); this.changed();
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
    // Connectivity is deliberately NOT required: an unconnected Output is a
    // work-in-progress pattern, not an invalid file. Structural validation and
    // the dependency/script diagnostics in the editor still gate the write.
    validateGraph(graph);
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
      // Writing this name makes it part of the library again, even if the same
      // file was deleted from the library earlier in this browser.
      if ((latest?.hidden || []).includes(fileName)) await this.store('handles', { ...latest, hidden: latest.hidden.filter(value => value !== fileName) });
      return { ...parseGraph(text), text, hash: await digest(text), id: referencedFileId('nodes', fileName, true) || await nodeFileId(folder.id, fileName), handle, fileName, folderId: folder.id };
    });
    await this.refresh({ include: [fileName] }); this.changed(); return result;
  }
  // Delete removes the pattern from this browser's library and writes nothing:
  // the .nodes.json file, its contents and its disk location are untouched. A
  // folder-linked file is forgotten here (and remembered as hidden, so a project
  // that still lists it cannot silently re-add it); a picker-opened file simply
  // leaves the opened list. `open()` restores either one.
  async remove(id) {
    const record = this.records.find(r => r.id === id);
    if (!record) throw new Error('Pattern no longer available. Refresh the folder.');
    await lock(async () => {
      const state = await this.store('handles') || empty();
      const hidden = state.hidden || [];
      if (record.folderId) {
        state.hidden = [...new Set([...hidden, record.fileName])].slice(-HIDDEN_LIMIT);
        // Drop any opened entry that points at this exact file: the folder scan
        // is name-filtered, but a remembered handle would re-add it by identity.
        const keep = [];
        for (const entry of state.opened || []) {
          let same = entry.handle?.name === record.fileName;
          if (same) { try { same = await entry.handle.isSameEntry(record.handle); } catch { same = false; } }
          if (!same) keep.push(entry);
        }
        state.opened = keep;
      } else {
        state.opened = (state.opened || []).filter(entry => entry.id !== id);
        state.hidden = hidden.filter(value => value !== id);
      }
      await this.store('handles', state);
    });
    await this.refresh(); this.changed();
  }
}
export const nodePatterns = new NodePatterns();
export const listGraphs = () => nodePatterns.records;
export const watchGraphs = listener => nodePatterns.watch(listener);
