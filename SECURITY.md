# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in MC-AI, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@mc-ai.dev** (replace with your actual contact)

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix and disclosure**: Coordinated with reporter, typically within 30 days

## Scope

The following are in scope for security reports:

- Authentication and authorization bypass
- State injection or manipulation
- MCP tool sandbox escapes
- Taint tracking bypass
- SQL injection, XSS, or other injection attacks
- Secrets exposure in logs or state
- Denial of service via crafted workflow graphs

## Architecture Security

MC-AI follows a Zero Trust architecture. See [`docs/SECURITY.md`](docs/SECURITY.md) for the full security model including sandboxing, taint tracking, and MCP firewall details.
