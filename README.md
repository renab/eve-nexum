# Nexum self-hosted image builds

Public build fork of [GQuantrill/eve-nexum](https://github.com/GQuantrill/eve-nexum).
Application source and its AGPL license/history are preserved on `upstream-sync`.
The default `builds` branch contains only this independent automation.

## Images

| Component | Rolling image | Immutable image |
| --- | --- | --- |
| Server and SDE importer | `ghcr.io/renab/nexum-server:stable` | `ghcr.io/renab/nexum-server:sha-<full-source-commit>` |
| Web | `ghcr.io/renab/nexum-web:stable` | `ghcr.io/renab/nexum-web:sha-<full-source-commit>` |

Images target **linux/amd64**. Configure the existing Argo CD Image Updater to
track the digest of `stable` for each image. Keep server and web on matching
source revisions. The run summary records published digests. There is no
semver ordering assumption and no `latest` tag maintained by this pipeline.

## Updates and validation

The workflow runs hourly at minute 17 UTC, on automation pushes to `builds`, or
through **Actions > Sync, validate and publish Nexum > Run workflow**. GitHub
can delay scheduled jobs. It fast-forwards `upstream-sync` from upstream `main`,
without rewriting history. A rewritten upstream history fails for manual review.
Sync and validation run in one workflow, because pushes made with `GITHUB_TOKEN`
do not trigger another push workflow. Upstream workflow files are never executed.

Before promotion: frozen-lockfile installs, server TypeScript build and unit/DB
integration tests against disposable PostgreSQL 16, web lint and unit tests,
both production Docker builds, then isolated container smoke tests of migration,
startup, health, web HTML, nginx configuration and web-to-API forwarding.
The smoke test uses an empty SDE fixture: full SDE import and real EVE SSO are
deployment checks, not certified by this pipeline. No production secrets are used.

The exact tested images cross an artifact boundary into a separate publishing
job. SHA tags are write-once by workflow policy (GHCR admins can still change
tags). Reruns preserve existing SHA images, allowing recovery after a partial
publish. Both SHA images exist before rolling promotion. GHCR cannot promote
two packages atomically; a mid-promotion failure may briefly leave mixed stable
revisions. Rerun the workflow to finish. The success marker is written only after
both pushes. Scheduled runs skip a successful source/automation pair and retry
failed pairs. Manual runs revalidate even an unchanged source.

## Future local patches

Keep `upstream-sync` pristine. Create a `patches` branch from it, commit application
patches there, and set the repository Actions variable `SOURCE_BRANCH=patches`.
The workflow then builds that branch's exact commit. When upstream moves, merge
`upstream-sync` into `patches` and resolve/test conflicts normally. Publishing
stops until that branch includes current upstream; local patches are never reset.
Remove the variable to return to unmodified upstream. Use manual dispatch after
pushing patches, or wait for the next hourly check.

## Permissions and one-time settings

No PAT or custom secret is required. The source job gets `contents: write`,
validation gets `contents: read`, and publishing gets `contents: write` plus
`packages: write`, using the built-in `GITHUB_TOKEN`. Keep Actions enabled.

Both packages were verified anonymously pullable after the
[first successful run](https://github.com/renab/eve-nexum/actions/runs/36282871805).
**No manual GitHub approval or visibility change is currently required.** If a
package is recreated or its permissions change, check that its visibility is
**Public** for anonymous cluster pulls (new GHCR packages may default private):

- [nexum-server settings](https://github.com/users/renab/packages/container/nexum-server/settings)
- [nexum-web settings](https://github.com/users/renab/packages/container/nexum-web/settings)

Private packages require authenticated pulls. Ensure this repository
retains Actions write access to both packages (OCI source labels link them).
GitHub can disable scheduled workflows in inactive public repositories after
60 days; check Actions if updates stop and re-enable the workflow as needed.

## Deployment boundary

No Kubernetes, Helm or Argo resources are managed here. Follow the upstream
README and environment examples on `upstream-sync` for runtime configuration,
PostgreSQL, SDE import and EVE SSO credentials.

The upstream web nginx template uses Docker DNS `127.0.0.11` and backend name
`server`, with `API_PORT` substituted at startup. Your cluster deployment must
supply an appropriate nginx configuration/DNS resolver and backend address.
This pipeline deliberately preserves upstream application behavior.

References: [GitHub token workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[GHCR permissions and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
