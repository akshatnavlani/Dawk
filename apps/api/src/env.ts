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
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
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

export function loadEnv(): Env {
  const parsed = envSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: blankToUndefined(process.env.SESSION_SECRET),
    APP_URL: blankToUndefined(process.env.APP_URL),
    GOOGLE_CLIENT_ID: blankToUndefined(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: blankToUndefined(process.env.GOOGLE_CLIENT_SECRET),
  });

  if (!parsed.success) {
    console.error(
      "Missing or invalid DATABASE_URL, SESSION_SECRET, or APP_URL. SESSION_SECRET must be at least 32 characters. APP_URL must be an absolute URL without a trailing slash.",
    );
    process.exit(1);
  }

  return parsed.data;
}
