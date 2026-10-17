/**
 * Request contracts for the administrator mail surface (row 5).
 *
 * Legacy's `Admin::test_email` accepted a `to` and a `variant` from a form. The
 * same two fields are accepted here, with the same rule (`variant` is `plain`
 * only when it is exactly `plain`; anything else is the HTML message) and the
 * same lower-casing of the recipient.
 *
 * The recipient is deliberately *not* declared with `format: "email"`. The shared
 * validator's message ("to is not a valid email") is not the sentence the legacy
 * form showed, and the route refuses an invalid address itself with
 * `Enter a valid recipient email address.` — one rule, one wording.
 */

export const TEST_EMAIL_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: {
    to: { type: "string", minLength: 1, maxLength: 190, lowercase: true, trim: true },
    variant: { type: "string", values: ["html", "plain"], default: "html" },
  },
};

/** The legacy refusal shown when the address is not a single valid email. */
export const INVALID_RECIPIENT_MESSAGE = "Enter a valid recipient email address.";
