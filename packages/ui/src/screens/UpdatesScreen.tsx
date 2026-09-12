import type { AppLocation } from '@94ai/client';
import { RELEASE_NOTES, type ReleaseNoteEntry } from '@94ai/core';

export interface UpdatesScreenProps {
  onNavigate: (location: AppLocation) => void;
  entries?: readonly ReleaseNoteEntry[];
}

export function UpdatesScreen({ onNavigate, entries = RELEASE_NOTES }: UpdatesScreenProps) {
  return (
    <section className="product-screen updates-screen">
      <button
        type="button"
        className="back-button"
        onClick={() => onNavigate({ route: 'settings' })}
        aria-label="返回設定"
      >
        ‹ 返回設定
      </button>

      <header className="screen-heading">
        <div>
          <p className="screen-eyebrow">Updates & Announcements</p>
          <h1>更新與公告</h1>
          <p>查看最新版本紀錄、功能公告與改進說明。</p>
        </div>
      </header>

      <div className="updates-list" role="feed" aria-label="版本更新紀錄">
        {entries.map((entry) => {
          const isCurrent = entry.status === 'current';
          return (
            <article
              key={entry.version}
              className={`update-card${isCurrent ? ' update-card--current' : ''}`}
              aria-labelledby={`update-title-${entry.version}`}
            >
              <div className="update-card__header">
                <div className="update-card__version-row">
                  <strong className="update-card__version">v{entry.version}</strong>
                  <span
                    className={`update-badge${isCurrent ? ' update-badge--current' : ''}`}
                  >
                    {isCurrent ? '目前版本' : '已發布'}
                  </span>
                </div>
                <time className="update-card__date" dateTime={entry.date}>
                  {entry.date}
                </time>
              </div>

              <h2 id={`update-title-${entry.version}`} className="update-card__title">
                {entry.title}
              </h2>

              <ul className="update-card__highlights">
                {entry.highlights.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>

              {entry.details && entry.details.length > 0 ? (
                <ul className="update-card__details">
                  {entry.details.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
