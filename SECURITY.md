# Security

POCP makes a security claim: a coding agent can't fake green CI by weakening the tests. A way around that claim is a security bug, and we want to hear about it privately first.

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

Out of scope are the limits the README already states, for example code that special-cases test inputs, or a Git host where the POCP check isn't required.

## What happens next

POCP is a prototype maintained by one person, so responses are best effort. You'll get an acknowledgement, then a fix or a written decision. Once it's fixed, the advisory is published, with credit to you if you want it.
