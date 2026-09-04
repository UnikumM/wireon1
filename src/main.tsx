import React from 'react';
import ReactDOM from 'react-dom/client';
// Every selectable typeface ships as a static import. A dynamic `import()` per
// choice would sound cleaner, but it flashes the system font on every switch,
// and in the packaged app the files are local anyway — nothing is saved.
import '@fontsource-variable/onest';
import '@fontsource-variable/golos-text';
import '@fontsource-variable/manrope';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import './styles/global.css';
import { MiniWindow } from './components/player/mini';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { handleAuthCallbackPage } from './services/discordAuth';
import { useThemeStore } from './store/useThemeStore';
import { usePlayerLayoutStore } from './store/usePlayerLayoutStore';

/**
 * Three documents share this bundle: the app, the OAuth callback popup and the
 * always-on-top mini player. Each one is picked here, because booting the full
 * app in the other two would start a second player and a second sync loop.
 */
function renderRoot(): void {
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

  // Colour and depth are restored before the first render, and for every window
  // that shows the interface: the mini player draws its own document and would
  // otherwise stay on the built-in accent while the main window uses the chosen
  // one. `hydrateTheme` is guarded against a second read, so the same call from
  // App costs nothing.
  void useThemeStore.getState().hydrateTheme();

  // Player layout is restored here for the same reason, plus one of its own: the
  // bar reads it on mount, and the mini player never mounts the bar. Both calls
  // are guarded, so whichever runs second is a no-op.
  void usePlayerLayoutStore.getState().hydratePlayerLayout();

  if (window.electronAPI?.isMiniWindow) {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <MiniWindow />
        </ErrorBoundary>
      </React.StrictMode>
    );
    return;
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// The OAuth redirect lands on this same document. When it does, the callback
// handler posts the code back to the opener and closes the popup, so the app
// itself must never boot into that window.
if (!handleAuthCallbackPage()) {
  renderRoot();
}
