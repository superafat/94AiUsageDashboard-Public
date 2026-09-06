# 94AiUsageDashboard v0.1.2 Publication & Security Checklist

> **CRITICAL POLICY:** The private development repository stays private permanently.
>
> Owner authorization for public publication was granted on 2026-09-06. Public releases MUST be created only from a verified sanitized clean export in a separate public repository; private Git history must never be pushed or copied into that repository.

## Pre-Publication Release Gates

All gates below are mandatory and must be verified before any public release candidate is approved:

- [x] **1. History scan**:
  - Run full Git history audit across all reachable commits and historical blobs (`npm run audit:public`).
  - Verify no API keys, private tokens, personal email addresses, local home paths (`<HOME>/...`), or internal identifiers exist in any commit.
  - Zero unreviewed real-secret findings; reviewed synthetic/policy fixtures must match the exact bounded baseline.
  - *v0.1.2 Status:* Audited across reachable commits. ZERO real secrets or private credentials found. 16 historical policy findings identified (12 local home path patterns, 2 example email patterns, 2 synthetic Firebase project markers), all 16 matching the reviewed bounded baseline and containing zero real secrets. Because private Git history contains historical findings rather than zero findings, public release MUST proceed via sanitized clean export into a new public repository rather than making the private repository public.

- [x] **2. Binary review**:
  - Audit every tracked binary file (screenshots, images, icons, archives).
  - Ensure every binary has a recorded SHA-256 and has been reviewed for sensitive account info (email, avatars, private consoles).
  - Any unreviewed binary blocks release.
  - *v0.1.2 Status:* 3 tracked screenshot PNG files in `docs/evidence/` verified against SHA-256 allowlist (`3261d049...`, `71a6cf6e...`, `69ff3214...`). All visually reviewed per Controller ruling as synthetic test quota UI with clean metadata chunks (`IHDR`, `IDAT`, `IEND` only). All binary evidence files are excluded from the clean public export.

- [x] **3. License approval**:
  - Project license: **MIT License** (`LICENSE`).
  - Review all third-party dependencies for compatibility and attribution requirements.
  - *v0.1.2 Status:* **APPROVED 2026-09-06**. Direct dependencies are cataloged with zero blockers; project license is MIT.

- [x] **4. Owner approval**:
  - Exact release identity: `0.1.2`.
  - Private development repository remains private.
  - Separate clean public repository is authorized for self-hosted distribution.
  - *v0.1.2 Status:* **APPROVED 2026-09-06**. Owner authorized end-to-end handling, including creation and setup of the public repository.

- [x] **5. Clean export**:
  - Verify the clean export manifest and artifacts.
  - Ensure the exported public tree contains only sanitized documentation, configuration placeholders, and verified code.
  - Guarantee that local developer credentials, `.env*` files, and private development environments are never exported.
  - *v0.1.2 Status:* **VERIFIED ON FINAL RELEASE CANDIDATE**. Publication requires the canonical Node 22 release gate, regenerated sanitized export, manifest verification, and clean-room acceptance to pass on the exact candidate; immutable evidence is kept in the private engineering repository.

---

## v0.1.2 Publication Readiness Assessment

| Field | Value |
| :--- | :--- |
| **Release Version** | `0.1.2` |
| **Implementation Candidate Commit** | Determined by final clean verification; exact SHA is recorded in private release evidence. |
| **Candidate Tree SHA** | Recorded in private release evidence after final clean verification. |
| **Recommended Publication Mechanism** | **Sanitized clean export in the separate public repository `superafat/94AiUsageDashboard-Public`.** Private repository remains strictly private. |
| **Git History Findings** | 16 total historical findings (12 `local_home_path`, 2 `email_address`, 2 `private_firebase_marker`). Zero real secrets. |
| **Remaining REVIEW Items** | 3 tracked binary PNGs in `docs/evidence/` (allowlisted by SHA-256, visually reviewed as synthetic UI, excluded from export). |
| **License Decision** | **MIT — APPROVED 2026-09-06**. |
| **Release PR Requirement** | Private release PR and exact-head CI must be green before publication. |
| **Working Tree** | Must be clean when the final release gate and export run. |
| **Rollback Reference** | Exact private candidate SHA is recorded in private release evidence after final verification. |
| **Full Evidence Document** | `docs/evidence/v0.1.2-publication-readiness.md` |
