import { assertFolderReference, missingFolderFiles, folderReference } from '../platform/folderReferences.js';
import { registerLinkedProjectFolder } from '../platform/project-folders.js';
import { createHandleStorage } from '../platform/handleStorage.js';
import { chooseFolder, folderPermission, requireFolderPermission, scanFolder, linkedFile } from '../platform/folderAccess.js';
import { mediaKindForName, mimeForName } from './media-store.js';

// Folder links never contain media bytes. Existing media persistence/playback
// consumes the same file handles as the individual-file picker.
//
// A linked directory is a SOURCE, never an importer: scanning it (on startup, on
// Refresh or when it is linked) only re-points the media patterns this library
// already has — matched by the record's own file name and its directory, never by
// hashing the file — so a project gets back exactly the media it recorded. New
// patterns come from the explicit ADD / OPEN controls only.
export class MediaFolder {
  constructor({ storage = createHandleStorage('viz2-media-folder'), onFiles = async () => {}, onStatus = () => {} } = {}) {
    this.storage = storage; this.onFiles = onFiles; this.onStatus = onStatus;
    this.handle = null; this.status = { folder: '', permission: 'prompt', errors: [] };
    this.channel = null; this.closed = false;
  }
  publish(patch) { this.status = { ...this.status, ...patch }; if (!this.closed) this.onStatus(this.status); }
  lock(fn) { return navigator.locks.request('viz2-media-folder', fn); }
  async restore() {
    this.handle = await this.storage('folder');
    this.publish({ folder: this.handle?.name || '', permission: this.handle ? await folderPermission(this.handle) : 'prompt', errors: [] });
  }
  async start() {
    this.channel = new BroadcastChannel('viz2-media-folder');
    this.channel.onmessage = () => this.lock(() => this.restore()).catch(e => this.publish({ errors: [e.message] }));
    try { await this.refresh(false); } catch (e) { this.publish({ errors: [e.message] }); }
  }
  async scan(handle, choosing = false) {
    if (!choosing || folderReference('media')?.needsRelink) assertFolderReference('media', handle, choosing);
    await requireFolderPermission(handle);
    return (await scanFolder(handle, { accepts: mediaKindForName, limit: 256 })).map(entry => ({ ...entry, kind: mediaKindForName(entry.name), mime: mimeForName(entry.name), folderName: handle.name }));
  }
  // The files this library expects inside a linked directory, resolved BY NAME from
  // the project's own media references — never by listing the whole folder, whose
  // picker cap (256) would otherwise stop a project restoring its own media from a
  // directory full of other clips. Nothing is created here: ADD / OPEN do that.
  async expectedFiles(handle) {
    const ref = folderReference('media');
    const expected = (ref?.needsRelink ? [] : ref?.files || []).filter(file => file.linked && file.fileName);
    const sources = [];
    for (const file of expected) {
      let entry;
      try { entry = await handle.getFileHandle(file.fileName); await entry.getFile(); }
      catch { continue; } // Absent or not readable as a file: reported as missing below.
      sources.push({ handle: entry, name: file.fileName, kind: mediaKindForName(file.fileName), mime: mimeForName(file.fileName), folderName: handle.name });
    }
    return sources;
  }
  // Re-point the records this library already has; a scan never adopts a directory.
  async syncExpected(handle) {
    const sources = await this.expectedFiles(handle);
    this.publish({ errors: missingFolderFiles('media', sources.map(source => source.name)) });
    if (sources.length) await this.onFiles(sources, { adoptNew: false });
  }
  async link() {
    const handle = await chooseFolder({ id: 'viz2-media-folder', label: 'Media' });
    await requireFolderPermission(handle); // A directory that cannot be read is never linked.
    await this.lock(async () => {
      const previousHandle = await this.storage('folder');
      await this.storage('folder', handle);
      // A different directory gets its own identity and fresh file references,
      // even if its basename matches the previous link.
      await registerLinkedProjectFolder('media', handle, previousHandle);
      await this.restore();
      // Linking grants access; it does not load the directory. Files already in
      // this library are re-pointed (ADD/OPEN are what bring new ones in).
      try { await this.syncExpected(handle); }
      finally { this.channel?.postMessage('changed'); }
    });
  }
  async refresh(request = true) {
    // Permission must be requested from the gesture, before entering the lock.
    if (request && this.handle) await requireFolderPermission(this.handle, 'read', true);
    return this.lock(async () => {
      await this.restore();
      assertFolderReference('media', this.handle);
      if (!this.handle) return;
      if (!request && this.status.permission !== 'granted') await requireFolderPermission(this.handle);
      await this.syncExpected(this.handle);
    });
  }
  async browse() {
    assertFolderReference('media', this.handle);
    await requireFolderPermission(this.handle, 'read', true);
    return this.scan(this.handle);
  }
  async open(name) {
    assertFolderReference('media', this.handle);
    await requireFolderPermission(this.handle, 'read', true);
    const handle = await linkedFile(this.handle, name, mediaKindForName);
    await handle.getFile(); // Report a deleted/unreadable selection before adding.
    // The one path that turns a file in the linked directory into a pattern.
    await this.onFiles([{ handle, name, kind: mediaKindForName(name), mime: mimeForName(name), folderName: this.handle.name }], { adoptNew: true });
  }
  async unlink() {
    await this.lock(async () => { await this.storage('folder', null); await this.restore(); });
    this.channel?.postMessage('changed');
  }
  close() { this.closed = true; this.channel?.close(); }
}
