# Merchant privacy publication and acceptance

The public pages are versioned source, rendered through the existing docs route:

- `/docs/privacy`: operator, purposes, data categories, rights and actual safeguards.
- `/docs/subprocessors`: Cloud providers, optional connections, and location limits.
- `/docs/retention`: actual expiry behavior and records excluded from it.
- `/docs/data-processing`: clearly marked proposed agreement; not automatically executed.

Marketing links expose the privacy policy and agreement. Docs navigation and
Markdown exports also expose all four pages. Publishing the pages is not proof
of consent, a signed merchant contract, active retention jobs or App Store review.
Do not silently turn a proposal into binding terms or claim it was accepted by
existing merchants.

## Before executing the merchant agreement

1. Record both legal parties, authorized contacts, version/date and written
   acceptance. Complete scope, duration, subject/data categories and instructions.
2. Approve and operationalize the subprocessor-change notice period and objection
   handling. A 30-day advance notice is proposed to the operator; not yet adopted.
3. Confirm actual hosting/logging locations and the relevant contracting entities,
   signed provider DPAs and required transfer safeguards. Provider website links
   are references, not evidence that the operator accepted a DPA or selected a region.
4. Inventory the merchant's optional AI, channel, action and sandbox services.
   Document who contracts with each provider and the data/transfer path; a customer
   key alone does not settle legal responsibility.
5. Agree only supported retention, export and deletion deadlines, including
   retained evidence, queues, files, backups and lawful exceptions. Rehearse a
   synthetic request and keep completion evidence. Webhook receipt is insufficient.
6. Attach the verified deployed safeguards and outstanding gaps. Do not promise
   full storage/backup encryption, immutable logs, SOC 2 or a recovery SLA without
   evidence. New contractual commitments need the operator's acceptance.

## Sources and implementation anchors

- [Shopify protected customer data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [Brazil's LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
- [ANPD international transfer guidance](https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados)
- [ICO processor contract guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/what-needs-to-be-included-in-the-contract/)
- `src/lib/billing.ts`: 90/365-day plan trace windows.
- `src/server/billing/retention.ts`: billed Stripe/Shopify coverage, pinned-evidence
  exclusions, bounded trace and ingestion-queue cleanup; not conversation expiry.
- `app/api/shopify/webhooks/commerce/route.ts` and
  `scripts/shopify-privacy.ts`: privacy intake/operator handling; verify actual
  fulfillment rather than treating receipt as deletion.
- `src/server/security/audit.ts` and [audit runbook](security-audit.md):
  metadata-only event format, supported boundaries and collection limitations.

Keep account-specific evidence, signatures, server/cloud identifiers, customer
records and provider contracts out of the repository. Jurisdiction-specific
legal review should use the completed schedule and actual deployment evidence.
