# Security

AfyaPay is pre-launch. Nothing in this repository processes live payments or real customer data.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). We aim to acknowledge reports within 3 working days.

## Rules for contributors

- Never commit secrets. CI scans every push and pull request with gitleaks and fails on a finding.
- If a secret is committed by mistake, treat it as leaked: rotate it first, then remove it from history.
- Never use real customer data in tests, fixtures or demos.
- Never store M-Pesa PINs, card numbers, card security codes or banking passwords anywhere.
