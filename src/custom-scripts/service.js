import { SKETCHES } from '../sketch-registry.js';
import { stageSources, SCRIPT_SUFFIX } from './compiler.js';
import { adaptPattern } from './adapter.js';
import { scriptStorage, supportError, starterScript } from './storage.js';

export class CustomScripts {
  constructor({ role = 'control', onChange = () => {}, onStatus = () => {}, storage = scriptStorage, channel = null } = {}) {
    this.role = role; this.onChange = onChange; this.onStatus = onStatus; this.storage = storage;
    this.handle = null; this.active = { revision: 0, sources: [] };
    this.status = { folder: '', permission: 'prompt', files: [], errors: [], busy: false, support: supportError() };
    this.channel = channel;
    this.closed = false;
    this.queue = Promise.resolve();
  }
  publish(patch = {}) { if (this.closed) return; this.status = { ...this.status, ...patch }; this.onStatus(this.status); }
  report = (message) => {
    if (this.closed || this.status.errors.includes(message)) return;
    this.publish({ errors: [...this.status.errors.slice(-19), message] });
    this.channel?.postMessage({ type: 'error', message });
  };
  async start() {
    this.channel ||= new BroadcastChannel('viz2-custom-scripts-v1');
    this.channel.onmessage = ({ data }) => {
      if (data?.type === 'revision') this.enqueue(() => this.restore()).catch(() => {});
      if (data?.type === 'error' && typeof data.message === 'string') this.publish({ errors: [...this.status.errors.slice(-19), data.message] });
    };
    try {
      this.handle = await this.storage('folder');
      await this.restore();
      const permission = await this.handle?.queryPermission({ mode: 'readwrite' }) || 'prompt';
      this.publish({ folder: this.handle?.name || '', permission });
    } catch (e) { this.report(`Storage/reconnect: ${e.message}. Choose folder again.`); }
  }
  enqueue(fn) {
    const work = this.queue.then(async () => {
      if (this.closed) return;
      this.publish({ busy: true });
      try { return await fn(); }
      catch (e) { if (e.name !== 'AbortError') this.report(e.message); throw e; }
      finally { this.publish({ busy: false }); }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  stage(snapshot) {
    const entries = stageSources(snapshot.sources, SKETCHES.filter((s) => !s.customScript).map((s) => s.id));
    return entries;
  }
  apply(snapshot, entries) {
    const previous = SKETCHES.filter((s) => s.customScript);
    const next = entries.map((entry) => adaptPattern(entry, this.report, (name) => this.asset(name, snapshot.folder)));
    SKETCHES.splice(0, SKETCHES.length, ...SKETCHES.filter((s) => !s.customScript), ...next);
    this.active = snapshot;
    this.publish({ files: snapshot.files || snapshot.sources.map((s) => s.name), errors: [] });
    this.onChange(new Set([...previous, ...next].map((s) => s.id)));
  }
  async restore() {
    const snapshot = await this.storage('active');
    if (this.closed || !snapshot || snapshot.revision <= this.active.revision) return;
    // Each window validates independently; malformed/nondeterministic scripts
    // cannot wipe its last-good registry. Only trusted deterministic code works.
    this.apply(snapshot, this.stage(snapshot));
  }
  async commit(sources, folder = this.handle) {
    if (this.role !== 'control') throw new Error('Only the control window can change scripts');
    const snapshot = { revision: Math.max(Date.now(), this.active.revision + 1), sources, files: [...new Set([...this.status.files, ...sources.map((s) => s.name)])], folder };
    const entries = this.stage(snapshot);
    await this.storage('active', snapshot); // Failure preserves old registrations.
    if (this.closed) return;
    this.apply(snapshot, entries);
    this.channel?.postMessage({ type: 'revision', revision: snapshot.revision });
  }
  assertControl() { if (this.role !== 'control') throw new Error('Only the control window can change scripts'); }
  async permission(request = false) {
    this.assertControl();
    if (!this.handle) throw new Error('Choose a scripts folder first.');
    let permission = await this.handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted' && request) permission = await this.handle.requestPermission({ mode: 'readwrite' });
    this.publish({ permission });
    if (permission !== 'granted') throw new Error('Folder permission denied or expired. Click Reconnect, or choose the folder again. Last-good scripts remain active.');
  }
  // Invoke picker/requestPermission directly from a user gesture, not a queue.
  async choose() {
    this.assertControl();
    if (supportError()) throw new Error(supportError());
    const handle = await showDirectoryPicker({ id: 'viz2-custom-scripts', mode: 'readwrite' });
    return this.enqueue(async () => {
      await this.storage('folder', handle);
      this.handle = handle;
      this.publish({ folder: handle.name, files: [] });
      await this.readFolder();
    });
  }
  async reconnect() {
    this.assertControl();
    if (!this.handle) return this.choose();
    // requestPermission must be invoked while activation is available.
    const permission = await this.handle.requestPermission({ mode: 'readwrite' });
    this.publish({ permission });
    if (permission !== 'granted') throw new Error('Reconnect was denied. Allow read/write access in Chrome or choose another folder.');
  }
  reload() { return this.enqueue(() => this.readFolder()); }
  async readFolder() {
    await this.permission();
    const sources = [];
    for await (const [name, handle] of this.handle.entries()) {
      if (handle.kind !== 'file' || !name.endsWith(SCRIPT_SUFFIX)) continue;
      if (sources.length >= 100) throw new Error('Folder: maximum 100 .viz.js files; move extra scripts out and Reload.');
      try {
        const file = await handle.getFile();
        if (file.size > 1_000_000) throw new Error('File exceeds 1 MB');
        sources.push({ name, text: await file.text() });
      } catch (e) { throw new Error(`${name}: read: ${e.message}. Save the file and Reload; last-good registrations retained.`); }
    }
    sources.sort((a, b) => a.name.localeCompare(b.name));
    this.publish({ files: sources.map((s) => s.name) });
    await this.commit(sources);
  }
  create(name) {
    return this.enqueue(async () => {
      await this.permission();
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Name must contain 1..80 characters');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'pattern';
      const id = `custom-${slug}-${crypto.randomUUID().slice(0, 8)}`;
      const filename = `${id}.viz.js`;
      // Never overwrite an existing external file.
      try { await this.handle.getFileHandle(filename); throw new Error(`${filename}: already exists`); }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      if (this.active.sources.length && this.active.folder && !await this.handle.isSameEntry(this.active.folder)) {
        throw new Error('The selected folder has not activated successfully. Fix its errors and Reload before creating a script.');
      }
      const text = starterScript(id, name);
      let writer;
      try {
        const file = await this.handle.getFileHandle(filename, { create: true });
        writer = await file.createWritable();
        await writer.write(text); await writer.close();
      } catch (e) {
        await writer?.abort().catch(() => {});
        throw new Error(`${filename}: write failed: ${e.message}. Check folder permission and available disk space.`);
      }
      this.publish({ files: [...this.status.files, filename] });
      // Creating a starter must not silently activate other external edits.
      await this.commit([...this.active.sources, { name: filename, text }]);
      return filename;
    });
  }
  remove(name) {
    return this.enqueue(async () => {
      if (!this.active.sources.some((s) => s.name === name)) throw new Error(`${name}: not active`);
      // Do not evaluate the removed file again. Disk remains untouched; Reload restores it.
      await this.commit(this.active.sources.filter((s) => s.name !== name), this.active.folder);
    });
  }
  deleteFile(name, confirmed = false) {
    return this.enqueue(async () => {
      if (!confirmed) throw new Error('Disk deletion requires confirmation');
      if (!this.status.files.includes(name) || !name.endsWith(SCRIPT_SUFFIX) || /[/\\]/.test(name)) throw new Error('Unknown script filename');
      await this.permission();
      // A failed folder switch retains another directory's last-good sources.
      // Filename equality alone must never authorize removing those registrations.
      if (this.active.folder && !await this.handle.isSameEntry(this.active.folder)) {
        throw new Error(`${name}: the selected folder has not activated successfully. Fix its errors and Reload before deleting a script.`);
      }
      try { await this.handle.removeEntry(name); }
      catch (e) { throw new Error(`${name}: disk delete failed: ${e.message}. Reconnect or verify the file still exists.`); } // no recursive deletion
      this.publish({ files: this.status.files.filter((f) => f !== name) });
      // Use the last-good source snapshot so another broken disk file cannot
      // prevent disposal of this deleted file's registrations.
      await this.commit(this.active.sources.filter((s) => s.name !== name), this.active.folder);
    });
  }
  async asset(name, folder) {
    if (typeof name !== 'string' || !name || /[/\\]/.test(name) || name === '.' || name === '..') throw new Error('assetURL expects a filename in the chosen folder (no subdirectories)');
    const handle = folder || await this.storage('folder') || this.handle;
    if (!handle || await handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error(`${name}: reconnect scripts folder in the control window to load assets`);
    try { return await (await handle.getFileHandle(name)).getFile(); }
    catch (e) { throw new Error(`${name}: asset read: ${e.message}`); }
  }
  close() { this.closed = true; this.channel?.close(); }
}
