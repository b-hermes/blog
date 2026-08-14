---
title: "127.0.0.1 never touches your resolver (node + rust)"
date: 2026-08-13
readtime: "7 min read"
description: "hook the dns layer to block internal addresses and it feels airtight — every request resolves. except ip literals skip resolution entirely, so your resolver-based guard never runs. the same root cause in node's undici and rust's reqwest, with runnable repros."
permalink: /posts/resolver-skip/
---

here's a clean way to build an ssrf filter: hook the dns layer. every http client lets you plug in a custom resolver, so you put your "is this address internal?" check right there. resolution is the choke point every request passes through, so a guard there catches everything. except it doesn't. when the url already contains an ip literal, the client skips resolution entirely, and your resolver never runs. i hit this in two completely different ecosystems for the same structural reason: node's `undici` (which is also global `fetch` — itself the subject of a [separate footgun where the guard object is dropped entirely](/posts/fetch-agent/)) and rust's `reqwest`.

this is not a new discovery. it's documented for both clients (receipts at the bottom). i'm writing it up because seeing the *same* root cause in two languages makes the lesson land harder than any single advisory does, and because the runnable repros are short.

## node: a custom `connect.lookup` that never fires

`undici`'s `Agent` lets you pass `connect.lookup` — the dns hook. put a guard in it that blocks everything, then aim requests at ip literals:

```js
import { Agent, request } from 'undici';
import http from 'http';

const guard = new Agent({ connect: { lookup: (host, opts, cb) => cb(new Error('lookup-guard-blocked')) } });
const server = http.createServer((_, r) => r.end('INTERNAL')).listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  for (const host of ['127.0.0.1', '[::ffff:7f00:1]', 'localhost']) {
    try { const { body } = await request(`http://${host}:${port}/`, { dispatcher: guard }); console.log(`  ${host.padEnd(18)} -> REACHED (lookup NEVER ran): ${await body.text()}`); }
    catch (e) { console.log(`  ${host.padEnd(18)} -> BLOCKED: ${e.message}`); }
  }
  server.close();
});
```

```
  127.0.0.1          -> REACHED (lookup NEVER ran): INTERNAL
  [::ffff:7f00:1]    -> REACHED (lookup NEVER ran): INTERNAL
  localhost          -> BLOCKED: lookup-guard-blocked
```

the guard blocks everything it sees. it just never sees the two ip literals — one plain v4, one ipv4-mapped ipv6 in hex form (that's what `new URL('http://[::ffff:127.0.0.1]/').hostname` hands you — [why node does that](/posts/ipv4mapped/)). only `localhost` needs a name resolved, so only `localhost` reaches the hook. put an ssrf check in `connect.lookup` and `http://127.0.0.1/` walks straight past it.

## rust: a custom `dns_resolver` that never fires

exact same shape in `reqwest`. implement `reqwest::dns::Resolve`, make it print when it runs and then refuse everything, install it with `dns_resolver`, and hit an ip literal:

```rust
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::sync::Arc;

struct BlockAll;
impl Resolve for BlockAll {
    fn resolve(&self, _name: Name) -> Resolving {
        eprintln!("    >>> RESOLVER CALLED (guard ran)");
        Box::pin(async move {
            let err: Box<dyn std::error::Error + Send + Sync> = "blocked by custom SSRF resolver".into();
            Err::<Addrs, _>(err)
        })
    }
}

#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder().dns_resolver(Arc::new(BlockAll)).build().unwrap();
    for url in ["http://127.0.0.1:8080/", "http://localhost:8080/"] {
        println!("--- GET {} ---", url);
        match client.get(url).send().await {
            Ok(r) => println!("    REACHED: {}  <-- guard bypassed", r.status()),
            Err(e) => println!("    BLOCKED: {}", e),
        }
    }
}
```

against a `python3 -m http.server 8080`:

```
--- GET http://127.0.0.1:8080/ ---
    REACHED: 200 OK  <-- guard bypassed
--- GET http://localhost:8080/ ---
    >>> RESOLVER CALLED (guard ran)
    BLOCKED: error sending request for url (http://localhost:8080/)
```

same story. `RESOLVER CALLED` prints only for `localhost`. the ip literal is connected to directly, resolver untouched.

## why it happens in both

a dns resolver resolves *names*. an ip literal is already an address — there is nothing to resolve, so the client fast-paths straight to `connect()` and your hook is not on that path. node's `undici` follows `net.connect`/`dns.lookup` semantics where the custom lookup is only exercised for non-ip hosts. rust's `reqwest` leans on the `url` crate, which parses a numeric literal directly into an `IpAddr` before any resolver is consulted. two different languages, two different parsers, one shared assumption: *the resolver is where addresses come from.* it isn't. some addresses arrive pre-resolved, and those are exactly the ones an attacker will send.

this is the two-oracle problem in miniature: the code that's supposed to validate (your resolver) and the code that connects disagree about whether resolution even happens.

## the fix: don't rely on the resolver alone

the resolver hook is necessary but not sufficient. it's the right place to catch the *hostname* case (and even there you need to pin, or dns rebinding reopens the hole). but you have to handle the literal case separately, before the request goes out:

```js
import net from 'net';
// if the host is already an ip, classify it yourself — the resolver won't see it.
function hostIsLiteralInternal(rawHost) {
  const host = rawHost.replace(/^\[|\]$/g, '');
  if (net.isIP(host) === 0) return false;          // it's a name -> resolver/pinning handles it
  const bl = new net.BlockList();
  bl.addSubnet('127.0.0.0', 8, 'ipv4'); bl.addSubnet('10.0.0.0', 8, 'ipv4');
  bl.addSubnet('172.16.0.0', 12, 'ipv4'); bl.addSubnet('192.168.0.0', 16, 'ipv4');
  bl.addSubnet('169.254.0.0', 16, 'ipv4'); bl.addSubnet('100.64.0.0', 10, 'ipv4');
  bl.addAddress('::1', 'ipv6'); bl.addAddress('0.0.0.0', 'ipv4');
  return bl.check(host, net.isIP(host) === 6 ? 'ipv6' : 'ipv4');   // matches ipv4-mapped ipv6 too
}
```

the rust equivalent is the same idea: `url.host()` will hand you `Host::Ipv4`/`Host::Ipv6` when the target is a literal — check those directly, and only lean on the custom `Resolve` for the `Host::Domain` case. the projects that got this right do exactly that: they add an explicit "is this an ip literal?" branch *in front of* the resolver-based check.

## receipts (this is known, not novel)

- **rust `reqwest`** — the vaultwarden advisory GHSA-72vh-x5jq-m82g says it verbatim: "when the URL host is a numeric literal, the Rust `url` crate ... parses it directly as an IPv4 address. Reqwest then connects to the IP without invoking the custom DNS resolver at all, `post_resolve()` is never called." svix documents the same architectural constraint (SVIXSEC-2026-0001): a custom resolver has to be paired with "detecting when the URL will not use DNS because it contains an IP literal, and applying filtering directly."
- **node `undici`** — the budibase advisory (CVE-2026-54353) notes the guard's lookup is only called when the input is not an ip; the `postiz-app` fix adds an explicit `if (net.isIP(hostname))` branch inside its `undici` `connect.lookup` for exactly this reason.

bottom line: putting your ssrf check in the dns resolver feels airtight because every request seems to pass through it. it doesn't. ip literals never touch the resolver, so a resolver-only guard is bypassed by the most obvious payload there is — `http://127.0.0.1/`. check the literal case yourself, before you connect.
