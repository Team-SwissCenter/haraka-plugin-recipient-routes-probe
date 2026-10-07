# haraka-plugin-recipient-routes-probe

[![Test][ci-img]][ci-url] [![Cover][cov-img]][cov-url] [![Qlty][qlty-img]][qlty-url]

Validate incoming mails recipients against defined target MX before accepting them.

# Recipient validation with SMTP probing

This plugin lets you define delivery routes based on target domain and will probe the target MX for recipients validity before accepting to relay the mail.

Recipient validation is done by connecting to target MX via SMTP and checking that it accepts the recipient, using EHLO, MAIL FROM and RCPT TO commands.
This is kinda similar as what Postfix's [Recipient address verification](https://www.postfix.org/ADDRESS_VERIFICATION_README.html#recipient) provides.

The validation result is then stored in a redis cache for a configurable amount of time. While this is optional, it is highly recommended as it will lower pressure on the target MXes.

## Requirements

In order to successfully use this plugin, you will need:

- A working Haraka instance (obviously)
- Haraka [Outbound mail](https://haraka.github.io/core/Outbound) enabled and configured
- A list of the domains you want to route mails for and their target MXes

## Installation

```sh
cd /path/to/local/haraka
npm install haraka-plugin-recipient-routes-probe
echo "recipient-routes-probe" >> config/plugins
service haraka restart
```

## Configuration

Copy the sample config file from the distribution into your haraka config dir and then modify them:

```sh
cp node_modules/haraka-plugin-recipient-routes-probe/config/recipient-routes-prob*.ini config/
```

The plugin is configured via two configuration files:

- The main plugin configuration file `config/recipient-routes-probe.ini`

```ini
; Optional redis configuration for this particular plugin
; Defaults to global Haraka redis plugin configuration

[redis]
;host=127.0.0.1
;port=6379
;password=changeme
;database=0

; SMTP probe settings (default: 5 seconds)
[probe]
;timeout=5

; Redis caching settings
[cache]
;enabled=true
;ttl=86400
;negative_ttl=300
```

- The list of target domains and their MXes `config/recipient-routes-probe-domains.ini`

```ini
; Format is domain.tld=protocol://target_mx:target_port
cooldomain.com=smtp://somemx.example.com:25

; If protocol is omitted, it defaults to smtp
greatdomain.com=othermx.example.com:25
somedomain.com=mx.example.com:25
```

Only `smtp://` (and the no-scheme shorthand) are currently supported. LMTP
targets parse but are rejected with `DENYSOFT "LMTP delivery not supported"`
at delivery time; see the upstream `recipient-routes` plugin if you need
LMTP routing.

## Redis caching

Cached redis entries consists of redis keys in the format of `probe:recipient@domain.tld`.
The value of the redis key contains the result code (numeric value of either `OK`, `DENY`, `DENYSOFT` code) associated with the message returned by the target MXes.

Additionally, the keys are given a time to live in seconds, configurable in `[cache]` section of main config file.
Redis will then automatically expire keys that are older than their TTL in order to maintain fresh clean cache.

You can of course list and delete entries from the cache manually, if you need to. Below an example with `redis-cli`

```sh
select 0
127.0.0.1:6379[0]> KEYS probe:*
1) "probe::patrick@cooldomain.com"
2) "probe::badguy@nicedomain.com"
3) "probe::tom@greatdomain.com"
4) "probe::news@fundomain.com"

127.0.0.1:6379[0]> DEL probe::badguy@nicedomain.com
(integer) 1
```

# Author and credits

Written by Sébastien Riccio. Most of the code is outrageously inspired by Matt Simerson's [recipient-routes](https://github.com/haraka/haraka-plugin-recipient-routes) plugin though. Thanks !

<!-- leave these buried at the bottom of the document -->

[ci-img]: https://github.com/Team-SwissCenter/haraka-plugin-recipient-routes-probe/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/Team-SwissCenter/haraka-plugin-recipient-routes-probe/actions/workflows/ci.yml
[cov-img]: https://codecov.io/github/Team-SwissCenter/haraka-plugin-recipient-routes-probe/coverage.svg
[cov-url]: https://codecov.io/github/Team-SwissCenter/haraka-plugin-recipient-routes-probe
[qlty-img]: https://qlty.sh/gh/Team-SwissCenter/projects/haraka-plugin-recipient-routes-probe/maintainability.svg
[qlty-url]: https://qlty.sh/gh/Team-SwissCenter/projects/haraka-plugin-recipient-routes-probe
