import { SKETCHES } from '../sketch-registry.js';
import { stageSources, SCRIPT_SUFFIX } from './compiler.js';
import { adaptPattern } from './adapter.js';
import { scriptStorage, supportError } from './storage.js';

export class CustomScripts {
  constructor({ role = 'control', onChange = () => {}, onStatus = () => {}, storage = scriptStorage, channel = null } = {}) {
    this.role = role; this.onChange = onChange; this.onStatus = onStatus; this.storage = storage;
    this.handle = null; this.active = { revision: 0, sources: [] };
    this.status = { folder: '', permission: 'prompt', files: [], opened: [], errors: [], busy: false, support: supportError() };
    this.channel = channel;
    this.closed = false;
    this.queue = Promise.resolve();
    this.entries = [];
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
      const snapshot = await this.storage('active');
      this.handle = snapshot && 'folder' in snapshot ? snapshot.folder : await this.storage('folder');
      await this.restore();
      const permission = await this.handle?.queryPermission({ mode: 'read' }) || 'prompt';
      this.publish({ folder: this.handle?.name || '', permission });
      if (this.role === 'control' && this.handle && permission === 'granted') await this.listFiles();
    } catch (e) { this.report(`Storage/reconnect: ${e.message}. Unlink and Link Folder again.`); }
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
  stage(snapshot, changed = snapshot.sources.map((s) => s.name)) {
    const names = new Set(changed);
    const retained = this.entries.filter((e) => !names.has(e.file) && snapshot.sources.some((s) => s.name === e.file));
    const protectedIds = [...SKETCHES.filter((s) => !s.customScript).map((s) => s.id), ...retained.map((e) => e.definition.id)];
    const entries = [...retained, ...stageSources(snapshot.sources.filter((s) => names.has(s.name)), protectedIds)];
    if (entries.length > 256) throw new Error('Maximum 256 custom patterns');
    return entries;
  }
  apply(snapshot, entries) {
    const previous = SKETCHES.filter((s) => s.customScript);
    const unchanged = new Set(entries.filter((e) => this.entries.includes(e)).map((e) => e.definition.id));
    const next = entries.map((entry) => unchanged.has(entry.definition.id)
      ? previous.find((s) => s.id === entry.definition.id)
      : adaptPattern(entry, this.report, (name) => this.asset(name, snapshot.folder)));
    for (const entry of next) entry.nodesSourceText = snapshot.sources.find(s => s.name === entry.customScript)?.text || '';
    SKETCHES.splice(0, SKETCHES.length, ...SKETCHES.filter((s) => !s.customScript), ...next);
    this.entries = entries;
    this.active = snapshot;
    this.handle = snapshot.folder;
    this.publish({ folder: this.handle?.name || '', files: snapshot.files || [], opened: snapshot.sources.map((s) => s.name), errors: [] });
    const affected = new Set([...previous, ...next].filter((s) => !unchanged.has(s.id)).map((s) => s.id));
    if (affected.size) this.onChange(affected);
  }
  async restore() {
    const snapshot = await this.storage('active');
    // Older snapshots autoloaded the whole folder. Require explicit selection now.
    if (this.closed || !snapshot?.selectionVersion || snapshot.revision <= this.active.revision) return;
    const sameFolder = this.active.folder && snapshot.folder && await this.active.folder.isSameEntry(snapshot.folder);
    if (this.closed) return;
    const changed = snapshot.sources.filter((s) => !sameFolder || !this.active.sources.some((old) => old.name === s.name && old.text === s.text)).map((s) => s.name);
    this.apply(snapshot, this.stage(snapshot, [...changed, ...(snapshot.changed || [])]));
  }
  async commit(sources, folder = this.handle, changed = sources.map((s) => s.name), files = this.status.files) {
    this.assertControl();
    // Folder handle, explicit selection and last-good code persist atomically.
    const snapshot = { selectionVersion: 1, revision: Math.max(Date.now(), this.active.revision + 1), sources, files, folder, changed };
    const entries = this.stage(snapshot, changed);
    await this.storage('active', snapshot);
    if (this.closed) return;
    this.apply(snapshot, entries);
    this.channel?.postMessage({ type: 'revision', revision: snapshot.revision });
  }
  assertControl() { if (this.role !== 'control') throw new Error('Only the control window can change scripts'); }
  async permission(request = false) {
    this.assertControl();
    if (!this.handle) throw new Error('Link a scripts folder first.');
    let permission = await this.handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && request) permission = await this.handle.requestPermission({ mode: 'read' });
    this.publish({ permission });
    if (permission !== 'granted') throw new Error('Folder permission denied or expired. Click Open Script or reload to renew access, or unlink and Link Folder again. Last-good scripts remain active.');
  }
  // Invoke picker/requestPermission directly from a user gesture, not a queue.
  async choose() {
    this.assertControl();
    if (supportError()) throw new Error(supportError());
    const handle = await showDirectoryPicker({ id: 'viz2-custom-scripts', mode: 'read' });
    return this.enqueue(async () => {
      const files = await this.listFiles(handle, false);
      await this.commit([], handle, [], files);
      this.publish({ permission: 'granted' });
    });
  }
  async reconnect() {
    this.assertControl();
    if (!this.handle) return this.choose();
    // requestPermission must be invoked while activation is available.
    const permission = await this.handle.requestPermission({ mode: 'read' });
    this.publish({ permission });
    if (permission !== 'granted') throw new Error('Reconnect was denied. Allow read access in Chrome or choose another folder.');
  }
  async listFiles(folder = this.handle, publish = true) {
    this.assertControl();
    if (!folder) throw new Error('Link a scripts folder first.');
    const files = [];
    for await (const [name, handle] of folder.entries()) {
      if (handle.kind !== 'file' || !name.endsWith(SCRIPT_SUFFIX)) continue;
      if (files.length >= 100) throw new Error('Folder: maximum 100 .viz.js files');
      files.push(name);
    }
    files.sort((a, b) => a.localeCompare(b));
    if (publish) this.publish({ files });
    return files;
  }
  browse() { return this.enqueue(async () => { await this.permission(); return this.listFiles(); }); }
  async readSource(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.viz\.js$/.test(name)) throw new Error('Invalid .viz.js filename');
    try {
      const file = await (await this.handle.getFileHandle(name)).getFile();
      if (file.size > 1_000_000) throw new Error('File exceeds 1 MB');
      return { name, text: await file.text() };
    } catch (e) { throw new Error(`${name}: read: ${e.message}. Last-good registrations retained.`); }
  }
  open(name) {
    return this.enqueue(async () => {
      await this.permission();
      if (this.active.sources.some((s) => s.name === name)) return;
      const source = await this.readSource(name);
      await this.commit([...this.active.sources, source], this.handle, [name]);
    });
  }
  reload(name) {
    return this.enqueue(async () => {
      await this.permission();
      if (name && !this.active.sources.some((s) => s.name === name)) throw new Error(`${name}: not opened`);
      const files = await this.listFiles();
      const changed = name ? [name] : this.active.sources.map((s) => s.name);
      const sources = [];
      for (const source of this.active.sources) {
        if (!changed.includes(source.name)) sources.push(source);
        else if (files.includes(source.name)) sources.push(await this.readSource(source.name));
        // A file removed externally retires its patterns. Unopened files are never read.
      }
      await this.commit(sources, this.handle, changed, files);
    });
  }
  remove(name) {
    return this.enqueue(async () => {
      this.assertControl();
      if (!this.active.sources.some((s) => s.name === name)) throw new Error(`${name}: not opened`);
      // Like media Remove: forget the loaded item, never touch its physical source.
      // Empty changed list also avoids re-evaluating unrelated last-good scripts.
      await this.commit(this.active.sources.filter((s) => s.name !== name), this.handle, []);
    });
  }
  unlink() {
    return this.enqueue(async () => {
      await this.commit([], null, [], []);
      this.publish({ permission: 'prompt' });
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
