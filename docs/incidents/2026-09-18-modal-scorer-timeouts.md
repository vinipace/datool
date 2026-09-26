# Troubleshooting Modal scorer timeouts

If a scorer preview returns `Scorer exceeded its execution or memory limit.`,
check the provider's sandbox status and the worker exit code. Test a trivial
scorer to distinguish runtime limits from application code failures.

Datool reserves and caps Modal containers at 256 MiB. The worker has separate
JavaScript heap and Python address-space limits. The sandbox has a 30-second
maximum lifetime and blocked network access. Cleanup calls
`terminate({ wait: true })` within a bounded window; an explicit shell entrypoint
handles TERM/INT for prompt shutdown.

## Verify provider behavior

The opt-in live suite checks success, errors, output limits, timeouts, recovery,
and sandbox termination through an independent Modal client. It creates billable
sandboxes. Supply `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` through the environment:

```sh
DATOOL_TEST_MODAL=1 bun test tests/modal-sandbox-live.test.ts
```

The suite does not install a Modal profile or write credentials to files. Keep
sandbox IDs, execution timelines, screenshots, and installation-specific results
in private operational records outside the repository.
