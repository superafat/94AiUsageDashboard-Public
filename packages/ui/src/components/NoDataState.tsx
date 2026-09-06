export function NoDataState({ connected = false }: { connected?: boolean } = {}) {
  if (connected) {
    return <div className="state-card"><strong>來源已連接，但目前沒有可顯示的額度資料</strong><p>其他已連接的 AI 額度仍可正常使用；來源提供新資料後會自動顯示。</p></div>;
  }
  return <div className="state-card"><strong>目前沒有可顯示的額度資料</strong><p>請確認 Mac 上的 OpenUsage 與同步程式是否正常。</p></div>;
}
