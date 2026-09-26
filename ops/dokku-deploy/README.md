# Restricted Datool deployment key

The `datool-deploy` SSH account accepts only:

- `disk:load-image datool datool-release:COMMIT-RUN-ATTEMPT IMAGE_BYTES`
- `ps:report datool`
- `ps:report datool --running`
- `disk:status datool`

The image reference must use a 40-character hexadecimal commit and positive
CI pipeline/build numbers. The declared image size must be positive and at most
8 GiB. The disk plugin performs its independent capacity and image checks.

The account has no password, Docker group membership or interactive SSH access.
Its root-owned authorized key uses `restrict` and a forced command. A root-owned
Python entrypoint validates arguments both before and after switching to the
Dokku account using a bounded sudo rule. Commands are executed as argument lists,
without a shell. Arbitrary commands, other apps, SSH forwarding and PTYs are denied.

As root, copy this directory to a trusted installation directory and run:

```sh
bash install.sh /path/to/plain-ed25519-public-key.pub
```

Set `DOKKU_SSH_HOST` to the target hostname or IP in the restricted
`datool-production` CircleCI context. The private key belongs in the same `datool-production` CircleCI context
as `DOKKU_NETCUP_SSH_PRIVATE_KEY`. Pin the target's verified host key in
`DOKKU_NETCUP_SSH_KNOWN_HOSTS`. Do not print or commit the private key.
Restrict the context to `vinipace/datool` on main and disable SSH reruns through
its context expression. See [CI activation](../../docs/ci.md#activation-and-credentials).

Validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'dokku_deploy_test.py'
```

After installation, verify real status access and rejection of arbitrary
commands and other application names before enabling automated deployment.
