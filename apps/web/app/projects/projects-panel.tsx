"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN, buttonClass, linkClass } from "../auth-shared";

type Project = {
  id: string;
  name: string;
  role: "owner" | "member";
  orchestrator: { channelId: string } | null;
};

export function ProjectsPanel() {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch(`${API_ORIGIN}/projects`, {
        credentials: "include",
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const body = (await response.json()) as { projects?: Project[] };
      setProjects(body.projects ?? []);
    })();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">
        Projects
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Your projects
      </h1>
      <p className="mt-3 text-stone-600">
        Creating a project also creates its Orchestrator channel. Chat comes
        later.
      </p>
      <a className={`${buttonClass} mt-6 w-fit`} href="/projects/new">
        New project
      </a>
      <ul className="mt-8 space-y-3">
        {projects === null ? (
          <li className="text-sm text-stone-500">Loading…</li>
        ) : projects.length === 0 ? (
          <li className="text-sm text-stone-500">No projects yet.</li>
        ) : (
          projects.map((project) => (
            <li key={project.id}>
              <a
                className="flex items-center justify-between rounded-lg border border-stone-200 bg-white px-4 py-3"
                href={`/projects/${project.id}`}
              >
                <span className="font-medium">{project.name}</span>
                <span className="text-sm text-stone-500">{project.role}</span>
              </a>
            </li>
          ))
        )}
      </ul>
      <p className="mt-8 text-sm text-stone-500">
        <a className={linkClass} href="/account">
          Account
        </a>
      </p>
    </main>
  );
}
