import type { AppLocation } from '@94ai/client';

export function HelpScreen({ onNavigate }: { onNavigate: (location: AppLocation) => void }) {
  return <section className="product-screen help-screen">
    <header className="screen-heading"><div><p className="screen-eyebrow">Help & privacy</p><h1>使用說明與隱私</h1><p>先知道資料怎麼流動，再決定要不要使用。</p></div></header>
    <div className="help-grid"><article><span>01</span><h2>看到什麼</h2><p>目前額度、重置時間、Reset Credits、Token 使用趨勢與估算 API 等值費用。</p></article><article><span>02</span><h2>資料從哪來</h2><p>Mac Companion 使用受管理的 OpenUsage 引擎，讀取你電腦上既有的 AI 工具狀態。</p></article><article><span>03</span><h2>什麼不上傳</h2><p><strong>Provider Token 不會上傳</strong>。Prompt、Response、程式碼、Cookie、原始 Session 也不會進入雲端。</p></article><article><span>04</span><h2>費用代表什麼</h2><p>費用是依本機 Token 使用與模型價格計算的 API 等值估算，不等於你的訂閱帳單或實際扣款。</p></article></div>
    <section className="privacy-flow-card"><strong>Mac → 最小化彙總 → 你的手機</strong><p>雲端只保存顯示產品所需的額度快照、每日 Token/估算費用彙總與必要同步狀態，並依帳號隔離。</p></section>
    <button className="secondary-button" type="button" onClick={() => onNavigate({ route: 'getting-started' })}>查看開始使用流程</button>
  </section>;
}
