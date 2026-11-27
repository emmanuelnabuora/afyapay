# Pilot readiness: gate G5 evidence (E10)

Gate G5 (security readiness) needs the evidence below before the pilot. Only compliance closes a gate, with evidence recorded against it in the staff admin. This folder holds the engineering evidence. It is not a statement that the gate is closed.

| Item | Status | Evidence |
|---|---|---|
| Security headers on every response | Done | `src/web-app.ts`, tests in `src/web-app.spec.ts` |
| Dependency scanning | Done, in CI on every PR | `npm audit --audit-level=high` and Trivy (vulnerabilities, secrets, misconfiguration) in `.github/workflows/ci.yml`, plus Dependabot (`.github/dependabot.yml`) |
| Container scanning | Not applicable yet | No container image is built; Render builds from source. Trivy scans the file system and lockfiles instead. Add an image scan if we ship an image. |
| Code scanning | Done, in CI | CodeQL with extended security queries (`.github/workflows/codeql.yml`) |
| Automated web security scan | Done, in CI on every PR and weekly | OWASP ZAP baseline of `/`, `/insurer/`, `/admin/` and the API (`.github/workflows/security-scan.yml`, rules in `.zap/rules.tsv`) |
| Load test at 10x pilot volume | Done | [load-test.md](load-test.md) |
| Backup and restore drill | Done in development; repeat in production | [restore-drill.md](restore-drill.md) |
| External penetration test | Waiting on the founder's OK to spend | Quotes, then report and fixes |
| Incident response runbook | To do | |
| Secret rotation runbook | To do | |
| Support playbook (customers and insurers) | To do | |
| Production environment plan | To do; the region needs counsel's advice, and nothing is deployed without the founder's approval | |

The ZAP baseline is a passive scan. It is not a penetration test and does not replace one.

## ZAP baseline findings (first run, 27 Nov 2026)

There were no failures and three low-risk warnings. All three are now fixed:

| Warning | Where | Fix |
|---|---|---|
| Sub Resource Integrity missing (90003) | Google Fonts stylesheet | Inter and Space Grotesk are now self-hosted (`@fontsource-variable`). Pages make no third-party requests, so no customer IP addresses go to Google, and the CSP allows only our own origin. |
| Cross-Origin-Embedder-Policy missing (90004) | All responses | `Cross-Origin-Embedder-Policy: require-corp` is now sent. |
| CSP directive with no fallback (10055) | 301 redirect from `/insurer` and `/admin` | The app now sends this redirect itself, with the full CSP. |
