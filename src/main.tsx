import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Gracefully handle benign Vite HMR websocket connection errors in preview iframes
if (typeof window !== 'undefined') {
  const ignoreBenignErrors = (event: ErrorEvent | PromiseRejectionEvent) => {
    const errorMsg = 'message' in event ? event.message : (event.reason?.message || String(event.reason || ''));
    if (
      /websocket|websocket closed|failed to connect/i.test(errorMsg) ||
      errorMsg.includes('WebSocket') ||
      errorMsg.includes('HMR')
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener('unhandledrejection', ignoreBenignErrors);
  window.addEventListener('error', ignoreBenignErrors);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
