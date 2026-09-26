# Security policy

## Supported versions

Security fixes target the latest release and the current `main` branch. Older
versions are not maintained with separate security backports. Update to a current
release before reporting an issue that has already been fixed.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/vinipace/datool/security/advisories/new).
Do not report undisclosed vulnerabilities in public issues, discussions, or pull
requests. Include the affected version, deployment configuration, impact, and a
minimal reproduction using synthetic data. Never include production API keys,
session cookies, customer traces, or personal information.

We will investigate and coordinate disclosure through the private advisory.
There is no guaranteed response time or paid bounty program.

## Deployment boundaries

Read [self-hosting](docs/self-hosting.md) before exposing an installation. Use
HTTPS, unique stable secrets, explicit signup policy, and a separate execution
provider for untrusted scorers. Mounting the Docker socket grants the application
control of that host. Keep application, database, Redis, and provider credentials
out of logs and source control.

Dependency advisories and the temporary version overrides are documented in
[dependency security](docs/dependency-security.md).
