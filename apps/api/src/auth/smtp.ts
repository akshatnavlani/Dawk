import net from "node:net";
import tls from "node:tls";
import type { Mail, Mailer } from "./mail";

const TIMEOUT_MS = 15_000;

export type SmtpSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** Tests only. Live mail always negotiates TLS before AUTH. */
  allowInsecure?: boolean;
};

type Reply = { code: number; lines: string[] };

export function createSmtpMailer(settings: SmtpSettings): Mailer {
  return {
    async send(message) {
      await deliver(settings, message);
    },
  };
}

async function deliver(settings: SmtpSettings, message: Mail): Promise<void> {
  let connection: SmtpConnection | undefined;
  try {
    const from = envelopeAddress(settings.from);
    assertHeader(message.to);
    assertHeader(settings.from);
    assertHeader(message.subject);
    connection = await openConnection(settings);
    await expectReply(connection, settings, 220);
    let reply = await command(connection, settings, "EHLO dawk", 250);
    if (!connection.secure && !settings.allowInsecure) {
      if (!hasCapability(reply, "STARTTLS")) {
        throw smtpError(settings, "tls required");
      }
      await command(connection, settings, "STARTTLS", 220);
      connection = await connection.upgrade(settings.host);
      reply = await command(connection, settings, "EHLO dawk", 250);
    }
    await authenticate(connection, settings, reply);
    await command(connection, settings, `MAIL FROM:<${from}>`, 250);
    await command(connection, settings, `RCPT TO:<${message.to}>`, 250);
    await command(connection, settings, "DATA", 354);
    connection.write(`${messageData(settings.from, message)}\r\n.\r\n`);
    await expectReply(connection, settings, 250);
    connection.send("QUIT");
  } catch (error) {
    if (error instanceof Error && error.message === "mail_failed") {
      throw error;
    }
    console.error(`smtp failed reason=${redact(errorText(error), settings)}`);
    throw new Error("mail_failed");
  } finally {
    connection?.close();
  }
}

async function authenticate(
  connection: SmtpConnection,
  settings: SmtpSettings,
  reply: Reply,
): Promise<void> {
  if (hasCapability(reply, "AUTH PLAIN") || hasCapability(reply, "PLAIN")) {
    const token = Buffer.from(
      `\u0000${settings.user}\u0000${settings.password}`,
    ).toString("base64");
    await command(connection, settings, `AUTH PLAIN ${token}`, 235);
    return;
  }
  if (hasCapability(reply, "AUTH LOGIN") || hasCapability(reply, "LOGIN")) {
    await command(connection, settings, "AUTH LOGIN", 334);
    await command(
      connection,
      settings,
      Buffer.from(settings.user).toString("base64"),
      334,
    );
    await command(
      connection,
      settings,
      Buffer.from(settings.password).toString("base64"),
      235,
    );
    return;
  }
  throw smtpError(settings, "auth unsupported");
}

function messageData(from: string, message: Mail): string {
  return [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeSubject(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    dotStuff(message.text),
  ].join("\r\n");
}

function encodeSubject(subject: string): string {
  if (/^[\t\x20-\x7e]*$/.test(subject)) {
    return subject;
  }
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function dotStuff(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function envelopeAddress(from: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const address = angle?.[1] ?? from.trim();
  if (!/^[^@\s<>]+@[^@\s<>]+$/.test(address)) {
    throw new Error("mail_failed");
  }
  return address;
}

function assertHeader(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error("mail_failed");
  }
}

function hasCapability(reply: Reply, name: string): boolean {
  const wanted = name.toUpperCase();
  return reply.lines.some((line) => {
    const text = line.replace(/^\d{3}[ -]/, "").toUpperCase();
    return (
      text === wanted ||
      text.startsWith(`${wanted} `) ||
      text.includes(` ${wanted}`)
    );
  });
}

async function command(
  connection: SmtpConnection,
  settings: SmtpSettings,
  line: string,
  expected: number,
): Promise<Reply> {
  connection.send(line);
  return expectReply(connection, settings, expected);
}

async function expectReply(
  connection: SmtpConnection,
  settings: SmtpSettings,
  expected: number,
): Promise<Reply> {
  const reply = await readReply(connection);
  if (reply.code !== expected) {
    throw smtpError(settings, reply.lines.join(" "));
  }
  return reply;
}

async function readReply(connection: SmtpConnection): Promise<Reply> {
  const lines: string[] = [];
  for (;;) {
    const line = await connection.readLine();
    lines.push(line);
    const match = /^(\d{3})([ -])/.exec(line);
    if (!match?.[1] || !match[2]) {
      throw new Error("smtp reply");
    }
    if (match[2] === " ") {
      return { code: Number(match[1]), lines };
    }
  }
}

function smtpError(settings: SmtpSettings, detail: string): Error {
  console.error(`smtp failed reason=${redact(detail, settings)}`);
  return new Error("mail_failed");
}

function redact(detail: string, settings: SmtpSettings): string {
  let reason = detail.replace(/\s+/g, " ").trim();
  const hidden = [
    settings.password,
    settings.user,
    Buffer.from(settings.password).toString("base64"),
    Buffer.from(`\u0000${settings.user}\u0000${settings.password}`).toString(
      "base64",
    ),
  ];
  for (const secret of hidden) {
    if (secret) {
      reason = reason.replaceAll(secret, "[redacted]");
    }
  }
  return reason.slice(0, 160) || "unknown";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "connection";
}

function openConnection(settings: SmtpSettings): Promise<SmtpConnection> {
  return new Promise((resolve, reject) => {
    const implicitTls = settings.port === 465;
    const socket = implicitTls
      ? tls.connect({
          host: settings.host,
          port: settings.port,
          servername: settings.host,
        })
      : net.connect({ host: settings.host, port: settings.port });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => fail(new Error("timeout"));
    socket.setTimeout(TIMEOUT_MS);
    socket.once("timeout", onTimeout);
    socket.once("error", fail);
    const ready = implicitTls ? "secureConnect" : "connect";
    socket.once(ready, () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeListener("error", fail);
      socket.removeListener("timeout", onTimeout);
      resolve(new SmtpConnection(socket));
    });
  });
}

class SmtpConnection {
  private buffer = "";
  private pending: string[] = [];
  private waiter: ((result: { line?: string; error?: Error }) => void) | null =
    null;

  constructor(private socket: net.Socket) {
    this.socket.setTimeout(TIMEOUT_MS);
    this.socket.on("data", (chunk: Buffer) => {
      this.push(chunk.toString("utf8"));
    });
    this.socket.on("error", (error: Error) => this.fail(error));
    this.socket.on("timeout", () => {
      this.fail(new Error("timeout"));
      this.socket.destroy();
    });
    this.socket.on("end", () => this.fail(new Error("closed")));
  }

  get secure(): boolean {
    return this.socket instanceof tls.TLSSocket && this.socket.encrypted;
  }

  send(command: string): void {
    this.socket.write(`${command}\r\n`);
  }

  write(text: string): void {
    this.socket.write(text);
  }

  readLine(): Promise<string> {
    const queued = this.pending.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      this.waiter = (result) => {
        if (result.line !== undefined) {
          resolve(result.line);
          return;
        }
        reject(result.error ?? new Error("closed"));
      };
    });
  }

  upgrade(host: string): Promise<SmtpConnection> {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("timeout");
    this.socket.removeAllListeners("end");
    const secure = tls.connect({ socket: this.socket, servername: host });
    return new Promise((resolve, reject) => {
      secure.once("secureConnect", () => resolve(new SmtpConnection(secure)));
      secure.once("error", (error: Error) => {
        secure.destroy();
        reject(error);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private push(text: string): void {
    this.buffer += text;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (this.waiter) {
        const wait = this.waiter;
        this.waiter = null;
        wait({ line });
      } else {
        this.pending.push(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private fail(error: Error): void {
    if (!this.waiter) {
      return;
    }
    const wait = this.waiter;
    this.waiter = null;
    wait({ error });
  }
}
