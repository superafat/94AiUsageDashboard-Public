# Contributing

感謝協助改善 94AiUsageDashboard。

## 開發環境

- Node.js 22 LTS
- npm
- Java 21+
- Firebase CLI
- Chromium（Playwright 會管理測試版本）

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:rules
npm run build
npm run test:e2e
npm run verify:public-ready
```

## 開發原則

1. 新功能與修正採 TDD：先寫會失敗的測試並確認 RED，再做最小修正。
2. Provider adapter 不得把 provider 私有格式滲漏到 React UI。
3. 不得用 mock 冒充 Firestore Rules / Browser 真實流程。
4. 缺資料要顯示無資料或省略，不得猜 0 / 100。
5. v1 保持 read-only；任何遠端 mutation 都是獨立產品決策。
6. 不得提交秘密、正式客戶資料、prompt、response 或本機 session log。

## Pull Request

PR 請包含：目的、修改範圍、測試證據、是否涉及 auth / Firestore Rules / privacy boundary，以及未完成事項。

修改 Provider 支援時，至少加入正常、缺欄位、stale、未知 resource 與錯誤 fixture。

## 公開準備規則

- UI／視覺修改必須附實際 browser screenshot evidence，不接受概念圖冒充成品。
- Issue／PR 不得附 `.env.local`、Keychain 值、Provider auth/login 檔、Cookie、token 或私人完整 log。
- 影響 Provider、history、device health、Firebase Rules 或 BackendProfile 時，PR 必須說明 privacy/security impact。
- 不直接 push 生產環境；release candidate 必須由 `npm run verify:public-ready` 與 exact-head CI 驗證。
