# AGENTS.md — 94AiUsageDashboard

This document specifies the operational role, boundaries, telemetry truth, and development guardrails for autonomous agents working in `94AiUsageDashboard`.

## 1. Role and Boundaries

- **Read-Only Telemetry Observation**: `94AiUsageDashboard` remains observation-first for account-scoped quotas, usage history, and reset windows. The only bounded mutation exception is the Reset Credit R2 lane defined below.
- **DevControl Authority**: Work allocation, worker routing, and scheduling decisions belong exclusively to `superafat/94AiDevControl`. `94AiUsageDashboard` does not decide work allocation.
- **Non-Control**: Dashboard must not launch agents, purchase quota or overage, centrally manage provider credentials, block all development work when telemetry is unavailable, or automatically reset credits.
- **Reset Credit R2 Bounded Exception**: A Reset Credit command may be relayed only after explicit user confirmation in the Web/PWA and only to a paired Mac whose pinned public key verifies the signed inventory and receipts.
  - **Release State**: `v0.1.4` remains in DEVELOPMENT; the latest formal public release remains `v0.1.3`.
  - **Transport vs. Real-Consume Gating**: The R2 transport/runtime lane is enabled via `AI_USAGE_RESET_COMMANDS_ENABLED=1` on the Mac companion (default disabled). Real provider consumption requires an additional R3 rollout gate `AI_USAGE_RESET_REAL_CONSUME_ENABLED=1`. Without both exact flags, new commands fail closed with `code = 'r3_authorization_required'`.
  - **R3 Real Consumption Unauthorized**: R3 is NOT authorized and NOT enabled in production. Real Reset Credit consumption remains 0. Owner exact transaction approval is strictly required before any R3 real-voucher acceptance. Agents must never instruct normal users to enable the R3 flag.
  - **Device-Wide Unresolved Interlock**: Before publishing actionable inventory or starting any new provider mutation, the Mac agent scans all account journals for the same `backendId + userId + deviceId`. If any journal contains unresolved work (`executing`, `reconcileRequired=true`, `state=unknown`, or `code=reconcile_required`), all provider mutations across all accounts on that device are blocked, actionable inventory remains absent/invalidated, and commands return signed `reconcile_required` terminal receipts.
  - **Forbidden Actions**: Automatic reset, automatic retry, silent voucher substitution, browser-side Provider credentials, and unverified key rotation remain strictly forbidden.
- **Account & Device Isolation**: Synchronization is account-scoped and device-isolated. Unknown, stale, or shared-pool observations must never become invented balances or extra independent reserves.

## 2. Privacy & Credential Boundary

- **Credential Containment**: Provider credentials (tokens, session cookies, API keys) remain exclusively on the user's Mac and within macOS Keychain.
- **Sanitized Aggregates Only**: Local Companion synchronizes only authorized, sanitized quota snapshots and daily token/cost aggregates to the user's self-hosted Firebase project.
- **Strict Prohibitions**: Never synchronize, log, or upload raw prompts, model responses, chat logs, session transcripts, source code, or private local file paths.
- **Estimated Costs**: Displayed costs are API-equivalent estimates based on local usage counters and model catalog rates. They are estimates, not paid invoices or billing receipts.
- **Reset Timestamps**: Reaching a reset timestamp indicates reset-awaiting-refresh until upstream replenishment is observed from the provider.

## 3. Multi-Agent Custody & Git Rules

- **Worktree Custody**: Work only in the controller-provided isolated workspace or worktree. Never touch unrelated worktrees or concurrent branches.
- **No Ref Mutation**: AGY must not commit, push, force-push, mutate Git refs or indexes, merge, or create releases unless explicitly requested by the controller.
- **Test-Driven Development**: TDD is mandatory for every functional change (RED failing test first, then minimal GREEN implementation).
- **Public/Private Separation**: The private engineering repository remains private. Public distribution is via sanitized, verified exports to `superafat/94AiUsageDashboard-Public`. Store binaries (App Store / Google Play) remain a separate future release, not a claimed current capability.
- **Zero-Cost GitHub Default**: GitHub Actions / hosted CI and other potentially billable GitHub features are disabled by default. Use local Mac verification (Node/build/tests/Firebase Emulator/Playwright) as the normal gate. Do not enable or run a paid/potentially billable GitHub feature unless the Owner has explicitly approved that exact use after being told why it is necessary and the expected cost/usage impact.
- **No Automatic Actions**: Repository workflows must not trigger on push or pull request. A dormant manual workflow may be retained only as an exception path and must remain remotely disabled unless a specific Owner approval authorizes one run.
