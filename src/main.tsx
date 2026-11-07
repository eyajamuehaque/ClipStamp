import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/anton';
import '@fontsource/bebas-neue';
import '@fontsource/oswald/700.css';
import '@fontsource/permanent-marker';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource-variable/bricolage-grotesque';
import './index.css';
import App from './App';
import { clearExportFiles } from './engine/export';
import { registerSW } from 'virtual:pwa-register';

// Cache the whole app so it opens and works with no internet connection.
registerSW({ immediate: true });

// A download link doesn't survive a reload, so the exports behind them can go.
void clearExportFiles();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
