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
        console.error(`mail failed status=${response.status}`);
        throw new Error("mail_failed");
      }
    },
  };
}

export function createMailer(env: {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}): Mailer {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    return createResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  }
  return consoleMailer;
}
