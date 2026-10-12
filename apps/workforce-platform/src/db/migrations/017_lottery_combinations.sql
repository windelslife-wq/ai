-- Lottery combination intelligence (row 15, slice 2).
--
-- Two tables: the generated-combination record and the AI decision report that
-- documents it (legacy `lottery_combinations` + `lottery_ai_decisions`, the
-- spec §14/§16/§26/§33 pair).
--
--   combinations <- (1:N) ai_decisions
--
-- Every generated line set is stored WITH the inputs that produced it — mode,
-- seed, locks, excludes, context-line count, rules version, dataset version —
-- because the decision record is the ACTUAL inputs used (spec §26), never a
-- story invented after the fact. `lines`, `constraints` and `score_summary`
-- are JSON text exactly as legacy stores them, decoded by the repository on
-- read on both adapters.
--
-- `mode` holds one of legacy's five generation modes (`RANDOM`, `BALANCED`,
-- `HISTORICAL`, `DIVERSIFIED`, `ANTI-POPULAR`) or `SYSTEM` — the stamp a saved
-- full-system build carries. A SYSTEM row's score_summary holds the line count
-- and the C(N,5) x C(S,2) formula instead of a balance score: a system's cost
-- honesty (`estimatedCost: null` — never fabricated) lives in the plan, and no
-- column in this schema names money.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), matching migrations 007
-- through 016 (divergence AV-2 / SP-1 / LT-1).
--
-- Additive only. Provider/draw ids and the combination link are plain integers
-- rather than foreign keys for the reason migration 016 records: the file
-- adapter must implement the identical contract, and it has no referential
-- engine. Nothing here can be purchased, priced or settled for money — these
-- are analysis records about number lines.
--
-- `constraints` keeps legacy's own column name (a MySQL reserved word, hence the
-- backticks legacy also used): renaming it would buy nothing and cost a mapping
-- in every statement, on both adapters.

CREATE TABLE IF NOT EXISTS wf_lottery_combinations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lottery_code VARCHAR(32) NOT NULL,
  mode VARCHAR(32) NOT NULL,
  model_version VARCHAR(64) NOT NULL,
  seed VARCHAR(32) NULL,
  line_count INT NOT NULL DEFAULT 0,
  lines MEDIUMTEXT NOT NULL,
  `constraints` MEDIUMTEXT NOT NULL,
  score_summary MEDIUMTEXT NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_lottery_combinations_code (lottery_code, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_ai_decisions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lottery_code VARCHAR(32) NOT NULL,
  combination_id BIGINT UNSIGNED NULL,
  model_version VARCHAR(64) NOT NULL,
  mode VARCHAR(32) NULL,
  decision MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_lottery_ai_decisions_comb (combination_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
