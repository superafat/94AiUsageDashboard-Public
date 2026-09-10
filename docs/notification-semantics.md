# v0.1.4 notification event contract

This source module does not send notifications, launch work, consume reset vouchers or change provider state. Phone delivery and sync integration are tracked separately in #29; the #28 helpers are not evidence of a live notification.

## Observation and opt-in

The asynchronous evaluator uses browser-compatible Web Crypto for deterministic event IDs. It requires an injected clock and exact backend/user/device/provider/resource identity. Notification channels default off. Missing, stale, future, erroneous, contradictory or out-of-order observations never invent full quota or a new baseline. Only valid fresh observations establish state. State and event schemas reject unknown fields and invalid dates, numeric values or event bands.

Consumption uses absolute ten-percentage-point bands. The first fresh observation and new opt-in establish a baseline without replaying old alerts. A multi-band jump yields one event. The high-water mark is retained through ordinary corrections. Units, limits, plans and materially changed windows have explicit rebaseline semantics; separate provider accounts and resources are never combined.

## Reset evidence

A countdown reaching zero is not a reset. The current conservative reset event requires a later provider reset timestamp by at least sixty seconds, still in the future, at least 99% remaining and at least ten percentage points of observed replenishment. A new window without this evidence is quietly rebaselined. Small timestamp jitter retains the cycle anchor. Partial rolling recovery, backwards timestamps and plan changes do not claim a full reset. This can miss a reset followed by substantial consumption between polls; it does not guess. Reset cause is not attributed to manual/global action. A future verified command integration must provide its own account-bound evidence rather than an arbitrary success boolean.

## Local durable journal

The caller supplies a dedicated existing local directory. The journal pins backend/user/device identity and keys states by full provider and resource. Bounded reads validate all stored records; corruption or a foreign scope is rejected without overwriting it. Files are regular and non-linked, writes use a private exclusive temporary file, fsync and atomic rename. The lock is not automatically stolen or broken.

State and outbox changes are persisted together. Pending and acknowledged events are separate. Replays of known event IDs do not add duplicate pending events. Unknown acknowledgements, oversized state/file/item counts and older state writes fail closed. Expiry pruning is explicit and clock-injected. Capacity failure preserves the prior journal rather than silently dropping pending records. Neither an outbox entry nor a successful acknowledgement is a phone delivery receipt without a separately verified sender.
