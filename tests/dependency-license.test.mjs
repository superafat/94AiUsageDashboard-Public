import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = process.cwd();
const DOC_REVIEW_PATH = path.join(ROOT_DIR, "docs", "dependency-license-review.md");
const NOTICES_PATH = path.join(ROOT_DIR, "THIRD_PARTY_NOTICES.md");

function getDirectProductionDependencies() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const workspaces = rootPkg.workspaces || [];
  const directDeps = new Map();

  // Root dependencies
  if (rootPkg.dependencies) {
    for (const [name, versionRange] of Object.entries(rootPkg.dependencies)) {
      if (!name.startsWith("@94ai/")) {
        if (!directDeps.has(name)) directDeps.set(name, []);
        directDeps.get(name).push({ workspace: "root", versionRange });
      }
    }
  }

  // Workspaces dependencies
  for (const ws of workspaces) {
    const wsPkgPath = path.join(ROOT_DIR, ws, "package.json");
    if (fs.existsSync(wsPkgPath)) {
      const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, "utf8"));
      if (wsPkg.dependencies) {
        for (const [name, versionRange] of Object.entries(wsPkg.dependencies)) {
          if (!name.startsWith("@94ai/")) {
            if (!directDeps.has(name)) directDeps.set(name, []);
            directDeps.get(name).push({ workspace: ws, versionRange });
          }
        }
      }
    }
  }

  return directDeps;
}

function getInstalledMetadata(pkgName) {
  const pkgJsonPath = path.join(ROOT_DIR, "node_modules", pkgName, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Package ${pkgName} is not installed in node_modules`);
  }
  return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
}

test("docs/dependency-license-review.md exists and inventories all direct production dependencies", () => {
  assert.ok(fs.existsSync(DOC_REVIEW_PATH), "docs/dependency-license-review.md must exist");
  const content = fs.readFileSync(DOC_REVIEW_PATH, "utf8");

  const directDeps = getDirectProductionDependencies();
  assert.ok(directDeps.size > 0, "Must have discovered direct production dependencies");

  for (const [pkgName] of directDeps.entries()) {
    const meta = getInstalledMetadata(pkgName);
    const installedVersion = meta.version;
    const license = meta.license || (meta.licenses && meta.licenses[0]?.type);

    // Package name must be in the document
    assert.ok(
      content.includes(pkgName),
      `docs/dependency-license-review.md must include direct production dependency: ${pkgName}`
    );

    // Resolved version must be in the document
    assert.ok(
      content.includes(installedVersion),
      `docs/dependency-license-review.md must include resolved version ${installedVersion} for ${pkgName}`
    );

    // License must be in the document
    assert.ok(
      content.includes(license),
      `docs/dependency-license-review.md must include license ${license} for ${pkgName}`
    );
  }
});

test("every direct production dependency has license classification and no blockers", () => {
  const content = fs.readFileSync(DOC_REVIEW_PATH, "utf8");
  const directDeps = getDirectProductionDependencies();

  const PERMISSIVE_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);
  const BLOCKER_REGEX = /GPL|AGPL|SSPL|custom|unknown/i;

  for (const [pkgName] of directDeps.entries()) {
    const meta = getInstalledMetadata(pkgName);
    const license = String(meta.license || (meta.licenses && meta.licenses[0]?.type) || "UNKNOWN");

    assert.ok(
      !BLOCKER_REGEX.test(license),
      `Package ${pkgName} has blocker license ${license}; GPL/AGPL/SSPL/custom/unknown direct production dependencies are forbidden without owner/legal review`
    );

    assert.ok(
      PERMISSIVE_LICENSES.has(license),
      `Package ${pkgName} license ${license} must be classified as Permissive`
    );
  }

  // Document must explicitly classify Permissive and state 0 blockers
  assert.match(content, /Classification/i);
  assert.match(content, /Permissive/i);
  assert.match(content, /Blockers?:\s*0|0\s*blockers?/i);
});

test("OpenUsage attribution in THIRD_PARTY_NOTICES.md specifies MIT and trademark boundary without affiliation", () => {
  assert.ok(fs.existsSync(NOTICES_PATH), "THIRD_PARTY_NOTICES.md must exist");
  const notices = fs.readFileSync(NOTICES_PATH, "utf8");

  // Verify MIT License
  assert.match(notices, /MIT\s+License|License:\s*MIT/i);

  // Verify Author/Copyright
  assert.match(notices, /Robin\s+Ebers/i);
  assert.match(notices, /Copyright/i);

  // Verify independent third-party boundary & no affiliation
  assert.match(notices, /independent|獨立/i);
  assert.match(notices, /trademark|商標/i);
  assert.match(notices, /not\s+affiliated|no\s+affiliation|不代表.*背書|未獲.*背書|獨立第三方/i);
});

test("project open-source license is MIT and publication docs record owner authorization", () => {
  const content = fs.readFileSync(DOC_REVIEW_PATH, "utf8");
  const notices = fs.readFileSync(NOTICES_PATH, "utf8");
  const licensePath = path.join(ROOT_DIR, "LICENSE");
  const checklistPath = path.join(ROOT_DIR, "docs/publication-checklist.md");

  assert.ok(fs.existsSync(licensePath), "LICENSE must exist before public publication");
  const license = fs.readFileSync(licensePath, "utf8");
  const checklist = fs.readFileSync(checklistPath, "utf8");

  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 superafat/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(content, /project license.*MIT|MIT.*project license/i);
  assert.match(notices, /94AiUsageDashboard v0\.1\.2.*MIT License/i);
  assert.match(checklist, /License Decision.*MIT/i);
  assert.match(checklist, /Owner approval[\s\S]*APPROVED/i);
});
