import { resolveDNS, isDomain } from '../helpers/helpers.js';
import { getConfigAddresses, extractWireguardParams, base64ToDecimal, generateRemark, randomUpperCase, getRandomPath } from './helpers';
import { initializeParams, userID, trojanPassword, hostName, defaultHttpsPorts } from "../helpers/init";
import { getDataset } from '../kv/handlers.js';
import { renderErrorPage } from '../pages/errorPage.js';

async function buildXrayDNS (proxySettings, outboundAddrs, domainToStaticIPs, isWorkerLess, isBalancer, isWarp) {
    const { 
        remoteDNS, 
        resolvedRemoteDNS, 
        localDNS, 
        vlessTrojanFakeDNS, 
        enableIPv6, 
        warpFakeDNS,
        warpEnableIPv6,
        blockAds, 
        bypassIran, 
        bypassChina,
        blockPorn, 
        bypassRussia 
    } = proxySettings;

    const isBypass = bypassIran || bypassChina || bypassRussia;
    const isBlock = blockAds || blockPorn;
    const bypassRules = [
        { rule: bypassIran, domain: "geosite:category-ir", ip: "geoip:ir" },
        { rule: bypassChina, domain: "geosite:cn", ip: "geoip:cn" },
        { rule: bypassRussia, domain: "geosite:category-ru", ip: "geoip:ru" }
    ];

    const blockRules = [
        { rule: blockAds, host: "geosite:category-ads-all", address: ["127.0.0.1"] },
        { rule: blockAds, host: "geosite:category-ads-ir", address: ["127.0.0.1"] },
        { rule: blockPorn, host: "geosite:category-porn", address: ["127.0.0.1"] }
    ];

    const isFakeDNS = (vlessTrojanFakeDNS && !isWarp) || (warpFakeDNS && isWarp);
    const isIPv6 = (enableIPv6 && !isWarp) || (warpEnableIPv6 && isWarp);
    const outboundDomains = outboundAddrs.filter(address => isDomain(address));
    const isOutboundRule = outboundDomains.length > 0;
    const outboundRules = outboundDomains.map(domain => `full:${domain}`);
    isBalancer && outboundRules.push("full:www.gstatic.com");
    const finalRemoteDNS = isWorkerLess
        ? ["https://cloudflare-dns.com/dns-query"]
        : isWarp
            ? warpEnableIPv6 
                ? ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"] 
                : ["1.1.1.1", "1.0.0.1"]
            : [remoteDNS];

    const dnsHost = {};
    isBlock && blockRules.forEach( ({ rule, host, address}) => {
        if (rule) dnsHost[host] = address; 
    });
    
    const staticIPs = domainToStaticIPs ? await resolveDNS(domainToStaticIPs) : undefined;
    if (staticIPs) dnsHost[domainToStaticIPs] = enableIPv6 ? [...staticIPs.ipv4, ...staticIPs.ipv6] : staticIPs.ipv4;
    if (resolvedRemoteDNS.server && !isWorkerLess && !isWarp) dnsHost[resolvedRemoteDNS.server] = resolvedRemoteDNS.staticIPs;
    if (isWorkerLess) {
        const domains = ["cloudflare-dns.com", "cloudflare.com", "dash.cloudflare.com"];
        const resolved = await Promise.all(domains.map(resolveDNS));
        const hostIPv4 = resolved.flatMap(r => r.ipv4);
        const hostIPv6 = enableIPv6 ? resolved.flatMap(r => r.ipv6) : [];
        dnsHost["cloudflare-dns.com"] = [
            ...hostIPv4,
            ...hostIPv6
        ];
    }

    const hosts = Object.keys(dnsHost).length ? { hosts: dnsHost } : {};
    let dnsObject = {
        ...hosts,
        servers: finalRemoteDNS,
        queryStrategy: isIPv6 ? "UseIP" : "UseIPv4",
        tag: "dns",
    };
      
    isOutboundRule && dnsObject.servers.push({
        address: localDNS,
        domains: outboundRules,
        skipFallback: true
    });

    let localDNSServer = {
        address: localDNS,
        domains: [],
        expectIPs: [],
        skipFallback: true
    };

    if (!isWorkerLess && isBypass) {
        bypassRules.forEach(({ rule, domain, ip }) => {
            if (rule) {
                localDNSServer.domains.push(domain);
                localDNSServer.expectIPs.push(ip);
            }
        });

        dnsObject.servers.push(localDNSServer);
    }

    if (isFakeDNS) {
        const fakeDNSServer = isBypass && !isWorkerLess 
            ? { address: "fakedns", domains: localDNSServer.domains } 
            : "fakedns";
        dnsObject.servers.unshift(fakeDNSServer);
    }

    return dnsObject;
}

function buildXrayRoutingRules (proxySettings, outboundAddrs, isChain, isBalancer, isWorkerLess) {
    const { 
        localDNS, 
        bypassLAN, 
        bypassIran, 
        bypassChina, 
        bypassRussia, 
        blockAds, 
        blockPorn, 
        blockUDP443 
    } = proxySettings;

    const isBlock = blockAds || blockPorn;
    const isBypass = bypassIran || bypassChina || bypassRussia;
    const geoRules = [
        { rule: bypassLAN, type: 'direct', domain: "geosite:private", ip: "geoip:private" },
        { rule: bypassIran, type: 'direct', domain: "geosite:category-ir", ip: "geoip:ir" },
        { rule: bypassChina, type: 'direct', domain: "geosite:cn", ip: "geoip:cn" },
        { rule: blockAds, type: 'block', domain: "geosite:category-ads-all" },
        { rule: blockAds, type: 'block', domain: "geosite:category-ads-ir" },
        { rule: blockPorn, type: 'block', domain: "geosite:category-porn" }
    ];
    const outboundDomains = outboundAddrs.filter(address => isDomain(address));
    const isOutboundRule = outboundDomains.length > 0;
    let rules = [
        {
            inboundTag: [
                "dns-in"
            ],
            outboundTag: "dns-out",
            type: "field"
        },
        {
            inboundTag: [
                "socks-in",
                "http-in"
            ],
            port: "53",
            outboundTag: "dns-out",
            type: "field"
        }
    ];

    if (!isWorkerLess && (isOutboundRule || isBypass)) rules.push({
        ip: [localDNS],
        port: "53",
        network: "udp",
        outboundTag: "direct",
        type: "field"
    });

    if (isBypass || isBlock) {
        const createRule = (type, outbound) => ({
            [type]: [],
            outboundTag: outbound,
            type: "field"
        });

        let geositeDirectRule, geoipDirectRule;
        if (!isWorkerLess) {
            geositeDirectRule = createRule("domain", "direct");
            geoipDirectRule = createRule("ip", "direct");
        }

        let geositeBlockRule = createRule("domain", "block");
        geoRules.forEach(({ rule, type, domain, ip }) => {
            if (rule) {
                if (type === 'direct') {
                    geositeDirectRule?.domain.push(domain);
                    geoipDirectRule?.ip?.push(ip);
                } else {
                    geositeBlockRule.domain.push(domain);
                }
            }
        });
        
        !isWorkerLess && isBypass && rules.push(geositeDirectRule, geoipDirectRule);
        isBlock && rules.push(geositeBlockRule);
    }

    blockUDP443 && rules.push({
        network: "udp",
        port: "443",
        outboundTag: "block",
        type: "field",
    });

    rules.push({
        ip: [
            "10.10.34.34",
            "10.10.34.35",
            "10.10.34.36"
        ],
        outboundTag: "block",
        type: "field"
    })

    if (isBalancer) {
        rules.push({
            network: "tcp,udp",
            balancerTag: "all",
            type: "field"
        });
    } else  {
        rules.push({
            network: "tcp,udp",
            outboundTag: isChain ? "chain" : isWorkerLess ? "fragment" : "proxy",
            type: "field"
        });
    }

    return rules;
}

function buildXrayVLESSOutbound (tag, address, port, host, sni, proxyIP, isFragment, allowInsecure, enableIPv6) {
    let outbound = {
        protocol: "vless",
        settings: {
            vnext: [
                {
                    address: address,
                    port: +port,
                    users: [
                        {
                            id: userID,
                            encryption: "none",
                            level: 8
                        }
                    ]
                }
            ]
        },
        streamSettings: {
            network: "ws",
            security: "none",
            sockopt: {},
            wsSettings: {
                headers: {
                    Host: host,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
                },
                path: `/${getRandomPath(16)}${proxyIP ? `/${btoa(proxyIP)}` : ''}?ed=2560`
            }
        },
        tag: tag
    };

    if (defaultHttpsPorts.includes(port)) {
        outbound.streamSettings.security = "tls";
        outbound.streamSettings.tlsSettings = {
            allowInsecure: allowInsecure,
            fingerprint: "randomized",
            alpn: ["h2", "http/1.1"],
            serverName: sni
        };
    }

    if (isFragment) {
        outbound.streamSettings.sockopt.dialerProxy = "fragment";
    } else {
        outbound.streamSettings.sockopt.tcpKeepAliveIdle = 60;
        outbound.streamSettings.sockopt.tcpNoDelay = true;
        outbound.streamSettings.sockopt.domainStrategy = enableIPv6 ? "UseIPv4v6" : "UseIPv4";
    }
    
    return outbound;
}

function buildXrayTrojanOutbound (tag, address, port, host, sni, proxyIP, isFragment, allowInsecure, enableIPv6) {
    let outbound = {
        protocol: "trojan",
        settings: {
            servers: [
                {
                    address: address,
                    port: +port,
                    password: trojanPassword,
                    level: 8
                }
            ]
        },
        streamSettings: {
            network: "ws",
            security: "none",
            sockopt: {},
            wsSettings: {
                headers: {
                    Host: host
                },
                path: `/tr${getRandomPath(16)}${proxyIP ? `/${btoa(proxyIP)}` : ''}?ed=2560`
            }
        },
        tag: tag
    };

    if (defaultHttpsPorts.includes(port)) {
        outbound.streamSettings.security = "tls";
        outbound.streamSettings.tlsSettings = {
            allowInsecure: allowInsecure,
            fingerprint: "randomized",
            alpn: ["h2", "http/1.1"],
            serverName: sni
        };
    }

    if (isFragment) {
        outbound.streamSettings.sockopt.dialerProxy = "fragment";
    } else {
        outbound.streamSettings.sockopt.tcpKeepAliveIdle = 60;
        outbound.streamSettings.sockopt.tcpNoDelay = true;
        outbound.streamSettings.sockopt.domainStrategy = enableIPv6 ? "UseIPv4v6" : "UseIPv4";
    }
    
    return outbound;
}

function buildXrayWarpOutbound (proxySettings, warpConfigs, endpoint, isChain, client) {
    const { 
		nikaNGNoiseMode,  
		noiseCountMin, 
		noiseCountMax, 
		noiseSizeMin, 
		noiseSizeMax, 
		noiseDelayMin, 
		noiseDelayMax 
	} = proxySettings;

    const {
        warpIPv6,
        reserved,
        publicKey,
        privateKey
    } = extractWireguardParams(warpConfigs, isChain);

    let outbound = {
        protocol: "wireguard",
        settings: {
            address: [
                "172.16.0.2/32",
                warpIPv6
            ],
            mtu: 1280,
            peers: [
                {
                    endpoint: endpoint,
                    publicKey: publicKey,
                    keepAlive: 5
                }
            ],
            reserved: base64ToDecimal(reserved),
            secretKey: privateKey
        },
        streamSettings: {
            sockopt: {
                dialerProxy: "proxy",
                tcpKeepAliveIdle: 100,
                tcpNoDelay: true,
            }
        },
        tag: isChain ? "chain" : "proxy"
    };

    !isChain && delete outbound.streamSettings;
    client === 'nikang' && !isChain && Object.assign(outbound.settings, {
        wnoise: nikaNGNoiseMode,
        wnoisecount: noiseCountMin === noiseCountMax ? noiseCountMin : `${noiseCountMin}-${noiseCountMax}`,
        wpayloadsize: noiseSizeMin === noiseSizeMax ? noiseSizeMin : `${noiseSizeMin}-${noiseSizeMax}`,
        wnoisedelay: noiseDelayMin === noiseDelayMax ? noiseDelayMin : `${noiseDelayMin}-${noiseDelayMax}`
    });

    return outbound;
}

function buildXrayChainOutbound(chainProxyParams) {
    if (['socks', 'http'].includes(chainProxyParams.protocol)) {
        const { protocol, host, port, user, pass } = chainProxyParams;
        return {
            protocol: protocol,
            settings: {
                servers: [
                    {
                        address: host,
                        port: +port,
                        users: [
                            {
                                user: user,
                                pass: pass,
                                level: 8
                            }
                        ]
                    }
                ]
            },
            streamSettings: {
                network: "tcp",
                sockopt: {
                    dialerProxy: "proxy",
                    tcpNoDelay: true
                }
            },
            mux: {
                enabled: true,
                concurrency: 8,
                xudpConcurrency: 16,
                xudpProxyUDP443: "reject"
            },
            tag: "chain"
        };
    }

    const { 
        hostName, 
        port, 
        uuid, 
        flow, 
        security, 
        type, 
        sni, 
        fp, 
        alpn, 
        pbk, 
        sid, 
        spx, 
        headerType, 
        host, 
        path, 
        authority, 
        serviceName, 
        mode 
    } = chainProxyParams;

    let proxyOutbound = {
        mux: {
            concurrency: 8,
            enabled: true,
            xudpConcurrency: 16,
            xudpProxyUDP443: "reject"
        },
        protocol: "vless",
        settings: {
            vnext: [
                {
                    address: hostName,
                    port: +port,
                    users: [
                        {
                            encryption: "none",
                            flow: flow,
                            id: uuid,
                            level: 8,
                            security: "auto"
                        }
                    ]
                }
            ]
        },
        streamSettings: {
            network: type,
            security: security,
            sockopt: {
                dialerProxy: "proxy",
                tcpNoDelay: true
            }
        },
        tag: "chain"
    };
    
    if (security === 'tls') {
        const tlsAlpns = alpn ? alpn?.split(',') : [];
        proxyOutbound.streamSettings.tlsSettings = {
            allowInsecure: false,
            fingerprint: fp,
            alpn: tlsAlpns,
            serverName: sni
        };
    }

    if (security === 'reality') { 
        delete proxyOutbound.mux;
        proxyOutbound.streamSettings.realitySettings = {
            fingerprint: fp,
            publicKey: pbk,
            serverName: sni,
            shortId: sid,
            spiderX: spx
        };
    }

    if (headerType === 'http') {
        const httpPaths = path?.split(',');
        const httpHosts = host?.split(',');
        proxyOutbound.streamSettings.tcpSettings = {
            header: {
                request: {
                    headers: { Host: httpHosts },
                    method: "GET",
                    path: httpPaths,
                    version: "1.1"
                },
                response: {
                    headers: { "Content-Type": ["application/octet-stream"] },
                    reason: "OK",
                    status: "200",
                    version: "1.1"
                },
                type: "http"
            }
        };
    }

    if (type === 'tcp' && security !== 'reality' && !headerType) proxyOutbound.streamSettings.tcpSettings = {
        header: {
            type: "none"
        }
    };
    
    if (type === 'ws') proxyOutbound.streamSettings.wsSettings = {
        headers: { Host: host },
        path: path
    };
    
    if (type === 'grpc') {
        delete proxyOutbound.mux;
        proxyOutbound.streamSettings.grpcSettings = {
            authority: authority,
            multiMode: mode === 'multi',
            serviceName: serviceName
        };
    }
    
    return proxyOutbound;
}

function buildXrayConfig (proxySettings, remark, isFragment, isBalancer, isChain, balancerFallback, isWarp) {
    const { 
        vlessTrojanFakeDNS, 
        enableIPv6, 
        warpFakeDNS,
        warpEnableIPv6,
        bestVLESSTrojanInterval, 
        bestWarpInterval, 
        lengthMin, 
        lengthMax, 
        intervalMin, 
        intervalMax, 
        fragmentPackets 
    } = proxySettings;

    const isFakeDNS = (vlessTrojanFakeDNS && !isWarp) || (warpFakeDNS && isWarp);
    const isIPv6 = (enableIPv6 && !isWarp) || (warpEnableIPv6 && isWarp);
    let config = structuredClone(xrayConfigTemp);
    config.remarks = remark;
    if (isFakeDNS) {
        config.inbounds[0].sniffing.destOverride.push("fakedns");
        config.inbounds[1].sniffing.destOverride.push("fakedns");
        !isIPv6 && config.fakedns.pop();
    } else {
        delete config.fakedns; 
    }

    if (isFragment) {
        const fragment = config.outbounds[0].settings.fragment;
        fragment.length = `${lengthMin}-${lengthMax}`;
        fragment.interval = `${intervalMin}-${intervalMax}`;
        fragment.packets = fragmentPackets;
        config.outbounds[0].settings.domainStrategy = enableIPv6 ? "UseIPv4v6" : "UseIPv4";
    } else {
        config.outbounds.shift();
    }

    if (isBalancer) {
        const interval = isWarp ? bestWarpInterval : bestVLESSTrojanInterval;
        config.observatory.probeInterval = `${interval}s`;
        config.observatory.subjectSelector = [isChain ? 'chain' : 'prox'];
        config.routing.balancers[0].selector = [isChain ? 'chain' : 'prox']; 
        if (balancerFallback) config.routing.balancers[0].fallbackTag = balancerFallback; 
    } else {
        delete config.observatory;
        delete config.routing.balancers;
    }

    return config;
}

async function buildXrayBestPingConfig(proxySettings, totalAddresses, chainProxy, outbounds, isFragment) {
    const remark = isFragment ? '💦 BPB F - Best Ping 💥' : '💦 BPB - Best Ping 💥';
    let config = buildXrayConfig(proxySettings, remark, isFragment, true, chainProxy, chainProxy ? 'chain-2' : 'prox-2');
    config.dns = await buildXrayDNS(proxySettings, totalAddresses, undefined, false, true, false);
    config.routing.rules = buildXrayRoutingRules(proxySettings, totalAddresses, chainProxy, true, false);
    config.outbounds.unshift(...outbounds);

    return config;
}

async function buildXrayBestFragmentConfig(proxySettings, hostName, chainProxy, outbounds) {
    const bestFragValues = ['10-20', '20-30', '30-40', '40-50', '50-60', '60-70', 
                            '70-80', '80-90', '90-100', '10-30', '20-40', '30-50', 
                            '40-60', '50-70', '60-80', '70-90', '80-100', '100-200'];

    let config = buildXrayConfig(proxySettings, '💦 BPB F - Best Fragment 😎', true, true, chainProxy, undefined, false);
    config.dns = await buildXrayDNS(proxySettings, [], hostName, false, true, false);
    config.routing.rules = buildXrayRoutingRules(proxySettings, [], chainProxy, true, false);
    const fragment = config.outbounds.shift();
    let bestFragOutbounds = [];
    
    bestFragValues.forEach( (fragLength, index) => { 
        if (chainProxy) {
            let chainOutbound = structuredClone(chainProxy);
            chainOutbound.tag = `chain-${index + 1}`;
            chainOutbound.streamSettings.sockopt.dialerProxy = `prox-${index + 1}`;
            bestFragOutbounds.push(chainOutbound);
        }
        
        let proxyOutbound = structuredClone(outbounds[chainProxy ? 1 : 0]);
        proxyOutbound.tag = `prox-${index + 1}`;
        proxyOutbound.streamSettings.sockopt.dialerProxy = `frag-${index + 1}`;
        let fragmentOutbound = structuredClone(fragment);
        fragmentOutbound.tag = `frag-${index + 1}`;
        fragmentOutbound.settings.fragment.length = fragLength;
        fragmentOutbound.settings.fragment.interval = '1-1';
        bestFragOutbounds.push(proxyOutbound, fragmentOutbound);
    });
    
    config.outbounds.unshift(...bestFragOutbounds);
    return config;
}

async function buildXrayWorkerLessConfig(proxySettings) {
    let config = buildXrayConfig(proxySettings, '💦 BPB F - WorkerLess ⭐', true, false, false, undefined, false);
    config.dns = await buildXrayDNS(proxySettings, [], undefined, true);
    config.routing.rules = buildXrayRoutingRules(proxySettings, [], false, false, true);
    let fakeOutbound = buildXrayVLESSOutbound('fake-outbound', 'google.com', '443', userID, 'google.com', 'google.com', '', true, false);
    delete fakeOutbound.streamSettings.sockopt;
    fakeOutbound.streamSettings.wsSettings.path = '/';
    config.outbounds.push(fakeOutbound);
    return config;
}

export async function getXrayCustomConfigs(request, env, isFragment) {
    await initializeParams(request, env);
    const { kvNotFound, proxySettings } = await getDataset(request, env);
    if (kvNotFound) return await renderErrorPage(request, env, 'KV Dataset is not properly set!', null, true);
    let configs = [];
    let outbounds = [];
    let protocols = [];
    let chainProxy;
    const {
        proxyIP,
        outProxy,
        outProxyParams,
        cleanIPs,
        enableIPv6,
        customCdnAddrs,
        customCdnHost,
        customCdnSni,
        vlessConfigs,
        trojanConfigs,
        ports
    } = proxySettings;

    if (outProxy) {
        const proxyParams = JSON.parse(outProxyParams);
        try {
            chainProxy = buildXrayChainOutbound(proxyParams);
        } catch (error) {
            console.log('An error occured while parsing chain proxy: ', error);
            chainProxy = undefined;
            await env.bpb.put("proxySettings", JSON.stringify({
                ...proxySettings, 
                outProxy: '',
                outProxyParams: {}
            }));
        }
    }
    
    const Addresses = await getConfigAddresses(hostName, cleanIPs, enableIPv6);
    const customCdnAddresses = customCdnAddrs ? customCdnAddrs.split(',') : [];
    const totalAddresses = isFragment ? [...Addresses] : [...Addresses, ...customCdnAddresses];
    const totalPorts = ports.filter(port => isFragment ? defaultHttpsPorts.includes(port): true);
    vlessConfigs && protocols.push('VLESS');
    trojanConfigs && protocols.push('Trojan');
    let proxyIndex = 1;
    
    for (const protocol of protocols) {
        let protocolIndex = 1;
        for (const port of totalPorts)  {
            for (const addr of totalAddresses) {
                const isCustomAddr = customCdnAddresses.includes(addr);
                const configType = isCustomAddr ? 'C' : isFragment ? 'F' : '';
                const sni = isCustomAddr ? customCdnSni : randomUpperCase(hostName);
                const host = isCustomAddr ? customCdnHost : hostName;
                const remark = generateRemark(protocolIndex, port, addr, cleanIPs, protocol, configType);
                let customConfig = buildXrayConfig(proxySettings, remark, isFragment, false, chainProxy, undefined, false);
                customConfig.dns = await buildXrayDNS(proxySettings, [addr], undefined);
                customConfig.routing.rules = buildXrayRoutingRules(proxySettings, [addr], chainProxy, false, false);
                let outbound = protocol === 'VLESS'
                    ? buildXrayVLESSOutbound('proxy', addr, port, host, sni, proxyIP, isFragment, isCustomAddr, enableIPv6)
                    : buildXrayTrojanOutbound('proxy', addr, port, host, sni, proxyIP, isFragment, isCustomAddr, enableIPv6);

                customConfig.outbounds.unshift({...outbound});
                outbound.tag = `prox-${proxyIndex}`;

                if (chainProxy) {
                    customConfig.outbounds.unshift(chainProxy);
                    let chainOutbound = structuredClone(chainProxy);
                    chainOutbound.tag = `chain-${proxyIndex}`;
                    chainOutbound.streamSettings.sockopt.dialerProxy = `prox-${proxyIndex}`;
                    outbounds.push(chainOutbound);
                }
                
                outbounds.push(outbound);
                configs.push(customConfig);
                proxyIndex++;
                protocolIndex++;
            }
        }
    }
    
    const bestPing = await buildXrayBestPingConfig(proxySettings, totalAddresses, chainProxy, outbounds, isFragment);
    let finalConfigs = [...configs, bestPing];
    if (isFragment) {
        const bestFragment = await buildXrayBestFragmentConfig(proxySettings, hostName, chainProxy, outbounds);
        const workerLessConfig = await buildXrayWorkerLessConfig(proxySettings); 
        finalConfigs.push(bestFragment, workerLessConfig);
    }
    return new Response(JSON.stringify(finalConfigs, null, 4), { 
        status: 200,
        headers: {
            'Content-Type': 'text/plain;charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'CDN-Cache-Control': 'no-store'
        }
    });
}

export async function getXrayWarpConfigs (request, env, client) {
    const { kvNotFound, proxySettings, warpConfigs } = await getDataset(request, env);
    if (kvNotFound) return await renderErrorPage(request, env, 'KV Dataset is not properly set!', null, true);
    let xrayWarpConfigs = [];
    let xrayWoWConfigs = [];
    let xrayWarpOutbounds = [];
    let xrayWoWOutbounds = [];
    const { warpEndpoints } = proxySettings;
    const outboundDomains = warpEndpoints.split(',').map(endpoint => endpoint.split(':')[0]).filter(address => isDomain(address));
    const proIndicator = client === 'nikang' ? ' Pro ' : ' ';
    
    for (const [index, endpoint] of warpEndpoints.split(',').entries()) {
        const endpointHost = endpoint.split(':')[0];
        let warpConfig = buildXrayConfig(proxySettings, `💦 ${index + 1} - Warp${proIndicator}🇮🇷`, false, false, false, undefined, true);
        let WoWConfig = buildXrayConfig(proxySettings, `💦 ${index + 1} - WoW${proIndicator}🌍`, false, false, true, undefined, true);
        warpConfig.dns = WoWConfig.dns = await buildXrayDNS(proxySettings, [endpointHost], undefined, false, false, true);    
        warpConfig.routing.rules = buildXrayRoutingRules(proxySettings, [endpointHost], false, false, false);
        WoWConfig.routing.rules = buildXrayRoutingRules(proxySettings, [endpointHost], true, false, false);
        const warpOutbound = buildXrayWarpOutbound(proxySettings, warpConfigs, endpoint, false, client);
        const WoWOutbound = buildXrayWarpOutbound(proxySettings, warpConfigs, endpoint, true, client);
        warpOutbound.settings.peers[0].endpoint = endpoint;
        WoWOutbound.settings.peers[0].endpoint = endpoint;
        warpConfig.outbounds.unshift(warpOutbound);
        WoWConfig.outbounds.unshift(WoWOutbound, warpOutbound);
        xrayWarpConfigs.push(warpConfig);
        xrayWoWConfigs.push(WoWConfig);
        const proxyOutbound = structuredClone(warpOutbound);
        proxyOutbound.tag = `prox-${index + 1}`;
        const chainOutbound = structuredClone(WoWOutbound);
        chainOutbound.tag = `chain-${index + 1}`;
        chainOutbound.streamSettings.sockopt.dialerProxy = `prox-${index + 1}`;
        xrayWarpOutbounds.push(proxyOutbound);
        xrayWoWOutbounds.push(chainOutbound);
    }

    const dnsObject = await buildXrayDNS(proxySettings, outboundDomains, undefined, false, true, true);
    let xrayWarpBestPing = buildXrayConfig(proxySettings, `💦 Warp${proIndicator}- Best Ping 🚀`, false, true, false, undefined, true);
    xrayWarpBestPing.dns = dnsObject;    
    xrayWarpBestPing.routing.rules = buildXrayRoutingRules(proxySettings, outboundDomains, false, true, false);
    xrayWarpBestPing.outbounds.unshift(...xrayWarpOutbounds);
    let xrayWoWBestPing = buildXrayConfig(proxySettings, `💦 WoW${proIndicator}- Best Ping 🚀`, false, true, true, undefined, true);
    xrayWoWBestPing.dns = dnsObject;
    xrayWoWBestPing.routing.rules = buildXrayRoutingRules(proxySettings, outboundDomains, true, true, false);
    xrayWoWBestPing.outbounds.unshift(...xrayWoWOutbounds, ...xrayWarpOutbounds);
    const configs = [...xrayWarpConfigs, ...xrayWoWConfigs, xrayWarpBestPing, xrayWoWBestPing];
    return new Response(JSON.stringify(configs, null, 4), { 
        status: 200,
        headers: {
            'Content-Type': 'text/plain;charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'CDN-Cache-Control': 'no-store'
        }
    });
}

const xrayConfigTemp = {
    remarks: "",
    log: {
        loglevel: "warning",
    },
    dns: {},
    fakedns: [
        {
            ipPool: "198.18.0.0/15",
            poolSize: 32768
        },
        {
            ipPool: "fc00::/18",
            poolSize: 32768
        }
    ],
    inbounds: [
        {
            port: 10808,
            protocol: "socks",
            settings: {
                auth: "noauth",
                udp: true,
                userLevel: 8,
            },
            sniffing: {
                destOverride: ["http", "tls"],
                enabled: true,
                routeOnly: true
            },
            tag: "socks-in",
        },
        {
            port: 10809,
            protocol: "http",
            settings: {
                auth: "noauth",
                udp: true,
                userLevel: 8,
            },
            sniffing: {
                destOverride: ["http", "tls"],
                enabled: true,
                routeOnly: true
            },
            tag: "http-in",
        },
        {
            listen: "127.0.0.1",
            port: 10853,
            protocol: "dokodemo-door",
            settings: {
              address: "1.1.1.1",
              network: "tcp,udp",
              port: 53
            },
            tag: "dns-in"
        }
    ],
    outbounds: [
        {
            tag: "fragment",
            protocol: "freedom",
            settings: {
                fragment: {
                    packets: "tlshello",
                    length: "",
                    interval: "",
                },
                domainStrategy: "UseIP"
            },
            streamSettings: {
                sockopt: {
                    tcpKeepAliveIdle: 100,
                    tcpNoDelay: true
                },
            },
        },
        {
            protocol: "dns",
            tag: "dns-out"
        },
        {
            protocol: "freedom",
            settings: {},
            tag: "direct",
        },
        {
            protocol: "blackhole",
            settings: {
                response: {
                    type: "http",
                },
            },
            tag: "block",
        },
    ],
    policy: {
        levels: {
            8: {
                connIdle: 300,
                downlinkOnly: 1,
                handshake: 4,
                uplinkOnly: 1,
            }
        },
        system: {
            statsOutboundUplink: true,
            statsOutboundDownlink: true,
        }
    },
    routing: {
        domainStrategy: "IPIfNonMatch",
        rules: [],
        balancers: [
            {
                tag: "all",
                selector: ["prox"],
                strategy: {
                    type: "leastPing",
                },
            }
        ]
    },
    observatory: {
        probeInterval: "30s",
        probeURL: "https://www.gstatic.com/generate_204",
        subjectSelector: ["prox"],
        EnableConcurrency: true,
    },
    stats: {}
};