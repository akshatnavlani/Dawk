import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const API_ORIGIN_KEY = "NEXT_PUBLIC_API_ORIGIN";

/**
 * Next.js only auto-loads env files in apps/web. The public API origin lives
 * in the repo-root .env, so copy that one key into `env` for the client bundle.
 * No other root env var is read or forwarded.
 */
function readRepoRootApiOrigin(): string | undefined {
  const envPath = repoRootEnvPath();
  if (!envPath) return undefined;
  let source: string;
  try {
    source = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  for (const line of source.split(/\r?\n/)) {
    const value = apiOriginAssignment(line);
    if (value !== undefined) return value;
  }
  return undefined;
}

function repoRootEnvPath(): string | undefined {
  // next.config.ts lives in apps/web. Next also starts with that directory
  // as cwd, so both paths are the repo-root .env.
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
    path.resolve(process.cwd(), "../../.env"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function apiOriginAssignment(line: string): string | undefined {
  let trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  if (trimmed.startsWith("export ")) {
    trimmed = trimmed.slice("export ".length).trim();
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0 || trimmed.slice(0, eq).trim() !== API_ORIGIN_KEY) {
    return undefined;
  }

  let raw = trimmed.slice(eq + 1).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    raw = raw.slice(1, -1);
  } else {
    const commentAt = raw.search(/\s+#/);
    if (commentAt !== -1) raw = raw.slice(0, commentAt).trim();
  }
  return raw.length > 0 ? raw : undefined;
}

const apiOrigin = readRepoRootApiOrigin();

const nextConfig: NextConfig = {
  agentRules: false,
  // Quick tunnels change hostnames. Dev assets and the reload socket must
  // accept them or the browser console fills with blocked WebSocket errors.
  allowedDevOrigins: ["*.trycloudflare.com"],
  ...(apiOrigin ? { env: { [API_ORIGIN_KEY]: apiOrigin } } : {}),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:3001/:path*",
      },
    ];
  },
};

export default nextConfig;
