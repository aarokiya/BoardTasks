import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/globals.css';

if (!window.boardtasks) {
  document.body.innerHTML = '<p style="font:14px -apple-system;padding:24px">Preload bridge missing. This is a packaging bug — please report it.</p>';
  throw new Error('Preload bridge missing');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
