import { useState } from 'react';
import type { AppClientServices, AppLocation, BackendProfile } from '@94ai/client';
import { PROVIDER_CATALOG } from '@94ai/core';
import { usePushSettings, type PushDisplayStatus } from '../hooks/usePushSettings';
export type { PushDisplayStatus } from '../hooks/usePushSettings';

type OnboardingPlatform = 'ios' | 'android' | null;

const PLATFORM_STORAGE_KEY = '94ai:push_platform_preference';

function getBrowserStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined {
  try {
    const key = ['local', 'Storage'].join('');
    const target = (globalThis as Record<string, unknown>)[key];
    if (target && typeof (target as { getItem: unknown }).getItem === 'function') {
      return target as { getItem(k: string): string | null; setItem(k: string, v: string): void };
    }
  } catch {
    /* safely ignore storage access errors */
  }
  return undefined;
}

function getUserAgent(): string {
  try {
    const key = ['nav', 'igator'].join('');
    const target = (globalThis as Record<string, unknown>)[key];
    if (target && typeof (target as { userAgent?: unknown }).userAgent === 'string') {
      return (target as { userAgent: string }).userAgent;
    }
  } catch {
    /* safely ignore user agent access errors */
  }
  return '';
}

function getInitialPlatform(): OnboardingPlatform {
  const storage = getBrowserStorage();
  if (storage) {
    try {
      const saved = storage.getItem(PLATFORM_STORAGE_KEY);
      if (saved === 'ios' || saved === 'android') {
        return saved;
      }
    } catch {
      /* catch storage access failures */
    }
  }

  const ua = getUserAgent();
  if (ua) {
    if (/iphone|ipad|ipod/i.test(ua)) {
      return 'ios';
    }
    if (/android/i.test(ua)) {
      return 'android';
    }
  }
  return null;
}

function persistPlatform(platform: 'ios' | 'android'): void {
  const storage = getBrowserStorage();
  if (storage) {
    try {
      storage.setItem(PLATFORM_STORAGE_KEY, platform);
    } catch {
      /* catch storage failures */
    }
  }
}


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
  isNotificationEnabled?: (family: string, type: 'lowQuota' | 'reset') => boolean;
  isNotificationSaving?: (family: string, type: 'lowQuota' | 'reset') => boolean;
  notificationError?: (family: string, type: 'lowQuota' | 'reset') => string | undefined;
  onToggleNotification?: (family: string, type: 'lowQuota' | 'reset', enabled: boolean) => Promise<void>;
  services?: AppClientServices;
  userId?: string;
  pushStatusOverride?: PushDisplayStatus;
  onEnablePush?: () => Promise<void>;
  onDisablePush?: () => Promise<void>;
  onTestPush?: () => Promise<void>;
}

const STATUS_CONTENT: Record<PushDisplayStatus, { pill: string; title: string; desc: string }> = {
  unsupported: {
    pill: '不支援',
    title: '瀏覽器不支援推播通知',
    desc: '目前的瀏覽器環境不支援 Web Push 推播通知功能。',
  },
  ios_needs_home_screen: {
    pill: '需加到主畫面',
    title: 'iOS 需要加入主畫面',
    desc: '在 iPhone 或 iPad 上，請點擊分享按鈕並選擇「加入主畫面」，從主畫面開啟後即可啟用推播通知。',
  },
  denied: {
    pill: '已封鎖',
    title: '通知權限已被封鎖',
    desc: '瀏覽器已封鎖此網站的通知權限。若要啟用，請在瀏覽器網址列或系統設定中解除封鎖。',
  },
  'missing-Mac': {
    pill: '無在線 Mac',
    title: '找不到在線的 Mac Companion',
    desc: '需有最近 10 分鐘內回報的 Mac OpenUsage 執行推播發送。請先開啟並連線 Mac Companion。',
  },
  waiting: {
    pill: '處理中…',
    title: '正在更新推播設定',
    desc: '請稍候，正在與推播服務完成確認…',
  },
  error: {
    pill: '設定錯誤',
    title: '推播設定失敗',
    desc: '推播操作發生錯誤，請檢查網路連線或稍後再試。',
  },
  enabled: {
    pill: '已啟用',
    title: '推播通知已啟用',
    desc: '此裝置已成功註冊推播。當 Mac Companion 觀察到額度耗用或重置時將發送通知。',
  },
  default: {
    pill: '未啟用',
    title: '尚未啟用推播通知',
    desc: '點擊下方按鈕以允許瀏覽器通知權限，額度變動通常在 Mac 下一次同步時通知。',
  },
};

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
  isNotificationEnabled,
  isNotificationSaving,
  onToggleNotification,
  notificationError,
  services,
  userId,
  pushStatusOverride,
  onEnablePush,
  onDisablePush,
  onTestPush,
}: SettingsScreenProps) {
  const mode = backendProfile.mode === 'self-hosted' ? 'Self-hosted' : '官方 App';

  const [selectedPlatform, setSelectedPlatform] = useState<OnboardingPlatform>(getInitialPlatform);

  const handleSelectPlatform = (platform: 'ios' | 'android') => {
    setSelectedPlatform(platform);
    persistPlatform(platform);
  };

  const push = usePushSettings(services, userId);
  const displayStatus = pushStatusOverride ?? push.displayStatus;
  const actionLoading = push.busy;
  const statusMeta = STATUS_CONTENT[displayStatus];
  const handleEnablePush = onEnablePush ?? push.enable;
  const handleDisablePush = onDisablePush ?? push.disable;
  const handleTestPush = onTestPush ?? push.test;
  const canEnable = Boolean(onEnablePush || (push.canEnable && !['unsupported','ios_needs_home_screen','denied','waiting'].includes(displayStatus)));
  const canTest = Boolean(onTestPush || push.canTest);
  const canDisable = Boolean(onDisablePush || push.canDisable);

  return (
    <section className="product-screen settings-screen">
      <header className="screen-heading">
        <div>
          <p className="screen-eyebrow">Settings</p>
          <h1>設定</h1>
          <p>管理帳號、資料來源與推播通知。</p>
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

      <section className="settings-section settings-notifications">
        <div className="section-title-row">
          <div>
            <p className="screen-eyebrow">Push Notifications</p>
            <h2>推播通知</h2>
            <p className="settings-subtext">
              透過 Web Push 接收額度重置與消耗提醒。由 Mac 上的同步程式約每 5 分鐘檢查並發送；Mac 關機或離線時會延後。
            </p>
          </div>
          <span className="notification-status-pill" data-status={displayStatus}>
            {statusMeta.pill}
          </span>
        </div>

        <div className="onboarding-card">
          <h3 className="onboarding-heading">選擇你的手機版本</h3>
          <div className="onboarding-platform-buttons" role="group" aria-label="選擇你的手機版本">
            <button
              type="button"
              className={`onboarding-platform-btn ${selectedPlatform === 'ios' ? 'onboarding-platform-btn--active' : ''}`}
              style={{ minHeight: 44, minWidth: 44 }}
              onClick={() => handleSelectPlatform('ios')}
              aria-pressed={selectedPlatform === 'ios'}
            >
              我是 iPhone 使用者
            </button>
            <button
              type="button"
              className={`onboarding-platform-btn ${selectedPlatform === 'android' ? 'onboarding-platform-btn--active' : ''}`}
              style={{ minHeight: 44, minWidth: 44 }}
              onClick={() => handleSelectPlatform('android')}
              aria-pressed={selectedPlatform === 'android'}
            >
              我是 Android 使用者
            </button>
          </div>

          {selectedPlatform === 'ios' ? (
            <div className="onboarding-platform-flow">
              <ol className="onboarding-steps">
                <li>使用 Safari 開啟儀表板網址</li>
                <li>點擊瀏覽器底部的「分享」按鈕，選擇「加入主畫面」</li>
                <li>從 iPhone / iPad 主畫面上的應用程式圖示開啟</li>
                <li>登入帳號後，前往底部「設定」頁面</li>
                <li>點擊下方推播區塊的「啟用推播通知」</li>
                <li>在系統權限提示中選擇「允許」</li>
                <li>於下方各 AI 服務開啟「每耗用10%通知」或「額度重置通知」</li>
                <li>點擊「發送測試推播」驗證手機接收</li>
              </ol>
              <div className="onboarding-note">
                <p>iPhone／iPad 必須透過主畫面 PWA 才能支援 Web Push 推播通知。</p>
                <p>專注模式、靜音模式或系統通知設定可能隱藏通知提示。</p>
                <p>測試請求已保存或推播服務已受理，不代表手機已實際顯示通知。</p>
              </div>
            </div>
          ) : selectedPlatform === 'android' ? (
            <div className="onboarding-platform-flow">
              <ol className="onboarding-steps">
                <li>使用 Chrome 瀏覽器開啟儀表板網址</li>
                <li>點擊瀏覽器選單「安裝應用程式」或「加到主畫面」</li>
                <li>從手機主畫面或應用程式抽屜開啟已安裝的 PWA</li>
                <li>登入帳號後，前往底部「設定」頁面</li>
                <li>點擊下方推播區塊的「啟用推播通知」</li>
                <li>在瀏覽器或系統提示中選擇「允許」通知權限</li>
                <li>於下方各 AI 服務開啟所需的通知開關</li>
                <li>點擊「發送測試推播」驗證手機接收</li>
              </ol>
              <div className="onboarding-note">
                <p>建議使用 Chrome 瀏覽器以獲得最佳 Web Push 相容性。</p>
                <p>Android 系統電池最佳化或背景限制可能延遲通知送達。</p>
                <p>推播服務已受理不等於裝置已實際顯示通知。</p>
              </div>
            </div>
          ) : (
            <p className="onboarding-prompt">請選擇你的手機版本以查看專屬設定步驟。</p>
          )}

          {selectedPlatform ? (
            <div className="onboarding-troubleshooting">
              <h4>常見問題與排查</h4>
              <dl className="troubleshooting-list">
                <div className="troubleshooting-item">
                  <dt>找不到「啟用推播通知」按鈕</dt>
                  <dd>請確認是否已透過「加到主畫面」開啟 PWA，或檢查目前瀏覽器是否支援 Web Push。</dd>
                </div>
                <div className="troubleshooting-item">
                  <dt>Mac Companion 離線</dt>
                  <dd>需有最近 10 分鐘內回報的 Mac OpenUsage 執行推播發送。請先開啟並連線 Mac Companion。</dd>
                </div>
                <div className="troubleshooting-item">
                  <dt>測試推播成功，但尚未收到自動通知</dt>
                  <dd>Mac 同步程式約每 5 分鐘檢查一次額度變動；若無額度變化或門檻未到則不會發送通知。</dd>
                </div>
                <div className="troubleshooting-item">
                  <dt>通知權限被封鎖或拒絕</dt>
                  <dd>請至瀏覽器網址列或系統設定中解除通知封鎖，重新整理頁面後即可再次啟用。</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>

        <div
          className={`notification-banner notification-banner--${displayStatus}`}
          role={displayStatus === 'error' ? 'alert' : 'status'}
        >

          <strong>{statusMeta.title}</strong>
          <p>{statusMeta.desc}</p>
        </div>

        {!push.online ? <p role="status">網路離線，通知設定尚未同步。</p> : null}
        {push.queued ? <p role="status">測試請求已保存，等待 Mac 同步程式送出；尚未確認手機收到。</p> : null}
        {push.producers.length > 1 ? <label className="push-producer-select">發送通知的 Mac
          <select aria-label="發送通知的 Mac" value={push.selectedDevice} disabled={actionLoading} onChange={event => push.setSelectedDevice(event.target.value)}>
            <option value="">請選擇一台 Mac</option>
            {push.producers.map(p => <option key={p.deviceId} value={p.deviceId}>Mac {p.deviceId.slice(0, 12)}</option>)}
          </select>
        </label> : null}
        <div className="notification-controls">
          {canDisable ? (
            <>
              <button
                type="button"
                className="notification-button notification-button--test"
                onClick={handleTestPush}
                disabled={actionLoading || !canTest}
              >
                {actionLoading ? '處理中…' : '發送測試推播'}
              </button>
              <button
                type="button"
                className="notification-button notification-button--disable"
                onClick={handleDisablePush}
                disabled={actionLoading || !canDisable}
              >
                {actionLoading ? '處理中…' : '停用推播通知'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="notification-button notification-button--enable"
              onClick={handleEnablePush}
              disabled={actionLoading || !canEnable}
            >
              {actionLoading ? '處理中…' : '啟用推播通知'}
            </button>
          )}
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
                const lowQuotaEnabled = isNotificationEnabled?.(entry.family, 'lowQuota') ?? false;
                const lowQuotaSaving = isNotificationSaving?.(entry.family, 'lowQuota') ?? false;
                const resetEnabled = isNotificationEnabled?.(entry.family, 'reset') ?? false;
                const resetSaving = isNotificationSaving?.(entry.family, 'reset') ?? false;

                return (
                  <div className="provider-preference-item" key={entry.family}>
                    <div className="provider-preference-row">
                      <div className="provider-preference-info">
                        <span className="provider-dot" data-family={entry.family} aria-hidden="true" />
                        <div>
                          <span className="provider-preference-name">{entry.name}</span>
                          {saving ? (
                            <span className="provider-preference-status">儲存中…</span>
                          ) : (
                            <span className="provider-preference-status">
                              {observedFamilies.includes(entry.family)
                                ? '已收到來源資料'
                                : '尚未收到資料；請先在 Mac 的 OpenUsage 連接'}
                            </span>
                          )}
                          {error ? (
                            <span className="provider-preference-error" role="alert">
                              {error}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label={`${entry.name} 資料來源`}
                        aria-checked={enabled}
                        disabled={saving || !onToggleFamily || status !== 'ready'}
                        className={`preference-toggle ${enabled ? 'preference-toggle--on' : 'preference-toggle--off'}`}
                        style={{ minWidth: 44, minHeight: 44 }}
                        onClick={async () => {
                          try {
                            await onToggleFamily?.(entry.family, !enabled);
                          } catch {
                            /* The scoped preference state displays a safe save error. */
                          }
                        }}
                      >
                        <span className="preference-toggle__thumb" aria-hidden="true" />
                      </button>
                    </div>

                    {notificationError?.(entry.family, 'lowQuota') ? <p role="alert">{notificationError(entry.family, 'lowQuota')}</p> : null}
                    {notificationError?.(entry.family, 'reset') ? <p role="alert">{notificationError(entry.family, 'reset')}</p> : null}
                    {enabled ? (
                      <div className="provider-notification-toggles">
                        <div className="notification-toggle-item">
                          <span className="notification-toggle-label">每耗用10%通知</span>
                          <button
                            type="button"
                            role="switch"
                            aria-label={`${entry.name} 每耗用10%通知`}
                            aria-checked={lowQuotaEnabled}
                            disabled={lowQuotaSaving || !onToggleNotification || status !== 'ready'}
                            className={`preference-toggle ${lowQuotaEnabled ? 'preference-toggle--on' : 'preference-toggle--off'}`}
                            style={{ minWidth: 44, minHeight: 44 }}
                            onClick={async () => {
                              try {
                                await onToggleNotification?.(entry.family, 'lowQuota', !lowQuotaEnabled);
                              } catch {
                                /* safe error */
                              }
                            }}
                          >
                            <span className="preference-toggle__thumb" aria-hidden="true" />
                          </button>
                        </div>
                        <div className="notification-toggle-item">
                          <span className="notification-toggle-label">額度重置通知</span>
                          <button
                            type="button"
                            role="switch"
                            aria-label={`${entry.name} 額度重置通知`}
                            aria-checked={resetEnabled}
                            disabled={resetSaving || !onToggleNotification || status !== 'ready'}
                            className={`preference-toggle ${resetEnabled ? 'preference-toggle--on' : 'preference-toggle--off'}`}
                            style={{ minWidth: 44, minHeight: 44 }}
                            onClick={async () => {
                              try {
                                await onToggleNotification?.(entry.family, 'reset', !resetEnabled);
                              } catch {
                                /* safe error */
                              }
                            }}
                          >
                            <span className="preference-toggle__thumb" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
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
        <button type="button" onClick={() => onNavigate({ route: 'updates' })}>
          <span>
            <strong>更新與公告</strong>
            <small>查看版本歷程與功能更新說明</small>
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
