export function StatusPill({ label, tone = 'success' }: { label: string; tone?: 'success' | 'warning' | 'danger' | 'neutral' }) {
  return <span className="status-pill" data-tone={tone}><span aria-hidden="true" className="status-dot" />{label}</span>;
}
