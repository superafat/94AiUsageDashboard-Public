# Third-Party Notices

> **Project Open-Source License:**
> 94AiUsageDashboard v0.1.2 採用 **MIT License**；完整條款請見根目錄 `LICENSE`。本文件另外記錄本專案所整合或引用的第三方軟體、套件授權與商標聲明。

---

## 1. OpenUsage

94AiUsageDashboard 使用 OpenUsage 作為獨立安裝的受管理本機資料引擎。目前額度優先使用 OpenUsage CLI，必要時使用 loopback HTTP fallback；歷史 Token／估算費用經隔離的本機 history adapter。本 repo 不 fork、不內嵌 OpenUsage 原始碼，也不代表 OpenUsage 作者對本專案背書。

- **Upstream Repository:** https://github.com/robinebers/openusage
- **License:** MIT License
- **Copyright:** Copyright (c) 2026 Robin Ebers

OpenUsage 的授權條款以其原始 repository 內的 `LICENSE` 為準。

### 商標與獨立第三方邊界 (Trademark & Independent Third-Party Boundary)

OpenUsage 為 Robin Ebers 所開發之獨立開源專案。94AiUsageDashboard 為獨立第三方整合軟體（independent third-party integration），透過本機 CLI 與 loopback HTTP 介面與 OpenUsage 互動。本專案未獲 Robin Ebers 或 OpenUsage 官方背書、贊助或附屬（not affiliated with, endorsed by, or sponsored by OpenUsage or Robin Ebers）。所有商標、服務標章及專案名稱均為其各自擁有者之財產（All trademarks, service marks, and names are the property of their respective owners）。

### Privacy Separation

依 OpenUsage 上游目前文件／實作，其本身可能具有匿名 daily-active ping、crash reporting 或其他可選 analytics。這些屬 OpenUsage 自己的第三方行為，與 94AiUsageDashboard 的 Firebase 同步不同；使用者應另讀上游隱私／設定資訊。

---

## 2. Direct Production Dependencies

本專案 direct production dependencies 之完整審核清單、版本來源與授權分類請參見 [docs/dependency-license-review.md](docs/dependency-license-review.md)。

| Package Name | Resolved Version | License | Classification | Notes / Notice Source |
| :--- | :--- | :--- | :--- | :--- |
| `@testing-library/jest-dom` | `6.9.1` | `MIT` | Permissive | `node_modules/@testing-library/jest-dom/LICENSE` |
| `@testing-library/react` | `16.3.3` | `MIT` | Permissive | `node_modules/@testing-library/react/LICENSE` |
| `@vitejs/plugin-react` | `5.2.0` | `MIT` | Permissive | `node_modules/@vitejs/plugin-react/LICENSE` |
| `firebase` | `12.18.0` | `Apache-2.0` | Permissive | `node_modules/firebase/LICENSE` |
| `jsdom` | `26.1.0` | `MIT` | Permissive | `node_modules/jsdom/LICENSE.txt` |
| `react` | `19.2.8` | `MIT` | Permissive | `node_modules/react/LICENSE` |
| `react-dom` | `19.2.8` | `MIT` | Permissive | `node_modules/react-dom/LICENSE` |
| `vite` | `7.3.6` | `MIT` | Permissive | `node_modules/vite/LICENSE.md` |

既有 8 個 direct production dependencies 採用 MIT 或 Apache-2.0；新增的 web-push 3.6.7 另依 MPL-2.0 保留原始碼取得與授權聲明。查無 GPL/AGPL/SSPL/custom/unknown 等 blocker 授權。

---

## 3. Other Dependencies & Dev Tools

其他 npm `devDependencies`（如 TypeScript、ESLint、Vitest、Playwright 等）僅用於本機開發、靜態檢查與測試建置，不包含於生產環境 runtime 分發。其授權資訊以各 dependency 自身的 package metadata / LICENSE 為準。

## 4. Web Push library (v0.1.4)

- **Package:** web-push 3.6.7
- **License:** Mozilla Public License 2.0 (MPL-2.0)
- **Upstream:** https://github.com/web-push-libs/web-push
- **Exact source and license package:** https://registry.npmjs.org/web-push/-/web-push-3.6.7.tgz
- **Installed license:** `node_modules/web-push/LICENSE`

This dependency's source code is available under MPL-2.0. It is used unmodified in the Mac Companion, not relabeled MIT and not copied into browser code. The source archive above includes the MPL-covered files and original license notices. Recipients retain their MPL source rights independently of this application's MIT license. When redistributing the Companion with installed dependencies, preserve these notices and the original library license/source availability. No affiliation with or endorsement by the Web Push library maintainers is claimed.

Development declarations: @types/web-push 3.6.4, MIT, from DefinitelyTyped. They are not the runtime Web Push library.
