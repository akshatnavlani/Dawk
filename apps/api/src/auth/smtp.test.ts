import { describe, expect, test } from "bun:test";
import net from "node:net";
import { createSmtpMailer, type SmtpSettings } from "./smtp";

const password = "smtp-secret-value";

function settings(port: number, allowInsecure = true): SmtpSettings {
  return {
    host: "127.0.0.1",
    port,
    user: "smtp-user",
    password,
    from: "Dawk <invite@example.com>",
    allowInsecure,
  };
}

function listen(
  reply: (line: string, socket: net.Socket) => "data" | "line",
): Promise<{
  port: number;
  lines: string[];
  close: () => Promise<void>;
}> {
  const lines: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write("220-hi\r\n220 ready\r\n");
      let buffer = "";
      let mode: "line" | "data" = "line";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (mode === "data") {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) {
              return;
            }
            lines.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            mode = "line";
            socket.write("250 queued\r\n");
            continue;
          }
          const nl = buffer.indexOf("\r\n");
          if (nl === -1) {
            return;
          }
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          lines.push(line);
          mode = reply(line, socket);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        lines,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function plainServer() {
  return listen((line, socket) => {
    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO")) {
      socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
    } else if (upper.startsWith("AUTH PLAIN")) {
      socket.write("235 ok\r\n");
    } else if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) {
      socket.write("250 ok\r\n");
    } else if (upper === "DATA") {
      socket.write("354 go\r\n");
      return "data";
    } else if (upper === "QUIT") {
      socket.write("221 bye\r\n");
    } else {
      socket.write("500 no\r\n");
    }
    return "line";
  });
}

describe("createSmtpMailer", () => {
  test("sends a dot-stuffed message after AUTH PLAIN", async () => {
    const server = await plainServer();
    try {
      await createSmtpMailer(settings(server.port)).send({
        to: "guest@example.com",
        subject: "Join",
        text: "hello\n.hidden",
      });
    } finally {
      await server.close();
    }

    const auth = server.lines.find((line) => line.startsWith("AUTH PLAIN "));
    const token = auth?.slice("AUTH PLAIN ".length) ?? "";
    expect(Buffer.from(token, "base64").toString("utf8")).toBe(
      `\u0000smtp-user\u0000${password}`,
    );
    expect(server.lines).toContain("MAIL FROM:<invite@example.com>");
    expect(server.lines).toContain("RCPT TO:<guest@example.com>");
    const data = server.lines.find((line) => line.includes("Subject: Join"));
    expect(data).toContain("From: Dawk <invite@example.com>");
    expect(data).toContain("hello\r\n..hidden");
    expect(data?.includes(password)).toBe(false);
  });

  test("a rejected recipient becomes mail_failed and the log omits the password", async () => {
    const logged: string[] = [];
    const originalError = console.error;
    console.error = ((line?: unknown) => {
      logged.push(String(line));
    }) as typeof console.error;
    const server = await listen((line, socket) => {
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        socket.write("250 AUTH PLAIN\r\n");
      } else if (upper.startsWith("AUTH PLAIN")) {
        socket.write("235 ok\r\n");
      } else if (upper.startsWith("MAIL FROM")) {
        socket.write("250 ok\r\n");
      } else if (upper.startsWith("RCPT TO")) {
        socket.write(`550 refused ${password}\r\n`);
      } else {
        socket.write("250 ok\r\n");
      }
      return "line";
    });
    try {
      await expect(
        createSmtpMailer(settings(server.port)).send({
          to: "guest@example.com",
          subject: "Join",
          text: "invite-body-secret",
        }),
      ).rejects.toThrow("mail_failed");
    } finally {
      console.error = originalError;
      await server.close();
    }

    const line = logged.join("\n");
    expect(line.startsWith("smtp failed reason=550 refused")).toBe(true);
    expect(line.includes(password)).toBe(false);
    expect(line.includes("invite-body-secret")).toBe(false);
    expect(line.includes("guest@example.com")).toBe(false);
  });

  test("refuses AUTH before TLS when the server offers STARTTLS", async () => {
    const logged: string[] = [];
    const originalError = console.error;
    console.error = ((line?: unknown) => {
      logged.push(String(line));
    }) as typeof console.error;
    const server = await listen((line, socket) => {
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        socket.write("250-STARTTLS\r\n250 AUTH PLAIN\r\n");
      } else if (upper === "STARTTLS") {
        socket.write("220 ready\r\n");
        socket.end();
      } else {
        socket.write("500 no\r\n");
      }
      return "line";
    });
    try {
      await expect(
        createSmtpMailer(settings(server.port, false)).send({
          to: "guest@example.com",
          subject: "Join",
          text: "body",
        }),
      ).rejects.toThrow("mail_failed");
    } finally {
      console.error = originalError;
      await server.close();
    }
    expect(logged.join("\n").includes(password)).toBe(false);

    expect(server.lines.some((line) => line.startsWith("AUTH"))).toBe(false);
  });
});
