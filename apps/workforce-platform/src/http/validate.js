/**
 * Declarative request validation for the core HTTP platform (finding F-04).
 *
 * Schemas are plain objects declared next to each route. Validation is strict by
 * default: unknown types are rejected, strings are length-checked, and every
 * issue is reported per field without ever echoing the submitted value back.
 *
 * Supported schema nodes:
 *   { type: "string",  minLength, maxLength, pattern, format: "email" | "uid",
 *                       values, trim, lowercase, nullable, default }
 *   { type: "integer", min, max, nullable, default }
 *   { type: "number",  min, max, nullable, default }
 *   { type: "boolean", nullable, default }
 *   { type: "array",   items, minItems, maxItems, unique }
 *   { type: "object",  properties, required, additionalProperties }
 *
 * `coerce: true` (used for query strings) converts "1"/"true"/"false" and
 * numeric strings before type checks; it is never applied to JSON bodies, where
 * a wrong type is a client bug worth rejecting.
 */

const EMAIL_PATTERN = /^[^\s@,;()"\\]+@[^\s@,.]+(\.[^\s@,.]+)+$/;
const SIX_DIGIT_UID = /^[0-9]{6}$/;
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;

const FORMAT_PATTERNS = Object.freeze({
  email: EMAIL_PATTERN,
  uid: SIX_DIGIT_UID,
  username: USERNAME,
  token: /^[A-Za-z0-9_\-\.]{16,256}$/,
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOfValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function coerce(value, type) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (type === "integer" || type === "number") {
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return value;
    return type === "integer" ? Math.trunc(parsed) : parsed;
  }
  if (type === "boolean") {
    if (["1", "true", "yes"].includes(trimmed.toLowerCase())) return true;
    if (["0", "false", "no"].includes(trimmed.toLowerCase())) return false;
    return value;
  }
  if (type === "array") {
    if (trimmed === "") return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      // Comma-separated lists are convenient for filters and are unambiguous.
      return trimmed.split(",").map((part) => part.trim()).filter(Boolean);
    }
  }
  return value;
}

function validateNode(schema, input, field, issues, options) {
  const coerceInput = options.coerce === true;
  let value = input;

  if (schema.default !== undefined && (value === undefined || value === null || value === "")) {
    value = typeof schema.default === "function" ? schema.default() : schema.default;
  }

  if (value === undefined) {
    if (schema.required) issues.push({ field, code: "REQUIRED", message: "is required" });
    return { present: false, value: undefined };
  }

  if (value === null) {
    if (schema.nullable) return { present: true, value: null };
    issues.push({ field, code: "NULL_NOT_ALLOWED", message: "must not be null" });
    return { present: true, value: null };
  }

  if (coerceInput) value = coerce(value, schema.type);

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        issues.push({ field, code: "TYPE", message: "must be a string" });
        break;
      }
      if (schema.trim !== false) value = value.trim();
      if (schema.lowercase) value = value.toLowerCase();
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({ field, code: "TOO_SHORT", message: `must be at least ${schema.minLength} characters` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ field, code: "TOO_LONG", message: `must be at most ${schema.maxLength} characters` });
      }
      if (schema.pattern) {
        const regex = schema.pattern instanceof RegExp ? schema.pattern : new RegExp(schema.pattern);
        if (!regex.test(value)) {
          issues.push({ field, code: "PATTERN", message: schema.patternMessage || "has an invalid format" });
        }
      }
      if (schema.format) {
        const regex = FORMAT_PATTERNS[schema.format];
        if (!regex) throw new Error(`Unknown validation format: ${schema.format}`);
        if (!regex.test(value)) {
          issues.push({ field, code: "FORMAT", message: `is not a valid ${schema.format}` });
        }
      }
      if (schema.values && !schema.values.includes(value)) {
        issues.push({ field, code: "ENUM", message: `must be one of: ${schema.values.join(", ")}` });
      }
      break;
    }
    case "integer":
    case "number": {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric) || (schema.type === "integer" && !Number.isSafeInteger(numeric))) {
        issues.push({ field, code: "TYPE", message: schema.type === "integer" ? "must be a whole number" : "must be a number" });
        break;
      }
      value = numeric;
      if (schema.min !== undefined && value < schema.min) issues.push({ field, code: "MIN", message: `must be at least ${schema.min}` });
      if (schema.max !== undefined && value > schema.max) issues.push({ field, code: "MAX", message: `must be at most ${schema.max}` });
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        issues.push({ field, code: "TYPE", message: "must be true or false" });
        break;
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push({ field, code: "TYPE", message: "must be an array" });
        break;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({ field, code: "MIN_ITEMS", message: `must contain at least ${schema.minItems} item(s)` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({ field, code: "MAX_ITEMS", message: `must contain at most ${schema.maxItems} item(s)` });
      }
      if (schema.unique) {
        const seen = new Set();
        for (const item of value) {
          const key = typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
          if (seen.has(key)) {
            issues.push({ field, code: "NOT_UNIQUE", message: "must not contain duplicates" });
            break;
          }
          seen.add(key);
        }
      }
      if (schema.items) {
        value = value.map((item, index) => {
          const result = validateNode({ ...schema.items, required: true }, item, `${field}[${index}]`, issues, options);
          return result.value;
        });
      }
      break;
    }
    case "object": {
      if (!isPlainObject(value)) {
        issues.push({ field, code: "TYPE", message: "must be an object" });
        break;
      }
      const properties = schema.properties || {};
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            issues.push({ field: `${field}.${key}`, code: "UNKNOWN_PROPERTY", message: "is not an accepted field" });
          }
        }
      }
      const next = {};
      for (const [key, childSchema] of Object.entries(properties)) {
        const result = validateNode(
          { ...childSchema, required: childSchema.required ?? (schema.required || []).includes(key) },
          value[key],
          `${field}.${key}`,
          issues,
          options,
        );
        if (result.present) next[key] = result.value;
      }
      // Nested objects keep only declared keys so an unexpected field can never
      // reach a repository as an implicit filter.
      value = next;
      break;
    }
    default:
      throw new Error(`Unsupported validation type: ${schema.type}`);
  }

  return { present: true, value };
}

/**
 * @returns {{value: object, query: object, issues: never[]}|{value: never, issues: Array}}
 */
export function validateRequest({ bodySchema, querySchema, paramsSchema }, request) {
  const issues = [];

  const body = bodySchema
    ? validateNode({ type: "object", additionalProperties: bodySchema.additionalProperties ?? false, ...bodySchema }, request.body ?? {}, "body", issues, {}).value
    : request.body;

  const params = {};
  if (paramsSchema) {
    for (const [key, schema] of Object.entries(paramsSchema)) {
      const result = validateNode({ ...schema, required: true }, request.params?.[key], key, issues, { coerce: true });
      if (result.present) params[key] = result.value;
    }
  }

  const query = {};
  if (querySchema) {
    for (const [key, schema] of Object.entries(querySchema)) {
      const result = validateNode(schema, request.query?.[key], key, issues, { coerce: true });
      if (result.present) query[key] = result.value;
    }
  }

  if (issues.length) {
    return { issues, body, query, params };
  }
  return { value: { body, query, params }, issues: [] };
}

/** Builds the client-safe 422 payload: field names + rules, never values. */
export function validationDetails(issues) {
  return issues.slice(0, 12).map((issue) => ({ field: issue.field.replace(/^body\./, ""), code: issue.code, message: issue.message }));
}

export function validationMessage(issues) {
  const first = issues[0];
  if (!first) return "Request validation failed";
  const field = first.field.replace(/^body\./, "");
  if (first.code === "REQUIRED") return `${field} is required`;
  if (first.code === "TOO_SHORT") return `${field} is too short`;
  if (first.code === "TOO_LONG") return `${field} is too long`;
  return `${field} ${first.message}`.trim();
}

export const FIELD_FORMATS = FORMAT_PATTERNS;
