# Security

POCP makes a scoped security claim: within the threat model in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), and with POCP's CI check required on the Git host, a test edit that weakens the tests doesn't pass CI on its own: it is blocked or goes to a maintainer. What that covers depends on the mode (fast or deep); the README's table and "What it doesn't do" list both. A way around that claim, inside that scope, is a security bug, and we want to hear about it privately first.

## Reporting a bypass

Report it privately on GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue or pull request for a bypass until it's fixed.

Include:

- the POCP version or commit you tested
- what you did, as a script or a short list of steps
- what POCP should have reported, and what it reported instead

## What counts

- A change that weakens the tests, or the rules that require them, and still passes `pocp gate` and `pocp verify`.
- A forged or reused proof that `pocp verify` accepts.
- A way to turn the CI check off that POCP doesn't report.

Out of scope are the limits the README already states, for example code that special-cases test inputs, a Git host where the POCP check isn't required, or a pull request that edits its own CI workflow to fake the check (a known gap, described in the threat model; a fix is planned).

## What happens next

POCP is a prototype maintained by one person, so responses are best effort. You'll get an acknowledgement, then a fix or a written decision. Once it's fixed, the advisory is published, with credit to you if you want it.
