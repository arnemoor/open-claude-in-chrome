# Vendored: rrweb record

- **Package:** `@rrweb/record`
- **Version:** `2.1.6`
- **License:** MIT

## File

`rrweb-record.min.js` is the unmodified contents of `package/dist/record.umd.min.cjs`
from the npm tarball, obtained with:

```
npm pack @rrweb/record@2.1.6
tar xzf rrweb-record-2.1.6.tgz
```

sha256 (`shasum -a 256 rrweb-record.min.js`):

```
fde9a5c5c38fc23c9f8d6429b4e74c8996156e1632f132693b68e32509dc92f0
```

It is a UMD build, so loading it as a classic script defines a global,
`window.rrwebRecord`, whose `record` function (`rrwebRecord.record({ emit, ... })`)
is `@rrweb/record`'s sole export (re-exported from `rrweb`).

The trailing `//# sourceMappingURL=record.umd.min.cjs.map` comment points at a
source map that is not vendored here (not needed at runtime); Chrome DevTools
will just show the minified source if opened directly.

## License text

The npm tarball does not include a `LICENSE` file (this package publishes from
a subdirectory of the `rrweb-io/rrweb` monorepo). `LICENSE-rrweb.txt` is the
project's MIT license, fetched from `github.com/rrweb-io/rrweb` (`LICENSE` on
the `master` branch), matching the `"license": "MIT"` field in this package's
`package.json`.
