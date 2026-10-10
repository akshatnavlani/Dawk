import { describe, expect, test } from "bun:test";
import {
  createFallbackMailer,
  createResendMailer,
  type Mail,
  smtpFrom,
} from "./mail";

const apiKey = "re_test_key_do_not_log";

async function sendWith(
  status: number,
  message: string,
): Promise<{ error: unknown; line: string }> {
  const logged: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = ((line?: unknown) => {
    logged.push(String(line));
  }) as typeof console.error;
  globalThis.fetch = (async () =>
    Response.json({ message }, { status })) as typeof fetch;
  try {
    await createResendMailer(apiKey, "Dawk <invite@example.com>").send({
      to: "guest@example.com",
      subject: "Join",
      text: "invite-body-secret",
    });
    return { error: undefined, line: logged.join("\n") };
  } catch (error) {
    return { error, line: logged.join("\n") };
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

describe("createResendMailer", () => {
  test("a non-2xx sender rejection becomes mail_unverified_sender and the log omits the key", async () => {
    const { error, line } = await sendWith(
      403,
      `You can only send testing emails to your own email address (${apiKey}). Verify a domain first.`,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("mail_unverified_sender");
    expect(line.startsWith("mail failed status=403 reason=")).toBe(true);
    expect(line.includes("testing emails")).toBe(true);
    expect(line.includes(apiKey)).toBe(false);
    expect(line.includes("invite-body-secret")).toBe(false);
    expect(line.includes("guest@example.com")).toBe(false);
  });

  test("any other non-2xx stays mail_failed and the log omits the key", async () => {
    const { error, line } = await sendWith(500, `upstream broke ${apiKey}`);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("mail_failed");
    expect(line.startsWith("mail failed status=500 reason=")).toBe(true);
    expect(line.includes(apiKey)).toBe(false);
    expect(line.includes("invite-body-secret")).toBe(false);
  });
});

describe("createFallbackMailer", () => {
  const message: Mail = {
    to: "guest@example.com",
    subject: "Join",
    text: "invite-body-secret",
  };

  test("uses smtp only after the primary send throws", async () => {
    const sent: string[] = [];
    const logged: string[] = [];
    const originalError = console.error;
    console.error = ((line?: unknown) => {
      logged.push(String(line));
    }) as typeof console.error;
    try {
      await createFallbackMailer(
        {
          async send() {
            throw new Error("mail_unverified_sender");
          },
        },
        {
          async send(mail) {
            sent.push(mail.to);
          },
        },
      ).send(message);
    } finally {
      console.error = originalError;
    }

    expect(sent).toEqual(["guest@example.com"]);
    expect(logged).toEqual(["mail resend failed; trying smtp"]);
  });

  test("does not call smtp when resend accepts the message", async () => {
    let fallback = false;
    await createFallbackMailer(
      { async send() {} },
      {
        async send() {
          fallback = true;
        },
      },
    ).send(message);
    expect(fallback).toBe(false);
  });
});

describe("smtpFrom", () => {
  test("uses the smtp account when MAIL_FROM is a different address", () => {
    expect(smtpFrom("Dawk <onboarding@resend.dev>", "mailer@example.com")).toBe(
      "Dawk <mailer@example.com>",
    );
  });
});
