import { useEffect, useState, type ReactNode } from 'react';
import { useStore, edit, removeAudioClip, type Tool } from './store';
import Stage from './components/Stage';
import Timeline from './components/Timeline';
import ClipStrip from './components/ClipStrip';
import { MediaPanel, TextPanel, LogoPanel, RemovePanel, AdjustPanel, ColorPanel, AudioPanel, ExportPanel } from './components/Panels';
import { togglePlay, stepFrame, addVideoFiles } from './player';
import { loadProject, saveProject } from './engine/persist';

const I = (d: string) => <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;

const TOOLS: { id: Tool; label: string; icon: ReactNode; panel: () => ReactNode }[] = [
  { id: 'media', label: 'Clip', icon: I('M4 6h16v12H4zM10 9v6l5-3z'), panel: MediaPanel },
  { id: 'text', label: 'Text', icon: I('M5 6h14M12 6v13M9 19h6'), panel: TextPanel },
  { id: 'logo', label: 'Logo', icon: I('M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01'), panel: LogoPanel },
  { id: 'remove', label: 'Remove', icon: I('M4 7h16M7 7v12h10V7M10 4h4M10 11v5M14 11v5'), panel: RemovePanel },
  { id: 'adjust', label: 'Frame', icon: I('M7 3v14h14M3 7h14v14'), panel: AdjustPanel },
  { id: 'color', label: 'Colour', icon: I('M12 3a9 9 0 100 18c1 0 1.5-.8 1.2-1.6-.4-1 .3-2.4 1.6-2.4H17a4 4 0 004-4c0-5-4-10-9-10zM7.5 11h.01M10 7h.01M14.5 7h.01'), panel: ColorPanel },
  { id: 'audio', label: 'Audio', icon: I('M9 18V6l11-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z'), panel: AudioPanel },
  { id: 'export', label: 'Export', icon: I('M12 4v11M7 10l5 5 5-5M5 20h14'), panel: ExportPanel },
];

type InstallEvent = Event & { prompt: () => Promise<void> };

export default function App() {
  const tool = useStore(s => s.tool);
  const notice = useStore(s => s.notice);
  const canUndo = useStore(s => s.past.length > 0);
  const canRedo = useStore(s => s.future.length > 0);
  const [restoring, setRestoring] = useState(true);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const supported = typeof window.VideoEncoder !== 'undefined' && typeof window.OffscreenCanvas !== 'undefined';

  // Restore the autosaved project (videos included) on load.
  useEffect(() => {
    loadProject().then(doc => {
      if (doc && doc.clips.length) {
        useStore.getState().replaceDoc(doc);
        useStore.setState({ currentClipId: doc.clips[0].id });
      }
      setRestoring(false);
    });
  }, []);

  // Autosave a moment after each change.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    let last = useStore.getState().doc;
    return useStore.subscribe(s => {
      if (restoring || s.doc === last) return;
      last = s.doc;
      clearTimeout(t);
      t = setTimeout(() => saveProject(s.doc).catch(e => console.warn('Autosave failed', e)), 1200);
    });
  }, [restoring]);

  useEffect(() => {
    const onInstall = (e: Event) => { e.preventDefault(); setInstall(e as InstallEvent); };
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('beforeinstallprompt', onInstall);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('beforeinstallprompt', onInstall); window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return; }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1); }
      else if (e.key === 's' && !mod) (document.querySelector('[title^="Split this clip"]') as HTMLButtonElement | null)?.click();
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selectedOverlayId && s.stageMode === 'output') {
          edit(d => ({ ...d, overlays: d.overlays.filter(o => o.id !== s.selectedOverlayId) }));
          useStore.setState({ selectedOverlayId: null });
        } else if (s.selectedSeg) {
          const { hideId, segId } = s.selectedSeg;
          edit(d => ({ ...d, hides: d.hides.map(h => h.id === hideId ? { ...h, segments: h.segments.filter(x => x.id !== segId) } : h) }));
          useStore.setState({ selectedSeg: null });
        } else if (s.selectedAudioId) {
          removeAudioClip(s.selectedAudioId);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const Panel = TOOLS.find(t => t.id === tool)!.panel;

  return (
    <div className="app"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); addVideoFiles([...e.dataTransfer.files]); } }}>
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
            <rect x="3" y="7" width="26" height="18" rx="2" fill="#f2c14e" />
            <g fill="#1b1f27">{[6, 11, 16, 21, 26].map(x => <rect key={x} x={x - 1.5} y="9" width="3" height="2.4" rx=".6" />)}{[6, 11, 16, 21, 26].map(x => <rect key={'b' + x} x={x - 1.5} y="20.6" width="3" height="2.4" rx=".6" />)}</g>
            <path d="M13 13.2v5.6l5-2.8z" fill="#1b1f27" />
          </svg>
          <span className="brand-name">Clipsmith</span>
          <span className="brand-tag">Free video editor that runs on your device</span>
        </div>
        <div className="bar-actions">
          <button className="icon-btn" onClick={() => useStore.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">{I('M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3')}</button>
          <button className="icon-btn" onClick={() => useStore.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">{I('M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3')}</button>
          <span className={'status ' + (online ? '' : 'off')} title="Editing never needs a connection">{online ? 'Private · files stay here' : 'Offline · still works'}</span>
          {install && <button className="btn sm" onClick={async () => { await install.prompt(); setInstall(null); }}>Install app</button>}
          <button className="btn primary sm" onClick={() => useStore.setState({ tool: 'export' })}>Export</button>
        </div>
      </header>

      {!supported && (
        <div className="banner">This browser can't encode video. Open Clipsmith in a recent Chrome, Edge or Safari 17+ to export.</div>
      )}

      <main className="work">
        <nav className="rail" aria-label="Tools">
          {TOOLS.map(t => (
            <button key={t.id} className={tool === t.id ? 'on' : ''} aria-current={tool === t.id}
              onClick={() => useStore.setState({ tool: t.id, stageMode: t.id === 'remove' ? 'hide' : t.id === 'text' || t.id === 'logo' ? 'output' : useStore.getState().stageMode })}>
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
        </nav>
        <aside className="panel" aria-label={TOOLS.find(t => t.id === tool)!.label + ' settings'}>
          <Panel />
        </aside>
        <section className="center">
          {restoring ? <div className="drop"><p>Opening your last project…</p></div> : <Stage />}
          <Timeline />
          <ClipStrip />
        </section>
      </main>

      {notice && <div className={'toast ' + notice.kind} role="status">{notice.text}</div>}
    </div>
  );
}
