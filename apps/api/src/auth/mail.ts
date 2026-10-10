import { createSmtpMailer } from "./smtp";

export type Mail = {
  to: string;
  subject: string;
  text: string;
};

export type Mailer = {
  send(message: Mail): Promise<void>;
};

export const consoleMailer: Mailer = {
  async send(message) {
    console.log(
      `mail to=${message.to} subject=${message.subject}\n${message.text}`,
    );
  },
};

export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(message) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        const detail = await resendErrorMessage(response);
        console.error(
          `mail failed status=${response.status} reason=${shortReason(detail, apiKey)}`,
        );
        throw new Error(
          senderRejected(detail) ? "mail_unverified_sender" : "mail_failed",
        );
      }
    },
  };
}

export function createFallbackMailer(
  primary: Mailer,
  fallback: Mailer,
): Mailer {
  return {
    async send(message) {
      try {
        await primary.send(message);
      } catch {
        console.error("mail resend failed; trying smtp");
        await fallback.send(message);
      }
    },
  };
}

export function createMailer(env: {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
}): Mailer {
  const resend =
    env.RESEND_API_KEY && env.MAIL_FROM
      ? createResendMailer(env.RESEND_API_KEY, env.MAIL_FROM)
      : undefined;
  const smtp =
    env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASSWORD
      ? createSmtpMailer({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          user: env.SMTP_USER,
          password: env.SMTP_PASSWORD,
          from: smtpFrom(env.MAIL_FROM, env.SMTP_USER),
        })
      : undefined;
  if (resend && smtp) {
    return createFallbackMailer(resend, smtp);
  }
  return resend ?? smtp ?? consoleMailer;
}

async function resendErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

function shortReason(message: string, apiKey: string): string {
  let reason = message.replace(/\s+/g, " ").trim();
  if (apiKey) {
    reason = reason.replaceAll(apiKey, "[redacted]");
  }
  reason = reason.slice(0, 160);
  return reason || "unknown";
}

export function smtpFrom(mailFrom: string | undefined, user: string): string {
  const match = mailFrom ? /<([^<>\s]+@[^<>\s]+)>/.exec(mailFrom) : null;
  const address = (match?.[1] ?? mailFrom ?? "").trim().toLowerCase();
  if (mailFrom && address === user.trim().toLowerCase()) {
    return mailFrom;
  }
  const display = mailFrom?.match(/^\s*([^<]+?)\s*</)?.[1]?.trim();
  if (display && !/[\r\n"]/.test(display)) {
    return `${display} <${user}>`;
  }
  return user;
}

function senderRejected(message: string): boolean {
  return /domain|verif|testing[\s-]*(recipient|email)/i.test(message);
}

export function mailErrorCode(
  error: unknown,
): "mail_unverified_sender" | "mail_failed" {
  return error instanceof Error && error.message === "mail_unverified_sender"
    ? "mail_unverified_sender"
    : "mail_failed";
}
