# AGENTS.md — 94AiUsageDashboard

This document specifies the operational role, boundaries, telemetry truth, and development guardrails for autonomous agents working in `94AiUsageDashboard`.

## 1. Role and Boundaries

- **Read-Only Telemetry Observation**: `94AiUsageDashboard` is strictly an observation dashboard for account-scoped quotas, usage history, and reset windows.
- **DevControl Authority**: Work allocation, worker routing, and scheduling decisions belong exclusively to `superafat/94AiDevControl`. `94AiUsageDashboard` does not decide work allocation.
- **Non-Control**: Dashboard must not launch agents, reset credits, purchase quota or overage, centrally manage provider credentials, or block all development work when telemetry is unavailable.
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
