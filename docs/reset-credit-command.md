# Codex 重置券核心指令規範 (Reset Credit Command Specification — R1)

本文檔記錄 `94AiUsageDashboard` v0.1.4 針對 Issue #30 R1 階段所建立的安全 Reset Credit 核心架構、型別契約與本機執行防護邊界。

---

## 1. 核心安全邊界 (Safety Boundaries)

- **尚未開放實際重置券消耗 (No Live Consume Yet)**：
  R1 僅交付指令契約、資料解析器、JSON-RPC Adapter 介面、本機 Journal 狀態機與受控執行器 (`executeResetCreditCommand`)。本階段所有單元測試與整合驗證均透過假傳輸層（Fake Transport / Process Seam）進行，禁止調用真實安裝之 Codex 帳號或消耗實際 Reset Voucher。
- **嚴格顯式選券 (Explicit-Credit Only)**：
  Adapter 與指令執行層必須帶有明確且唯一的 `creditId`，絕對禁止自動省略 `creditId`、禁止盲目選取第一張可用券、禁止降級至其他認證或快取帳號。
- **不可推論性與可操作條件 (Actionability Rules)**：
  - 只有在 `accountId` 非空，且 `credits` 陣列中存在明確標記為 `status: 'available'` 與 `resetType: 'codexRateLimits'` 的項目時，才視為可操作 (`actionable`)。
  - `credits: null` 代表 Provider 僅回傳計數但尚未提供明細，此時視為不可操作 (`un-actionable`)，不得憑空合成券資料，亦不可視為零張。
  - 當存在過期時間相同（Tie）之多張券時，因券身分具二義性，嚴格禁止自動推論選取。
  - 未知期限券可顯示，但優先權不得高於已知最短剩餘期限之可用券；過期券一律不可操作。
- **嚴格帳號與目標裝置綁定 (Strict Account & Device Binding)**：
  指令與執行狀態皆綁定 `backendId`、`userId`、`targetDeviceId`、`accountId`。執行前必須於同一隔離連線重新讀取 Provider 狀態，若帳號或目標券狀態不符，立即中斷並拒絕發送消耗請求。
- **核心時間與計數一致性 (Core Consistency Invariants)**：
  - Inventory：`observedAt < expiresAt`、`availableCount >= 0`，若有明細陣列則不可出現 `availableCount === 0` 卻有可用券，且 `availableCount >= 可用明細張數`。
  - Command：`requestedAt < expiresAt`。
  - Result：若存在 `completedAt`，必須滿足 `completedAt >= executedAt`。

---

## 2. 本機日誌與冪等性 (Local Journal & Idempotency)

- **狀態機規範**：
  `prepared`（已就緒） $\to$ `executing`（執行中） $\to$ `terminal`（終態：`success` | `failed` | `unknown`）。
- **提前持久化與全欄位重複比對**：
  - 在向 Provider 發出消耗請求之前，日誌必須先將指令寫入 `prepared` 並原子化轉移為 `executing`。
  - `prepareCommand` 針對重複 `commandId` 比對所有標準欄位（`version`, `commandId`, `idempotencyKey`, `creditId`, `accountId`, `targetDeviceId`, `userId`, `backendId`, `requestedAt`, `expiresAt`），任一欄位變更即拋出 `command_mutation_rejected`。
  - `idempotencyMap` 與 `entries` 之間具備嚴格雙向對射（Bijection），孤立或錯位映射一律拒絕。
- **防重複與衝突拒絕**：
  - 相同 `commandId` 且欄位完全一致之重複呼叫，直接回傳已記錄之日誌項目。
  - 若相同 `idempotencyKey` 但指派至不同 `commandId`，一律判定為衝突（`idempotency_conflict`）並拒絕執行。
- **崩潰回復與禁止自動重試 (Crash Recovery & No Auto-Retry)**：
  - 日誌重新載入或行程重啟時，若發現先前殘留於 `executing` 狀態之項目，系統立即將其自動收斂為 `terminal`，並標記 `state: 'unknown'`、`code: 'reconcile_required'` 與 `reconcileRequired: true`。
  - 絕對禁止在重啟後自動對 Provider 發動二次消耗。終態記錄不可倒退 (`terminal_state_immutable`)。
- **檔案系統保全與鎖定復原 (Filesystem Safeguards & Crash-Safe Locking)**：
  - 本機日誌採用 `0o600` 嚴格私有權限，防範符號連結攻擊 (`O_NOFOLLOW`)，鎖定機制採用 `O_CREAT | O_EXCL`。
  - 鎖定檔寫入持有者 PID 與 Nonce；發生 `EEXIST` 時，僅在鎖定檔為一般非符號連結、單一連結、本進程所屬，且確認該 PID 確定不存在（`ESRCH`）並通過 inode/dev 二次檢驗時才安全回收。若 PID 存活或疑似存活，維持 `journal_locked`。
  - 在鎖定保護下啟動與執行時，安全清理孤立之 `reset-journal.tmp.*` 暫存檔（上限 32 個，超過則 fail-closed 拋出 `journal_too_many_temp_files`）。
  - 若日誌檔案損毀（非有效 JSON），系統立即以失敗關閉 (`fail-closed`)，絕不盲目覆寫或清除既有損毀檔案。

---

## 3. 通訊與協定安全性 (JSON-RPC Protocol Security)

- **進程隔離與固定指令邊界**：
  生產環境僅透過固定子進程指令 `codex` 與固定參數 `['app-server', '--stdio']`（`shell: false`）執行，禁止自外部傳入任意執行檔路徑。
  `CodexResetAdapter` 不自 `@94ai/agent` 公開出口導出，防範未經日誌直接消耗。
- **方法白名單與嚴格 JSON-RPC 解析**：
  - 僅允許執行 `initialize`、`initialized`、`account/rateLimits/read` 及 `account/rateLimitResetCredit/consume`。
  - 回應必須為包含 `jsonrpc: "2.0"` 之純物件、匹配掛起請求 ID、`result` 與 `error` 恰好二擇一。拒絕重複或未預期的回應 ID，嚴格限制通知訊息格式與長度。
- **嚴格 Provider 庫存驗證**：
  `account/rateLimits/read` 回應必須符合嚴格 Provider 結構：非空合法 `accountId`、合法整數 `availableCount`、每筆券明細必須具備唯一 ID、枚舉 `status`、枚舉 `resetType`、合理範圍整數時間戳，嚴格禁止合成 `unknown_id`、`unknown_status` 或 `unknown_type`。所有結果轉換後均通過 `parseResetCreditInventory` 驗證。
- **發送確定性與未知結果語意 (Dispatch Uncertainty)**：
  - 消耗請求在 `transport.send(payload)` 成功寫入 stdin 之前，絕不標記為已發送；發送前的傳輸中斷回傳 `transport_error`（`failed`）。
  - 只有在寫入成功後發生的逾時、連線關閉或中斷，結果才判定為 `unknown_outcome`（`unknown`），絕不判定為失敗而發動自動重試。
  - `ProcessTransport` 嚴密檢測 stdin 銷毀與寫入錯誤回呼；安全關閉時等待子行程退出並以時短安全逾時升級強制中斷。
- **機敏資訊防護**：
  不輸出 stderr 原始資料，錯誤訊息與結果代碼一律經過機敏特徵過濾，絕對禁止將 Bearer Token、私有路徑或 Provider 原始文字洩漏至例外拋出或前端日誌。

---

## 4. 單一受控執行器 (Journal-Gated Executor)

- **`executeResetCreditCommand` 專屬執行路徑**：
  - 步驟流程：命令格式與範圍解析 $\to$ `journal.prepareCommand`（事前鎖定冪等鍵） $\to$ 既有終態直接回傳 / 既有執行中拋出防護 $\to$ 檢查過期時間 $\to$ `journal.transitionToExecuting` $\to$ 調用 Adapter 一次 $\to$ `journal.transitionToTerminal` 回寫終態。
  - 保證 Adapter 調用次數 $\le 1$。執行器不具備自動重試邏輯。

---

## 5. 交付狀態與後續範疇 (Status & Next Steps)

- **R1 完成範圍**：
  - `@94ai/core`：`packages/core/src/reset-credit-command.ts` 契約解析器、時間與計數一致性驗證、選券輔助函式。
  - `@94ai/agent`：`apps/agent/src/codex-reset-adapter.ts` 隔離 JSON-RPC 通訊配接器（固定指令邊界、嚴格訊息解析、精確發送確定性）。
  - `@94ai/agent`：`apps/agent/src/reset-command-journal.ts` Mac 本機原子化防重複日誌（死鎖安全回收、暫存清理上限、全欄位比對、對射驗證）。
  - `@94ai/agent`：`apps/agent/src/reset-command-executor.ts` 核心單一執行器（至多執行一次）。
  - 所有測試皆通過 TDD 嚴格驗證。
- **R2 待處理範疇 (Pending in R2)**：
  - Web UI / PWA 二次確認視窗 (`ResetCreditConfirmDialog.tsx`)。
  - Firestore 雲端配對指令傳輸通道 (`packages/firebase`)。
  - 前端與 Mac Companion 背景代理人之指令輪詢接合。
