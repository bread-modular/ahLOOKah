import { createHandleStorage } from './handleStorage.js';
import { scanFolder, folderPermission } from './folderAccess.js';
import {
  FOLDER_SECTIONS,
  folderReference,
  sanitizeFolderReferences,
  importFolderReferences,
} from './folderReferences.js';
import {
  bindProjectFolder,
  clearProjectFolder,
  ensureProjectFolder,
  newFolderId,
  recallProjectFolder,
} from './project-folders.js';
import { scriptStorage } from '../custom-scripts/storage.js';
import { SCRIPT_SUFFIX } from '../custom-scripts/compiler.js';
import { sourceHash } from '../custom-scripts/hash.js';
import { nodeFileId } from '../nodes/repository.js';
import { listMediaRecords, putMediaRecord } from '../media/media-store.js';

const nodesStorage = createHandleStorage('viz2-node-patterns');
const mediaStorage = createHandleStorage('viz2-media-folder');
const merge = (pending, files) => [...new Map([...(pending || []), ...files].map(file => [file.id || `${file.linked}:${file.fileName}`, file])).values()];

export const FOLDER_LABELS = Object.freeze({ scripts: 'Custom Scripts', nodes: 'Node Patterns', media: 'Media' });
const label = (section) => FOLDER_LABELS[section] || section;
const log = (message) => { try { globalThis.console?.warn?.(`[project] ${message}`); } catch { /* noop */ } };

// Script file list for a project: keyed by file name so a loaded source never loses
// what the project already recorded for that file. A loaded entry has no fingerprint
// of its own, so spreading it over the inherited entry keeps the inherited `sha256`
// (and `linked`), while a digest computed from the folder right now overrides it.
function mergeScriptFiles(inherited, loaded, digests) {
  const byName = new Map();
  for (const file of inherited || []) byName.set(file.fileName, file);
  for (const file of loaded) byName.set(file.fileName, { ...byName.get(file.fileName), ...file });
  return [...byName.values()].map(file => {
    const fresh = digests.get(file.fileName);
    return fresh ? { ...file, sha256: fresh } : file;
  });
}

// Fingerprint of every script file the linked folder currently holds. Save Project
// writes these into the project file instead of the code, so Open Project can tell
// an unchanged script from one edited since. A file that cannot be read simply gets
// no fingerprint and keeps the explicit OPEN.
async function scriptDigestsFor(handle) {
  const digests = new Map();
  if (!handle) return digests;
  try {
    if (await folderPermission(handle) !== 'granted') return digests;
    // Same cap as the scripts service (100 .viz.js files per folder). Reaching the
    // cap truncates the scan instead of aborting it, so the files that were read
    // still get fingerprints rather than the whole folder losing them.
    let truncated = false;
    const files = await scanFolder(handle, {
      accepts: name => name.endsWith(SCRIPT_SUFFIX),
      limit: 100,
      onLimit: () => { truncated = true; },
    });
    if (truncated) log('Script folders are capped at 100 files: later files get no fingerprint.');
    for (const file of files) {
      const digest = await sourceHash(await (await file.handle.getFile()).text());
      if (digest) digests.set(file.name, digest);
    }
  } catch { /* no fingerprints: every listed script keeps the explicit OPEN */ }
  return digests;
}

// Snapshot the linked directories for a project file: names + file references,
// plus the directory identity (`folderId`) that lets the SAME computer reopen
// them without a re-link. Handles and file bytes never travel.
export async function collectFolderReferences(media) {
  const script = await scriptStorage('active');
  const scriptsHandle = script && 'folder' in script ? script.folder : await scriptStorage('folder');
  const nodes = await nodesStorage('handles');
  const mediaHandle = await mediaStorage('folder');
  const result = {};
  // Register linked directories, but do not turn a stale pre-import handle into
  // the identity of an unresolved imported reference (even if names coincide).
  // Keep that reference's id until the operator confirms the actual directory.
  const scriptsRef = folderReference('scripts');
  const nodesRef = folderReference('nodes');
  const mediaRef = folderReference('media');
  let scriptsId = scriptsRef?.needsRelink ? scriptsRef.folderId : null;
  if (!scriptsRef?.needsRelink && scriptsHandle) scriptsId = (await ensureProjectFolder('scripts', scriptsHandle))?.id || null;
  else if (!scriptsHandle && !scriptsRef?.needsRelink) clearProjectFolder('scripts');
  let nodesId = nodesRef?.needsRelink ? nodesRef.folderId : null;
  if (!nodesRef?.needsRelink && nodes?.folder?.handle) {
    // The project identity — not the folder id that salts node pattern ids.
    nodesId = (await ensureProjectFolder('nodes', nodes.folder.handle))?.id || null;
  } else if (!nodes?.folder?.handle && !nodesRef?.needsRelink) clearProjectFolder('nodes');
  let mediaId = mediaRef?.needsRelink ? mediaRef.folderId : null;
  if (!mediaRef?.needsRelink && mediaHandle) mediaId = (await ensureProjectFolder('media', mediaHandle))?.id || null;
  else if (!mediaHandle && !mediaRef?.needsRelink) clearProjectFolder('media');

  const scriptDigests = await scriptDigestsFor(scriptsRef?.needsRelink ? null : scriptsHandle);
  result.scripts = {
    folderName: folderReference('scripts')?.folderName || scriptsHandle?.name || null,
    folderId: scriptsId,
    // A fingerprint of each file's current code travels instead of the code, so
    // opening the project later can tell an unchanged script from an edited one.
    files: mergeScriptFiles(
      folderReference('scripts')?.files,
      (script?.sources || []).map(source => ({ fileName: source.name, linked: true })),
      scriptDigests,
    ),
  };
  let nodeFiles = [];
  const pendingNodes = folderReference('nodes');
  if (nodes?.folder && !pendingNodes?.needsRelink && (!pendingNodes?.folderName || pendingNodes.folderName === nodes.folder.handle.name) && await folderPermission(nodes.folder.handle) === 'granted') {
    // Export names only. No graph contents, native handles or standalone node export.
    nodeFiles = await Promise.all((await scanFolder(nodes.folder.handle, { accepts: name => name.endsWith('.nodes.json'), limit: 64 })).map(async file => ({
      fileName: file.name, linked: true,
      id: folderReference('nodes')?.files.find(f => f.linked && f.fileName === file.name)?.id || await nodeFileId(nodes.folder.id, file.name),
    })));
  } else nodeFiles = pendingNodes ? [] : nodes?.references || []; // Last successful scan if permissions expired.
  result.nodes = {
    folderName: folderReference('nodes')?.folderName || nodes?.folder?.handle.name || null,
    folderId: nodesId,
    files: merge(folderReference('nodes')?.files, [...nodeFiles, ...(nodes?.opened || []).map(file => ({ fileName: file.handle.name, id: file.id, linked: false }))]),
  };
  const mediaFolderName = mediaRef?.folderName || mediaHandle?.name || null;
  const mediaRecords = new Map((await listMediaRecords().catch(() => [])).map(record => [record.id, record]));
  const mediaFiles = await Promise.all(media.filter(file => file.fileName).map(async file => {
    const inherited = mediaRef?.folderId === mediaId && !mediaRef?.needsRelink &&
      mediaRef?.files.find(entry => entry.id === file.id && entry.fileName === file.fileName)?.linked === true;
    let linked = !!inherited;
    if (!linked && mediaHandle && !mediaRef?.needsRelink && file.folderName === mediaHandle.name) {
      // Metadata's folderName is only a label: two physical media directories can
      // share it. Require the saved file handle to match a child of this folder.
      try {
        const original = mediaRecords.get(file.id)?.handle;
        if (original) linked = await original.isSameEntry(await mediaHandle.getFileHandle(file.fileName));
      } catch { /* File absent/inaccessible: do not claim it belongs here. */ }
    }
    return { fileName: file.fileName, id: file.id, linked };
  }));
  result.media = {
    folderName: mediaFolderName,
    folderId: mediaId,
    files: merge(mediaRef?.files, mediaFiles),
  };
  return sanitizeFolderReferences(result);
}

// Apply a project's directory expectations to this computer.
//
// Each section is first looked up by directory identity: when this computer still
// has the handle the project was exported from (same machine, another project, a
// different browser profile would not), the directory is adopted directly and the
// operator is never asked to re-pick it.
//
// `pending` lists the sections that could NOT be adopted here — a different
// computer, a cleared profile, an expired grant, or a same-named directory that
// now holds a different identity. Those block the save until they are linked.
export async function applyFolderReferences(references) {
  const resolved = [];
  const pending = [];
  const reconnect = [];
  const handles = {};
  if (!references) {
    // Pre-project exports carried no folder section: keep this machine's links.
    importFolderReferences(undefined);
    return { resolved, pending, reconnect, mediaFolder: null };
  }
  // A colliding id whose remembered handle names a different directory cannot
  // be rebound to the imported directory. Give this import a new pending id and
  // leave the other project's remembered handle untouched.
  const localReferences = { ...references };

  for (const section of FOLDER_SECTIONS) {
    const ref = references[section];
    if (!ref.folderName) { clearProjectFolder(section); continue; }
    const stored = ref.folderId ? await recallProjectFolder(ref.folderId) : null;
    const handle = stored?.section === section ? stored.handle || null : null;
    let folderId = ref.folderId || newFolderId();
    const entry = { section, label: label(section), folderName: ref.folderName, folderId };
    if (stored && (stored.section !== section || (handle && handle.name !== ref.folderName))) {
      // This id is already claimed by a different remembered directory/section.
      // A name mismatch is a reason to reject, never evidence for substitution.
      folderId = newFolderId();
      localReferences[section] = { ...ref, folderId };
      bindProjectFolder(section, folderId, ref.folderName);
      pending.push({ ...entry, folderId, reason: 'changed' });
      continue;
    }
    if (!handle) {
      // No usable handle here: keep the imported id for confirmed adoption.
      // Older projects with no id receive a fresh pending id.
      localReferences[section] = { ...ref, folderId };
      bindProjectFolder(section, folderId, ref.folderName);
      pending.push({ ...entry, reason: 'missing' });
      continue;
    }
    let permission = 'granted';
    try { permission = await folderPermission(handle); } catch { permission = 'denied'; }
    if (permission === 'denied') {
      pending.push({ ...entry, reason: 'denied' });
      continue;
    }
    handles[section] = handle;
    bindProjectFolder(section, ref.folderId, ref.folderName);
    resolved.push(section);
    if (permission !== 'granted') reconnect.push({ section, label: label(section), folderName: ref.folderName });
  }

  importFolderReferences(localReferences, resolved);

  // Scripts: adopt the directory but never its sources. The source text never
  // travels — the project carries a fingerprint per file, and startup reopens only
  // the files whose bytes still match it (service.projectScripts); the operator
  // opens anything else explicitly.
  const script = await scriptStorage('active');
  const scriptFolder = references.scripts.folderName
    ? handles.scripts || script?.folder || await scriptStorage('folder')
    : null;
  await scriptStorage('active', { selectionVersion: 1, revision: Date.now(), sources: [], files: [], folder: scriptFolder, changed: [] });

  // Nodes: adopt the resolved directory, keeping its previous folder id only when
  // it is the very same entry (that id salts node pattern ids and retires drafts
  // opened from another folder — a project's identity is deliberately not reused
  // here; imported node ids come from the project's own file references).
  const nodes = await nodesStorage('handles');
  let nodesFolder = null;
  if (references.nodes.folderName) {
    if (handles.nodes) {
      const current = nodes?.folder;
      let same = false;
      if (current?.handle) { try { same = await current.handle.isSameEntry(handles.nodes); } catch { same = false; } }
      nodesFolder = { handle: handles.nodes, id: same ? current.id : newFolderId() };
    } else nodesFolder = nodes?.folder || null;
  }
  await nodesStorage('handles', { folder: nodesFolder, opened: [] });

  if (!references.media.folderName) await mediaStorage('folder', null);
  else if (handles.media) await mediaStorage('folder', handles.media);
  else log(`Media directory “${references.media.folderName}” still needs a link on this computer.`);

  return { resolved, pending, reconnect, mediaFolder: handles.media || null };
}

// Re-point metadata-only media records at their files inside a directory that was
// adopted by identity. Without this, switching projects on one computer would
// still mark every media pattern as missing.
export async function relinkImportedMedia(folderHandle) {
  if (!folderHandle || typeof folderHandle.getFileHandle !== 'function') return 0;
  let restored = 0;
  const records = await listMediaRecords().catch(() => []);
  for (const record of records) {
    if (!record || record.handle || !record.fileName) continue;
    if (record.folderName !== folderHandle.name) continue;
    try {
      const handle = await folderHandle.getFileHandle(record.fileName);
      await handle.getFile(); // A deleted file must not look linked.
      await putMediaRecord({ ...record, handle });
      restored += 1;
    } catch { /* Missing file: the pattern stays marked, never blocks the project. */ }
  }
  return restored;
}
