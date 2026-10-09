/**
 * Safe request-body parsing with hard limits.
 *
 * Three content types are accepted and nothing else:
 *   application/json            → parsed value (objects only for mutations)
 *   application/x-www-form-urlencoded → flat string map (HTML form fallbacks)
 *   multipart/form-data         → bounded fields + files, for uploads only
 *
 * Bodies are buffered, never streamed to disk, and always capped before
 * allocation so a hostile Content-Length cannot pre-commit memory.
 */

import { AppError } from "./errors.js";

const MAX_MULTIPART_PARTS = 24;
const MAX_FIELD_BYTES = 16 * 1024;

export async function readRawBody(request, limitBytes) {
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw AppError.tooLarge(`The request body must not exceed ${limitBytes} bytes`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw AppError.tooLarge(`The request body must not exceed ${limitBytes} bytes`);
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), size };
}

export function contentTypeOf(request) {
  return String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
}

export function boundaryOf(request) {
  const match = /boundary="?([^";]+)"?/i.exec(String(request.headers["content-type"] || ""));
  return match ? match[1] : null;
}

export function parseJsonBody(buffer, { required = false } = {}) {
  if (buffer.length === 0) {
    if (required) throw AppError.badRequest("A JSON request body is required");
    return undefined;
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw AppError.badRequest("The request body is not valid JSON", { code: "INVALID_JSON" });
  }
}

export function parseFormBody(buffer) {
  const params = new URLSearchParams(buffer.toString("utf8"));
  const values = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) {
      values[key] = Array.isArray(values[key]) ? [...values[key], value] : [values[key], value];
    } else {
      values[key] = value;
    }
  }
  return values;
}

function findDelimiters(buffer, needle, from = 0) {
  const positions = [];
  let index = buffer.indexOf(needle, from);
  while (index !== -1) {
    positions.push(index);
    index = buffer.indexOf(needle, index + needle.length);
  }
  return positions;
}

function parseContentDisposition(value) {
  const name = /name="([^"]*)"/i.exec(value)?.[1] ?? null;
  const filename = /filename="([^"]*)"/i.exec(value)?.[1] ?? null;
  return { name, filename };
}

/**
 * @returns {{fields: Record<string, string>, files: Array<{field: string, filename: string|null, contentType: string, data: Buffer, size: number}>}}
 */
export function parseMultipart(buffer, boundary, { maxFileBytes = 2 * 1024 * 1024 } = {}) {
  if (!boundary) throw AppError.unsupportedMediaType("multipart/form-data requires a boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  const starts = findDelimiters(buffer, delimiter);
  if (starts.length < 2) throw AppError.badRequest("The upload could not be read", { code: "MALFORMED_MULTIPART" });

  for (let index = 0; index < starts.length - 1; index += 1) {
    if (parts.length >= MAX_MULTIPART_PARTS) throw AppError.badRequest("Too many parts in the upload", { code: "TOO_MANY_PARTS" });
    const bodyStart = starts[index] + delimiter.length;
    const bodyEnd = starts[index + 1];
    let sliceStart = bodyStart;
    // A closing delimiter is `--\r\n`; a part separator is just `\r\n`.
    if (buffer.slice(sliceStart, sliceStart + 2).toString() === "--") continue;
    if (buffer.slice(sliceStart, sliceStart + 2).toString() === "\r\n") sliceStart += 2;
    const part = buffer.slice(sliceStart, bodyEnd);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString("utf8");
    let data = part.slice(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - 2);
    parts.push({ headerText, data });
  }

  const fields = {};
  const files = [];
  for (const { headerText, data } of parts) {
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText)?.[1] ?? "";
    const { name, filename } = parseContentDisposition(disposition);
    if (!name) continue;
    const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1]?.trim().toLowerCase() ?? "application/octet-stream";
    if (filename === null) {
      if (data.length > MAX_FIELD_BYTES) {
        throw AppError.unprocessable(`Field ${name} is too long`, { code: "FIELD_TOO_LONG" });
      }
      const value = data.toString("utf8");
      fields[name] = Object.hasOwn(fields, name) ? (Array.isArray(fields[name]) ? [...fields[name], value] : [fields[name], value]) : value;
      continue;
    }
    if (data.length > maxFileBytes) {
      throw AppError.tooLarge(`The uploaded file must not exceed ${maxFileBytes} bytes`);
    }
    files.push({ field: name, filename, contentType, data, size: data.length });
  }
  return { fields, files };
}
