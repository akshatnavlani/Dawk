import { describe, expect, test } from "bun:test";
import { parseSmtpEnv } from "./env";

const complete = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "secret",
  MAIL_FROM: "Dawk <invite@example.com>",
};

describe("parseSmtpEnv", () => {
  test("blank smtp settings stay unset", () => {
    expect(parseSmtpEnv({})).toEqual({ ok: true });
  });

  test("a complete smtp block is accepted", () => {
    expect(parseSmtpEnv(complete)).toEqual({
      ok: true,
      value: {
        host: "smtp.example.com",
        port: 587,
        user: "mailer",
        password: "secret",
      },
    });
  });

  test("a partial smtp block is rejected", () => {
    const parsed = parseSmtpEnv({ SMTP_HOST: "smtp.example.com" });
    expect(parsed.ok).toBe(false);
  });

  test("a gmail app password keeps its letters and drops the displayed spaces", () => {
    expect(
      parseSmtpEnv({
        ...complete,
        SMTP_HOST: "smtp.gmail.com",
        SMTP_PASSWORD: "abcd efgh ijkl mnop",
      }),
    ).toEqual({
      ok: true,
      value: {
        host: "smtp.gmail.com",
        port: 587,
        user: "mailer",
        password: "abcdefghijklmnop",
      },
    });
  });
});
