import type { AppLocation } from '@94ai/client';
import { BeeMascot } from '../components/BeeMascot';

export function WelcomeScreen({ onNavigate }: { onNavigate: (location: AppLocation) => void }) {
  return <main className="welcome-screen">
    <section className="welcome-hero"><span className="welcome-brand"><BeeMascot size={32} /></span><p className="screen-eyebrow">94AiUsageDashboard</p><h1>手機查看 AI 額度，<br />不再靠猜。</h1><p>把 Codex、Antigravity、Claude Code 的額度、重置時間與使用趨勢整理在同一個地方。</p>
      <div className="welcome-actions"><button className="primary-button" type="button" onClick={() => onNavigate({ route: 'getting-started' })}>開始設定</button><button className="secondary-button" type="button" onClick={() => onNavigate({ route: 'help' })}>先看隱私說明</button></div>
    </section>
    <section className="welcome-preview" aria-label="產品功能預覽"><div className="welcome-preview__header"><span>蜂神榜 Ai 額度儀表板</span><b>51%</b></div><div className="welcome-preview__bar"><i /></div><div className="welcome-preview__stats"><span>5 小時額度</span><span>每週額度</span><span>使用統計</span></div></section>
    <section className="welcome-features"><article><b>01</b><strong>Mac 讀取</strong><p>Mac Companion 從你的 AI 工具取得額度與本機使用統計。</p></article><article><b>02</b><strong>最小同步</strong><p>只同步額度與彙總統計，不上傳對話與程式碼。</p></article><article><b>03</b><strong>手機查看</strong><p>Web/PWA 現在可用，架構已準備未來 Android 與 iPhone App。</p></article></section>
    <section className="privacy-promise"><span className="leaf-mark" aria-hidden="true"><i /><i /></span><div><strong>Provider 憑證留在 Mac</strong><p>Codex、Antigravity、Claude 的登入憑證不會送到手機 App 或雲端資料庫。</p></div></section>
  </main>;
}
