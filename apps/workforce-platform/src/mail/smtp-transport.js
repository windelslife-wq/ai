/**
 * A minimal SMTP submission client (row 5).
 *
 * Legacy sent mail through CodeIgniter's Email library. This is the same
 * conversation, written directly against `node:net`/`node:tls`, for three
 * reasons: the deployment target is shared hosting and the Node tree carries no
 * mail dependency; the behaviour an operator needs (STARTTLS, AUTH PLAIN/LOGIN,
 * a bounded timeout, a transcript that never contains the password) is small;
 * and an injectable transport is what lets the test suite exercise the protocol
 * against a local server instead of pretending a send succeeded.
 *
 * It supports exactly what `application/config/email.php` configured:
 *   - implicit TLS on connect (`crypto: "ssl"`, usually port 465);
 *   - STARTTLS upgrade (`crypto: "tls"`, usually port 587) — and, unlike
 *     CodeIgniter, it refuses to continue if the server does not offer it
 *     (divergence MA-1), because falling back to clear text would silently
 *     downgrade the connection;
 *   - `AUTH PLAIN` or `AUTH LOGIN` when a username and password are configured;
 *   - plain SMTP with no encryption only when the operator asked for that.
 *
 * `send()` never throws. It resolves `{ok: true}` or `{ok: false, error,
 * transcript}`; the caller decides the safe sentence to show a person. The
 * transcript is for the server log only and has every credential redacted at the
 * point it is written.
 */

import net from "node:net";
import tls from "node:tls";
import { buildMessage } from "./mime.js";

const CRLF = "\r\n";
/** A reply cannot legitimately exceed a few hundred bytes; anything larger is abuse. */
const MAX_REPLY_BYTES = 65_536;

export class SmtpError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "SmtpError";
    if (code) this.code = code;
  }
}

/** Parse `250-` / `250 ` reply lines. */
function parseReplyLine(line) {
  const match = /^(\d{3})([ -])(.*)$/.exec(line);
  if (!match) return null;
  // RFC 5321 says a multi-line reply repeats the same code; a server that changes
  // it mid-reply is broken, and treating the last code as authoritative is what
  // every client does.
  return { code: Number(match[1]), more: match[2] === "-", text: match[3] };
}

/**
 * A line/reply reader over a socket. The socket is the only source of truth;
 * `detach()` is how the STARTTLS upgrade hands the raw socket to `tls.connect`
 * without two readers consuming the same bytes.
 */
function createSession(socket, transcript) {
  let buffer = "";
  const queued = [];
  const waiters = [];
  let failure = null;

  socket.setEncoding("utf8");

  const fail = (error) => {
    if (failure) return;
    failure = error instanceof Error ? error : new SmtpError(String(error));
    while (waiters.length) waiters.shift().reject(failure);
  };

  const onData = (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_REPLY_BYTES) {
      fail(new SmtpError("The SMTP server sent an oversized reply"));
      socket.destroy();
      return;
    }
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      transcript.push(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else queued.push(line);
      index = buffer.indexOf("\n");
    }
  };
  const onError = (error) => fail(error);
  const onClose = () => fail(new SmtpError("The SMTP server closed the connection"));

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  function readLine() {
    if (queued.length) return Promise.resolve(queued.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  async function readReply() {
    let line = await readLine();
    let parsed = parseReplyLine(line);
    if (!parsed) throw new SmtpError(`The SMTP server sent an unreadable reply: ${line.slice(0, 120)}`);
    const lines = [line];
    while (parsed.more) {
      line = await readLine();
      parsed = parseReplyLine(line);
      if (!parsed) throw new SmtpError(`The SMTP server sent an unreadable reply: ${line.slice(0, 120)}`);
      lines.push(line);
    }
    return { code: parsed.code, lines };
  }

  function writeRaw(data) {
    return new Promise((resolve, reject) => {
      if (!socket.writable) {
        reject(new SmtpError("The SMTP socket is not writable"));
        return;
      }
      socket.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Send one line and require one of `codes` in reply. */
  async function command(text, codes, { secret = false } = {}) {
    transcript.push(secret ? "[credentials redacted]" : text);
    await writeRaw(`${text}${CRLF}`);
    return expect(codes, text.split(" ")[0]);
  }

  async function expect(codes, label) {
    const reply = await readReply();
    if (!codes.includes(reply.code)) {
      throw new SmtpError(`The SMTP server refused ${label} (${reply.lines.join(" ")})`, { code: reply.code });
    }
    return reply;
  }

  function detach() {
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("close", onClose);
  }

  return { readReply, readLine, command, expect, writeRaw, detach };
}

/** Open the socket: implicit TLS for `ssl`, plain TCP otherwise. */
function connect({ host, port, crypto, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = crypto === "ssl"
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const readyEvent = crypto === "ssl" ? "secureConnect" : "connect";
    const onReady = () => {
      socket.off("error", onError);
      socket.setTimeout(timeoutMs);
      resolve(socket);
    };
    const onError = (error) => {
      socket.off(readyEvent, onReady);
      socket.destroy();
      reject(error);
    };
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
  });
}

/** Upgrade an already-connected socket to TLS (STARTTLS). */
function upgrade(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    const onReady = () => {
      secure.off("error", onError);
      secure.setTimeout(timeoutMs);
      resolve(secure);
    };
    const onError = (error) => {
      secure.off("secureConnect", onReady);
      secure.destroy();
      reject(error);
    };
    secure.once("secureConnect", onReady);
    secure.once("error", onError);
  });
}

/** EHLO, returning the capability tokens (`STARTTLS`, `AUTH PLAIN LOGIN`, …). */
async function ehlo(session) {
  const reply = await session.command("EHLO windels-workforce", [250]);
  const lines = reply.lines.map((line) => line.slice(4));
  const capabilities = new Map();
  for (const line of lines) {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (!name) continue;
    // `AUTH PLAIN LOGIN` and the older `AUTH=PLAIN LOGIN` spelling both exist.
    const key = name.toUpperCase().replace(/=.*$/, "");
    const value = name.includes("=") ? `${name.split("=").slice(1).join(" ")} ${rest.join(" ")}`.trim() : rest.join(" ");
    capabilities.set(key, `${capabilities.get(key) ?? ""} ${value}`.trim());
  }
  return capabilities;
}

/** DATA payload: dot-stuff every line and terminate the message. */
async function writeData(session, payload) {
  const normalised = payload.replace(/\r?\n/g, CRLF);
  const stuffed = normalised
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
  await session.writeRaw(`${stuffed}${stuffed.endsWith(CRLF) ? "" : CRLF}.${CRLF}`);
  return session.expect([250], "DATA");
}

/**
 * @param {{host: string, port: number, crypto: "ssl"|"tls"|"", user?: string,
 *   pass?: string, timeoutMs?: number}} settings
 */
export function createSmtpTransport(settings) {
  const timeoutMs = settings.timeoutMs ?? 10_000;

  return {
    /**
     * @param {{from: string, fromName?: string, to: string, subject: string,
     *   html: string, text?: string, replyTo?: string|null, replyName?: string|null,
     *   now?: number}} message
     * @returns {Promise<{ok: true, transcript: string[]} | {ok: false, error: Error, transcript: string[]}>}
     */
    async send(message) {
      const transcript = [];
      let socket = null;
      try {
        const { payload } = buildMessage(message);
        socket = await connect({ host: settings.host, port: settings.port, crypto: settings.crypto, timeoutMs });
        socket.on("timeout", () => socket.destroy(new SmtpError("The SMTP conversation timed out")));
        let session = createSession(socket, transcript);

        await session.expect([220], "the greeting");
        let capabilities = await ehlo(session);

        if (settings.crypto === "tls") {
          if (!capabilities.has("STARTTLS")) {
            throw new SmtpError("The SMTP server does not offer STARTTLS", { code: "STARTTLS_UNAVAILABLE" });
          }
          await session.command("STARTTLS", [220]);
          const plain = socket;
          session.detach();
          socket = await upgrade(plain, settings.host, timeoutMs);
          socket.on("timeout", () => socket.destroy(new SmtpError("The SMTP conversation timed out")));
          session = createSession(socket, transcript);
          capabilities = await ehlo(session);
        }

        if (settings.user && settings.pass) {
          const auth = capabilities.get("AUTH") ?? "";
          const mechanisms = auth.toUpperCase().split(/\s+/).filter(Boolean);
          if (mechanisms.includes("PLAIN")) {
            const token = Buffer.from(`\u0000${settings.user}\u0000${settings.pass}`, "utf8").toString("base64");
            await session.command(`AUTH PLAIN ${token}`, [235], { secret: true });
          } else if (mechanisms.includes("LOGIN")) {
            await session.command("AUTH LOGIN", [334]);
            await session.command(Buffer.from(settings.user, "utf8").toString("base64"), [334], { secret: true });
            await session.command(Buffer.from(settings.pass, "utf8").toString("base64"), [235], { secret: true });
          } else {
            throw new SmtpError("The SMTP server offers no supported authentication mechanism", { code: "AUTH_UNSUPPORTED" });
          }
        }

        await session.command(`MAIL FROM:<${message.from}>`, [250]);
        await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
        await session.command("DATA", [354]);
        await writeData(session, payload);
        try {
          await session.command("QUIT", [221]);
        } catch {
          // QUIT is a courtesy: the message was already accepted at this point, and
          // a server that drops the connection after 250 has still accepted it.
        }
        session.detach();
        socket.destroy();
        return { ok: true, transcript };
      } catch (error) {
        try {
          socket?.destroy();
        } catch {
          // already gone
        }
        return { ok: false, error, transcript };
      }
    },

    /** For tests: the settings this transport would use (credentials excluded). */
    settings() {
      return { host: settings.host, port: settings.port, crypto: settings.crypto, timeoutMs };
    },
  };
}
