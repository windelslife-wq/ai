/**
 * Central error taxonomy for the HTTP platform.
 *
 * Rules:
 *  - Only AppError instances are safe to serialize to clients. Everything else
 *    becomes a generic 500 and is logged with its internal detail.
 *  - Database and filesystem causes are never echoed verbatim: they can contain
 *    table names, credentials fragments or absolute paths.
 */

export class AppError extends Error {
  constructor(statusCode, code, message, { details = null, retryAfter = 0, cause = null } = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
    if (cause) this.cause = cause;
  }

  static badRequest(message, { code = "INVALID_REQUEST", details = null } = {}) {
    return new AppError(400, code, message, { details });
  }

  static unauthorized(message = "Authentication is required", { code = "AUTH_REQUIRED" } = {}) {
    return new AppError(401, code, message);
  }

  static forbidden(message = "You do not have permission to perform this action", { code = "PERMISSION_DENIED" } = {}) {
    return new AppError(403, code, message);
  }

  static notFound(message = "The requested resource was not found", { code = "NOT_FOUND" } = {}) {
    return new AppError(404, code, message);
  }

  static conflict(message, { code = "CONFLICT", details = null } = {}) {
    return new AppError(409, code, message, { details });
  }

  static tooLarge(message = "The request body is too large", { code = "BODY_TOO_LARGE" } = {}) {
    return new AppError(413, code, message);
  }

  static unsupportedMediaType(message = "Unsupported media type", { code = "UNSUPPORTED_MEDIA_TYPE" } = {}) {
    return new AppError(415, code, message);
  }

  static unprocessable(message, { code = "VALIDATION_FAILED", details = null } = {}) {
    return new AppError(422, code, message, { details });
  }

  static tooManyRequests(message = "Too many requests", { retryAfter = 60 } = {}) {
    return new AppError(429, "RATE_LIMITED", message, { retryAfter });
  }

  static internal(message = "An unexpected error occurred", { cause = null } = {}) {
    return new AppError(500, "INTERNAL_ERROR", message, { cause });
  }

  static unavailable(message = "The service is temporarily unavailable", { code = "SERVICE_UNAVAILABLE", retryAfter = 5 } = {}) {
    return new AppError(503, code, message, { retryAfter });
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Errors that must keep their public contract stable regardless of how the
 * transport produced them.
 */
export function normalizeError(error, { headOnly = false } = {}) {
  if (error instanceof AppError) return error;
  const mapped = mapDatabaseError(error) || mapFileSystemError(error);
  if (mapped) return mapped;

  // Node's own socket/parse errors carry a code but no safe message.
  const internalCode = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
  const wrapped = new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred", { cause: error });
  wrapped.internalCode = internalCode;
  wrapped.headOnly = headOnly;
  return wrapped;
}

const UNAVAILABLE_DB_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "PROTOCOL_ENQUEUE_AFTER_QUIT",
  "PROTOCOL_ENQUEUE_AFTER_DESTROY", "HANDSHAKE_NOTICES", "AUTH_PLUGIN_CONNECTION_ERROR",
  "ER_SERVER_SHUTDOWN", "ER_CON_COUNT_ERROR", "ACCESS_DENIED_ERROR",
]);

const RETRYABLE_CONFLICT_DB_CODES = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

/**
 * Translates driver-level failures into client-safe statuses so a database
 * outage is never reported as an application bug (finding F-02).
 */
export function mapDatabaseError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const sqlState = typeof error?.sqlState === "string" ? error.sqlState : null;
  if (!code && !sqlState) return null;

  if (code === "ER_DUP_ENTRY" || sqlState === "23000" || sqlState === "23505") {
    return new AppError(409, "ALREADY_EXISTS", "That record already exists", { cause: error });
  }
  if (RETRYABLE_CONFLICT_DB_CODES.has(code)) {
    return new AppError(409, "CONCURRENT_UPDATE", "The record changed while being updated. Retry the request.", { cause: error, retryAfter: 2 });
  }
  if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR" || code === "ER_UNKNOWN_ERROR_MISSING_COLUMN") {
    return new AppError(503, "SCHEMA_UNAVAILABLE", "The database schema is not current. Ask an operator to run migrations.", { cause: error, retryAfter: 30 });
  }
  if (code === "ER_QUERY_INTERRUPTED" || code === "QUERY_TIMEOUT") {
    return new AppError(503, "DATABASE_TIMEOUT", "The database query took too long", { cause: error, retryAfter: 5 });
  }
  if (UNAVAILABLE_DB_CODES.has(code) || sqlState === "08S01" || sqlState === "HY000") {
    return new AppError(503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable", { cause: error, retryAfter: 5 });
  }
  if (code === "ER_DATA_TOO_LONG" || code === "WARN_DATA_TRUNCATED") {
    return new AppError(422, "VALUE_TOO_LONG", "A supplied value is too long for storage", { cause: error });
  }
  return null;
}

export function mapFileSystemError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code === "ENOENT") return new AppError(404, "NOT_FOUND", "The requested resource was not found", { cause: error });
  if (code === "EACCES" || code === "EPERM") {
    return new AppError(503, "STORAGE_UNAVAILABLE", "File storage is not writable on this host", { cause: error, retryAfter: 30 });
  }
  if (code === "EDQUOT" || code === "ENOSPC") {
    return new AppError(507, "STORAGE_FULL", "File storage is full", { cause: error, retryAfter: 300 });
  }
  return null;
}

export function errorBody(code, message, details = null) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
