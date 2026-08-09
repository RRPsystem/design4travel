import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewApp } from './PreviewApp.js';

const container = document.getElementById('preview-root');
if (!container) throw new Error('Missing #preview-root');
createRoot(container).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>,
);
