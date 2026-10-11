# Phase 8A — Human-reviewed paper execution proposals

**Date:** 2026-10-11 · **Branch:** `arena/b175c3e9-ai` · **Status:** partial implementation

## Scope and safety boundary

The selected Execution Supervisor workstream begins with a deliberately narrow,
paper-only proposal workflow. It is **not** a port of the full legacy supervisor;
its remaining scope must be reconciled with the PHP implementation and its tests.
The PHP `ExecutionSupervisor::route()` reaches `TradingConnector::placeOrder()`;
that broker/live-order boundary is intentionally absent from Node.

The Node service has no generic `/execution` route, `route()` method, broker
connector, live account, or automation mode. An approved proposal can be submitted
only through the existing Phase-7 Paper Trading service. That service reruns its
market-data, owner/account, mode/kill-switch, equity and RiskEngine checks at the
time of submission. All output remains simulation-only.

## Implemented workflow

1. An authenticated user creates a proposal for a paper account they own.
2. The service normalizes the intent and persists a small preflight record. It
   rejects unsafe global governance state and, when a strategy is specified,
   requires the exact executable version to be `APPROVED`; AI-sourced strategies
   also require their existing persisted human risk sign-off.
3. Eligible proposals enter `PENDING_APPROVAL`. A separately permissioned human
   decision (`trading.control`) records an approve/decline choice and a required
   reason. An unanswered approval expires after four hours.
4. Only `APPROVED` proposals may be submitted, through `paper.submitOrder()` and
   under `trading.execute`. A database compare-and-set / file-store serialized
   transaction claims the proposal once before the Paper Trading call.
5. The proposal records a bounded paper result or a safe failure status and emits
   an audit event. The result preserves synthetic provenance.

The claim is intentionally **at most once**. If the process stops after claiming
`PAPER_SUBMITTING`, Node does not retry automatically: the paper order might have
been created just before the interruption, and retrying could duplicate it. This
slice has no reconciliation worker or operator recovery command.

Current stored states are `REJECTED`, `PENDING_APPROVAL`, `APPROVED`, `DECLINED`,
`EXPIRED`, `PAPER_SUBMITTING`, `PAPER_EXECUTED`, `PAPER_PENDING`,
`PAPER_REJECTED`, and `PAPER_FAILED`.

## HTTP surface

All reads require `trading.view`; proposal creation and paper submission require
`trading.execute`; approve/decline requires `trading.control`. Cookie mutations
require session CSRF. Proposal lookup/listing bind the caller and independently
verify paper-account ownership. A foreign proposal appears not found.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/execution/status` | Reports the bounded paper-only scope and explicitly reports live/broker/automated capabilities unavailable |
| POST | `/api/v1/execution/proposals` | Create and preflight an owner-scoped paper proposal |
| GET | `/api/v1/execution/proposals` | List the caller's proposals with optional status/limit filters |
| GET | `/api/v1/execution/proposals/:proposalId` | Read one owner-scoped proposal |
| POST | `/api/v1/execution/proposals/:proposalId/decision` | Record a human approve/decline decision and reason |
| POST | `/api/v1/execution/proposals/:proposalId/paper-submit` | Submit an approved proposal once through Paper Trading |

There is no `POST /api/v1/execution`, `/route`, `/live`, broker route, or direct
connector call. `/system/status` reports `execution: partial`,
`paperProposalWorkflowAvailable: true`, and `liveTradingEnabled: false`.

## Persistence

Migration `008_execution_supervisor.sql` adds only `wf_execution_proposals` (the
Node schema now contains 22 tables). It stores a UUID, owner/account IDs, status,
intent/check/result JSON, human decision metadata, an optional paper-order FK and
timestamps. It deliberately creates no broker/live execution table.

The MySQL/MariaDB repository joins proposals to paper accounts and binds owner IDs
for reads and compare-and-set transitions. The file adapter includes the proposal
entity in its serialized WAL transaction and checks the same owner/account pair.
Both adapters expose proposal reads through the repository contract. Readiness now
requires migration `008_execution_supervisor`.

## Preserved Phase 7 acceptance

This extension does not change Phase 7's safety requirements: paper accounts remain
owner-scoped; persisted risk and governance remain authoritative; execution is
simulation-only; DV-10 still vetoes non-positive/non-finite equity; synthetic
provenance is retained; and synthetic paper trades remain excluded from live-approval
evidence. A proposal decision is not a live approval, and this module does not
provide evidence for enabling broker execution.

## Automated evidence and remaining gates

Final automated verification: workforce-platform `npm test` **482/482** and
`npm run verify:install` **29/29** (102 source files syntax-checked; 64 config
variables documented; client-bundle check skipped because `public/app/index.html`
is absent). Tests cover proposal normalization, preflight rejection, persisted
approval and expiry, owner isolation, AI strategy lifecycle/sign-off checks,
at-most-once claims, audit, synthetic result provenance, HTTP permissions/CSRF, a
synthetic Paper Trading round trip, file-store restart, migration parsing, backup
table discovery, and owner-bound compare-and-set SQL text/bind values. The latter
SQL tests use a recording fake; **no real MySQL/MariaDB server has been exercised**.

No cPanel/Passenger deployment, backup/restore rehearsal against the target database,
concurrent multi-worker test, PHP↔Node parity sign-off, licensed/live feed check or
production cutover has been performed. Keep PHP authoritative and live trading
disabled.

The full ordered Execution Supervisor, its automation envelope, broker/demo-account
gates, failure reconciliation/recovery, deeper parity tests and actual host validation
remain unfinished. Next acceptance work is to run migrations 001–008 and transaction
checks on the supported MySQL/MariaDB version, then rehearse backup/restore and
rollback on the real cPanel/Passenger host before expanding the supervisor scope.
