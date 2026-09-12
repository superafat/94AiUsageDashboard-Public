import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  PRODUCT_NAME_EN,
  PRODUCT_NAME_ZH,
  RELEASE_NOTES,
} from "./brand";

describe("canonical product brand identity", () => {
  it("defines canonical English product name exact as 94AiUsageDashboard (lowercase i)", () => {
    expect(PRODUCT_NAME_EN).toBe("94AiUsageDashboard");
    expect(PRODUCT_NAME_EN).not.toBe("94AIUsageDashboard");
    expect(PRODUCT_NAME_EN).not.toBe("94AiUseageDashboard");
    expect(PRODUCT_NAME_EN).toMatch(/^94AiUsageDashboard$/);
  });

  it("defines canonical Chinese product name exact as 蜂神榜 Ai 額度儀表板 (lowercase i)", () => {
    expect(PRODUCT_NAME_ZH).toBe("蜂神榜 Ai 額度儀表板");
    expect(PRODUCT_NAME_ZH).not.toBe("蜂神榜 AI 額度儀表板");
    expect(PRODUCT_NAME_ZH).not.toBe("AI 額度儀表板");
    expect(PRODUCT_NAME_ZH).toMatch(/^蜂神榜 Ai 額度儀表板$/);
  });

  it("defines current working app version as 0.1.4", () => {
    expect(APP_VERSION).toBe("0.1.4");
  });
});

describe("sanitized release note model", () => {
  it("exposes current development version 0.1.4 truthfully with required metadata", () => {
    expect(Array.isArray(RELEASE_NOTES)).toBe(true);
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);

    const current = RELEASE_NOTES[0];
    expect(current).toBeDefined();
    if (!current) throw new Error('missing current entry');
    expect(current.version).toBe("0.1.4");
    expect(current.status).toBe("development");
    expect(typeof current.title).toBe("string");
    expect(current.title.length).toBeGreaterThan(0);
    const formal = RELEASE_NOTES.find((entry) => entry.version === "0.1.3");
    expect(formal?.status).toBe("released");
    expect(typeof current.date).toBe("string");
    expect(current.date.length).toBeGreaterThan(0);
    expect(Array.isArray(current.highlights)).toBe(true);
    expect(current.highlights.length).toBeGreaterThan(0);
  });


  it("keeps v0.1.3 release history aligned with the published hardening release and does not backdate v0.1.4 push work", () => {
    const current = RELEASE_NOTES.find((entry) => entry.version === "0.1.4");
    const previous = RELEASE_NOTES.find((entry) => entry.version === "0.1.3");
    expect(current).toBeDefined();
    expect(previous).toBeDefined();
    if (!current || !previous) throw new Error("missing release history");

    const currentText = [current.title, ...current.highlights, ...(current.details ?? [])].join(" ");
    const previousText = [previous.title, ...previous.highlights, ...(previous.details ?? [])].join(" ");
    expect(currentText).toMatch(/推播/);
    expect(currentText).toMatch(/來源|額度種類|耗用/);
    expect(previousText).toMatch(/新鮮|過期|帳號|隔離|同步/);
    expect(previousText).not.toMatch(/iPhone|Android|推播通知設定/);
  });

  it("strictly sanitizes user-facing release notes from private internals and secrets", () => {
    const forbiddenPatterns = [
      { name: "git commit hash", regex: /\b[0-9a-f]{7,40}\b/i },
      { name: "PR identifier", regex: /\bPR\s*#?\d+\b|#\d+/i },
      { name: "Issue identifier", regex: /\bissue\s*#?\d+\b/i },
      { name: "private local path", regex: /(?:\/Users\/|\/home\/|\/private\/|\.worktrees)/i },
      { name: "token / secret shape", regex: /(?:AIza|ya29\.|gh[oprsu]_|1\/\/|ey[A-Za-z0-9_-]{20,})/ },
      { name: "email address", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
      { name: "raw HTML tag", regex: /<[^>]+>/ },
    ];

    for (const entry of RELEASE_NOTES) {
      const textsToScan = [
        entry.version,
        entry.title,
        entry.date,
        ...(entry.highlights ?? []),
        ...(entry.details ?? []),
      ];

      for (const text of textsToScan) {
        for (const { regex } of forbiddenPatterns) {
          expect(regex.test(text)).toBe(false);
        }
      }
    }
  });
});
