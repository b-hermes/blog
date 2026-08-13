---
title: "your ssrf filter's agent doesn't run: the fetch() footgun"
date: 2026-08-13
readtime: "6 min read"
description: "you wired an ssrf guard in as the http agent, tested it, shipped. but node's global fetch() silently ignores the agent option, so the filter never runs. why it happens, and the fix that actually works."
permalink: /posts/fetch-agent/
---

you added an ssrf-protection library. you wired it in as the `agent`, tested it with `http.get`, watched it block a request to `127.0.0.1`, and shipped. except the code that actually makes the outbound request uses `fetch()` now — and `fetch` silently ignores your agent. the filter you're relying on never runs.

## the setup

`ssrf-req-filter` is a popular little npm package whose whole job is to stop server-side requests from reaching internal addresses. you use it as the `agent` on your http client. the readme shows it with `http.get`, and it works exactly as advertised:

```js
const http = require('http');
const ssrfFilter = require('ssrf-req-filter');

http.get('http://127.0.0.1:9000/', { agent: ssrfFilter('http://127.0.0.1:9000/') });
// -> throws: Call to 127.0.0.1 is blocked.
```

connection-time check, blocks the internal address. great.

## the footgun

now use the exact same option on the global `fetch` — the thing most node code reaches for today:

```js
const r = await fetch('http://127.0.0.1:9000/', { agent: ssrfFilter('http://127.0.0.1:9000/') });
console.log(r.status, await r.text());
```

here's the two side by side against an internal-only listener:

```
http.get + agent :  BLOCKED -> Call to 127.0.0.1 is blocked.
fetch    + agent :  REACHED -> 200 SECRET-INTERNAL-RESPONSE
```

same option, same url, same library. `http.get` is protected. `fetch` walks straight to the internal service and returns `200`.

and it's not one library's bug. `request-filtering-agent` — the other popular agent-based ssrf guard — does the same thing: it blocks `http.get` and sails straight through `fetch`. it's the whole *agent-based* approach that `fetch` doesn't honor, not a defect in any single package. the maintainer of `request-filtering-agent` says as much in the open: native fetch/undici don't support the `agent` option, so the library "cannot protect fetch requests" (issue #23), and the undici tracker has the same gap written up (issue #2019). and it's not theoretical — this exact shape has been exploited: CVE-2025-69206 is a real ssrf where raw global `fetch` slipped past an agent-based guard.

*(tested aug 2026: ssrf-req-filter 1.1.1, request-filtering-agent, node v25. the global-`fetch` behaviour is undici's and has been stable across recent node versions.)*

## why

node's global `fetch` is undici. undici doesn't have an `agent` option — it has a `dispatcher`. when you pass an option undici doesn't recognize, it's silently dropped. no error, no warning, no deprecation notice. your `ssrfFilter(...)` object is constructed, handed to `fetch`, and thrown away. the request goes out with zero filtering.

## why it's so easy to hit

this isn't an exotic payload. it's a copy-paste. node 18 made `fetch` global, and everyone is migrating `http.get`/`axios`/`request` code over to it. the `{ agent: ... }` pattern comes along for the ride and *looks* correct — it's the same shape that worked before. and if your tests exercise the `http.get` path (or mock the network), they still pass. you have a green test suite and an ssrf guard that isn't in the request path.

## the obvious fixes are also traps

your first instinct is "fine, give `fetch` a dispatcher instead of an agent." it's trickier than it looks, and i verified both traps:

- **install `undici` and pass its `Agent` as `dispatcher` to the *global* `fetch`? doesn't work.** the global fetch uses node's *built-in* undici — a different module instance than the npm one — and mixing them throws `invalid onRequestStart`.
- **a custom `connect.lookup` that validates the resolved ip misses ip literals.** undici skips dns resolution when the host is already an ip, so `http://127.0.0.1/` walks straight past a lookup-based guard. (that's its own bug, and it shows up identically in rust's `reqwest`.)

## the fix that actually works

validate the destination *yourself*, before you call `fetch`, covering both the ip-literal and the hostname case. use node's built-in `net.BlockList` — the one native node primitive that matches ipv4-mapped ipv6 correctly ([why that matters](/posts/ipv4mapped/)), unlike a hand-rolled regex:

```js
const net = require('net');
const dns = require('dns').promises;

const bl = new net.BlockList();
for (const [n, p] of [['127.0.0.0',8],['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['169.254.0.0',16],['100.64.0.0',10]])
  bl.addSubnet(n, p, 'ipv4');
bl.addAddress('0.0.0.0', 'ipv4'); bl.addAddress('::1', 'ipv6');

async function assertSafe(rawUrl) {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
  for (const ip of ips)
    if (bl.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')) throw new Error('blocked internal address: ' + ip);
  return ips;
}
async function safeFetch(url, opts) { await assertSafe(url); return fetch(url, opts); }
```

tested against an internal listener, `safeFetch` blocks `127.0.0.1`, `169.254.169.254` (metadata) and `[::1]`, and lets `example.com` through. one thing it does *not* close on its own: **dns rebinding** — the name you validated can resolve to something else when `fetch` reconnects. to be airtight, pin: connect to the exact ip you validated (fetch the ip with a `Host` header), or re-check at connect time.

the general lesson is the one that keeps producing ssrf bugs: **the protection has to live on the layer that actually opens the socket.** "i added the library" is not the same statement as "the library is in the connection path." test the integration end to end — fire a request at an internal listener and confirm it's *actually* blocked — instead of trusting the guard is wired in because you imported it.

bottom line: if you protect `http.get` with an agent and then call `fetch` with the same option, you are unprotected and everything looks fine. check which function opens your sockets.
