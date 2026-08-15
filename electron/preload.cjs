// Preload runs before the renderer and is the only bridge across the isolation
// boundary. It exposes named operations, never `ipcRenderer` itself.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  openProject: (path) => ipcRenderer.invoke('project:open', path),
  // `reuse` lets the renderer say what it already has, so main only re-encodes
  // the clips whose artwork actually changed. See prepare.js.
  prepareProject: (project, basePath, reuse) =>
    ipcRenderer.invoke('project:prepare', { project, basePath, reuse }),
  saveProject: (project, path, saveAs) =>
    ipcRenderer.invoke('project:save', { project, path, saveAs }),
  listExamples: () => ipcRenderer.invoke('project:examples'),

  importAssets: (kind) => ipcRenderer.invoke('asset:import', kind),
  // Electron 32 removed File.path; webUtils is the supported way to turn a
  // dropped File back into a filesystem path, and it only exists in preload.
  pathForFile: (file) => webUtils.getPathForFile(file),
  describeFiles: (paths) => ipcRenderer.invoke('asset:describe', paths),
  // Fallback when a dropped File has no filesystem path: send the bytes.
  ingestFiles: (files) => ipcRenderer.invoke('asset:ingest', files),
  // Bytes for the preview mixer to decode; the renderer has no file access.
  readAudio: (path) => ipcRenderer.invoke('audio:read', path),
  transcribe: (src) => ipcRenderer.invoke('subtitles:transcribe', { src }),
  onTranscribeProgress: (fn) => {
    const wrapped = (_e, p) => fn(p);
    ipcRenderer.on('subtitles:progress', wrapped);
    return () => ipcRenderer.removeListener('subtitles:progress', wrapped);
  },
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  // Bytes of a bundled face, so the picker can preview each name in its own
  // type. Only faces in assets/fonts are readable; see the handler in main.
  readFont: (path) => ipcRenderer.invoke('fonts:read', path),
  listHands: () => ipcRenderer.invoke('hands:list'),

  exportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  startExport: (project, out) => ipcRenderer.invoke('export:start', { project, out }),
  // Returns an unsubscribe function so React effects can clean up; handing the
  // caller's own function to removeListener would not match the wrapper we
  // actually registered.
  onExportProgress: (fn) => {
    const wrapped = (_e, p) => fn(p);
    ipcRenderer.on('export:progress', wrapped);
    return () => ipcRenderer.removeListener('export:progress', wrapped);
  },
  // Application-menu clicks. Same unsubscribe contract as onExportProgress,
  // and for the same reason: the wrapper is what was registered, not `fn`.
  onMenuCommand: (fn) => {
    const wrapped = (_e, id) => fn(id);
    ipcRenderer.on('menu:command', wrapped);
    return () => ipcRenderer.removeListener('menu:command', wrapped);
  },
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
});
