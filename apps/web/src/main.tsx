// Entry point of the web app.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { startApp, useApp } from './state/store.ts';
import './styles.css';

/** The whole app is drawn again when the language changes (texts are translated while drawing). */
function Root(): React.JSX.Element {
  const lang = useApp((s) => s.lang);
  return <App key={lang} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
void startApp();

// Offline shell (installable app on phones), only for the built app on a secure page.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => { /* not available */ }); });
}
