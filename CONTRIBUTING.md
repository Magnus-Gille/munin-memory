# Contributing

Munin Memory is a small TypeScript/Node.js MCP server. Contributions are welcome, but the project optimizes for clarity and maintainability over feature count.

## Before you open a PR

1. Open an issue first for large changes, behavior changes, or protocol changes.
2. Keep PRs scoped. Small, well-explained changes are much easier to review.
3. Update documentation when behavior, defaults, or configuration change.
4. Add or update tests for code changes.

## Development setup

```bash
npm ci
npm run build
npm test
```

Runtime requirements:

- Node.js 20+
- npm

## Project expectations

- Prefer simple solutions over clever ones.
- Preserve backward compatibility when practical, especially for stored data and MCP tool behavior.
- Do not introduce network services or infrastructure dependencies unless there is a strong reason.
- Keep the repository safe to publish: no secrets, no machine-local paths in committed docs unless they are explicitly examples.

## Testing

Run the full suite before submitting a PR:

```bash
npm test
```

If you change OAuth, HTTP transport, or persistence logic, include regression coverage.

## Security

Do not open public issues for vulnerabilities involving auth, secret handling, or data exposure. Follow the guidance in [SECURITY.md](SECURITY.md).
