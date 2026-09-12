# 隱私與威脅模型

## 核心原則

Provider token／credential 永遠留在使用者自己的 Mac。94AiUsageDashboard 不需要把 Codex、Antigravity、Claude 等登入憑證送進 Firestore、Web 或未來手機 App。

## Self-hosted 資料流

```text
Provider credential（Mac only）
  → OpenUsage engine
  → 額度 + 最多 180 天 Token／估算費用彙總（既有 35 天安裝隨每日同步自然累積，不補造歷史） + device health
  → 使用者自己的 Firestore（Firebase Auth UID 隔離）
  → 使用者自己的 Web/PWA
```

Firestore 只接受白名單欄位。未登入與跨 UID 讀寫由 Rules 拒絕。每日歷史只保存日期、Token、可選的估算 API 等值費用與 finalized 狀態，不保存 Prompt、Response、session 或登入資料。

## 不同步的資料

- Provider access／refresh token、API key、Cookie
- Prompt、Response、AI 對話與原始 session
- 程式碼與完整本機路徑
- macOS Keychain 內容
- 原始 OpenUsage stderr／credential store

## OpenUsage 是第三方邊界

OpenUsage 是獨立第三方軟體，不等於我們的 Firebase 同步。依上游目前說明，OpenUsage 具有匿名 daily-active ping／crash reporting 等行為；使用者應同時閱讀 OpenUsage 自己的隱私與設定說明。因此不能把本產品描述成「完全離線」；OpenUsage 的第三方通訊與本專案 Firebase 同步必須分開說明。

## 歷史 Token 與費用

升級後本專案支援最多 180 天聚合資料。升級前之既有安裝保留現有最多 35 天資料，並隨每日同步自然累積至最多 180 天 Token／估算費用，系統絕不捏造或補填升級前未記錄之歷史天數。所有金額都標示為「估算 API 等值費用」，不是訂閱帳單、信用卡扣款或實際應付費用。費用資料不完整時不外推、不平均，而顯示「費用資料累積中」並忠實揭露目前實際可用天數。

## Firestore 集合路徑與保留語意 (Retention Semantics)

本專案在使用者所屬的 Firebase 專案中，僅使用以下嚴格限制於 `request.auth.uid == uid` 的 Firestore 集合路徑：

1. **額度快照 (Quota Snapshots)**
   - **集合路徑**：`/users/{uid}/devices/{deviceId}/providers/{providerId}`
   - **儲存內容**：目前 Provider 的資源額度快照（如 Session、Weekly、Spark 等用量數值與重置時間戳記）。
   - **保留語意 (Retention)**：每次本機 Agent 執行同步時，以最新快照直接覆寫 (overwrite) 該文件；永久保留至下次同步或由使用者手動刪除 Firestore 資料。Firestore Rules 設為 `delete: if false`（防止 Client 誤刪）。
2. **歷史摘要 (History Summary)**
   - **集合路徑**：`/users/{uid}/devices/{deviceId}/history/{providerId}`
   - **儲存內容**：最多 180 天的 Token 與估算費用聚合摘要（包含 `today`、`yesterday`、`last30Days`、`dayCount`、`chunkCount`）。既有 35 天資料平滑相容並持續累積。
   - **保留語意 (Retention)**：歷史同步時覆寫更新為最新統計摘要；保留至下次更新或由使用者清空資料。Rules 設為 `delete: if false`。
3. **歷史詳細區塊 (History Chunks)**
   - **集合路徑**：`/users/{uid}/devices/{deviceId}/history/{providerId}/historyChunks/{chunkId}`
   - **儲存內容**：每日用量分段區塊（`chunkId` 為 `'0'` 至 `'35'`，共最多 36 個分塊，每個分塊最多 5 筆每日聚合記錄，構成最多 180 天滑動視窗；舊版 35 天分塊 `'0'` 至 `'6'` 完全向後相容）。
   - **保留語意 (Retention)**：嚴格維持 180 天滑動視窗保留。超過 180 天的舊歷史區塊會在同步時被覆寫或刪除；Firestore Rules 明確允許登入本人對合法分塊 (`^([0-9]|[12][0-9]|3[0-5])$`) 執行建立、更新與刪除 (`allow delete: if signedInAs(uid)`)。
4. **裝置健康狀態 (Device Health)**
   - **集合路徑**：`/users/{uid}/devices/{deviceId}/health/{healthId}` (`healthId == 'current'`)
   - **儲存內容**：裝置與常駐程式健康度（包含 `engine`、`background`、`sync` 狀態及可用 Provider 數量）。
   - **保留語意 (Retention)**：每次健康檢查或同步時覆寫更新為最新快照；Rules 設為 `delete: if false`。
5. **Reset Credit 與指令 Metadata (Reset-command Metadata)**
   - **現況與保留語意**：在目前 v0.1.2 中，Rate-limit Reset Credits 僅作為唯讀展示，本專案**未啟用**任何破壞性遠端消耗指令通道，亦無運作中的指令集合。若未來啟用指令 metadata，亦將限定於擁有者自身裝置路徑（如 `/users/{uid}/devices/{deviceId}/commands/{commandId}`），僅存放短暫 TTL 之隨機指令識別碼、過期時間與冪等狀態，逾期或執行後自動清除，絕不存放任何 Provider 憑證。
6. **Provider 顯示與同步偏好設定 (Provider Preferences)**
   - **集合路徑**：`/users/{uid}/preferences/{family}`（`family` 為 11 種支援的 Provider 家族識別碼，如 `codex`、`antigravity`、`claude`、`copilot`、`cursor`、`devin`、`grok`、`ollama`、`opencode`、`openrouter`、`zai`）。
   - **儲存內容**：各 Provider 家族之啟用/停用狀態（`family`、`enabled: boolean`、`updatedAt`、`version: 1`）。
   - **保留語意 (Retention)**：由使用者在 Settings 畫面即時切換更新。Firestore Rules 限制僅允許擁有者讀寫，並設為 `delete: if false`。
   - **App-specific 邊界與 OpenUsage 隔離**：在 94AiUsageDashboard 設定中將特定 Provider 設為關閉 (OFF)，**純粹為本 App 之資料來源過濾與隱私控制**。此操作只會停止該 Provider 在儀表板／統計歷史／明細之展示與雲端同步發布，**絕不會**登出或刪除該 Provider 帳號、**絕不會**刪除既有歷史記錄、亦**絕不會**修改 OpenUsage 自身的全域組態或刪除本機憑證。

## 生命週期與解除安裝邊界

94AiUsageDashboard 的生命週期完全獨立於底層 AI 工具：
- **不會登出或刪除 Provider 憑證**：解除安裝或清空 94AiUsageDashboard 絕不會登出 Codex、Antigravity 或 Claude，亦不會刪除或修改這些 Provider 的本機憑證或 session。
- **雲端資料可隨時清空**：因資料皆在使用者自己的 Firebase，使用者可透過 Firebase Console 或 CLI 隨時清空 `/users/{uid}` 或刪除整個 Firebase 專案。

## 未來官方 App 模式

```text
Provider credential（Mac only）
  → Mac Companion
  → 最小化 quota/history/device health
  → official minimal control plane
  → owner Android/iPhone App
```

未來官方 App 上線前必須另做正式威脅模型、資料保留／刪除、帳號刪除、濫用防護、事件回應與隱私政策。Self-hosted 與 official-app 由 `BackendProfile` 分離，不能因未來官方服務而改成把 Provider 憑證上傳中央。

## 已知完整性邊界

Self-hosted 使用者控制自己的 Firebase 身分與 client，同一 UID 可偽造自己的統計；這只能污染自己的資料。跨 UID 隔離與 Provider credential 保密仍是硬邊界。

