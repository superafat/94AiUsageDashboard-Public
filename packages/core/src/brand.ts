export const PRODUCT_NAME_EN = '94AiUsageDashboard';
export const PRODUCT_NAME_ZH = '蜂神榜 Ai 額度儀表板';
export const APP_VERSION = '0.1.4';

export interface ReleaseNoteEntry {
  version: string;
  title: string;
  date: string;
  status: 'current' | 'released';
  highlights: readonly string[];
  details?: readonly string[];
}

export const RELEASE_NOTES: readonly ReleaseNoteEntry[] = [
  {
    version: '0.1.4',
    title: '推播辨識與品牌體驗更新',
    date: '2026-09-11',
    status: 'current',
    highlights: [
      '推播通知現在會標示可確認的 AI 來源與額度種類，並顯示已耗用與剩餘比例',
      '新增 iPhone 與 Android 推播設定引導、常見問題與排查說明',
      '導入「蜂神榜 Ai 額度儀表板」品牌識別與蜜蜂吉祥物',
      '新增站內「更新與公告」專區，方便查看目前版本與歷次更新內容',
    ],
    details: [
      '來源沒有提供可靠模型名稱時，只顯示可確認的額度種類，不猜測模型名稱',
      'Reset 券使用流程仍在安全驗證中，目前不會自動或直接消耗任何 Reset 券',
    ],
  },
  {
    version: '0.1.3',
    title: '正確性、帳號隔離與同步可靠性強化',
    date: '2026-09-10',
    status: 'released',
    highlights: [
      '修正額度資料的新鮮度與過期判定，避免舊資料看起來像最新狀態',
      '強化不同帳號與資料來源之間的隔離，並改善多來源同步穩定性',
      '修正歷史資料日期語意與非百分比額度顯示，讓統計結果更符合實際資料',
      '改善診斷判定，避免零來源或異常時間資料被誤判為正常',
    ],
    details: [
      'Reset 券在此版本維持唯讀顯示，不提供消耗操作',
    ],
  },
  {
    version: '0.1.2',
    title: '首次公開 Self-hosted 版本',
    date: '2026-09-06',
    status: 'released',
    highlights: [
      '提供可自行部署的 AI 額度與使用量儀表板',
      '支援 1 天、7 天與 30 天使用歷史檢視',
      '提供 Mac 安裝、診斷、隱私、疑難排解與解除安裝指引',
      'Provider 登入憑證保留在使用者自己的 Mac，不放進網站前端',
    ],
  },
];
