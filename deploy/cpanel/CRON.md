# cPanel cron jobs

The platform ships **three scheduled CLI entry points**. Add their lines in cPanel → Cron Jobs after the application is up; the full context (locking, exit codes, backups) is in
[`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §7.

```cron
# Operations sweep: portfolio risk + stale proposal expiry. Measures unless --apply.
* * * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/scheduled-jobs.mjs --apply >> /home/USER/logs/workforce-cron.log 2>&1

# Sports: nine jobs in legacy's order (fixtures, odds, results, quality, ticket, settlement,
# performance, monitoring, cleanup), hourly.
0 * * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/sports-jobs.mjs --json >> /home/USER/logs/workforce-sports-cron.log 2>&1

# Lottery: seven jobs in legacy's order (sync, health, statistics, systems, tickets, backtests,
# retention), after the daily draw.
30 5 * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/lottery-jobs.mjs --json >> /home/USER/logs/workforce-lottery-cron.log 2>&1
```

Three properties of those lines are load-bearing:

- **Absolute `node` path.** cron does not inherit an interactive shell's `PATH`.
- **`cd` first.** `loadConfig` resolves relative storage paths against the working directory.
- **Source the environment.** The jobs need the same variables as the web app (`SESSION_SECRET`,
  `DB_*`); cPanel gives those to Passenger through the Application Manager, not to cron. Keep them
  in a file outside the web root with `0600` — never inline in the crontab, where they appear in the
  process list.

Before trusting the schedule: the **file adapter's lock is single-process only**
(`crossProcessSafety: false`), so real cron needs MySQL to be safe against overlap. A run that
overlaps the previous one reports `SKIPPED`, names the holder and exits 0; exit 1 means refused,
failed, or completed with a stage error. **No crontab has been installed in this repository** and
none of the three lines has been observed under real cron.

Never launch a persistent worker or daemon from cPanel cron, and do not schedule lottery/ticket
generation or any trading action. Cron must not enable live providers, trading, or publication
implicitly: every job takes its configuration from the environment it is given, and none of them
flips a gate.
