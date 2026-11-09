# Jev routing controls

Open an agent's **Guardrails → Jev check** section. The main **Enable Jev check**
switch controls scope routing for the agent. Channel switches let individual
channels opt out while retaining routing elsewhere. Turning the main switch off
disables all Jev routing calls; it preserves the saved channel choices for when
the main switch is enabled again. Website chat covers Chat Bubble and Help Page.

Before the agent generates a reply, Jev uses its instructions, available actions
and skills, conversation history and retrieved knowledge to choose `answer`,
`redirect` or `clarify`. The agent then generates its reply using that guidance.
Redirect and clarify routes cannot run actions, skills or sandbox commands.
There is no additional judge after the reply.

The main configuration field is `guardrails.jevCheckEnabled` (default `true`).
Optional `channelOverrides[channel].jevCheckEnabled` values inherit the main
setting and can disable routing for that channel. Configuration changes follow
the normal draft/apply and revision controls; the runtime reads the applied
configuration. Older configurations retain the enabled default.

Routing uses a project-configured TypeSafe AI key (`jev-latest`), or the project's
AI Gateway key (`typesafe-ai/jev`) when TypeSafe is not configured. Credentials
are read from the project provider store. Missing credentials, provider errors
or invalid evidence retain the original `unavailable` route: the agent continues
with its ordinary instructions and tools, with the failure recorded in its trace.
There is no retry through another provider after a failed request.

Enabled checks write a **Jev router** span and `scopeRouting` decision in the
turn snapshot. Provider tokens are recorded through the existing model-usage
ledger. Disabled checks make no Jev request and create no Jev usage event or
router span. Manual procedures and completed form continuations keep their
explicit routing authority. Other guardrails continue to apply.

Verification:

```sh
DATOOL_TEST_DATABASE_URL=<disposable-loopback-postgres-url> bun --no-env-file test tests/build-jev-routing.test.ts
```
