export const dynamic = "force-dynamic";

const API_HEALTH_URL = "http://127.0.0.1:3001/health";

type Health = {
  ok: boolean;
  service: "dawk-api";
  db: "up" | "down";
};

function isHealth(value: unknown): value is Health {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    record.service === "dawk-api" &&
    (record.db === "up" || record.db === "down")
  );
}

async function loadHealth(): Promise<Health | null> {
  try {
    const response = await fetch(API_HEALTH_URL, { cache: "no-store" });
    const body: unknown = await response.json();
    if (!isHealth(body)) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

function Status({ label, value }: { label: string; value: string }) {
  const tone =
    value === "up" || value === "reachable"
      ? "bg-emerald-100 text-emerald-900"
      : value === "unknown"
        ? "bg-stone-200 text-stone-800"
        : "bg-red-100 text-red-900";

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 bg-white px-4 py-3">
      <dt className="text-sm font-medium text-stone-600">{label}</dt>
      <dd className={`rounded-full px-3 py-1 text-sm font-medium ${tone}`}>
        {value}
      </dd>
    </div>
  );
}

export default async function Home() {
  const health = await loadHealth();
  const apiStatus = health ? "reachable" : "unreachable";
  const dbStatus = health?.db ?? "unknown";

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">M0</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dawk</h1>
      <p className="mt-3 text-stone-600">
        Local foundation. This page reports whether the API and Postgres are up.
      </p>
      <dl className="mt-8 space-y-3">
        <Status label="API" value={apiStatus} />
        <Status label="Database" value={dbStatus} />
      </dl>
      <p className="mt-6 text-sm text-stone-500">
        Direct check:{" "}
        <a
          className="font-medium text-stone-800 underline decoration-stone-300 underline-offset-4"
          href="http://127.0.0.1:3001/health"
        >
          127.0.0.1:3001/health
        </a>
        . Reload this page to check again.{" "}
        <a
          className="font-medium text-stone-800 underline decoration-stone-300 underline-offset-4"
          href="/login"
        >
          Sign in
        </a>
      </p>
    </main>
  );
}
