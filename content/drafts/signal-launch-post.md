---
persona: Signal
status: draft
target: (undecided — no publishing destination chosen yet)
---

# Draft: launch post

Agent sessions shouldn't die with their host.

We built Handoff Protocol: an MCP server + Postgres state machine that
serializes a running agent's context, moves it to a provisioned sandbox,
and meters what it costs to keep running there — six tools, a real state
machine, a live dashboard.

No claim that the agent "wants" to move. That decision is always a human's,
a script's, or a scheduler's — the tool surface has no consent primitive by
design. Full reasoning: [link to design doc §5].

Repo: [link]. Live dashboard: [link].

---

## Warden's notes

- Opening line is fine — it's an infra pitch, not a narrative claim.
- Good that the "no claim of agency" line is in the post itself rather than
  only in the disclaimers page a reader might not click through to.
- Flag before shipping: "meters what it costs to keep running there" reads
  as if metering is fully automatic. Per DESIGN.md §7, `report_usage` is
  currently self-reported by whoever calls it, not independently verified,
  and there's no real sandbox isolation yet either. Suggest either
  softening to "designed to meter" or adding a one-line showcase caveat
  before this goes anywhere outward-facing.
- No target destination chosen — per docs/TEAM.md, this stays `draft`
  until a human picks a target and reads it, at minimum for the
  wording flagged above.
