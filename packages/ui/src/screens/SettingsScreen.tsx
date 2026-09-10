import type { AppLocation, BackendProfile } from '@94ai/client';
import { PROVIDER_CATALOG } from '@94ai/core';

export interface SettingsScreenProps {
  userName: string;
  backendProfile: BackendProfile;
  onNavigate: (location: AppLocation) => void;
  onSignOut: () => Promise<void>;
  observedFamilies?: readonly string[];
  status?: 'idle' | 'loading' | 'ready' | 'error';
  hasObserved?: boolean;
  isFamilyEnabled?: (family: string) => boolean;
  isFamilySaving?: (family: string) => boolean;
  familyError?: (family: string) => string | undefined;
  onToggleFamily?: (family: string, enabled: boolean) => Promise<void>;
}

export function SettingsScreen({
  userName,
  backendProfile,
  onNavigate,
  onSignOut,
  observedFamilies = [],
  status = 'ready',
  hasObserved = true,
  isFamilyEnabled = (family) => ['codex', 'antigravity', 'claude'].includes(family),
  isFamilySaving = () => false,
  familyError = () => undefined,
  onToggleFamily,
}: SettingsScreenProps) {
  const mode = backendProfile.mode === 'self-hosted' ? 'Self-hosted' : '官方 App';

  return (
    <section className="product-screen settings-screen">
      <header className="screen-heading">
        <div>
          <p className="screen-eyebrow">Settings</p>
          <h1>設定</h1>
          <p>管理帳號、資料來源與使用說明。</p>
        </div>
      </header>

      <section className="settings-account">
        <span className="profile-avatar profile-avatar--small" aria-hidden="true" />
        <div>
          <strong>{userName}</strong>
          <span>{mode}</span>
          <small>{backendProfile.label}</small>
        </div>
      </section>

      <section className="settings-section settings-providers">
        <div className="section-title-row">
          <div>
            <p className="screen-eyebrow">Data Sources</p>
            <h2>資料來源偏好</h2>
            <p className="settings-subtext">
              選擇要在儀表板與統計中顯示的 AI 服務來源。關閉來源不會登出或變更 Mac 本機 OpenUsage 設定。
            </p>
          </div>
        </div>

        {status === 'loading' ? (
          <div className="state-card">正在載入偏好設定…</div>
        ) : status === 'error' && !hasObserved ? (
          <div className="state-card state-card--error" role="alert">
            <strong>偏好設定讀取失敗</strong>
            <p>無法取得資料來源偏好設定，請檢查網路連線或稍後再試。</p>
          </div>
        ) : (
          <>
            {status === 'error' ? (
              <div className="home-alert home-alert--danger" role="alert">
                <strong>偏好設定讀取失敗</strong>
                <span>保留最後成功設定。</span>
              </div>
            ) : null}
            <div className="provider-preference-list" role="group" aria-label="資料來源開關列表">
          {PROVIDER_CATALOG.map((entry) => {
            const enabled = isFamilyEnabled(entry.family);
            const saving = isFamilySaving(entry.family);
            const error = familyError(entry.family);

            return (
              <div className="provider-preference-row" key={entry.family}>
                <div className="provider-preference-info">
                  <span className="provider-dot" data-family={entry.family} aria-hidden="true" />
                  <div>
                    <span className="provider-preference-name">{entry.name}</span>
                    {saving ? <span className="provider-preference-status">儲存中…</span> : <span className="provider-preference-status">{observedFamilies.includes(entry.family) ? '已收到來源資料' : '尚未收到資料；請先在 Mac 的 OpenUsage 連接'}</span>}
                    {error ? <span className="provider-preference-error" role="alert">{error}</span> : null}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label={`${entry.name} 資料來源`}
                  aria-checked={enabled}
                  disabled={saving || !onToggleFamily || status !== 'ready'}
                  className={`preference-toggle ${enabled ? 'preference-toggle--on' : 'preference-toggle--off'}`}
                  onClick={async () => {
                    try { await onToggleFamily?.(entry.family, !enabled); }
                    catch { /* The scoped preference state displays a safe save error. */ }
                  }}
                >
                  <span className="preference-toggle__thumb" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <p className="settings-feature-note">
          通知設定將於未來版本支援。目前僅記錄偏好設定，不傳送推播通知。
        </p>
        </>
      )}
      </section>

      <div className="settings-list">
        <button type="button" onClick={() => onNavigate({ route: 'getting-started' })}>
          <span>
            <strong>Mac Companion 與開始使用</strong>
            <small>重新查看安裝與連接步驟</small>
          </span>
          <b>›</b>
        </button>
        <button type="button" onClick={() => onNavigate({ route: 'help' })}>
          <span>
            <strong>使用說明與隱私</strong>
            <small>了解額度、統計與資料邊界</small>
          </span>
          <b>›</b>
        </button>
      </div>

      <section className="settings-privacy">
        <strong>Provider 憑證不離開 Mac</strong>
        <p>App 不需要你的任何 Provider Token 或 API Key。Self-hosted 資料依自己的 Firebase 帳號隔離。</p>
      </section>

      <button className="signout-button" type="button" onClick={() => void onSignOut()}>
        登出
      </button>
    </section>
  );
}
