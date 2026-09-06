import type { AppRoute } from '@94ai/client';

export function NavIcon({ route }: { route: AppRoute }) {
  if (route === 'dashboard') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3l8.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-4v6H5a1.5 1.5 0 0 1-1.5-1.5Z" /></svg>;
  if (route === 'usage') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6" /></svg>;
  if (route === 'resets') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 8.2A8 8 0 1 0 20 15M19.5 8.2V3.5M19.5 8.2h-4.7" /></svg>;
  if (route === 'settings') return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" /></svg>;
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>;
}
