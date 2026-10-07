### Unreleased

- fix: compatible with both Haraka < 3.2 and >= 3.2 Address objects (`address()` became a string property)
- fix: an exception in the rcpt hook defers the recipient instead of crashing Haraka
- fix: routes are kept in a Map, so domains like `constructor` no longer resolve through Object.prototype
- fix: IDN route keys are stored as A-labels, the form recipient hosts arrive in
- fix: honor `[probe] timeout`, enforced by the plugin (core's smtp_client ignores plugin timeouts)
- fix: a refused backend connection defers at once instead of waiting for the plugin timeout
- fix: only cache the backend's answer to RCPT; connection errors and sender rejections are not cached
- fix: send `RCPT TO:<address>` with angle brackets (RFC 5321)
- fix: get_mx returns an MX object (IPv6 safe) and no longer logs an error for domains it does not route
- fix: a route without a port defaults to 25 (smtp) or 24 (lmtp)
- fix: route entries without a scheme default to `smtp://`
- doc: README states only SMTP is supported
- fix: set queue.wants to outbound (no space)
- test: replace done callbacks with async/promises
- test: convert test runner to node:test
- dep(eslint): upgrade to v10
- misc cleanups

## 1.0.0 - 2023-11-25

- Initial release
