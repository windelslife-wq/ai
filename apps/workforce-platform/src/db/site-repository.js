/**
 * Public-site SQL for the MySQL/MariaDB adapter (Phase 3: contact intake).
 *
 * Same rules as `account-repository.js`: every value is bound, sort columns are
 * resolved through an allow-list, and LIMIT/OFFSET are coerced to bounded integers
 * before interpolation because mysql2 does not bind them reliably in `LIMIT`.
 */

const SORT_COLUMNS = Object.freeze({
  id: "id",
  createdAt: "created_at",
  name: "name",
  email: "email",
  status: "status",
});

function boundedInteger(value, { fallback, min = 1, max = 200 }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function directionOf(value) {
  return String(value).toLowerCase() === "asc" ? "ASC" : "DESC";
}

function likeTerm(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`).slice(0, 80)}%`;
}

function row(row) {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    email: row.email,
    message: row.message,
    status: row.status,
    clientFingerprint: row.client_fingerprint,
    userAgent: row.user_agent ?? null,
    requestId: row.request_id ?? null,
    handledBy: row.handled_by ?? null,
    handledAt: row.handled_at ?? null,
    createdAt: row.created_at,
  };
}

export function createSiteRepository(pool) {
  return {
    async recordContactInquiry({ reference, name, email, message, clientFingerprint, userAgent = null, requestId = null, createdAt = null }) {
      await pool.execute(
        `INSERT INTO wf_contact_inquiries
           (reference, name, email, message, client_fingerprint, user_agent, request_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', COALESCE(?, UTC_TIMESTAMP(3)))`,
        [reference, name, email, message, clientFingerprint, userAgent, requestId, createdAt ? new Date(createdAt) : null],
      );
      const [rows] = await pool.execute(
        "SELECT id, reference, created_at FROM wf_contact_inquiries WHERE reference = ? LIMIT 1",
        [reference],
      );
      return {
        id: rows[0]?.id ?? null,
        reference,
        createdAt: rows[0]?.created_at ?? null,
      };
    },

    async pageContactInquiries({ limit = 25, offset = 0, search = null, status = null, sort = "createdAt", direction = "desc" } = {}) {
      const boundedLimit = boundedInteger(limit, { fallback: 25, max: 200 });
      const boundedOffset = boundedInteger(offset, { fallback: 0, min: 0, max: 1_000_000 });
      const orderBy = SORT_COLUMNS[sort] || SORT_COLUMNS.createdAt;
      const where = [];
      const values = [];
      if (search) {
        where.push("(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR reference LIKE ?)");
        const term = likeTerm(String(search).toLowerCase());
        values.push(term, term, term);
      }
      if (status) {
        where.push("status = ?");
        values.push(status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM wf_contact_inquiries ${clause}`, values);
      const [rows] = await pool.query(
        `SELECT id, reference, name, email, message, status, client_fingerprint, user_agent, request_id, handled_by, handled_at, created_at
           FROM wf_contact_inquiries
          ${clause}
          ORDER BY ${orderBy} ${directionOf(direction)}, id DESC
          LIMIT ${boundedLimit} OFFSET ${boundedOffset}`,
        values,
      );
      return { total: Number(countRow?.total ?? 0), inquiries: rows.map(row) };
    },

    async countContactInquiries() {
      const [[countRow]] = await pool.query("SELECT COUNT(*) AS total FROM wf_contact_inquiries");
      return Number(countRow?.total ?? 0);
    },
  };
}
