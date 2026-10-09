DROP INDEX IF EXISTS agent_runs_one_active_main;

UPDATE agents
SET skill_id = NULL
WHERE skill_id IN (
  SELECT id
  FROM skills
  WHERE slug IN ('orchestrator', 'frontend', 'backend')
    AND version = 1
);

DELETE FROM skills
WHERE slug IN ('orchestrator', 'frontend', 'backend')
  AND version = 1;
