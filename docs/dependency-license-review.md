# Dependency & Third-Party License Review

**Project:** 94AiUsageDashboard (v0.1.4)
**Date:** 2026-09-11
**Status:** COMPLETE (Zero Blockers)
**Blockers: 0**

---

## 1. Executive Summary & Policy Boundary

This document provides a comprehensive license inventory and review of all **direct production dependencies** declared across the root and workspace manifests of 94AiUsageDashboard.

> [!IMPORTANT]
> **Project License Decision:**
> The project owner authorized end-to-end public publication on 2026-09-06. 94AiUsageDashboard v0.1.2 is released under the **MIT License**. The dependency audit below remains the compatibility evidence for that decision.

### Classification Categories
1. **Permissive (Approved):** Licenses that grant broad rights to use, modify, and distribute without copyleft reciprocation obligations (e.g., `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`).
2. **Review (Conditional):** Weak copyleft or non-standard licenses (e.g., `MPL-2.0`, `EPL-2.0`, `CDDL-1.0`) that require specific file-isolation and distribution analysis.
3. **Blocker (Prohibited without legal review):** Any strong copyleft, source-available, custom, unlicense, or unknown licenses (`GPL`, `AGPL`, `SSPL`, `custom`, `unknown`). Any direct production dependency in this category is a hard publication blocker.

---

## 2. Inventory Methodology

1. **Manifest Inspection:** Inspected root `package.json` and all workspace manifests defined in `package.json`:
   - `apps/agent`
   - `apps/web`
   - `packages/core`
   - `packages/firebase`
   - `packages/openusage`
   - `packages/client`
   - `packages/ui`
2. **Scope Filtering:**
   - **Included:** Direct production dependencies declared in `dependencies`.
   - **Excluded (Internal Workspaces):** Local monorepo packages prefixed with `@94ai/*`.
   - **Excluded (Dev-only):** Development, build, and test tooling declared under `devDependencies`.
3. **Metadata Resolution:**
   - Package version and SPDX license identifier resolved directly from installed package metadata (`node_modules/<pkg>/package.json`) and cross-checked with `package-lock.json`.

---

## 3. Direct Production Dependency Inventory

Every direct production dependency declared in root or workspace manifests is itemized below:

| Package Name | Declaring Workspace(s) | Declared Specifier | Resolved Version | License (SPDX) | Classification | Blocker Status | License Notice Source |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `@testing-library/jest-dom` | `apps/web` | `^6.9.1` | `6.9.1` | `MIT` | **Permissive** | No | `node_modules/@testing-library/jest-dom/LICENSE` |
| `@testing-library/react` | `apps/web` | `^16.3.3` | `16.3.3` | `MIT` | **Permissive** | No | `node_modules/@testing-library/react/LICENSE` |
| `@vitejs/plugin-react` | `apps/web` | `^5.2.0` | `5.2.0` | `MIT` | **Permissive** | No | `node_modules/@vitejs/plugin-react/LICENSE` |
| `firebase` | `apps/web`, `packages/firebase` | `^12.18.0` / `^12.2.0` | `12.18.0` | `Apache-2.0` | **Permissive** | No | `node_modules/firebase/LICENSE` |
| `jsdom` | `apps/web` | `^26.1.0` | `26.1.0` | `MIT` | **Permissive** | No | `node_modules/jsdom/LICENSE.txt` |
| `react` | `apps/web`, `packages/ui` | `^19.2.8` | `19.2.8` | `MIT` | **Permissive** | No | `node_modules/react/LICENSE` |
| `react-dom` | `apps/web` | `^19.2.8` | `19.2.8` | `MIT` | **Permissive** | No | `node_modules/react-dom/LICENSE` |
| `vite` | `apps/web` | `^7.3.6` | `7.3.6` | `MIT` | **Permissive** | No | `node_modules/vite/LICENSE.md` |

| `web-push` | `apps/agent` | `3.6.7` | `3.6.7` | `MPL-2.0` | **Review — Approved for this unmodified dependency** | No | `node_modules/web-push/LICENSE` |

### Workspace-Internal Packages (Monorepo Code)
The following packages are declared under `dependencies` but represent internal workspace modules authored within this repository, not third-party dependencies:
- `@94ai/core` (`packages/core`)
- `@94ai/firebase` (`packages/firebase`)
- `@94ai/openusage` (`packages/openusage`)
- `@94ai/client` (`packages/client`)
- `@94ai/ui` (`packages/ui`)
- `@94ai/agent` (`apps/agent`)
- `@94ai/web` (`apps/web`)

### Note on Web Workspace Tooling Dependencies
Several testing and bundler tools (`@testing-library/jest-dom`, `@testing-library/react`, `@vitejs/plugin-react`, `jsdom`, `vite`) are declared under `dependencies` in `apps/web/package.json`. In accordance with the requirement to audit all declared production dependencies, they are included in this review. All five packages are licensed under the permissive `MIT` license and do not impose restrictive distribution obligations.

---

## 4. Review Findings & Blocker Assessment

- **Total Direct External Production Dependencies:** 9 unique packages
- **Permissive Licenses:** 8 (7 `MIT`, 1 `Apache-2.0`)
- **Review Licenses:** 1 (`web-push` 3.6.7, MPL-2.0; bounded decision below)
- **Blocker Licenses:** 0 (`Blockers: 0`)

No GPL, AGPL, SSPL, custom, or unknown licenses exist among direct production dependencies.

---

## 5. Third-Party Attribution & Trademark Boundaries

### OpenUsage Engine
- **Upstream Repository:** https://github.com/robinebers/openusage
- **Author:** Robin Ebers
- **License:** `MIT` License
- **Integration Model:** Managed external binary / local data engine. Not forked, not embedded in this repository.
- **Trademark Boundary & Affiliation:** OpenUsage is an independent project by Robin Ebers. 94AiUsageDashboard is an independent third-party integration and is not endorsed by, affiliated with, or sponsored by OpenUsage or Robin Ebers. All trademarks and project names remain the property of their respective owners.

---

## 6. Next Release Gates

1. **Gate 3 (License Approval): APPROVED.** Project license is MIT; direct dependency review has zero blockers.
2. **Gate 4 (Owner Sign-off): APPROVED 2026-09-06.** Owner authorized end-to-end public publication, including creation of the separate clean public repository.

## 7. v0.1.4 Web Push dependency decision

`web-push` **3.6.7** is MPL-2.0, not MIT or a permissive license. This is an **Unmodified Node-only integration**: the original library remains a separate npm dependency in the Mac Companion. No upstream source is copied into our MIT files or modified, and it is not included in the browser application bundle. The project license remains MIT; dependency rights remain MPL-2.0. This specific reviewed case does not approve arbitrary MPL packages or future versions.

Source and license are available in the exact source package:
https://registry.npmjs.org/web-push/-/web-push-3.6.7.tgz

The distribution retains the dependency's LICENSE and source package metadata. Public users receive this source/rights notice in `THIRD_PARTY_NOTICES.md` and the pinned package-lock. Any later binary bundling must retain the notice and access to the MPL-covered source; modifying or copying MPL source requires a new file-level license review. Existing prohibitions on GPL/AGPL/SSPL/unknown licenses are unchanged.

Verified lock integrity: `sha512-OpiIUe8cuGjrj3mMBFWY+e4MMIkW3SVT+7vEIjvD9kejGUypv8GPDf84JdPWskK8zMRIJ6xYGm+Kxr8YkPyA0A==`.
The dev-only `@types/web-push` **3.6.4** declarations are MIT and are not runtime crypto.

Primary references: https://github.com/web-push-libs/web-push/blob/master/LICENSE and https://www.mozilla.org/en-US/MPL/2.0/FAQ/ (file-level licensing and source-access notices). **Blockers: 0** for the exact unmodified integration; this is an engineering distribution inventory, not a blanket legal opinion.
