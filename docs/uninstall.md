# 解除安裝與生命週期清理 (Uninstall & Lifecycle Cleanup)

本文件提供 94AiUsageDashboard（Self-hosted 自行部署模式）的完整生命週期清理指引。

---

## 核心原則與獨立性邊界

1. **不會登出 Provider，亦不會刪除 Provider 憑證**：
   - 解除安裝 94AiUsageDashboard **絕不會**登出您的 Codex、Antigravity 或 Claude Code。
   - 本專案從未持有、儲存或修改任何 Provider 的原始憑證或 session，因此解除安裝程序**絕不會**刪除或清除這些 Provider 的本機憑證或登入狀態。
2. **OpenUsage 為獨立第三方軟體**：
   - 94AiUsageDashboard 僅作為 OpenUsage 的唯讀聚合展示層。
   - 解除安裝 94AiUsageDashboard **不會**解除安裝 OpenUsage，亦不會變更其設定檔。若欲移除 OpenUsage，請透過其專屬方式（如 Homebrew）處理。
3. **使用者完全掌控雲端資料**：
   - 本專案採用 Self-hosted 架構，所有雲端資料皆存放於使用者自己的 Firebase 專案中，使用者隨時可清空或刪除該專案。

---

## 五大清理步驟

### 步驟 1：移除 Mac 背景同步常駐程式 (Mac Background Agent Removal)

執行專案內建的解除安裝指令，停止背景排程並移除 launchd 註冊檔：

```bash
npm run usage -- uninstall
```

如需手動確認或強制清理：
1. 停止並卸載 launchd 服務：
   ```bash
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.94ai.usage-dashboard.sync.plist
   ```
2. 刪除 plist 排程設定檔：
   ```bash
   rm -f ~/Library/LaunchAgents/com.94ai.usage-dashboard.sync.plist
   ```

---

### 步驟 2：清除本機 Dashboard 憑證與狀態 (Local Dashboard Credentials & State Removal)

94AiUsageDashboard 在本機保存的狀態僅包含本專案同步專用的 Firebase refresh token 與裝置識別碼：

1. **從 macOS Keychain 移除 Firebase Refresh Token**：
   本專案使用 macOS Keychain 安全隔離儲存登入憑證：
   - Keychain 服務名稱 (Service)：`94AiUsageDashboard`
   - Keychain 帳號名稱 (Account)：`firebase-refresh-token`（包含分段清單與區塊）
   - 可透過終端機執行清理：
     ```bash
     security delete-generic-password -s "94AiUsageDashboard" -a "firebase-refresh-token"
     ```
     *(若有分段金鑰，亦可於 macOS「鑰匙圈存取」App 搜尋 `94AiUsageDashboard` 並刪除相關項目)*
2. **刪除本機裝置識別碼 (Device ID)**：
   ```bash
   rm -rf ~/.config/94ai-usage-dashboard/device-id
   ```
3. **刪除本機環境變數檔 (可選)**：
   若不再於本機執行或開發本專案，可刪除根目錄下的設定檔：
   ```bash
   rm -f .env.local
   ```

---

### 步驟 3：刪除 Firebase 雲端資料與專案 (Firebase Project & Cloud Data Removal)

所有雲端資料均存放在您自己的 Firebase 專案，路徑均限制於使用者自己的 UID 之下：

- **資料所在路徑**：
  - `/users/{uid}/devices/{deviceId}/providers/{providerId}`
  - `/users/{uid}/devices/{deviceId}/history/{providerId}`
  - `/users/{uid}/devices/{deviceId}/history/{providerId}/historyChunks/{chunkId}`
  - `/users/{uid}/devices/{deviceId}/health/{healthId}`

**清理選項**：
- **選項 A：僅刪除 Firestore 資料**
  前往 [Firebase Console](https://console.firebase.google.com/) > 進入您的專案 > **Firestore Database**，直接刪除 `/users/{uid}` 文件或集合。
- **選項 B：完全刪除 Firebase 專案**
  若該 Firebase 專案僅供 94AiUsageDashboard 使用，可在 Firebase Console 的「專案設定」中點擊「刪除專案」，或使用 Firebase CLI 執行：
  ```bash
  firebase projects:delete <YOUR_PROJECT_ID>
  ```

---

### 步驟 4：OpenUsage 獨立性與 Provider 憑證處理 (OpenUsage Independence)

- **OpenUsage 的獨立解除安裝**：
  如您確定不再需要 OpenUsage 核心引擎，可依照 OpenUsage 官方說明移除，例如：
  ```bash
  brew uninstall --cask openusage
  ```
- **Provider 憑證（Codex / Antigravity / Claude Code）**：
  94AiUsageDashboard **絕不會**接觸亦**絕不會**刪除這些 AI 工具的登入憑證。若您需要撤銷或登出各 Provider 的授權，請在各工具官方命令列或官方網頁控制台進行（例如執行各工具的登出指令或撤銷 API Key / OAuth 授權）。

---

### 步驟 5：瀏覽器與 PWA 清理 (Browser & PWA Cleanup)

1. **移除已安裝的 PWA 應用程式**：
   - **macOS / 桌面瀏覽器**：在 Chrome / Edge / Safari 中開啟應用程式管理，點擊選單並選擇「解除安裝 94AiUsageDashboard」，並勾選同時清除資料。
   - **行動裝置 (iOS / Android)**：在手機主畫面上長按 94AiUsageDashboard 圖示，選擇「刪除 App」或「移除書籤」。
2. **清除瀏覽器網站儲存資料**：
   若透過一般網頁瀏覽器存取過儀表板，請清除該站台網域的儲存資料：
   - 開啟瀏覽器「設定」>「隱私權與安全性」>「網站設定」>「Cookie 與網站資料」。
   - 清除該站台的 **localStorage**、**IndexedDB** 與 **Service Worker** 快取 (Cache Storage)。
