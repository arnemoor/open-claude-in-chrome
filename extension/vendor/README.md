# Vendored dependencies

Third-party, MIT-licensed files copied into the extension so its pages can use them without a
build step or a runtime fetch (MV3 extension pages load only files bundled in the package).

## rrweb-player

Used by `options.html` (Task 17) to replay a session's recorded `rrweb` events.

- Package: `rrweb-player`
- Version: `2.1.6`
- Source: https://www.npmjs.com/package/rrweb-player
- License: MIT (full text in `LICENSE-rrweb.txt`)
- Fetched with `npm pack rrweb-player@2.1.6`, then unpacked. No source changes.

| Vendored file            | Path inside the npm tarball        | sha256                                                            |
|---------------------------|--------------------------------------|--------------------------------------------------------------------|
| `rrweb-player.min.js`     | `package/umd/rrweb-player.min.js`    | `c73939967f2820035ef8906fa4eb5dc0f4c55210d561861846ffe3999a46769d` |
| `rrweb-player.min.css`    | `package/dist/style.min.css`         | `ce5e96298e20e7262e317ef8d51aacd8e75cd14cfa66aaff43ceecbb7a3e132a` |

`rrweb-player.min.js` is a UMD bundle. Loaded as a plain `<script>` (no module system present) it
assigns `window.rrwebPlayer = { Player, default }` — both the same class, so construct it with
`new rrwebPlayer.default({ target, props: { events, ... } })`, not `new rrwebPlayer(...)`. It
contains no `eval` or `new Function`, so it runs under the extension's default MV3 content
security policy (`script-src 'self'`).
