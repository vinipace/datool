ALTER TABLE organization_billing
  ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconcile_failures integer NOT NULL DEFAULT 0 CHECK (reconcile_failures >= 0);

CREATE INDEX organization_billing_reconcile_due_idx
  ON organization_billing(reconcile_after, organization_id)
  WHERE customer_id IS NOT NULL;
