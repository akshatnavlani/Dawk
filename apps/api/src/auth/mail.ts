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
