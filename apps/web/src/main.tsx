import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppClientServices } from '@94ai/client';
import { AppRoot } from '@94ai/ui';
import { createE2EServices } from './e2e-fixtures';
import { createWebClientServices } from './services';
import '@94ai/ui/styles/tokens.css';
import '@94ai/ui/styles/app.css';

function servicesForRuntime(): AppClientServices {
  return import.meta.env.VITE_E2E === '1'
    ? createE2EServices(new URLSearchParams(location.search).get('fixture'))
    : createWebClientServices();
}

const services = servicesForRuntime();
createRoot(document.getElementById('root')!).render(<StrictMode><AppRoot services={services} /></StrictMode>);
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
