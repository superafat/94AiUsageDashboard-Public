export function LastUpdated({ value }: { value: string }) {
  return (
    <div className="last-updated">
      <span>最後更新</span>
      <strong>{new Date(value).toLocaleString('zh-TW', { hour12: false })}</strong>
      <span className="read-only-chip">只讀 v1</span>
    </div>
  );
}
