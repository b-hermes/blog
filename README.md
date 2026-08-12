# menna.website — 11ty source

Static blog built with [Eleventy](https://www.11ty.dev/). Same design as before; posts are now
individual files with real per-post URLs, per-post OG cards, and an RSS feed.

## run locally
```
npm install
npm run dev     # serves at http://localhost:8080 with live reload
npm run build   # outputs _site/
```

## add a new post
Drop a file in `src/posts/`. Two options:

- **markdown** (`src/posts/my-post.md`) — easiest for prose:
  ```
  ---
  title: "my post title"
  date: 2026-09-01
  readtime: "6 min read"
  description: "one line for the social/OG card and RSS."
  ---
  your **markdown** here. for code with the custom terminal colors, paste a raw
  <pre>...</pre> block (same span classes as the other posts: g/y/c/no/ok).
  ```
- **html** (`src/posts/my-post.html`) — for full control over markup (the 6 existing posts use this,
  so their hand-tuned code blocks render byte-for-byte). Same front-matter block on top.

The permalink defaults to `/posts/<filename>/`. It shows up on the home list and in the feed
automatically, newest first. Nothing else to touch — no index entry, no nav wiring, no hand-edited
`<div>`s (that's the whole point of the move).

## how it's wired
- `src/_includes/base.njk` — the page shell (head/meta/OG, header, nav, footer, theme toggle). Edit chrome here.
- `src/_includes/post.njk` — the per-post layout (back link, title, meta, content).
- `src/index.njk` — the home page (posts list + talks + about sections).
- `src/_includes/about.inc.njk`, `talks.inc.njk` — the about + talks content.
- `src/style.css`, `src/main.js` — the design + behavior, now editable as real files (were inline before).
- `src/CNAME`, `src/og.png`, `src/talks/` — passthrough assets.
- `.eleventy.js` — config (collections, date filters, passthrough).

## deploy
`.github/workflows/deploy.yml` builds and publishes on every push to `main`.
**One-time switch:** repo Settings → Pages → Source → **GitHub Actions**. Until you flip that, the old
branch-based Pages keeps serving `menna.website`, so nothing breaks while you review this.
