// Portable hints, never native handles or file contents. Names are not identities:
// an imported folder must be confirmed explicitly — unless this computer already
// remembers that directory identity (see project-folders.js), in which case the
// handle is adopted without asking.
export const FOLDER_REFERENCES_KEY = 'viz2_folder_references';
export const FOLDER_SECTIONS = ['scripts', 'nodes', 'media'];
const labels = { scripts: 'Custom Scripts', nodes: 'Node Patterns', media: 'Media' };
const safeName = value => typeof value === 'string' && value.length <= 255 && value.length > 0 && !/[\\/\x00-\x1f]/.test(value) && value !== '.' && value !== '..';
const safeId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);

export function sanitizeFolderReferences(raw) {
  if (raw === undefined) return undefined; // Old exports did not carry references.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid folder references.');
  const result = {};
  for (const section of FOLDER_SECTIONS) {
    const entry = raw[section];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files) || entry.files.length > 256 ||
        (entry.folderName !== null && !safeName(entry.folderName))) throw new Error(`Invalid ${labels[section]} folder reference.`);
    const ids = new Set();
    const files = entry.files.map(file => {
      if (!file || !safeName(file.fileName)) throw new Error(`Invalid ${labels[section]} filename.`);
      if (file.id !== undefined && (typeof file.id !== 'string' || !/^[\w-]{1,100}$/.test(file.id) || (section === 'nodes' && !file.id.startsWith('nodes-')) || ids.has(file.id))) throw new Error(`Invalid or duplicate ${labels[section]} file ID.`);
      if (file.id) ids.add(file.id);
      // Script files may carry a fingerprint (SHA-256) of the source they had when
      // the project was saved. It is identity of *content*, never the content and
      // never trust: it only lets an unchanged file open itself on load. Anything
      // malformed is dropped rather than guessed at.
      const digest = section === 'scripts' && typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256)
        ? { sha256: file.sha256 } : {};
      return { fileName: file.fileName, linked: file.linked === true,
        ...(typeof file.id === 'string' && /^[\w-]{1,100}$/.test(file.id) ? { id: file.id } : {}),
        ...digest };
    });
    result[section] = {
      folderName: entry.folderName,
      // Directory identity, not a name: the importing computer looks the native
      // handle up by this id (project-folders.js) before asking for a re-link.
      folderId: safeId(entry.folderId) ? entry.folderId : null,
      files,
    };
  }
  return result;
}

export function folderReference(section) {
  const raw = localStorage.getItem(FOLDER_REFERENCES_KEY);
  return raw ? JSON.parse(raw)[section] : undefined;
}

// `resolved` lists the sections this computer recognized by directory identity.
// Only the remaining ones are flagged as needing an explicit relink.
export function importFolderReferences(references, resolved = []) {
  if (!references) { localStorage.removeItem(FOLDER_REFERENCES_KEY); return; }
  const clean = sanitizeFolderReferences(references);
  const adopted = new Set(resolved);
  for (const [section, entry] of Object.entries(clean)) entry.needsRelink = !!entry.folderName && !adopted.has(section);
  localStorage.setItem(FOLDER_REFERENCES_KEY, JSON.stringify(clean));
}

export function patchFolderReference(section, patch) {
  const raw = localStorage.getItem(FOLDER_REFERENCES_KEY);
  if (!raw) return;
  const refs = JSON.parse(raw);
  if (!refs[section]) return;
  refs[section] = { ...refs[section], ...patch };
  localStorage.setItem(FOLDER_REFERENCES_KEY, JSON.stringify(refs));
}

export function assertFolderReference(section, handle, choosing = false) {
  const ref = folderReference(section);
  if (!ref?.folderName) return;
  const label = labels[section];
  if (handle?.name !== ref.folderName) throw new Error(`${label}: expected folder “${ref.folderName}”, found ${handle ? `“${handle.name}”` : 'no linked folder'}. Use Relink Folder to select “${ref.folderName}”.`);
  if (ref.needsRelink && !choosing) throw new Error(`${label}: Relink Folder to confirm “${ref.folderName}”. Folder names alone cannot identify a directory.`);
}

export function confirmFolderReference(section) {
  patchFolderReference(section, { needsRelink: false });
}

// New Project: drop every portable hint. The linked handles themselves are
// cleared by each section's Unlink; the remembered directory identities stay, so
// an older project file can still resume its folders here without re-linking.
export function clearFolderReferences() {
  try {
    localStorage.removeItem(FOLDER_REFERENCES_KEY);
  } catch {
    /* private mode — nothing else to clear */
  }
}

// Referenced files a successful scan did not find. Missing *files* never block a
// project: they are reported and marked, and the operator restores them later.
export function missingFolderFileNames(section, names) {
  return (folderReference(section)?.files || [])
    .filter(file => file.linked && !names.includes(file.fileName))
    .map(file => ({ fileName: file.fileName, ...(file.id ? { id: file.id } : {}) }));
}

export function missingFolderFiles(section, names) {
  return missingFolderFileNames(section, names)
    .map(file => `${labels[section]}: missing “${file.fileName}”. Restore the file, then Refresh folder or Relink Folder.`);
}

export function referencedFileId(section, name, linked) {
  const matches = folderReference(section)?.files.filter(file => file.fileName === name && file.linked === linked) || [];
  if (matches.length > 1) throw new Error(`${name}: multiple imported references share this filename. Names alone cannot identify the original file.`);
  return matches[0]?.id;
}

export function forgetFolderFile(section, value) {
  const raw = localStorage.getItem(FOLDER_REFERENCES_KEY);
  if (!raw) return;
  const refs = JSON.parse(raw);
  if (!refs[section]) return;
  refs[section].files = refs[section].files.filter(file => section === 'media' ? file.id !== value : file.fileName !== value);
  localStorage.setItem(FOLDER_REFERENCES_KEY, JSON.stringify(refs));
}
