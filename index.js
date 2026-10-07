'use strict'

const urlparser = require('url')
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
    plugin.cfg.cache.ttl = this.cfg.cache.ttl || 86400
    plugin.logdebug(`cache.ttl: ${plugin.cfg.cache.ttl}`)

    plugin.cfg.cache.negative_ttl = this.cfg.cache.negative_ttl || 300
    plugin.logdebug(`cache.negative_ttl: ${plugin.cfg.cache.negative_ttl}`)

    // Set smtp options
    if (!plugin.cfg.probe) {
        plugin.cfg.probe = {}
    }
    plugin.cfg.probe = {}
    plugin.cfg.probe.timeout = this.cfg.probe.timeout || 5
    plugin.logdebug(`probe.timeout: ${plugin.cfg.probe.timeout}`)

    plugin.merge_redis_ini()
}

exports.load_domains = function () {
    // Load target domains we handle with their MX
    const plugin = this

    plugin.cfg.domains = plugin.config.get('recipient-routes-probe-domains.ini', {}, () => {
        plugin.load_domains()
    })

    const lowered = {}
    if (plugin.cfg.domains.main) {
        const keys = Object.keys(plugin.cfg.domains.main)
        for (const key of keys) {
            lowered[key.toLowerCase()] = plugin.cfg.domains.main[key]
        }
        plugin.domains_list = lowered
        const domains_count = Object.keys(plugin.domains_list).length
        plugin.logdebug(`Target domains count: ${domains_count}`)
    }
}

exports.get_rcpt_address = function (rcpt) {
    // return current recipient address
    if (!rcpt.host) return [rcpt.address.toLowerCase()]
    return [rcpt.address.toLowerCase(), rcpt.host.toLowerCase()]
}

exports.parse_mx = function (entry) {
    // a bare host[:port] entry (no scheme) defaults to SMTP, per README
    if (typeof entry === 'string' && !/^[a-z]+:\/\//i.test(entry)) {
        entry = `smtp://${entry}`
    }

    // Parse entry for protocol, host and port
    const uri = new urlparser.parse(entry)

    // Target is SMTP
    if (uri.protocol === 'smtp:') {
        return {
            exchange: uri.hostname,
            port: uri.port,
        }
    }

    // target is LMTP
    if (uri.protocol === 'lmtp:') {
        return {
            exchange: uri.hostname,
            port: uri.port,
            using_lmtp: true,
        }
    }

    // unable to parse target MX
    return false
}

exports.check_domains_list = async function (domain) {
    // Check domains list, so we know if we handle this target domain
    return !!this.domains_list[domain]
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
            .hSet(`${cache_key_prefix}:${address}`, result)
            .expire(`${cache_key_prefix}:${address}`, ttl)
            .exec()
    } catch (err) {
        this.logerror(`Error adding cache entry: ${err}`)
        return false
    }
}

exports.probe_mx_for_recipient = async function (connection, cfg, address) {
    const plugin = this

    // Probe target MX
    try {
        // Return SMTP probe result
        return await new Promise((resolve, reject) => {
            plugin.smtp_client_module.get_client_plugin(plugin, connection, cfg, (err, smtp_client) => {
                // Catch any error
                if (err) {
                    connection.logerror(`SMTP Probe err: ${err}`, plugin)
                    reject({ code: DENYSOFT, msg: 'Probe client err' })
                    return
                }

                smtp_client.on('rcpt', (code, msg) => {
                    smtp_client.release()
                    resolve({ code: OK, msg: 'Recipient accepted' })
                })

                smtp_client.on('mail', () => {
                    // Send RCPT
                    smtp_client.send_command('RCPT', `TO:${address}`, plugin)
                })

                smtp_client.on('bad_code', (code, msg) => {
                    // Remote SMTP is not happy
                    smtp_client.release()
                    resolve({ code: code && code[0] === '5' ? DENY : DENYSOFT, msg })
                })

                smtp_client.removeAllListeners('error')
                smtp_client.on('error', (msg) => {
                    connection.logerror(`SMTP Probe error: ${msg}`, plugin)
                    resolve({ code: DENYSOFT, msg: `Probe client error` })
                })
            })
        })
    } catch (error) {
        connection.logerror(`SMTP Probe exception: ${error}`, plugin)
        return { code: DENYSOFT, msg: 'Probe client exception' }
    }
}

exports.shutdown = function () {
    if (this.db) this.db.quit()
}

exports.rcpt = async function (next, connection, params) {
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
    const target_mx = plugin.parse_mx(plugin.domains_list[domain])

    // MX Parsing failed
    if (!target_mx) {
        // We don't know about this domain
        plugin.logerror(`Not able to parse target MX (${plugin.domains_list[domain]} for domain ${domain}`, connection)
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
        plugin.logwarn('Redis not available. Skipping cache check', connection)
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
        connect_timeout: plugin.cfg.probe.timeout,
        idle_timeout: 5,
    }

    const smtp_result = await plugin.probe_mx_for_recipient(connection, smtp_options, address)
    if (smtp_result.code !== OK) {
        plugin.logdebug(
            `Recipient address ${address} refused by target MX ${target_mx.exchange}:${target_mx.port} ${smtp_result.code}/${smtp_result.msg}`,
            connection,
        )
        plugin.add_redis_cache_entry(address, smtp_result, plugin.cfg.cache.negative_ttl)
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
        const target_mx = this.parse_mx(this.domains_list[domain])

        if (target_mx) {
            this.loginfo(
                `[${hmail.todo.uuid}] Target MX found for domain ${domain} via ${target_mx.exchange}:${target_mx.port}`,
            )
            next(OK, `${target_mx.exchange}:${target_mx.port}`)
        } else {
            this.logerror(`[${hmail.todo.uuid}] No target MX found for domain ${domain}`)
            next()
        }
    } catch (err) {
        this.logerror(err)
        next()
    }
}
