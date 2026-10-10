/**
 * Public-site request contracts.
 *
 * Field rules are transcribed from the legacy form handler
 * (`application/controllers/Site.php::contact_submit`) so a visitor meets the
 * same acceptance behaviour on both stacks:
 *   name    non-empty, <= 120 characters (legacy `maxlength="120"`)
 *   email   valid single address, lower-cased, <= 190 characters
 *   message >= 10 and <= 2000 characters (legacy `mb_substr($message, 0, 2000)`)
 */

export const CONTACT_NAME = { type: "string", minLength: 1, maxLength: 120 };
export const CONTACT_EMAIL = { type: "string", maxLength: 190, lowercase: true, format: "email" };
export const CONTACT_MESSAGE = { type: "string", minLength: 10, maxLength: 2_000 };

export const CONTACT_SUBMIT = {
  type: "object",
  additionalProperties: false,
  required: ["name", "email", "message"],
  properties: {
    name: CONTACT_NAME,
    email: CONTACT_EMAIL,
    message: CONTACT_MESSAGE,
  },
};

/** The legacy rejection message, kept verbatim so both stacks read the same. */
export const CONTACT_INVALID_MESSAGE = "Enter your name, a valid email, and a message of at least 10 characters.";

export const INQUIRY_LIST_QUERY = {
  limit: { type: "integer", min: 1, max: 200, default: 25 },
  offset: { type: "integer", min: 0, max: 1_000_000, default: 0 },
  search: { type: "string", maxLength: 80, nullable: true },
  sort: { type: "string", values: ["id", "createdAt", "name", "email"], default: "createdAt" },
  direction: { type: "string", values: ["asc", "desc"], default: "desc" },
};
