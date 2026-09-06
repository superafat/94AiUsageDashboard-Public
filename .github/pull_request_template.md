## 目的與範圍

## 驗證
- [ ] Tests 已新增／更新並通過
- [ ] UI 變更附實際 browser screenshot / visual evidence
- [ ] Provider 行為變更有正常、缺欄位、stale／error 測試
- [ ] `npm run verify:public-ready` 通過（release candidate）

## Privacy / Security
- [ ] 沒有 Provider token、credential、Cookie、.env.local、私人 log 或正式使用者資料
- [ ] 已說明 Firebase Rules／UID／裝置健康資料影響
- [ ] 不新增未經批准的不可逆 quota/reset mutation

## 回退方式
