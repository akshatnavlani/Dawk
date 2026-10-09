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
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(32),
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
    CREDENTIALS_ENCRYPTION_KEY: blankToUndefined(
      process.env.CREDENTIALS_ENCRYPTION_KEY,
    ),
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
