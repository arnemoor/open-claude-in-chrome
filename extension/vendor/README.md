# Vendored dependencies

Third-party, MIT-licensed files copied into the extension so it can use them without a build
step or a runtime fetch (MV3 extensions load only files bundled in the package). No source
changes. The license text for both packages is in `LICENSE-rrweb.txt`.

## @rrweb/record

Injected by `audit/audit.js` (`ensureRecorder`) into audited tabs to record a masked DOM replay.

- Package: `@rrweb/record`
- Version: `2.1.6`
- License: MIT
- Fetched with `npm pack @rrweb/record@2.1.6`, then unpacked.

| Vendored file         | Path inside the npm tarball          | sha256                                                             |
|-----------------------|--------------------------------------|--------------------------------------------------------------------|
| `rrweb-record.min.js` | `package/dist/record.umd.min.cjs`    | `fde9a5c5c38fc23c9f8d6429b4e74c8996156e1632f132693b68e32509dc92f0` |

It is a UMD build. Loaded as a classic script it defines `window.rrwebRecord`, whose `record`
function (`rrwebRecord.record({ emit, ... })`) is the package's only export. The trailing
`//# sourceMappingURL=record.umd.min.cjs.map` comment points at a source map that is not
vendored (not needed at runtime).

## rrweb-player

Used by `options.html` to replay a session's recorded events.

- Package: `rrweb-player`
- Version: `2.1.6`
- License: MIT
- Fetched with `npm pack rrweb-player@2.1.6`, then unpacked.

| Vendored file          | Path inside the npm tarball          | sha256                                                             |
|------------------------|--------------------------------------|--------------------------------------------------------------------|
| `rrweb-player.min.js`  | `package/umd/rrweb-player.min.js`    | `c73939967f2820035ef8906fa4eb5dc0f4c55210d561861846ffe3999a46769d` |
| `rrweb-player.min.css` | `package/dist/style.min.css`         | `ce5e96298e20e7262e317ef8d51aacd8e75cd14cfa66aaff43ceecbb7a3e132a` |

`rrweb-player.min.js` is a UMD bundle. Loaded as a plain `<script>` it assigns
`window.rrwebPlayer = { Player, default }`. Both are the same class, so construct it with
`new rrwebPlayer.default({ target, props: { events, ... } })`, not `new rrwebPlayer(...)`. It
contains no `eval` or `new Function`, so it runs under the extension's MV3 content security
policy (`script-src 'self'`).

## License text

Neither npm tarball includes a `LICENSE` file (both packages publish from subdirectories of the
`rrweb-io/rrweb` monorepo). `LICENSE-rrweb.txt` is the project's MIT license from
`github.com/rrweb-io/rrweb` (`LICENSE` at tag `rrweb@2.1.6`, identical to `master`), matching
the `"license": "MIT"` field in both packages' `package.json`.
