import { assertFolderReference, missingFolderFiles, forgetFolderFile, folderReference } from '../platform/folderReferences.js';
import { registerLinkedProjectFolder } from '../platform/project-folders.js';
import { chooseFolder, folderPermission, requireFolderPermission, scanFolder } from '../platform/folderAccess.js';
import { SKETCHES } from '../sketch-registry.js';
import { stageSources, SCRIPT_SUFFIX } from './compiler.js';
import { sourceHash } from './hash.js';
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
      this.publish({ folder: this.handle?.name || '' });
      await this.restore();
      const permission = await this.handle?.queryPermission({ mode: 'read' }) || 'prompt';
      this.publish({ folder: this.handle?.name || '', permission });
      if (this.handle && permission !== 'granted') {
        const waiting = this.pendingProjectScripts().length;
        this.report(waiting
          ? `Folder access must be renewed. Press Refresh to reopen the ${waiting} script${waiting === 1 ? '' : 's'} this project expects; last-good registrations remain active.`
          : 'Folder permission denied or expired. Refresh folder or Relink Folder to restore access; last-good scripts remain active.');
      }
      if (this.role === 'control' && this.handle && permission === 'granted') {
        await this.listFiles();
        // A project opened from a file reopens the scripts whose code still matches
        // what the project was saved with; anything else waits for an explicit OPEN.
        await this.projectScripts().catch((error) => this.report(`Project scripts: ${error.message}`));
      }
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
    this.publish({ folder: this.handle?.name || '', files: snapshot.files || [], opened: snapshot.sources.map((s) => s.name), reopened: [], stale: [], errors: [] });
    const affected = new Set([...previous, ...next].filter((s) => !unchanged.has(s.id)).map((s) => s.id));
    if (affected.size) this.onChange(affected);
  }
  async restore() {
    const snapshot = await this.storage('active');
    assertFolderReference('scripts', snapshot?.folder || this.handle);
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
  // Script files the linked project expects that are not open yet and carry a code
  // fingerprint — exactly the ones a renewed permission would reopen. Used for the
  // startup message when access has lapsed, so the hint is actionable.
  pendingProjectScripts() {
    return (folderReference('scripts')?.files || [])
      .filter(file => typeof file.sha256 === 'string' && !this.status.opened.includes(file.fileName));
  }
  async permission(request = false) {
    this.assertControl();
    if (!this.handle) throw new Error('Link a scripts folder first.');
    assertFolderReference('scripts', this.handle);
    let permission = await folderPermission(this.handle);
    if (permission !== 'granted' && request) permission = await this.handle.requestPermission({ mode: 'read' });
    this.publish({ permission });
    if (permission !== 'granted') throw new Error('Folder permission denied or expired. Click Open Script or reload to renew access, or unlink and Link Folder again. Last-good scripts remain active.');
  }
  // Invoke picker/requestPermission directly from a user gesture, not a queue.
  async choose() {
    this.assertControl();
    if (supportError()) throw new Error(supportError());
    const handle = await chooseFolder({ id: 'viz2-custom-scripts', mode: 'read', label: 'Custom Scripts' });
    if (folderReference('scripts')?.needsRelink) assertFolderReference('scripts', handle, true);
    return this.enqueue(async () => {
      const files = await this.listFiles(handle, false);
      const previousHandle = this.handle;
      await this.commit([], handle, [], files);
      // Only an imported, unresolved reference adopts its id. Ordinary relinks
      // leave the old directory and its remembered handle available to projects.
      await registerLinkedProjectFolder('scripts', handle, previousHandle);
      this.publish({ permission: 'granted', errors: missingFolderFiles('scripts', files) });
    });
  }
  async reconnect() {
    this.assertControl();
    if (!this.handle) return this.choose();
    assertFolderReference('scripts', this.handle);
    // requestPermission must be invoked while activation is available.
    const permission = await this.handle.requestPermission({ mode: 'read' });
    this.publish({ permission });
    if (permission !== 'granted') throw new Error('Reconnect was denied. Allow read access in Chrome or choose another folder.');
  }
  async listFiles(folder = this.handle, publish = true) {
    this.assertControl();
    if (!folder) throw new Error('Link a scripts folder first.');
    // Truncate at the folder cap (see create/compile limits) instead of throwing:
    // a folder at the cap must not stop the project reopen from running.
    const files = (await scanFolder(folder, { accepts: name => name.endsWith(SCRIPT_SUFFIX), limit: 100, onLimit: () => {} })).map(entry => entry.name);
    if (publish) this.publish({ files, errors: missingFolderFiles('scripts', files) });
    return files;
  }
  async create(name) {
    this.assertControl();
    if (typeof name !== 'string' || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.viz\.js$/.test(name)) throw new Error('Use a filename ending in .viz.js (letters, numbers, dots, hyphens, underscores).');
    const folder = this.handle;
    assertFolderReference('scripts', folder);
    await requireFolderPermission(folder, 'readwrite', true);
    return this.enqueue(async () => {
      if (this.handle !== folder) throw new Error('Linked folder changed. Retry in the current folder.');
      if ((await this.listFiles()).length >= 100) throw new Error('Folder: maximum 100 .viz.js files');
      // Never overwrite a user's source file. Serialize creation across tabs.
      await navigator.locks.request('viz2-script-create', async () => {
        try { await this.handle.getFileHandle(name); throw new Error('File already exists. Open it instead.'); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
        const file = await this.handle.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        try { await writer.write(`// Edit this file in your editor; reload it in the library.\napi.requireVersion(1);\napi.create({ id: 'custom-${crypto.randomUUID()}', name: ${JSON.stringify(name.replace(/\.viz\.js$/, '').slice(0, 80))}, draw({ p }) { p.background(24); } });\n`); await writer.close(); }
        catch (error) { await writer.abort().catch(() => {}); throw error; }
      });
      const files = await this.listFiles();
      await this.commit(this.active.sources, this.handle, [], files);
    });
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
  // Load the scripts a saved project expects when the linked folder still holds the
  // same code. A project file carries a fingerprint of each source, never the source
  // itself, so an unchanged file opens on its own while anything else — edited,
  // renamed, added, or a project that recorded no fingerprint at all — keeps the
  // explicit "Open trusted script" hint. Only the files a project names are
  // considered: linking a folder never runs its contents.
  async projectScripts() {
    this.assertControl();
    if (!this.handle || this.status.permission !== 'granted') return [];
    // A fingerprint is required: a name alone must never start code, so a project
    // file without one (older file, or a file that could not be read when it was
    // saved) leaves every entry to the explicit OPEN. The historical `linked` flag
    // is deliberately NOT the gate: it only records whether the file was in the
    // folder when the project was written, while the fingerprint says what the code
    // is — so a file that is back in the folder and byte-identical opens again.
    const expected = (folderReference('scripts')?.files || []).filter((file) => typeof file.sha256 === 'string');
    if (!expected.length) return [];
    const sources = [];
    const stale = [];
    for (const file of expected) {
      if (this.active.sources.some((source) => source.name === file.fileName)) continue;
      let source = null;
      try {
        source = await this.readSource(file.fileName);
      } catch {
        continue; // Gone from the folder: reported as missing, never blocking the project.
      }
      const digest = await sourceHash(source.text);
      if (!digest || digest !== file.sha256) {
        stale.push(file.fileName); // Edited since the project was saved.
        continue;
      }
      sources.push(source);
    }
    if (!sources.length) {
      if (stale.length) this.publish({ stale });
      return [];
    }
    const names = sources.map((source) => source.name);
    await this.commit([...this.active.sources, ...sources], this.handle, names);
    this.publish({ reopened: names, stale });
    return names;
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
      this.publish({ errors: missingFolderFiles('scripts', files) });
      // Refresh (Linked → Refresh) is also how a project reopen finishes when the
      // folder permission had lapsed at startup: renewing access is the gesture, and
      // this is the first moment the files can be read again.
      await this.projectScripts();
    });
  }
  remove(name) {
    return this.enqueue(async () => {
      this.assertControl();
      if (!this.active.sources.some((s) => s.name === name)) throw new Error(`${name}: not opened`);
      // Like media Remove: forget the loaded item, never touch its physical source.
      // Empty changed list also avoids re-evaluating unrelated last-good scripts.
      await this.commit(this.active.sources.filter((s) => s.name !== name), this.handle, []);
      forgetFolderFile('scripts', name);
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
