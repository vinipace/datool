# Datool licensing

Datool uses different licenses for different parts of the product:

| Component                                                                                                | License                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Observe: tracing, observability, dashboards, and integrations                                            | [Apache 2.0](LICENSES/Apache-2.0.txt)                  |
| Test: datasets, scorers, evaluations, and experiments                                                    | [Apache 2.0](LICENSES/Apache-2.0.txt)                  |
| TypeScript and Python SDKs, CLI, and shared infrastructure                                               | [Apache 2.0](LICENSES/Apache-2.0.txt)                  |
| Build: agent authoring and execution, knowledge, channels, conversations, and Build-specific simulations | [Elastic License 2.0 (ELv2)](LICENSES/Elastic-2.0.txt) |

The root [LICENSE](LICENSE) defines the exact files and directories covered by
ELv2. All other Datool-authored code defaults to Apache 2.0. Third-party code
keeps its existing licenses and notices. The licenses apply to separate portions
of the repository; Build is not offered under a choice of Apache 2.0 or ELv2.

## Observe, Test, and SDKs

These components remain open source. Apache 2.0 permits commercial use,
modification, redistribution, and hosting, subject to its terms. Using an SDK to
connect to Build does not change the SDK's license or grant an Apache license to
the Build server. Agent tracing and evaluation are distinct from Build's managed
agent runtime and its simulation tools.

Shared UI, authentication, project management, and observability infrastructure
remain Apache 2.0 unless expressly listed in LICENSE. Calling Build through a
shared API, MCP endpoint, or UI does not change the license of the Build code.

## Build and hosted offerings

Build is source-available under the unmodified ELv2 text. It permits use,
modification, and redistribution subject to its terms, including a restriction
on providing the software to third parties as a hosted or managed service that
exposes a substantial set of its features or functionality. This restriction
applies whether the service is paid or free.

ELv2 also protects license-key functionality and licensing/copyright notices.
It does not impose an automatic fee on every commercial use or require a
Datool-issued license key for ordinary self-hosting.

These examples explain the intended distinction; they do not amend ELv2:

| Scenario                                                                                                                       | Treatment                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Self-host Observe/Test or use the SDKs in your own product                                                                     | Permitted under Apache 2.0.                                                                                                          |
| Use Build internally to develop and run your business's agents                                                                 | Permitted under ELv2, subject to its terms.                                                                                          |
| Let visitors chat with a fixed support bot for your own business, without giving them substantial Build platform functionality | This limited end-user interaction is permitted under ELv2.                                                                           |
| Offer customers a hosted agent-building platform, including through a replacement UI or API                                    | Requires a separate commercial agreement when it exposes substantial Build functionality.                                            |
| Install Build on a client's infrastructure for that client's own use                                                           | Installation or consulting alone is not a hosted-service offering; ELv2 still applies.                                               |
| Run a managed bot service for multiple clients                                                                                 | Depends on the functionality clients receive. Obtain a commercial agreement if the offering exposes substantial Build functionality. |

The boundary is the functionality provided to third parties, not whether the
provider calls the product a competitor, charges for it, or shows Datool's UI.
ELv2 is source-available, not an OSI-approved open-source license.

## Commercial licensing

Datool offers a separate commercial licensing option for hosted or managed uses
of Build that ELv2 does not permit. To discuss an agreement, [open a licensing
inquiry with the Datool maintainers](https://github.com/vinipace/datool/issues/new?title=Build%20commercial%20licensing).
Describe the intended offering and request a private follow-up for confidential
details.

The commercial grant, covered versions, scope, fees, and other terms must be
agreed in writing with the applicable rights holder before the restricted use
begins. This page is not itself a commercial license. A Datool Cloud subscription
does not automatically grant permission to resell or host Build for others.

## Existing releases and contributions

This licensing split does not revoke Apache 2.0 rights already granted for
previously distributed code. Copies obtained under that license retain those
rights, subject to its terms. Apply the notices accompanying the version you
received; a later release cannot retroactively restrict an earlier Apache copy.

Contributions must have compatible provenance and preserve third-party notices.
Before accepting third-party contributions to Build, maintainers must obtain
rights sufficient to distribute them under ELv2 and offer the intended commercial
alternative. Do not assume a pull request transfers copyright or grants additional
commercial licensing rights. Newly added or moved Build implementation files must
remain in the scope declared in LICENSE.

## Distributing Datool

Include LICENSE, LICENSING.md, and LICENSES/ when distributing the combined
application, along with applicable third-party notices. Preserve notices and
identify modifications as required by the applicable licenses. The Docker image
includes these documents. The browser asset build copies the license texts to
public/licenses/ and retains an ELv2 notice in the Build widget bundles.

The standalone TypeScript SDK, CLI, and Python SDK retain their own Apache 2.0
package metadata and LICENSE files. Their package licenses do not cover the
combined application.
