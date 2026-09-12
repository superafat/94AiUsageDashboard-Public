# 一般使用者：從這裡開始

## 這是什麼

94AiUsageDashboard 讓你在手機或電腦查看**自己的額度**、重置時間、Token 使用趨勢與估算 API 等值費用。Codex、Antigravity、Claude Code 等 Provider 的登入憑證留在自己的 Mac。

## 現在需要準備什麼

目前私人／Self-hosted 版本需要：macOS 15+、已正常登入的 AI 工具、Google 帳號、官方 OpenUsage，以及你自己的 Firebase 專案。現在的 Self-hosted 安裝仍偏進階，但安裝後 Mac Companion 會背景自動同步。

## 最短使用流程

1. 安裝官方 OpenUsage 與 94AiUsageDashboard。
2. 完成自己的 Self-hosted Firebase 公開設定。
3. 執行 `npm run usage -- setup`，依畫面完成 Google 登入。
4. 手機開啟 PWA，以同一個 Google 帳號登入。
5. 之後 Mac 每五分鐘自動同步，不需要一直開著終端機。

## 會同步什麼

只同步額度、重置時間、最多 180 天的每日 Token／估算費用彙總（既有安裝由 35 天隨每日同步自然累積至最多 180 天，不補造歷史）、同步時間，以及最小化 Mac 健康狀態。估算費用不是訂閱帳單或實際扣款。


## 不會上傳什麼

Provider token／credential、Cookie、Prompt、Response、原始 session、程式碼、Keychain 值與完整本機路徑都不會同步到 Firestore／Web。

## 資料來源顯示與同步設定

你可以在 App「設定」頁面中個別啟用或停用 11 種 AI 工具來源。停用僅會在此 App 中隱藏並停止同步該工具，絕不會登出工具、刪除歷史記錄或變更 OpenUsage 自身設定。

## 未來 App

未來 App 的主要分享方式是 Google Play 與 App Store：Android／iPhone 使用者下載 App → 登入 → 配對自己的 Mac → 直接使用；一般使用者不需要 clone GitHub、安裝 Node 或建立自己的 Firebase。Self-hosted 仍保留給進階使用者。

## 需要協助

先看 `docs/install-macos.md` 與 `docs/troubleshooting.md`。若由 AI 程式碼助理執行安裝，請遵照規範合約 [`AI_INSTALL.md`](../AI_INSTALL.md)。解除安裝與生命週期清理指引請參閱 [`docs/uninstall.md`](uninstall.md)。回報問題前請執行 `npm run usage -- doctor --json`，但不要附上 `.env.local`、Keychain 值或 Provider 登入檔。
