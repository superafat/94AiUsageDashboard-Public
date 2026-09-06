import { useState } from 'react';
import type { AppLocation, AuthFailureCode } from '@94ai/client';

function signInMessage(error: unknown): string {
  const raw = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
  const code: AuthFailureCode = ['interaction-blocked', 'cancelled', 'network', 'configuration'].includes(raw) ? raw as AuthFailureCode : 'unknown';
  if (code === 'interaction-blocked') return '登入流程未能開啟。請允許登入視窗後再試。';
  if (code === 'cancelled') return '登入尚未完成，請再試一次。';
  if (code === 'network') return '目前無法連線，請確認網路後再試。';
  if (code === 'configuration') return '登入服務尚未設定完成，請聯絡管理者。';
  return '登入未成功，請稍後重試。';
}

export function GettingStartedScreen({ signedIn, onSignIn, onNavigate }: { signedIn: boolean; onSignIn: () => Promise<void>; onNavigate: (location: AppLocation) => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const signIn = async () => {
    if (pending) return;
    setPending(true); setMessage(null);
    try { await onSignIn(); } catch (error) { setMessage(signInMessage(error)); } finally { setPending(false); }
  };
  return <section className="product-screen setup-screen">
    <header className="screen-heading"><div><p className="screen-eyebrow">3 steps</p><h1>開始使用</h1><p>一般使用者只需要登入、安裝 Mac Companion、連接自己的 AI 工具。</p></div></header>
    <div className="setup-steps"><article data-ready={signedIn}><b>1</b><div><strong>登入 App</strong><p>使用自己的帳號識別你的額度資料。</p></div>{signedIn ? <span>已完成</span> : <button type="button" disabled={pending} onClick={() => void signIn()}>{pending ? '登入中…' : '使用 Google 登入'}</button>}</article>
      <article><b>2</b><div><strong>安裝 Mac Companion</strong><p>Mac 背景程式會安全取得額度與使用統計；未來 App 會提供配對引導。</p></div><span>Mac</span></article>
      <article><b>3</b><div><strong>連接你的 AI 工具</strong><p>在 Codex、Antigravity 或 Claude Code 正常登入後，資料會自動出現。</p></div><span>自動偵測</span></article></div>
    {message ? <p className="home-alert" role="alert">{message}</p> : null}
    <div className="setup-note"><strong>你不需要提供 AI Token</strong><p>Provider 憑證留在 Mac；目前 Self-hosted 進階模式仍可使用自己的 Firebase。</p></div>
    <button className="secondary-button" type="button" onClick={() => onNavigate({ route: 'help' })}>查看完整使用說明</button>
  </section>;
}
