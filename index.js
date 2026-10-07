'use strict'

const { domainToASCII } = require('node:url')

const cache_key_prefix = 'probe:'

exports.register = function () {
    const plugin = this
    plugin.smtp_client_module = this.haraka_require('smtp_client.js')

    // We need the redis plugin
    plugin.inherits('haraka-plugin-redis')

    // Load main plugin config
    plugin.load_config()

    // We want to use redis for caching
    if (plugin.cfg.cache.enabled) {
        plugin.register_hook('init_master', 'init_redis_plugin')
        plugin.register_hook('init_child', 'init_redis_plugin')
        plugin.loginfo('Redis caching enabled')
    } else {
        plugin.logwarn('Redis caching disabled. While optional, it is recommended to enable it!')
    }

    // Load target domains list
    plugin.load_domains()

    plugin.register_hook('rcpt', 'rcpt')
    plugin.register_hook('get_mx', 'get_mx')
}

exports.load_config = function () {
    // Load main plugin configuration
    const plugin = this

    plugin.cfg = plugin.config.get(
        'recipient-routes-probe.ini',
        {
            booleans: ['+enabled', '+cache.enabled'],
        },
        () => {
            plugin.load_config()
        },
    )

    // Set cache options
    if (!plugin.cfg.cache) {
        plugin.cfg.cache = {}
        plugin.cfg.cache.enabled = true
    }
    plugin.cfg.cache.ttl = parseInt(plugin.cfg.cache.ttl) || 86400
    plugin.logdebug(`cache.ttl: ${plugin.cfg.cache.ttl}`)

    plugin.cfg.cache.negative_ttl = parseInt(plugin.cfg.cache.negative_ttl) || 300
    plugin.logdebug(`cache.negative_ttl: ${plugin.cfg.cache.negative_ttl}`)

    // Set smtp options
    if (!plugin.cfg.probe) plugin.cfg.probe = {}
    plugin.cfg.probe.timeout = parseFloat(plugin.cfg.probe.timeout) || 5
    plugin.logdebug(`probe.timeout: ${plugin.cfg.probe.timeout}`)

    plugin.merge_redis_ini()
}

// Recipient hosts arrive as lower-case A-labels (punycode), so key the
// routes the same way. A Map keeps names like "constructor" from
// resolving through Object.prototype.
const normalize_domain = (domain) => {
    const lowered = String(domain).trim().toLowerCase()
    return domainToASCII(lowered) || lowered
}

exports.load_domains = function () {
    // Load target domains we handle with their MX
    const plugin = this

    const domains = plugin.config.get('recipient-routes-probe-domains.ini', {}, () => {
        plugin.load_domains()
    })

    const routes = new Map()
    for (const [domain, route] of Object.entries(domains.main ?? {})) {
        routes.set(normalize_domain(domain), route)
    }
    plugin.domains_list = routes
    plugin.logdebug(`Target domains count: ${routes.size}`)
}

// Haraka < 3.2 (address-rfc2821) has address() as a method,
// Haraka >= 3.2 (@haraka/email-address) has it as a string property
const address_of = (addr) => (typeof addr.address === 'function' ? addr.address() : addr.address)

exports.get_rcpt_address = function (rcpt) {
    // return current recipient address
    const address = address_of(rcpt).toLowerCase()
    if (!rcpt.host) return [address]
    return [address, rcpt.host.toLowerCase()]
}

exports.parse_mx = function (entry) {
    if (typeof entry !== 'string' || !entry.trim()) return false
    entry = entry.trim()

    // a bare host[:port] entry (no scheme) defaults to SMTP, per README
    if (!/^[a-z]+:\/\//i.test(entry)) entry = `smtp://${entry}`

    // Parse entry for protocol, host and port
    let uri
    try {
        uri = new URL(entry)
    } catch {
        return false
    }
    // URL keeps the brackets around IPv6 literals, and does not lower-case
    // the host of a non-special scheme such as smtp:
    const exchange = uri.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    if (!exchange) return false

    // Target is SMTP
    if (uri.protocol === 'smtp:') {
        return { exchange, port: parseInt(uri.port) || 25 }
    }

    // target is LMTP
    if (uri.protocol === 'lmtp:') {
        return { exchange, port: parseInt(uri.port) || 24, using_lmtp: true }
    }

    // unable to parse target MX
    return false
}

exports.check_domains_list = async function (domain) {
    // Check domains list, so we know if we handle this target domain
    return this.domains_list.has(domain)
}

exports.redis_available = async function () {
    // verify we can use redis
    return this.cfg.cache.enabled && this.db && (await this.redis_ping())
}

exports.check_redis_cache = async function (address) {
    const plugin = this
    // Lookup redis cache for an existing entry for this recipient
    try {
        const result = await plugin.db
            .multi()
            .hGet(`${cache_key_prefix}:${address}`, 'code')
            .hGet(`${cache_key_prefix}:${address}`, 'msg')
            .ttl(`${cache_key_prefix}:${address}`)
            .exec()
        if (result[0] && result[1]) {
            return result
        }
        return false
    } catch (err) {
        plugin.logerror(`Error looking up cache entry: ${err}`)
        return false
    }
}

exports.add_redis_cache_entry = async function (address, result, ttl) {
    if (!(await this.redis_available())) return

    // Add entry to redis cache
    try {
        return await this.db
            .multi()
            .hSet(`${cache_key_prefix}:${address}`, { code: result.code, msg: result.msg })
            .expire(`${cache_key_prefix}:${address}`, ttl)
            .exec()
    } catch (err) {
        this.logerror(`Error adding cache entry: ${err}`)
        return false
    }
}

// Resolves { code, msg, cacheable }. Only the backend's answer to RCPT is a
// verdict on the recipient; anything else (connection trouble, a rejected
// sender) must not be cached against the recipient address.
exports.probe_mx_for_recipient = function (connection, cfg, address) {
    const plugin = this

    return new Promise((resolve) => {
        let smtp_client
        let settled = false

        const done = (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (smtp_client) smtp_client.release()
            resolve(result)
        }
        const transient = (msg) => done({ code: DENYSOFT, msg, cacheable: false })

        // core's smtp_client only takes host and port from a plugin config
        // and stays silent when the connection fails, so bound the probe here
        const timer = setTimeout(() => {
            connection.logerror(plugin, `SMTP probe to ${cfg.host}:${cfg.port} timed out after ${cfg.timeout}s`)
            transient('Backend timeout')
        }, cfg.timeout * 1000)

        try {
            plugin.smtp_client_module.get_client_plugin(plugin, connection, cfg, (err, client) => {
                if (err) {
                    connection.logerror(plugin, `SMTP Probe err: ${err}`)
                    return transient('Probe client error')
                }
                smtp_client = client

                client.socket.once('error', (e) => {
                    connection.logerror(plugin, `SMTP probe to ${cfg.host}:${cfg.port} failed: ${e.message}`)
                    transient('Backend unavailable')
                })

                client.on('mail', () => {
                    client.send_command('RCPT', `TO:<${address}>`)
                })

                client.on('rcpt', () => {
                    done({ code: OK, msg: 'Recipient accepted', cacheable: true })
                })

                client.on('bad_code', (code, msg) => {
                    // Remote SMTP is not happy
                    done({
                        code: code && code[0] === '5' ? DENY : DENYSOFT,
                        msg,
                        cacheable: client.command === 'rcpt',
                    })
                })

                client.removeAllListeners('error')
                client.on('error', (msg) => {
                    connection.logerror(plugin, `SMTP Probe error: ${msg}`)
                    transient('Probe client error')
                })
            })
        } catch (err) {
            connection.logerror(plugin, `SMTP Probe exception: ${err}`)
            transient('Probe client exception')
        }
    })
}

exports.shutdown = function () {
    if (this.db) this.db.quit()
}

exports.rcpt = async function (next, connection, params) {
    // an exception escaping an async hook is an unhandled rejection,
    // which takes the whole Haraka process down
    try {
        await this.check_rcpt(next, connection, params)
    } catch (err) {
        connection.logerror(this, `rcpt check failed: ${err.stack || err}`)
        next(DENYSOFT, 'Backend error: recipient check failed')
    }
}

exports.check_rcpt = async function (next, connection, params) {
    const txn = connection.transaction
    const plugin = this

    // Skip if no transaction available
    if (!txn) return next()

    // Skip if no domain is found in RCPT address
    const [address, domain] = plugin.get_rcpt_address(params[0])
    if (!domain) {
        txn.results.add(plugin, { fail: 'domain.missing' })
        return next()
    }

    plugin.logdebug(`Recipient address: ${address} - domain: ${domain}`, connection)

    if (!(await plugin.check_domains_list(domain))) {
        // We don't know about this domain
        plugin.logdebug(`Domain ${domain} not found in our target domains list`, connection)
        txn.results.add(plugin, { fail: 'domain.unknown' })
        return next(DENY, 'Sorry, this domain not in my routes')
    }

    // Try to parse target MX from domains list
    const route = plugin.domains_list.get(domain)
    const target_mx = plugin.parse_mx(route)

    // MX Parsing failed
    if (!target_mx) {
        plugin.logerror(`Not able to parse target MX (${route}) for domain ${domain}`, connection)
        txn.results.add(plugin, { fail: 'mx.parsing' })
        return next(DENYSOFT, 'Backend error: Target MX parsing failed.')
    }

    // Unsupported LMTP
    if (target_mx.using_lmtp) {
        // We don't know how to handle lmtp (yet)
        plugin.logerror(`LMTP protocol for domain ${domain} not supported yet.`, connection)
        txn.results.add(plugin, { fail: 'lmtp.unsupported' })
        return next(DENYSOFT, 'Backend error: LMTP delivery not supported (yet)')
    }

    // First, check redis cache (if available)
    if (!(await plugin.redis_available())) {
        if (plugin.cfg.cache.enabled) plugin.logwarn('Redis not available. Skipping cache check', connection)
    } else {
        const cached_results = await plugin.check_redis_cache(address)
        if (!cached_results) {
            // Nothing in the redis cache for this address
            plugin.logdebug(`Recipient ${address} not found in redis cache`, connection)
        } else {
            plugin.logdebug(
                `Recipient ${address} found in redis cache (${cached_results[0]}/${cached_results[1]}/${cached_results[2]})`,
                connection,
            )
            if (parseInt(cached_results[0]) === parseInt(OK)) {
                // Allow relaying
                connection.relaying = true
                txn.results.add(plugin, { pass: 'cache.accept' })
                // We want to use outbound
                txn.notes.set('queue.wants', 'outbound')
            } else {
                txn.results.add(plugin, { fail: 'cache.deny' })
            }
            return next(parseInt(cached_results[0]), `${cached_results[1]} (cached)`)
        }
    }

    // Check if recipient is accepted by target MX
    const smtp_options = {
        host: target_mx.exchange,
        port: target_mx.port,
        timeout: plugin.cfg.probe.timeout,
    }

    const smtp_result = await plugin.probe_mx_for_recipient(connection, smtp_options, address)
    if (smtp_result.code !== OK) {
        plugin.logdebug(
            `Recipient address ${address} refused by target MX ${target_mx.exchange}:${target_mx.port} ${smtp_result.code}/${smtp_result.msg}`,
            connection,
        )
        if (smtp_result.cacheable) {
            plugin.add_redis_cache_entry(address, smtp_result, plugin.cfg.cache.negative_ttl)
        }
        txn.results.add(plugin, { fail: 'mx.deny' })
        next(smtp_result.code, smtp_result.msg)
    } else {
        plugin.logdebug(
            `Recipient address ${address} accepted by target MX ${target_mx.exchange}:${target_mx.port} ${smtp_result.code}/${smtp_result.msg}`,
            connection,
        )
        plugin.add_redis_cache_entry(address, smtp_result, plugin.cfg.cache.ttl)
        connection.relaying = true // Allow relaying
        txn.results.add(plugin, { pass: 'mx.accept' })
        txn.notes.set('queue.wants', 'outbound') // We want to use outbound
        next(smtp_result.code, smtp_result.msg)
    }
}

exports.get_mx = function (next, hmail, domain) {
    // Get target MX for domain
    try {
        const route = this.domains_list.get(String(domain).toLowerCase())

        // not ours (e.g. a bounce to a remote sender): let DNS decide
        if (!route) return next()

        const target_mx = this.parse_mx(route)
        if (!target_mx) {
            this.logerror(`[${hmail.todo.uuid}] Not able to parse target MX (${route}) for domain ${domain}`)
            return next()
        }

        this.loginfo(
            `[${hmail.todo.uuid}] Target MX found for domain ${domain} via ${target_mx.exchange}:${target_mx.port}`,
        )
        next(OK, { exchange: target_mx.exchange, port: target_mx.port, priority: 0 })
    } catch (err) {
        this.logerror(err)
        next()
    }
}
