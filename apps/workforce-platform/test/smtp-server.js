/**
 * A local SMTP server for the mail tests (row 5).
 *
 * The whole point of the injected transport is that a test can speak the real
 * protocol to a real socket without touching the network or an operator's
 * mailbox. This server implements just enough of RFC 5321 to accept or refuse the
 * conversation `createSmtpTransport` has: greeting, EHLO, AUTH PLAIN/LOGIN,
 * MAIL, RCPT, DATA and QUIT. It binds `127.0.0.1` on an ephemeral port, so tests
 * can run in parallel and no firewalled host is involved.
 *
 * It records what it received (`messages`, `attempts`) so a test asserts on the
 * bytes a real server would see — including dot-unstuffing — rather than on the
 * client's own claim of success.
 */

import net from "node:net";

const CRLF = "\r\n";

/**
 * @param {{auth?: "PLAIN"|"LOGIN"|"BOTH"|null, user?: string, pass?: string,
 *   rejectAuth?: boolean, rejectRcpt?: boolean, greeting?: string,
 *   refuseStartTls?: boolean}} options
 *   `auth: null` advertises no AUTH at all. `refuseStartTls` (the default)
 *   advertises no STARTTLS, which is what the transport must refuse to downgrade.
 */
export async function startSmtpServer(options = {}) {
  const {
    auth = "BOTH",
    user = "mailer@example.test",
    pass = "smtp-secret-pass",
    rejectAuth = false,
    rejectRcpt = false,
    greeting = "220 test.invalid ESMTP ready",
  } = options;

  const messages = [];
  const attempts = [];
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = "";
    let current = null;
    let loginStage = null;

    const send = (line) => socket.write(`${line}${CRLF}`);

    const capabilities = () => {
      const lines = ["SIZE 10485760", "8BITMIME"];
      if (auth) lines.push(auth === "PLAIN" ? "AUTH PLAIN" : auth === "LOGIN" ? "AUTH LOGIN" : "AUTH PLAIN LOGIN");
      lines.push("HELP");
      return lines.map((line, index) => `250${index === lines.length - 1 ? " " : "-"}${line}`).join(CRLF) + CRLF;
    };

    send(greeting);

    socket.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf(CRLF);
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf(CRLF);

        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ ...current, data });
            current = null;
            data = "";
            send("250 2.0.0 Ok: queued as TEST");
          } else {
            // RFC 5321 dot-unstuffing: a leading ".." becomes ".".
            data += `${line.startsWith("..") ? line.slice(1) : line}${CRLF}`;
          }
          continue;
        }

        const [verbRaw, ...rest] = line.split(" ");
        const verb = verbRaw.toUpperCase();
        attempts.push(line);
        if (loginStage === "user") {
          current.authUser = Buffer.from(line, "base64").toString("utf8");
          loginStage = "pass";
          send("334 UGFzc3dvcmQ6");
          continue;
        }
        if (loginStage === "pass") {
          current.authPass = Buffer.from(line, "base64").toString("utf8");
          loginStage = null;
          if (rejectAuth || current.authUser !== user || current.authPass !== pass) {
            send("535 5.7.8 Authentication credentials invalid");
          } else {
            send("235 2.7.0 Authentication successful");
          }
          continue;
        }

        switch (verb) {
          case "EHLO":
            socket.write(capabilities());
            break;
          case "HELO":
            send("250 test.invalid");
            break;
          case "AUTH": {
            current = current ?? {};
            const mechanism = (rest[0] || "").toUpperCase();
            if (mechanism === "PLAIN") {
              const token = rest[1] || "";
              const decoded = Buffer.from(token, "base64").toString("utf8").split("\u0000");
              current.authUser = decoded[1] ?? "";
              current.authPass = decoded[2] ?? "";
              if (rejectAuth || current.authUser !== user || current.authPass !== pass) {
                send("535 5.7.8 Authentication credentials invalid");
              } else {
                send("235 2.7.0 Authentication successful");
              }
            } else if (mechanism === "LOGIN") {
              loginStage = "user";
              send("334 VXNlcm5hbWU6");
            } else {
              send("504 5.5.4 Unrecognised authentication mechanism");
            }
            break;
          }
          case "MAIL":
            current = { from: rest.join(" "), rcpt: [] };
            send("250 2.1.0 Ok");
            break;
          case "RCPT":
            if (rejectRcpt) {
              send("550 5.1.1 <" + rest.join(" ") + ">: Recipient address rejected");
            } else {
              current.rcpt.push(rest.join(" "));
              send("250 2.1.5 Ok");
            }
            break;
          case "DATA":
            inData = true;
            send("354 End data with <CR><LF>.<CR><LF>");
            break;
          case "QUIT":
            send("221 2.0.0 Bye");
            socket.end();
            break;
          case "RSET":
            current = null;
            send("250 2.0.0 Ok");
            break;
          default:
            send("500 5.5.1 Command unrecognised");
        }
      }
    });

    socket.on("error", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    port: server.address().port,
    messages,
    attempts,
    get connections() {
      return connections;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
