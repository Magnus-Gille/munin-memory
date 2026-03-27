# Security Policy

## Supported versions

Security fixes are expected on the current `main` branch.

## Reporting a vulnerability

Please do not open a public GitHub issue for vulnerabilities involving:

- authentication or authorization
- token or secret handling
- OAuth flows
- data disclosure
- remote code execution or privilege escalation

Prefer private disclosure to the maintainer first. If GitHub private vulnerability reporting is enabled for the repository, use that. Otherwise, contact the maintainer through a private channel before public disclosure.

Include:

- affected version or commit
- impact summary
- reproduction steps
- any required configuration assumptions

## Scope notes

Munin Memory is primarily designed for self-hosted, single-user deployments. Public internet exposure requires correct reverse-proxy configuration, trusted-header setup for OAuth consent, and standard operational hardening such as HTTPS and restricted host headers.
