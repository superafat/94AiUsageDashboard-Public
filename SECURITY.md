# Security Policy

## 支援範圍

目前僅維護最新的 v1 開發分支。Repo 在正式公開前不承諾對外安全支援 SLA。

## 回報漏洞與安全通報

請優先使用 GitHub Private Vulnerability Reporting 或 Security Advisory 進行私下回報。若該功能尚未啟用，請僅建立不含任何敏感細節的 Issue，等待 maintainer 提供私人回報管道。

### 嚴禁附帶之機密檔案與記錄 (Strictly Forbidden in Reports)

在任何安全性通報、漏洞回報或公開討論中，**絕對嚴禁**張貼或附帶以下機密資料：
- `.env.local` 或任何本機環境變數檔案
- macOS Keychain 傾印或匯出資料 (Keychain dumps)
- Provider auth/session 檔案（包含 Codex、Antigravity、Claude Code 等上游工具之 session 檔、auth store 或 login token）
- 包含 Token、Cookie、API Key、OAuth refresh token 的完整 log 輸出 (full logs containing tokens)
- Firebase service-account JSON、Admin credentials 或私鑰
- 包含使用者原始程式碼、Prompt／Response 或個人隱私之檔案

### 安全回報指引

若需要提供環境狀態，請僅附上透過下列指令產生的清理後去敏 JSON 診斷報告，並於貼出前再次檢查確認無任何機密資訊：
```bash
npm run usage -- doctor --json
```


## 永久安全邊界

- 不接受 service-account JSON 進 repo。
- 不接受 OAuth refresh token / API key 進 `.env.example`、測試 fixture、Issue、PR 或 log。
- Web v1 只讀，不提供 reset-credit claim 或遠端 Mac 控制。
- Firestore 資料以 Firebase Auth UID 隔離。
- Mac Companion 優先使用官方 OpenUsage CLI；必要時使用固定 localhost HTTP fallback。歷史統計 adapter 只讀本機彙總，不允許任意遠端 OpenUsage URL。
- Local Agent 的 Firebase refresh credential 只應存在 OS credential store；macOS 實作會將長憑證分段存入 Keychain，避免把秘密放進命令列參數、檔案或環境變數。
- Firebase Web config（包含 Web API key）屬公開 client 設定；service-account JSON、OAuth/Firebase refresh credential 與其他私密 API key 仍屬秘密。

## v1.5 新增邊界

- Firestore 只接收 canonical quota、最多 180 天 aggregate history（舊安裝平滑累積至 180 天）與最小化 device health；Rules 逐層白名單並以 UID 隔離。
- `packages/ui`／`packages/client` 不提供 Provider credential 介面；未來 Android／iPhone App 也不得繞過 Mac credential boundary。
- `setup` 只能執行 allowlist 安全動作，不會消耗 Reset Credit、不會更改 Provider quota，也不會任意執行 shell 字串。
- 未來 official-app 後端、帳號刪除、資料保留、濫用防護與商店上架需另做正式安全／隱私 Gate。

## Issue #30 Reset Credit 安全邊界 (R2 Transport & R3 Safety Gate)

- **Provider 憑證不離開 Mac**：Web／手機端不接觸任何 Provider 憑證；所有操作皆由 Mac 本機執行。
- **P-256 簽署驗證與 TOFU 配對**：Mac 使用本機裝置金鑰簽署短期庫存（≤5 分鐘）與執行收據（`executing` / `terminal`）；Web 端實施 Trust-on-First-Use (TOFU) 本機金鑰配對，嚴格拒絕未經簽署、偽造或金鑰不符之結果。
- **Firestore 爭用控制與終態不可變**：固定單一請求槽位（租約上限 10 分鐘，原生 Timestamp 影子比對防時鐘偏移）；收據狀態機嚴格限定 `executing` → `terminal`，終態文件不可修改或刪除。
- **R2 傳輸與 R3 真實消耗嚴格分離**：
  - R2 傳輸/執行通道由 `AI_USAGE_RESET_COMMANDS_ENABLED=1` 開啟（預設停用）。
  - 真實 Provider 額度消耗受獨立之 R3 閘門 `AI_USAGE_RESET_REAL_CONSUME_ENABLED=1` 嚴格限制。
  - 若未同時具備兩者，新 Reset 指令**絕對禁止**發動 Provider 消耗、**絕對禁止**寫入 executing 收據、**絕對禁止**刪除庫存，必須以 `code: 'r3_authorization_required'` 失敗關閉 (fail-closed)。已完成的終態收據重播則不受影響。
  - R3 真實消耗目前處於**未授權 (NOT authorized)** 狀態，生產環境真實 Reset Credit 消耗數維持為 0。未經 Owner 實體驗收核准前，嚴禁開放一般使用者設定 R3 旗標。
- **裝置級全域未決互鎖 (Device-Wide Unresolved Interlock)**：
  - 在發布可操作庫存或發動任何 Provider 變更前，掃描該裝置下所有帳號之 Journal（`backendId + userId + deviceId`）。
  - 若同一裝置上任何帳號之 Journal 存在 `executing`、`reconcileRequired=true`、`state: 'unknown'` 或 `code: 'reconcile_required'`，該裝置上**所有帳號**全面禁止新的 Provider 變更，可操作庫存強制清空／失效，並回傳具簽章之 `reconcile_required` 終態收據。
  - 掃描過程嚴禁跨目錄跳脫或符號連結旁路，遇損毀狀態一律安全關閉 (fail-closed)。
