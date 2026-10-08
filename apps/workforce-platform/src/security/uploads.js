/**
 * Secure avatar upload handling with no external dependencies.
 *
 * Policy (mirrors and tightens the legacy PHP behaviour in `Auth::upload_avatar`):
 *  - accepted types are decided by content sniffing, never by the client's
 *    filename or declared MIME type;
 *  - size is capped before anything is written (2 MB, as in the PHP app);
 *  - files are stored OUTSIDE the static root, so they are only reachable
 *    through the authorized download route (finding F-06);
 *  - generated names are `u<userId>_<32hex>.<ext>`: no user text reaches the
 *    filesystem, and one account cannot enumerate another's file name;
 *  - writes are atomic (temp file + rename) and fsynced, and only a file the
 *    platform itself generated is ever deleted.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TRACKED_DIMENSION = 40_000_000; // px, decompression-bomb guard

const SIGNATURES = Object.freeze([
  { ext: "png", mime: "image/png", test: (buffer) => buffer.length > 12 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buffer.subarray(12, 16).toString("ascii") === "IHDR" },
  { ext: "jpg", mime: "image/jpeg", test: (buffer) => buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { ext: "gif", mime: "image/gif", test: (buffer) => buffer.length > 10 && buffer.subarray(0, 3).toString("ascii") === "GIF" && buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer.subarray(5, 6).toString("ascii") === "a" },
  { ext: "webp", mime: "image/webp", test: (buffer) => buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" },
]);

/** @returns {{ext: string, mime: string, width: number, height: number}|null} */
export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const match = SIGNATURES.find((signature) => signature.test(buffer));
  if (!match) return null;
  const dimensions = readDimensions(buffer, match.ext);
  return { ...match, ...dimensions };
}

function readDimensions(buffer, extension) {
  try {
    if (extension === "png") return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (extension === "gif") return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (extension === "jpg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
      return { width: 0, height: 0 };
    }
    if (extension === "webp") {
      const chunk = buffer.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const bits = buffer.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    // Unparseable dimensions are not a rejection reason; the signature already
    // proved the container. Zero means "unknown" and is never presented as real.
  }
  return { width: 0, height: 0 };
}

/**
 * @returns {{ok: true, file: {ext: string, mime: string, width: number, height: number, bytes: number}}|{ok: false, code: string, message: string}}
 */
export function validateImageUpload(file, { maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  if (!file || !Buffer.isBuffer(file.data) || file.data.length === 0) {
    return { ok: false, code: "NO_FILE", message: "Choose an image to upload" };
  }
  if (file.data.length > maxBytes) {
    return { ok: false, code: "FILE_TOO_LARGE", message: `Profile image must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller` };
  }
  const inspected = inspectImage(file.data);
  if (!inspected) return { ok: false, code: "UNSUPPORTED_TYPE", message: "Only PNG, JPEG, GIF or WebP images are allowed" };
  if (inspected.width > 0 && inspected.height > 0 && inspected.width * inspected.height > MAX_TRACKED_DIMENSION) {
    return { ok: false, code: "IMAGE_TOO_LARGE", message: "The image resolution is too large" };
  }
  return { ok: true, file: { ...inspected, bytes: file.data.length } };
}

export function avatarFileName(userId, extension) {
  return `u${Number(userId) || 0}_${randomBytes(16).toString("hex")}.${extension}`;
}

export async function storeAvatarFile({ uploadsDir, userId, extension, data }) {
  if (!path.isAbsolute(uploadsDir)) throw new TypeError("uploadsDir must be an absolute path");
  await mkdir(uploadsDir, { recursive: true, mode: 0o750 });
  const directoryStat = await stat(uploadsDir);
  if (!directoryStat.isDirectory()) throw new Error("Upload path is not a directory");
  const fileName = avatarFileName(userId, extension);
  const temporary = path.join(uploadsDir, `.tmp-${fileName}`);
  const finalPath = path.join(uploadsDir, fileName);
  await writeFile(temporary, data, { mode: 0o640, flag: "wx" });
  await rename(temporary, finalPath);
  return { fileName, filePath: finalPath };
}

/**
 * Removes a previously generated avatar. Anything not matching the generated
 * pattern is refused, so a stale or hand-edited database value can never turn
 * into an arbitrary unlink.
 */
export async function removeAvatarFile(uploadsDir, fileName) {
  if (typeof fileName !== "string") return false;
  // Ids start at 1 in both adapters, so `u0_` can never name a real owner and is
  // rejected here rather than relying on the ownership check downstream.
  if (!/^u[1-9]\d*_[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(fileName)) return false;
  const candidate = path.resolve(uploadsDir, fileName);
  if (!candidate.startsWith(path.resolve(uploadsDir) + path.sep)) return false;
  await unlink(candidate).catch(() => {});
  return true;
}

/** Validates an id used in a download route before it reaches the filesystem. */
export function parseAvatarFileId(value) {
  return typeof value === "string" && /^u[1-9]\d*_[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(value) ? value : null;
}
