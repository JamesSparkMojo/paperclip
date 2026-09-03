# GATES — SPA-6043

Solo atomic card: `recovery/service.ts` engine fix. One gate set for the card.

| Gate | Name | Oracle |
|------|------|--------|
| G1 | Engine: review-stage card goes in_review | Unit test: in_progress + waiting_on_review + review stage + no blockers -> status in_review, assignee unchanged, reviewer wake queued (not manager) |
| G2 | Engine: external-wait card re-wakes owner | Unit test: in_progress + waiting_on_review + no review stage + no blockers -> owner re-wake (scheduled_retry or queued wake) posted, comment naming wait, assignee unchanged |
| G3 | Engine: genuine strand still escalates | Unit test: generic failure / non-deliberate-wait strand path -> escalation to recovery owner still works |
| G4 | Engine: non-escalation after N re-wakes caps | Unit test / reasoning: only after N consecutive deliberate-wait strands (>=3) does escalate take over |
| G5 | typecheck clean | `npx tsc --noEmit` passes for changed files |

Once written, may not be weakened.

