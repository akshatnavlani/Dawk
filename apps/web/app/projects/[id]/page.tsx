import { ProjectPanel } from "./project-panel";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectPanel projectId={id} />;
}
