/**
 * The pieces every retention prune shares (row 5; risks R-27 and R-28).
 *
 * Retention in this platform is one policy with per-table windows, applied only
 * by an operator CLI. That policy has three mechanical parts, and they are here
 * rather than copied into four repositories:
 *
 *  - a bounded batch size, because a single unbounded `DELETE` on shared hosting
 *    can hold locks long enough to time out every request;
 *  - a bounded number of batches, so one invocation cannot run forever;
 *  - the report shape every prune returns, which is what the CLI prints and what
 *    the tests pin. `exhausted: false` means "the ceiling was reached and rows
 *    still match"; the remedy is to run again.
 *
 * `ISO_TEXT_LIKE` is a guard, not decoration. `wf_notifications.created_at` and
 * `wf_backtests.created_at` are `VARCHAR(32)` holding ISO-8601 UTC strings, and
 * the prune compares them as text. That comparison is chronological only while
 * every writer uses that one format (migration 006 says so). A row written by a
 * hand-run import as `11/07/2026` sorts *before* every `2026-…` string — the `/`
 * is below `2` — and would be silently deleted as "oldest". The `LIKE` pattern
 * only admits the canonical shape, so a malformed row is skipped and counted,
 * never guessed at.
 */

/** Rows per statement: long enough to make progress, short enough to release locks. */
export function boundedBatch(value, fallback = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 5_000);
}

/** How many statements one invocation may issue before it reports itself unfinished. */
export function boundedBatches(value, fallback = 1_000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 10_000);
}

/**
 * `LIKE` pattern for the canonical `YYYY-MM-DDTHH:MM:SS…` text timestamp.
 * `_` in `LIKE` is exactly one character, so this admits the fixed-width prefix
 * and anything after the seconds — `.000Z` or plain `Z`.
 */
export const ISO_TEXT_LIKE = "____-__-__T__:__:__%";

const ISO_TEXT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** The file adapter's equivalent of `ISO_TEXT_LIKE`, applied in JavaScript. */
export function isIsoText(value) {
  return ISO_TEXT_PATTERN.test(String(value ?? ""));
}

/**
 * The empty report, so all four prunes answer the same shape when there is
 * nothing to do — including the byte count, which the CLI prints as `0 B`.
 */
export function pruneReport({ cutoff, dryRun = false, bytesName = "bytes" } = {}) {
  return {
    matching: 0,
    deleted: 0,
    oldest: null,
    newest: null,
    cutoff,
    batches: 0,
    exhausted: true,
    dryRun: Boolean(dryRun),
    [bytesName]: 0,
  };
}

/**
 * Run the bounded `DELETE … ORDER BY … LIMIT` loop and fill in the report.
 *
 * `runBatch` is passed the clamped batch size and must return the number of rows
 * the statement affected. The loop stops on a partial batch (the table is
 * exhausted) or when the ceiling is reached, in which case the report is marked
 * unfinished rather than pretending the prune completed.
 */
export async function deleteInBatches(report, { batchSize, maxBatches }, runBatch) {
  if (report.dryRun || report.matching === 0) return report;
  const batch = boundedBatch(batchSize);
  const ceiling = boundedBatches(maxBatches);
  while (report.batches < ceiling) {
    const affected = await runBatch(batch);
    report.deleted += affected;
    report.batches += 1;
    if (affected < batch) break;
    if (report.batches === ceiling) report.exhausted = false;
  }
  return report;
}
