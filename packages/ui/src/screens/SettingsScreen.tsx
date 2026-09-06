import type { AppLocation, BackendProfile } from '@94ai/client';

export function SettingsScreen({ userName, backendProfile, onNavigate, onSignOut }: { userName: string; backendProfile: BackendProfile; onNavigate: (location: AppLocation) => void; onSignOut: () => Promise<void> }) {
  const mode = backendProfile.mode === 'self-hosted' ? 'Self-hosted' : '官方 App';
  return <section className="product-screen settings-screen">
    <header className="screen-heading"><div><p className="screen-eyebrow">Settings</p><h1>設定</h1><p>管理帳號、資料模式與使用說明。</p></div></header>
    <section className="settings-account"><span className="profile-avatar profile-avatar--small" aria-hidden="true" /><div><strong>{userName}</strong><span>{mode}</span><small>{backendProfile.label}</small></div></section>
    <div className="settings-list"><button type="button" onClick={() => onNavigate({ route: 'getting-started' })}><span><strong>Mac Companion 與開始使用</strong><small>重新查看安裝與連接步驟</small></span><b>›</b></button><button type="button" onClick={() => onNavigate({ route: 'help' })}><span><strong>使用說明與隱私</strong><small>了解額度、統計與資料邊界</small></span><b>›</b></button></div>
    <section className="settings-privacy"><strong>Provider 憑證不離開 Mac</strong><p>App 不需要你的 Codex、Antigravity 或 Claude Token。Self-hosted 資料依自己的 Firebase 帳號隔離。</p></section>
    <button className="signout-button" type="button" onClick={() => void onSignOut()}>登出</button>
  </section>;
}
