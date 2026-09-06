# macOS 安裝指南

> 這是目前 Self-hosted 進階版本的安裝方式。未來官方 App 會把 Firebase／Node 等工程步驟藏在一般使用者之外。

## 1. 準備

- macOS 15 或更新版本
- Node.js 22
- Google 帳號
- 已登入的 Codex／Antigravity／Claude Code 等工具
- 官方 OpenUsage
- Self-hosted Firebase 專案

Mac Companion **優先使用 OpenUsage CLI** 取得目前額度；若 CLI 不可用但官方 OpenUsage 的 localhost API 正常，會使用只限 `127.0.0.1` 的 HTTP fallback。目前歷史 Token／費用仍由本機歷史端點提供。setup 不會自動安裝 OpenUsage，也不會偷偷執行 Homebrew。

## 2. 建立 Self-hosted 後端

依 README 建立自己的 Firebase Web App、Google Authentication 與 Firestore，再把公開 Web config 放入 `.env.local`。不要放 Provider token、Firebase refresh credential 或 service-account JSON。

## 3. 安裝與檢查

```bash
npm ci
npm run usage -- doctor
npm run usage -- doctor --json
npm run usage -- setup
```

`doctor --json` 是給未來 App／自動診斷使用的穩定狀態；一般人直接看 `doctor` 的短清單即可。`setup` 可重跑：已完成的安全步驟不會重做破壞性操作。

## 4. 狀態對照

| 狀態碼 | 代表 | 下一步 |
| --- | --- | --- |
| `engine_missing` | 找不到可用 OpenUsage 引擎 | 安裝／啟動官方 OpenUsage後再重跑 setup |
| `backend_missing` | Self-hosted Firebase 公開設定未完成 | 完成 `.env.local` 的公開 Firebase 設定 |
| `auth_missing` | Mac Companion 尚未登入自己的同步帳號 | 重跑 setup 完成 Google 登入 |
| `background_missing` | 尚未安裝每五分鐘背景同步 | 重跑 setup |
| `sync_never` | 尚未第一次成功同步 | 確認前述狀態後執行 setup／sync |
| `sync_stale` | 最近成功同步已超過正常心跳 | 執行 doctor 並看故障排除 |

## 5. 背景同步

完成後 macOS LaunchAgent 每五分鐘同步。Provider credential 留在 Mac；Firebase 長期登入憑證只放在 macOS Keychain。

如需移除背景排程或完整清理本機與雲端狀態，請參閱 [docs/uninstall.md](uninstall.md)。

