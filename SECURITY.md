# Security

POCP makes a scoped security claim: within the threat model in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), and with POCP's CI check required on the Git host, a test edit that weakens the tests doesn't pass CI on its own: it is blocked or goes to a maintainer. What that covers depends on the mode (fast or deep); the table and "What it doesn't do" in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) list both. A way around that claim, inside that scope, is a security bug, and we want to hear about it privately first.

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

Out of scope are the limits [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) already states, for example code that special-cases test inputs, a Git host where the POCP check isn't required, or a branch pushed to your own repository, by someone with write access, that edits its workflow to post its own `pocp` status (a known gap, described in [docs/STATUS.md](docs/STATUS.md#a-limit-of-the-pocp-status); a dedicated GitHub App for the reporter, which closes it, is planned). A way for a pull request from a fork, or one whose CI-file edits weren't approved, to get a green `pocp` status is in scope.

## What happens next

POCP is early and maintained by one person, so responses are best effort. You'll get an acknowledgement, then a fix or a written decision. Once it's fixed, the advisory is published, with credit to you if you want it.
