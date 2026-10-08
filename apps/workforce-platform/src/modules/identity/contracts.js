/**
 * Identity and account request contracts.
 *
 * Rules are transcribed from the legacy PHP application so a signed-in user sees
 * the same acceptance behaviour on both stacks:
 *   username  /^[a-z][a-z0-9_]{2,19}$/  (Auth::validUsername)
 *   password  >= 12 characters + exact confirmation (Auth::register_submit)
 *   admin     >= 14 characters (Admin::create_user)
 *   email     single-value RFC-ish validation, lower-cased, unique
 *
 * `format: "uid"` matches the legacy six-digit User ID used as a login handle.
 */

export const USERNAME = {
  type: "string",
  minLength: 3,
  maxLength: 20,
  lowercase: true,
  pattern: /^[a-z][a-z0-9_]{2,19}$/,
  patternMessage: "must be 3–20 characters using letters, numbers or underscores, starting with a letter",
};

export const EMAIL = {
  type: "string",
  maxLength: 254,
  lowercase: true,
  format: "email",
};

export const PASSWORD = { type: "string", minLength: 12, maxLength: 1024 };
export const ADMIN_PASSWORD = { type: "string", minLength: 14, maxLength: 1024 };
export const DISPLAY_NAME = { type: "string", minLength: 1, maxLength: 120 };
export const IDENTIFIER = { type: "string", minLength: 1, maxLength: 254 };

/** Login accepts username, email address or the six-digit User ID. */
export const LOGIN = {
  type: "object",
  additionalProperties: false,
  required: ["identifier", "password"],
  properties: {
    identifier: IDENTIFIER,
    password: { type: "string", minLength: 1, maxLength: 1024 },
    remember: { type: "boolean", nullable: true },
    admin: { type: "boolean", nullable: true },
    clientLabel: { type: "string", maxLength: 120, nullable: true },
  },
};

export const REGISTER = {
  type: "object",
  additionalProperties: false,
  required: ["username", "email", "password", "passwordConfirm", "termsAccepted"],
  properties: {
    username: USERNAME,
    email: EMAIL,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
    termsAccepted: { type: "boolean" },
    displayName: { ...DISPLAY_NAME, required: false },
  },
};

export const CHANGE_PASSWORD = {
  type: "object",
  additionalProperties: false,
  required: ["currentPassword", "newPassword", "newPasswordConfirm"],
  properties: {
    currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
    newPassword: PASSWORD,
    newPasswordConfirm: PASSWORD,
    signOutOtherSessions: { type: "boolean", nullable: true },
  },
};

export const UPDATE_USERNAME = {
  type: "object",
  additionalProperties: false,
  required: ["username"],
  properties: { username: USERNAME, displayName: { ...DISPLAY_NAME, nullable: true } },
};

export const UPDATE_EMAIL = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: { email: EMAIL },
};

export const UPDATE_PROFILE = {
  type: "object",
  additionalProperties: false,
  required: ["displayName"],
  properties: { displayName: DISPLAY_NAME },
};

export const PASSWORD_RESET_REQUEST = {
  type: "object",
  additionalProperties: false,
  required: ["identifier"],
  properties: { identifier: IDENTIFIER },
};

export const ADMIN_CREATE_USER = {
  type: "object",
  additionalProperties: false,
  required: ["email", "displayName", "password", "role"],
  properties: {
    email: EMAIL,
    displayName: DISPLAY_NAME,
    password: ADMIN_PASSWORD,
    role: { type: "string", maxLength: 64, values: [...ADMIN_ROLES_LIST()] },
    username: { ...USERNAME, required: false },
  },
};

/** Kept in sync with the seeded legacy roles (tools/rbac.php). */
function ADMIN_ROLES_LIST() {
  return [
    "super_admin",
    "sports_admin",
    "sports_viewer",
    "trading_operator",
    "trading_viewer",
    "lottery_admin",
    "lottery_viewer",
    "platform_member",
  ];
}

export const ADMIN_ROLES = Object.freeze(ADMIN_ROLES_LIST());

export const USER_STATUS_VALUES = Object.freeze(["active", "disabled"]);

export const USER_STATUS_UPDATE = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", values: [...USER_STATUS_VALUES] } },
};

export const USER_ID_PARAM = { userId: { type: "integer", min: 1 } };

export const LIST_USERS_QUERY = {
  limit: { type: "integer", min: 1, max: 200, default: 25 },
  offset: { type: "integer", min: 0, max: 1_000_000, default: 0 },
  search: { type: "string", maxLength: 80, nullable: true },
  status: { type: "string", values: [...USER_STATUS_VALUES], nullable: true },
  sort: { type: "string", values: ["id", "username", "email", "status", "createdAt", "lastLogin"], default: "id" },
  direction: { type: "string", values: ["asc", "desc"], default: "asc" },
};

export const ACTIVITY_QUERY = {
  limit: { type: "integer", min: 1, max: 200, default: 50 },
  offset: { type: "integer", min: 0, max: 1_000_000, default: 0 },
  action: { type: "string", maxLength: 96, nullable: true },
};

export const AVATAR_FILE_PARAM = { fileId: { type: "string", pattern: /^u[1-9]\d*_[a-f0-9]{32}\.(png|jpg|gif|webp)$/ } };
