# Security operations and customer evidence

Use this guide to operate a deployment and answer security questionnaires. It is
a checklist to adopt, not evidence that the controls are already running. Keep
installation-specific records outside the public repository. The public
[security FAQ](../content/docs/security.mdx) describes product boundaries.

## Evidence before a customer commitment

For each control, record the owner, system/release, date, evidence location,
verification result and next review date. Track **implemented**, **verified in
this deployment**, and **externally assessed** separately. A passing test or
merged PR does not establish production deployment or regulatory approval.

| Claim | Product evidence | Deployment evidence still needed |
| --- | --- | --- |
| Scoped access | `src/server/auth/request.ts`, `src/server/auth/context.ts`, `tests/organization-auth.test.ts` | Current membership, keys/scopes, administrator access and access reviews. Members have broad workspace access. |
| Encrypted provider credentials | `src/server/model-providers/secrets.ts`, `tests/model-providers.test.ts` | Effective key location, private permissions, recovery and rotation procedure. This is not whole-database encryption. |
| HTTPS | Compose requires a public HTTPS origin. | Certificate/renewal test, proxy settings, and all external/internal connections crossing trust boundaries. |
| Encrypted storage and backups | Requires operator configuration. | Coverage of PostgreSQL, Redis, files, logs, swap, exports and snapshots; key separation; provider documentation or verified volume configuration. |
| Recoverability | Restore tests can validate a backup implementation. | Successful scheduled backups, freshness alerts, retention, a restore drill, measured recovery time and acceptable data loss. |
| Privacy fulfillment | `docs/shopify-privacy.md` documents intake and operator steps. | Complete export/erasure across relevant data copies and providers, verification and private completion evidence. |
| Auditability | Application traces and operational logs are available for their respective purposes. | Inventory of recorded access/actions, identity attribution, omissions, retention, access control and tamper protection. Do not claim complete audit coverage. |
| Code isolation | `docs/self-hosting.md` documents sandbox requirements. | Actual provider isolation, limits and failed-provider behavior; no untrusted access to the application host's Docker daemon. |

## Minimum deployment checklist

1. Inventory customer data and processors. Include traces, messages, tool inputs
   and outputs, contacts, knowledge files, queues, evaluations and exported data.
   Collect only what the feature needs. Assign retention and deletion ownership.
2. Protect administrative accounts with MFA and recovery methods; use named
   accounts, least privilege and prompt revocation. Review access at least
   quarterly and whenever responsibilities change. Store recovery material
   separately from the server.
3. Keep database/Redis ports private. Verify HTTPS and certificate renewal.
   Never disable certificate verification to fix a connection error. Protect
   `.env` and other secret files; exclude them from source control, logs and
   ordinary artifacts. Use a dedicated provider-encryption key on new installs.
4. Verify encryption at rest with evidence for every persistent data location.
   Encryption protects stolen storage; it does not stop a compromised running
   administrator or application from reading accessible data. Prefer standard
   volume/provider encryption over adding custom cryptography to every query.
5. Send encrypted backups to separate private storage with separate credentials.
   Keep the recovery key available outside the affected host. Define retention,
   deletion, recovery-time and recovery-point objectives. Alert on missing or
   failed backups and perform an isolated restore before relying on the plan.
   Recovered queues can replay messages/actions; keep restored workers offline
   until work has been reconciled. Do not enable a restore against production
   integrations during a drill.
6. Patch supported application/runtime/OS versions. Run `bun audit` after a
   frozen install, investigate reachability and remediate findings. Keep fixes
   reviewable, run the relevant integration tests, then verify the deployed
   release. Scan the final container and host as well as JavaScript packages.
7. Collect operational/security events without raw secrets or unnecessary
   personal data. Restrict log access and define retention. Test alert delivery
   and identify blind spots before promising data-access audit coverage.
8. Exercise one synthetic tenant-isolation denial, one real sign-in, one queued
   trace persistence, one relevant agent action, one privacy request and one
   restore. Keep results tied to the deployed version. Dependency scans and
   happy-path demos do not replace authorization tests or an independent review.

## Incident and recovery procedure to adopt

Assign an incident owner and a backup contact. Record a private timeline, scope,
affected systems/data, evidence and decisions. Contain exposure, revoke affected
credentials and preserve evidence without copying customer data into public
tickets. Check contractual and legal notification duties for the actual incident;
do not invent a universal deadline. Restore from verified clean material, test
the affected journeys and monitor recovery. Document cause, customer impact,
corrective actions and owners. Run a tabletop exercise and keep its evidence.

## Keeping overhead small

Use the existing release checks, private evidence records and scheduled backup
jobs first. Encryption of storage and background backup work need no extra
network request on each chat turn. Measure CPU, disk latency and backup contention
under representative load rather than promise zero overhead. Rate/resource-limit
maintenance jobs and avoid running a full backup during peak traffic.

## Preparing for SOC 2

Agree with an independent CPA firm on the system boundary, applicable Trust
Services Criteria and report type before buying compliance tooling. Type I
assesses design at a point in time; Type II also assesses operation over an
agreed period. Security practices need evidence over time, not just documents.

Prepare a system/data-flow description, risk register, policies with named
owners, vendor assessments, access/change reviews, incident and recovery drills,
vulnerability remediation records and actual monitoring evidence. A solo
operator should agree suitable compensating reviews with the auditor rather
than claim independent approval that did not occur. Add privacy/availability
commitments only when the business can operate and prove them.

Shopify protected-customer-data approval is a separate review. Answer its
questions using deployed evidence; do not attest to encryption, backups,
access logging or deletion based on this document alone.

References: [AICPA SOC resources](https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services),
[Shopify protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
