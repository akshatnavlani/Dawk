# Dawk architect protocol (condensed)

Use when a full design cycle is needed (new phase, major ADR change).

## Phases of work

A Discovery → B Requirements → C Feasibility → D HLD → E Detailed design → F Review → G Readiness / impl plan.

## SoT maintenance

Keep `SOURCE_OF_TRUTH.md` sections current. Do not fill unknown sections with fiction; mark **Pending**. Use change log for every material update.

## Impl plans

After design acceptance for a phase, create/update `PHASE_N_IMPLEMENTATION_PLAN.md` with readiness table, milestones, dependency map, SEC-CHECK, spikes, and go/no-go. Still no code until coding ban is lifted for that work.

## Simplicity

Modular monolith / shared multi-tenant app first. Add Redis, queues, K8s, MCP, sandboxes only when a phase requirement demands them.
