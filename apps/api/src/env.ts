import { z } from "zod";

const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  APP_URL: z
    .string()
    .url()
    .refine((value) => !value.endsWith("/"), "APP_URL must not end with /"),
  NEXT_PUBLIC_API_ORIGIN: z
    .string()
    .url()
    .refine(
      (value) => !value.endsWith("/"),
      "NEXT_PUBLIC_API_ORIGIN must not end with /",
    )
    .optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(32),
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.number().int().min(1).max(65535).optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadDatabaseEnv(): { DATABASE_URL: string } {
  const parsed = databaseEnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
  });

  if (!parsed.success) {
    console.error(
      "Missing or invalid DATABASE_URL. Copy .env.example to .env at the repo root and set DATABASE_URL.",
    );
    process.exit(1);
  }

  return parsed.data;
}

const gmailHosts = new Set(["smtp.gmail.com", "smtp.googlemail.com"]);

export function parseSmtpEnv(source: {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM?: string;
}):
  | {
      ok: true;
      value?: { host: string; port: number; user: string; password: string };
    }
  | { ok: false; message: string } {
  const host = blankToUndefined(source.SMTP_HOST);
  const portText = blankToUndefined(source.SMTP_PORT);
  const user = blankToUndefined(source.SMTP_USER);
  const password = blankToUndefined(source.SMTP_PASSWORD);
  if (!host && !portText && !user && !password) {
    return { ok: true };
  }
  const port =
    portText !== undefined && /^\d+$/.test(portText)
      ? Number(portText)
      : Number.NaN;
  if (
    !host ||
    !user ||
    password === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return {
      ok: false,
      message:
        "SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD must all be set. SMTP_PORT must be a number from 1 to 65535.",
    };
  }
  const normalizedPassword = gmailHosts.has(host.toLowerCase())
    ? password.replace(/\s+/g, "")
    : password;
  return {
    ok: true,
    value: { host, port, user, password: normalizedPassword },
  };
}

export function loadEnv(): Env {
  const smtp = parseSmtpEnv(process.env);
  if (!smtp.ok) {
    console.error(smtp.message);
    process.exit(1);
  }

  const parsed = envSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: blankToUndefined(process.env.SESSION_SECRET),
    APP_URL: blankToUndefined(process.env.APP_URL),
    NEXT_PUBLIC_API_ORIGIN: blankToUndefined(
      process.env.NEXT_PUBLIC_API_ORIGIN,
    ),
    GOOGLE_CLIENT_ID: blankToUndefined(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: blankToUndefined(process.env.GOOGLE_CLIENT_SECRET),
    CREDENTIALS_ENCRYPTION_KEY: blankToUndefined(
      process.env.CREDENTIALS_ENCRYPTION_KEY,
    ),
    RESEND_API_KEY: blankToUndefined(process.env.RESEND_API_KEY),
    MAIL_FROM: blankToUndefined(process.env.MAIL_FROM),
    SMTP_HOST: smtp.value?.host,
    SMTP_PORT: smtp.value?.port,
    SMTP_USER: smtp.value?.user,
    SMTP_PASSWORD: smtp.value?.password,
  });

  if (!parsed.success) {
    console.error(
      "Missing or invalid DATABASE_URL, SESSION_SECRET, APP_URL, or CREDENTIALS_ENCRYPTION_KEY. Both secrets must be at least 32 characters and must differ. APP_URL must be an absolute URL without a trailing slash.",
    );
    process.exit(1);
  }

  if (parsed.data.CREDENTIALS_ENCRYPTION_KEY === parsed.data.SESSION_SECRET) {
    console.error(
      "CREDENTIALS_ENCRYPTION_KEY must differ from SESSION_SECRET.",
    );
    process.exit(1);
  }

  return parsed.data;
}
