# `.github/workflows/`

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` (**CI**) | PRs to `main`, pushes to `main`, manual, and reused by `release.yml` | TypeScript `ci:check` (coverage floors 70/90/75/75), the Python Docker suite (ruff, mypy, 75 % coverage floor), a typecheck of the TypeScript examples, and the journal-codec self-check |
| `pr-security.yml` (**PR Security**) | PRs, pushes to `main`, manual, and reused by `release.yml` | Trivy (HIGH/CRITICAL vulnerable dependencies and misconfiguration) and Gitleaks (secrets in the new commits). Results go to the Security tab |
| `pr-governance.yml` (**PR Governance**) | PRs | `<type>/<desc>` branch names, Conventional Commits PR titles, and CODEOWNERS coverage when workflows, CODEOWNERS, `SECURITY.md` or `.gitleaks.toml` change |
| `release.yml` (**Release**) | Push of a bare semver tag such as `0.1.0` | Checks the tag matches all four version strings, reruns CI and Security, then publishes to npm (with provenance) and PyPI, and creates a GitHub release |

None of these run the live tests against a real OpenBox. Those stay manual (`npm run test:live`).

## Setup before the first release

| What | Where |
|---|---|
| `NPM_TOKEN` secret: an npm automation token allowed to publish `@openbox-ai/openbox-restate-sdk` (the `@openbox-ai` org must grant it) | Settings → Secrets and variables → Actions |
| PyPI trusted publisher: project `openbox-restate-sdk`, this repo, workflow `release.yml`, environment `pypi` | pypi.org → your project (or "pending publisher") → Publishing |
| Environments `release` and `pypi`. Add required reviewers for a manual approval before publishing | Settings → Environments |
| A public repository, because npm provenance needs one. Otherwise, remove `--provenance` | Settings → General |
| Optional: repo variable `ENFORCE_COMMIT_CONVENTION=true` to also check commit subjects | Settings → Secrets and variables → Actions → Variables |
| Optional: branch protection on `main` requiring **TypeScript**, **Python**, **Examples typecheck**, **Governance**, **Trivy** and **Gitleaks** | Settings → Branches |

## Releasing

1. Bump the version in `typescript/package.json`, `typescript/src/version.ts`, `python/pyproject.toml` and `python/openbox_restate/_version.py`, and merge.
2. Tag and push:
   ```bash
   git tag 0.1.0 && git push origin 0.1.0
   ```

To rerun a release for an existing tag: `gh workflow run release.yml --ref 0.1.0`. Don't dispatch it against a branch; the version check will fail.
