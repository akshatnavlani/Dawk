"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  messageFor,
} from "../../auth-shared";

type Pin = {
  decisionId?: string;
  proposal?: string;
};

type Decision = {
  id: string;
  status: string;
  proposal: string;
  supportCount: number;
  proposer: { kind: "user" | "agent"; label: string };
};

export function DecisionsPanel({
  projectId,
  channelId,
  role,
}: {
  projectId: string;
  channelId: string;
  role: "owner" | "member";
}) {
  const [briefPins, setBriefPins] = useState<Pin[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [proposal, setProposal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  async function load() {
    const [briefResponse, decisionResponse] = await Promise.all([
      fetch(`${API_ORIGIN}/projects/${projectId}/brief`, {
        credentials: "include",
      }),
      fetch(`${API_ORIGIN}/projects/${projectId}/decisions`, {
        credentials: "include",
      }),
    ]);
    if (briefResponse.ok) {
      const body = (await briefResponse.json()) as {
        brief?: { pins?: Pin[] };
      };
      setBriefPins(body.brief?.pins ?? []);
    }
    if (decisionResponse.ok) {
      const body = (await decisionResponse.json()) as {
        decisions?: Decision[];
      };
      setDecisions(body.decisions ?? []);
    }
  }

  useEffect(() => {
    const generation = reloadKey;
    let cancelled = false;
    void (async () => {
      const [briefResponse, decisionResponse] = await Promise.all([
        fetch(`${API_ORIGIN}/projects/${projectId}/brief`, {
          credentials: "include",
        }),
        fetch(`${API_ORIGIN}/projects/${projectId}/decisions`, {
          credentials: "include",
        }),
      ]);
      if (cancelled || generation < 0) {
        return;
      }
      if (briefResponse.ok) {
        const body = (await briefResponse.json()) as {
          brief?: { pins?: Pin[] };
        };
        setBriefPins(body.brief?.pins ?? []);
      }
      if (decisionResponse.ok) {
        const body = (await decisionResponse.json()) as {
          decisions?: Decision[];
        };
        setDecisions(body.decisions ?? []);
      }
    })();
    const source = new EventSource(
      `${API_ORIGIN}/channels/${channelId}/events`,
      { withCredentials: true },
    );
    source.addEventListener("decision.updated", () => {
      setReloadKey((current) => current + 1);
    });
    return () => {
      cancelled = true;
      source.close();
    };
  }, [projectId, channelId, reloadKey]);

  async function propose(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/decisions`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal, originChannelId: channelId }),
      },
    );
    setPending(false);
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(messageFor(body.error ?? null));
      return;
    }
    setProposal("");
    setReloadKey((current) => current + 1);
  }

  async function act(id: string, action: "support" | "accept" | "reject") {
    setError(null);
    const response = await fetch(`${API_ORIGIN}/decisions/${id}/${action}`, {
      method: "POST",
      credentials: "include",
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(messageFor(body.error ?? null));
      return;
    }
    await load();
    setReloadKey((current) => current + 1);
  }

  return (
    <section className="mt-8 border-t border-stone-200 pt-8">
      <h2 className="text-lg font-semibold">Decisions</h2>
      <h3 className="mt-4 text-sm font-semibold text-stone-700">Brief</h3>
      {briefPins.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">
          No accepted decisions yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm text-stone-800">
          {briefPins.map((pin) => (
            <li key={pin.decisionId ?? pin.proposal}>{pin.proposal}</li>
          ))}
        </ul>
      )}
      <ul className="mt-4 space-y-3">
        {decisions.map((decision) => (
          <li
            key={decision.id}
            className="rounded-lg border border-stone-200 bg-white px-4 py-3"
          >
            <p className="text-sm text-stone-500">
              {decision.status} · {decision.proposer.label} ·{" "}
              {decision.supportCount} support
            </p>
            <p className="mt-1 whitespace-pre-wrap text-stone-900">
              {decision.proposal}
            </p>
            {decision.status === "pending" && role === "member" ? (
              <button
                className={`${buttonClass} mt-3`}
                type="button"
                onClick={() => void act(decision.id, "support")}
              >
                Support
              </button>
            ) : null}
            {decision.status === "pending" && role === "owner" ? (
              <div className="mt-3 flex gap-2">
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void act(decision.id, "accept")}
                >
                  Accept
                </button>
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void act(decision.id, "reject")}
                >
                  Reject
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <form className="mt-4 space-y-3" onSubmit={propose}>
        <label className="block text-sm font-medium text-stone-700">
          Propose a decision
          <textarea
            className={fieldClass}
            value={proposal}
            onChange={(event) => setProposal(event.target.value)}
            required
          />
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <button className={buttonClass} type="submit" disabled={pending}>
          {pending ? "Saving…" : "Propose"}
        </button>
      </form>
    </section>
  );
}
