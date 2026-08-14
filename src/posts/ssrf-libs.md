---
title: "does your ssrf guard resolve dns, or just regex your string?"
date: 2026-08-13
readtime: "9 min read"
description: "most ssrf guards just regex the hostname string. i threw a corpus of internal addresses at the popular npm libraries, then showed the two things a string check can never catch: dns resolution, and kubernetes search-domain expansion that turns a bare label into an internal service."
permalink: /posts/ssrf-libs/
---

most ssrf "protection" in the wild is a function called something like `isPrivateIP()`. i took the popular npm ones and threw the same set of addresses at them. the ones that only look at the *string* miss two whole classes of bypass — and one of those classes is, embarrassingly, just a hostname.

this isn't hypothetical. a wrong `isPrivate` is a shipped vulnerability — i've reported cves for exactly this, including a category bypass in a url-safety npm lib (`dssrf`, CVE-2026-44232) where an ipv6 form slipped its `is_url_safe`. when a downstream app trusts one of these as its *only* ssrf check, one lib gap becomes everyone's gap.

and it's a live wave, not a museum piece. the same mapped-ipv6 / private-ip-classification gap shipped as cves across the ecosystem in 2026 alone: axios (CVE-2026-44492, `::ffff:` not normalized for `NO_PROXY`), sync-in server (CVE-2026-47684, private-ip regex misses `::ffff:127.0.0.1`), auth-fetch-mcp (CVE-2026-49857, `isPrivateV6` misses the hex form), twenty (GHSA-vrcj-hv2q-c58m, mapped-ipv6 normalization). every one of them is a classifier that looked at a string and got the representation wrong.

## the two questions a real guard has to answer

1. **representation** — after you decode every legal way of writing an address (hex-mapped ipv6, nat64, cgnat, decimal, octal, short form...), is it internal?
2. **resolution + pinning** — does it actually resolve the hostname, check the ip you're going to *connect* to, and then connect to that exact ip?

most libraries answer only #1, and some don't even do that well. #2 is where a string check is beaten by a plain public domain whose `A` record points at `127.0.0.1`. the string `evil.com` isn't private. the address it resolves to is.

## the test

same set of internal targets, four libraries (versions tested aug 2026: `ip@2.0.1`, `private-ip@3.0.2`, `ipaddr.js@2.5.0`, `ssrfcheck@1.4.0`). "MISS" = the library treats an internal address as safe/public.

| internal target | `ip` | `private-ip` | `ipaddr.js` | `ssrfcheck` |
|---|---|---|---|---|
| `127.0.0.1` | blocked | blocked | `loopback` | blocked |
| `127.1` (short form) | **MISS** | blocked | `loopback` | blocked |
| `100.64.0.1` (cgnat, rfc 6598) | **MISS** | blocked | `carrierGradeNat` | blocked |
| `0.0.0.0` | **MISS** | blocked | `unspecified` | blocked |
| `::ffff:7f00:1` (mapped, hex) | **MISS** | **MISS** | `ipv4Mapped` | blocked |
| `64:ff9b::7f00:1` (nat64) | **MISS** | **MISS** | `rfc6052` | blocked |
| `localtest.me` → `127.0.0.1` (dns) | n/a | n/a | n/a | **ALLOWED** |

## reading the table

**`ip`** — this is the one with ~8 million downloads a week, and it already carries a published SSRF-classification advisory (CVE-2024-29415). in my test it misses the short form `127.1`, cgnat, `0.0.0.0`, the hex-mapped form, and nat64. if your ssrf guard is `require('ip').isPrivate(host)`, you have gaps — don't use it for this. (it's not marked deprecated on npm — still actively pulled — which is exactly why the gaps matter.)

**`private-ip`** — catches the *dotted* mapped form `::ffff:127.0.0.1`, but misses the *hex* form `::ffff:7f00:1`. which matters, because the hex form is exactly what `new URL('http://[::ffff:127.0.0.1]/').hostname` hands you — node normalizes it for you, right into the gap ([why node does this](/posts/ipv4mapped/)). (this specific gap is already public — there's an open issue and a codeql query that names the package — so it's a known limitation, not a fresh finding. it's here as an illustration of the class.)

**`ipaddr.js`** — the honest surprise: it classifies *every* form correctly. `carrierGradeNat`, `ipv4Mapped`, `rfc6052`, `uniqueLocal` — it knows them all. but notice it returns a *range name*, not a yes/no. it's a classifier, not a guard. the bug moves into your code: if you only treat `'private'` and `'loopback'` as unsafe (which is what most people write), you just waved through cgnat, mapped, and nat64 that `ipaddr.js` correctly labeled. the library is right; the two-line mapping on top of it is where the hole is.

**`ssrfcheck`** — blocks every ip encoding i threw at it. and its readme says, in plain text, that it does **not** guarantee dns-layer security. that's the right kind of honesty. so `localtest.me` (a real public domain that resolves to `127.0.0.1`) sails through as safe — *by design*, and documented. it's not a bug in the library; it's a boundary the library tells you it doesn't cover.

## the dns gap, concretely

this is the part a string check fundamentally cannot fix:

```
ssrfcheck.isSSRFSafeURL('http://localtest.me/')          -> safe: true
ssrfcheck.isSSRFSafeURL('http://169-254-169-254.nip.io/') -> safe: true
```

both of those names resolve to addresses you never want your server to reach (loopback, and cloud metadata). the guard looks at the string, sees a normal-looking hostname, and says fine. only *resolution* catches this — and resolution is step #2 that most of these libraries deliberately leave to you. (and even when you do resolve, some http clients skip resolution entirely for ip literals, so a resolver-based guard never runs at all — [that trap, in node and rust](/posts/resolver-skip/).)

## and in kubernetes, the resolver rewrites your string

there's a sharper version of the dns gap, and it doesn't even need the attacker to control a domain. it just needs your app to run in kubernetes — which, statistically, it does.

every pod ships with a `resolv.conf` like this:

```
search <namespace>.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`ndots:5` means any hostname with fewer than 5 dots is treated as *relative*: the resolver appends the `search` suffixes and tries those *first*, before it ever tries the name as absolute. so when your code resolves the bare label `foo`, glibc's `getaddrinfo` doesn't look up `foo` — it looks up `foo.<namespace>.svc.cluster.local` first, and if a service by that name exists, that's what you connect to.

now put a string-based guard in front of it. it sees `foo`: not an ip literal, not `localhost`, nothing on the blocklist — allowed. but the resolver turns `foo` into an internal cluster service. the string the guard validated and the name the socket resolved are not the same name, and the difference is *internal-ness the attacker never typed*.

reproduced in a glibc container with a stock k8s-style `resolv.conf`:

```
# options ndots:5  /  search internal.svc.cluster.local
guard check on "127.0.0.1"  -> BLOCKED: private ip
guard check on "foo"        -> PASSED
  getaddrinfo("foo")        -> 127.0.0.1     # search-expanded to foo.internal.svc.cluster.local
  response                  -> INTERNAL-SECRET: reached the cluster service
```

the direct address `127.0.0.1` is blocked by the same guard. the bare label `foo` walks straight through and reaches the internal listener, because `getaddrinfo` search-expanded it. and you don't even need a dns server you control for a real target: `http://kubernetes/` expands to `kubernetes.default.svc.cluster.local` — the api server's ClusterIP. any internal service name you can guess is reachable through a guard that only read the string.

this is the resolution gap taken one step further. it isn't just "resolve the name and check the ip" — it's that the resolver can *manufacture* a name you never validated. and note the second-order trap: even a guard that *does* resolve can be beaten if it resolves the name differently than your http client does — the guard resolves `foo` as absolute (public or nxdomain, looks fine), the client search-expands it to the internal service. validate what the socket will actually connect to, not what you resolved in some other context.

## how to use them right

pick a library that does the whole thing at **connection time**, or wire the steps yourself:

1. **resolve the hostname once — the same way your client will**, search-domain expansion and all, not with a separate resolver that answers differently.
2. **for every resolved address (all `A` and all `AAAA`)**, normalize it and check against the full reserved set — not just rfc1918: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254.0.0/16` (metadata), `100.64.0.0/10` (cgnat), `0.0.0.0/8`, `::1`, `fe80::/10`, `fc00::/7`, ipv4-mapped, and the transition forms (nat64 `64:ff9b::/96`).
3. **pin the socket to the address you validated.** if you validate an ip but then hand the *hostname* to your http client, it resolves again and can get a different answer — that's the dns rebinding window.
4. **re-validate on every redirect.**

libraries that enforce this at connect time (`safeurl` in go, `ssrf_filter` in ruby) are the right shape — they resolve, validate, and pin. the classifiers here (`ipaddr.js`, `ssrfcheck`) answer question #1 well; if you use one of them, understand that you still own steps 2 through 4.

bottom line: an ssrf guard that only inspects the string is guarding the wrong thing. the address you validate is not guaranteed to be the address you connect to — so validate the *resolved* ip, normalize every representation, and pin the socket. if the library doesn't resolve dns, that's not a detail, it's half the job.
