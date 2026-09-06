# Android／iPhone App 發佈架構

## 產品目標

主流分享方式不是叫一般人 clone GitHub，而是：**Google Play／App Store → 安裝 App → 登入 → 配對 Mac → 使用自己的額度**。

## 共用核心

`packages/core`、`packages/client`、`packages/ui` 不依賴 Firebase Web popup、browser hash routing 或 DOM-only 資料存取。Web 是目前的一個 adapter；未來 Android／iOS 以 Capacitor shell 承接同一套 React 產品畫面與 domain contracts。

## Mac 是 Provider 信任邊界

Codex、Antigravity、Claude 等 Provider credential 留在 Mac Companion。手機只接收額度、重置時間、Token／估算費用彙總與最小化裝置健康狀態。

## 兩種 BackendProfile

- `self-hosted`：進階使用者管理自己的 Firebase。
- `official-app`：未來官方 App 使用最小化受管理後端；一般人不需要建立 Firebase。

正式 official-app 後端目前**尚未上線**。Android/iOS store project、簽章、推播、帳號刪除與隱私政策屬後續發佈階段。

## 配對體驗目標

未來 App 讀取 Mac Companion 的安全健康狀態，只顯示「缺 OpenUsage／尚未登入／背景同步未完成／同步正常」等穩定狀態碼，不顯示本機路徑、stderr 或 Token。

## Self-hosted 不消失

即使未來 App Store 版本上線，Self-hosted 仍保留給希望完全掌控 Firebase 與資料生命週期的使用者。
