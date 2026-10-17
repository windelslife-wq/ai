/**
 * The account screen's profile-image control (row 3, Phase 34).
 *
 * `POST`/`DELETE /api/v1/account/avatar` have existed since the identity slice
 * with no screen calling them: legacy's `/account` held a hero image, an upload
 * form and a remove form, and the port kept the routes and dropped the control.
 * This module is the vocabulary that control needs, kept out of the view so it
 * can be asserted directly:
 *
 *  - `AVATAR_ACCEPT` and `AVATAR_HINT` are the legacy form's `accept=` attribute
 *    and its "PNG, JPEG, GIF or WebP · up to 2 MB" line, transcribed;
 *  - `avatarInitials` is `views/auth/account.php`'s own fallback — the display
 *    name stripped to `[A-Za-z0-9 ]`, first character uppercased, `W` when
 *    nothing is left (`Auth::upload_avatar`'s initials branch);
 *  - `avatarView` decides image-versus-initials from `user.avatarUrl`, which is
 *    the only place the account view learns that an avatar exists;
 *  - `avatarFailureMessage` never replaces a refusal with a generic sentence. A
 *    503 `UPLOADS_DISABLED` — the host has image storage switched off — is named
 *    as such, with the operator's own remedy, instead of reading as a failed
 *    upload the member could retry forever.
 *
 * Nothing here invents a limit or a rule of its own: the accepted types are
 * decided by the server's content sniffing, and every refusal the control shows
 * is the server's message.
 */

/** The legacy form's `accept` attribute, verbatim. */
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/** The legacy hint line beside the control. */
export const AVATAR_HINT = "PNG, JPEG, GIF or WebP · up to 2 MB.";

/** Submitted with no file chosen: the server's own `NO_FILE` sentence. */
export const AVATAR_NO_FILE_MESSAGE = "Choose an image to upload";

export const AVATAR_UPLOADED_NOTICE = "Your profile image has been updated.";
export const AVATAR_REMOVED_NOTICE = "Your profile image has been removed.";

/** The uppercase letter legacy showed when an account had no image. */
export const AVATAR_FALLBACK_INITIAL = "W";

/**
 * Legacy: `strtoupper(mb_substr(preg_replace('/[^A-Za-z0-9 ]/', '', $displayName), 0, 1) ?: 'W')`.
 *
 * One deliberate difference: legacy took the first character of the stripped
 * string even when that character was a space, so `" Ada"` rendered a blank
 * circle. Leading spaces are skipped here — the first character that can be
 * read is used, and `W` still covers an empty or fully stripped name.
 */
export function avatarInitials(displayName) {
  const stripped = String(displayName ?? "").replace(/[^A-Za-z0-9 ]/g, "");
  const first = stripped.replace(/^\s+/, "").slice(0, 1);
  return first ? first.toUpperCase() : AVATAR_FALLBACK_INITIAL;
}

/**
 * @returns {{kind: "image", url: string, initials: string}|{kind: "initials", url: null, initials: string}}
 */
export function avatarView(user) {
  const url = String(user?.avatarUrl ?? "").trim();
  const initials = avatarInitials(user?.displayName || user?.username || "");
  return url ? { kind: "image", url, initials } : { kind: "initials", url: null, initials };
}

/**
 * The refusal sentence for a failed avatar call.
 *
 * `retryAfter` is only appended when the server asked for a wait: the 503 that
 * carries `retryAfter: 3600` is a configuration state, not a busy endpoint, so
 * it gets the operator's remedy instead of "try again in about 3600s".
 */
export function avatarFailureMessage(error) {
  const message = error?.message || "The profile image request did not complete.";
  if (error?.code === "UPLOADS_DISABLED") {
    return `${message}. An operator must set UPLOADS_ENABLED=1 on this host before an image can be stored.`;
  }
  if (Number(error?.retryAfter) > 0) return `${message} Try again in about ${error.retryAfter}s.`;
  return message;
}
