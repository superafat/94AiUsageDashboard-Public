# 94AiUsageDashboard

一個 **App-first、Self-hosted-capable、可延伸 Android / iPhone** 的 AI 額度與使用統計產品。

> **一般使用者先看：** [`docs/getting-started.md`](docs/getting-started.md)。若使用 AI 輔助安裝或自動化，請參閱規範合約：[`AI_INSTALL.md`](AI_INSTALL.md)。目前 Self-hosted 仍是進階安裝；未來主流分享方式是 Google Play / App Store → 登入 → 配對 Mac → 直接使用。

> **未來主要分發方式是 App-first。** 一般使用者的目標體驗是從 **Google Play / App Store** 安裝 Android／iPhone App，登入後配對自己的 Mac 就能使用，不需要理解 GitHub、Node、Firestore 或自己建立 Firebase。**Self-hosted 保留給進階使用者**與希望完全自管後端的人。

目前私人 **v1.5 Public-ready** 版本已完成共享 React UI／domain／client contracts、Web/PWA、歷史 Token／估算費用與 Mac Companion；預設以 **Capacitor** 作為未來 Android / iOS shell。`BackendProfile` 會把目前 Self-hosted Firebase 與未來官方 App 的最小託管後端隔離；兩種分發方式共用同一套額度邏輯與畫面，Provider 憑證在任何模式都留在使用者 Mac。**Android／iPhone 商店 App 尚未發佈。**

目前 v1.5 第一級 Provider 資料格式與畫面支援：

- **Codex**
- **Antigravity**
- **Claude Code**

資料由你自己的 Mac 上的 [OpenUsage](https://github.com/robinebers/openusage) 讀取，再由 Mac Companion 正規化後同步到 **你自己的 Firebase 專案**。目前額度優先使用 OpenUsage CLI；CLI 不可用時才使用固定 localhost HTTP fallback。歷史 Token／估算費用走隔離的本機 history adapter。

> **只讀觀察與職責邊界**：本專案為帳號層級額度、歷史用量與重置視窗之只讀觀察儀表板。工作派工與調度由 DevControl 統一管理。Dashboard 不啟動 AI 工具、不控制 Mac、不遠端重置額度、不購買額度、不集中管理 Provider 憑證；未知或過期資料不會假造成可用餘額。所有費用皆為本機 API 等值估算，不是實際帳單。

## 架構

```text
AI CLI / Desktop App
        ↓
     OpenUsage
        ↓ 127.0.0.1 only
  Local Agent (macOS)
        ↓ canonical snapshot
   Your own Firestore
        ↓ Firebase Auth
   Mobile-first PWA
```

核心資料格式不綁死 OpenUsage、React 或 Firebase，因此未來可以增加 Android / iOS shell，而不用重寫 provider 邏輯。

## 隱私邊界

Mac Companion 只同步額度快照、最多 35 天每日 Token／估算費用彙總，以及最小化裝置健康狀態。它不會同步或上傳 OAuth 權杖、API 金鑰、Cookie、對話或程式碼。完整禁止項目：

- OAuth access token / refresh token
- API key / cookie
- Prompt / response
- AI 對話內容
- Codex / Claude session 原文
- 原始程式碼或 repo 內容
- 本機完整路徑

Local Agent 的 Firebase refresh credential 只保存在 macOS Keychain，不寫入 `.env`、Firestore、GitHub 或一般 log；長憑證會安全分段存入 Keychain，不會塞進命令列參數。

## v1 Provider 支援

### Codex

顯示 OpenUsage 有提供的 Session、Weekly、Spark、Spark Weekly、credits、rate-limit reset credits 等資源。缺少的欄位直接省略，不猜成 0% 或 100%。若 OpenUsage 目前沒有從 `/v1/limits` 匯出 `gpt-reserve`，本專案也不會假造該數值；未來來源提供穩定 key 時可直接顯示。

### Antigravity

顯示 Gemini Session / Weekly 與 non-Gemini Session / Weekly。

### Claude Code

顯示 Session / Weekly，並支援 OpenUsage 提供的 Fable、Sonnet、Extra Usage 等資源。OpenUsage 可使用 Claude Code 或 Claude Desktop 的既有登入；本專案不自行讀取 Claude 憑證。

## 自行部署（Self-hosted）

> **AI 輔助安裝**：若由 AI 程式碼助理或自動化流程執行安裝，請依循 [`AI_INSTALL.md`](AI_INSTALL.md) 之確定性狀態機規範與安全邊界。

### 1. 安裝需求

- macOS 15 或更新版本（目前 Mac Companion）
- Node.js 22 LTS
- Java 21+（僅 Firebase Emulator 測試需要）
- Firebase CLI
- OpenUsage

依官方 OpenUsage 專案的安裝說明安裝。94AiUsageDashboard **不會自動安裝 OpenUsage**、不會偷偷執行 Homebrew。Mac Companion 優先使用 OpenUsage CLI；CLI 不可用但官方 localhost API 正常時使用 HTTP fallback。

### 2. 建立自己的 Firebase 專案

在 Firebase Console 建立專案，然後：

1. 建立 Web App。
2. 啟用 **Google Authentication**。
3. 建立 Cloud Firestore。
4. 把 `127.0.0.1` 與 `localhost` 加入 Firebase Authentication 的授權網域，供 Local Agent 一次性本機登入。
5. 記下 Web App 的公開 Firebase config。

Firebase Web API key 是公開 client config，不是 Admin secret；service-account JSON 則是敏感憑證，本專案不需要它。

### 3. 安裝專案

```bash
git clone https://github.com/superafat/94AiUsageDashboard-Public.git
cd 94AiUsageDashboard-Public
npm ci
cp .env.example .env.local
```

把 `.env.local` 改成你自己的 Firebase 公開 Web 設定。不要放 refresh token、service-account JSON 或其他秘密。

### 4. 套用 Firestore Security Rules

先用 Emulator 驗證：

```bash
npm run test:rules
```

正式部署 rules 前，請確認 Firebase CLI 指向你自己的 project：

```bash
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy --only firestore
```

Firestore Security Rules 會拒絕未登入存取與跨 UID 讀寫，並限制 snapshot schema。

### 5. Local Agent 一次設定與背景同步

先檢查環境，再執行一次設定：

```bash
npm run usage -- doctor
npm run usage -- doctor --json
npm run usage -- setup
```

`setup` 是**可重跑**流程：先檢查目前狀態，只執行允許的安全下一步。缺 OpenUsage 或 Self-hosted Firebase 設定時只提供精準說明，不會自動安裝第三方軟體；完成後 Mac 每 5 分鐘自動同步。

Local Agent 使用和手機網站相同的 Firebase Google Authentication。瀏覽器只把短效 Google ID token 交回 `localhost`，Agent 再向 Firebase 換取正式 Firebase session；長期 refresh credential 只存入 macOS Keychain，不需要額外建立 Desktop OAuth Client，也不使用 service account。

進階命令：

```bash
npm run usage -- login      # 只重新登入
npm run usage -- sync       # 立即同步一次
npm run usage -- install    # 安裝／更新背景同步
npm run usage -- uninstall  # 移除背景同步
npm run usage -- doctor     # 檢查設定、登入、OpenUsage、背景同步與最後同步
```

完整解除安裝與各層生命週期清理請見 [docs/uninstall.md](docs/uninstall.md)。


`sync` 會優先用 OpenUsage CLI 讀目前額度，必要時使用只限 localhost 的 HTTP fallback；歷史統計由本機 history adapter best-effort 讀取。資料轉成 canonical schema 後才以登入者自己的 Firebase 身分寫入 Firestore。

### 6. 啟動 Web PWA

本機：

```bash
npm run build -w apps/web
npm run preview -w apps/web
```

正式自行部署：

```bash
firebase deploy --only hosting
```

手機登入同一 Google 帳號後，就能查看 Mac 最近同步的額度。PWA 可加入 Android / iOS 主畫面。

### 登入與同步狀態

登入視窗遭阻擋或使用者取消時，頁面會顯示原因並允許重試；登入進行中不會重複送出請求。通訊軟體內建瀏覽器限制登入時，請以 Safari 或 Chrome 開啟同一網址。

Mac 每五分鐘同步一次。網站會分別檢查同步時間與來源取得時間：來源明確回報過期、七分鐘沒有同步，或來源資料超過十二分鐘未更新時，會標示可能過期；重新上傳舊資料不會把它變成新資料。斷網會立即顯示離線提醒。

Hosting 部署前會自動執行 `npm run build:hosting`，強制關閉測試資料模式後重新建置，避免把瀏覽器測試產物誤上線。離線快取只保存靜態網頁，不攔截登入回呼、私人 API 或帶有查詢參數的請求。

## 使用統計與估算費用

App 提供今日／近 7 天／近 30 天 Token 趨勢。每日歷史最多保留 35 天；7 天費用只有七天資料都完整時才顯示，否則顯示「費用資料累積中」，不平均、不外推。所有金額都是**估算 API 等值費用**，不是實際帳單或已扣款。

## 開發驗證

```bash
npm run lint
npm run typecheck
npm test
npm run test:rules
npm run test:acceptance
npm run build
npm run test:e2e
```

E2E 使用手機尺寸瀏覽器，驗證 Codex、Antigravity、Claude Code、多 Provider UI、只讀 reset credits、stale 狀態、離線 shell 與水平溢位。

## 安全與限制

- Web client 沒有 snapshot 寫入 UI。
- v1 不提供遠端 Mac 控制或 reset-credit claim。
- 跨 Firebase UID 存取由 Firestore Rules 強制拒絕。
- 同一 UID 自製惡意 client 理論上可以偽造自己的 snapshot；它只能污染自己的 self-hosted 資料。若未來需要更強完整性，可增加 server ingest / device attestation 模式。
- OpenUsage 掛掉時，最後成功資料應保留；來源回報 stale，或 Mac 超過正常背景同步心跳仍未成功更新時，網站才標示 stale，不得變成假 0 / 100。

## 開源與發布方式

94AiUsageDashboard v0.1.3（先前版本 v0.1.2 維持不可變紀錄）採 **MIT License**。完整私人開發歷史不公開；正式公開版本只會由通過安全檢查的乾淨匯出建立，避免把本機路徑、內部規劃、測試證據或其他私人開發痕跡帶進公開 Git 歷史。

公開發布倉庫為 `superafat/94AiUsageDashboard-Public`。公開使用者以 Self-hosted 模式部署自己的 Firebase，Provider 憑證保留在自己的 Mac。Android／iPhone 商店版本仍屬未來階段，不在 v0.1.3 範圍。

## License

本專案採用 **MIT License**，條款請見 `LICENSE`。第三方授權資訊請見 `THIRD_PARTY_NOTICES.md`，安全回報方式請見 `SECURITY.md`，貢獻流程請見 `CONTRIBUTING.md`。
