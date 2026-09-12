# 故障排除

先執行：`npm run usage -- doctor --json`。只分享這份已清理的狀態，不要分享原始登入檔。

| 畫面／狀態 | 可能原因 | 處理方式 |
| --- | --- | --- |
| `engine_missing` | OpenUsage CLI 與 localhost fallback 都不可用 | 安裝／開啟官方 OpenUsage，再重跑 setup |
| Provider 尚未收到可用額度 | Provider 未登入、來源暫無 quota 欄位 | 在自己的 Mac 確認 Provider 登入；其他 Provider 仍可正常使用 |
| `auth_missing` | Firebase 同步登入不存在 | 執行 setup，完成 Google 登入 |
| `background_missing` | 背景同步未安裝 | 執行 setup；必要時重新 install |
| `sync_stale`／舊資料 | Mac 關機、網路中斷或來源太久未更新 | Mac 上執行 doctor；確認背景同步與 OpenUsage |
| Google 登入彈出視窗被阻擋 | 內建瀏覽器／瀏覽器限制 | 用 Safari 或 Chrome 開啟並允許彈出登入 |
| 已連接但沒有額度 | 上游沒有可顯示欄位 | 保留「已連接」狀態，不會假造 0%／100% |

## 歷史 Token／費用

目前支援保留最多 180 天每日彙總；既有 35 天安裝不會被覆寫，而是隨每日同步自然累積至最多 180 天，系統絕不補造升級前歷史。費用只在證據完整時顯示：7／90／180 天需該期間每日費用皆可靠；30 天可使用同一個本地日期同步取得的可靠「Last 30 Days」彙總費用。跨日舊彙總或其他資料不足時顯示「費用資料累積中」，並誠實標明實際資料涵蓋天數。歷史來源失敗不會阻止目前額度同步。


## 回報問題時嚴禁附上敏感檔案與記錄 (Strictly Forbid Sensitive Files & Logs)

回報 Issue 或尋求協助時，**嚴禁**附上或張貼以下內容：
- `.env.local` 或任何本機環境設定檔
- Keychain 匯出或傾印 (Keychain dumps)
- Provider auth/session 檔案（如 Codex、Antigravity、Claude Code 的認證檔或本機 session 檔）
- 包含 Token、API Key、Cookie、OAuth refresh token 的完整 log 輸出 (full logs containing tokens)
- service-account JSON、Admin credentials 或私密憑證
- 包含 Prompt／Response 的對話內容或敏感檔案路徑

**安全的回報方式**：
僅提供經清理、不含機密資訊的診斷摘要：
```bash
npm run usage -- doctor --json
```
分享前請確認該輸出僅包含元件狀態與版本資訊，不要附加未遮蔽的終端機完整 log。

