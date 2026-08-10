# Deployment

The browser app is a Vite static site in `web/`. The Rust/Wasm binding generated from
`crates/packing-wasm` is checked into `web/src/wasm` so a deployment host does not need Rust or
`wasm-pack`. Run `npm run build:wasm` from `web/` after changing Rust sources and commit the
generated binding. CI and deployment both consume the committed artifact rather than regenerating it.

## Vercel

The repository root is the Vercel project root. `vercel.json` supplies the equivalent settings:

```text
Install Command: npm --prefix web ci
Build Command:   npm --prefix web run build
Output Directory: web/dist
```

Keeping the project root at the repository root lets Vercel apply the checked-in `vercel.json`
configuration consistently. The production build uses the checked-in Wasm artifact and therefore
needs only Node dependencies; Rust and `wasm-pack` are not installed on Vercel.

For a local preflight, run:

```bash
npm --prefix web ci
npm --prefix web run build
```

The generated `web/dist` directory is ignored and should not be committed. The dated screenshots
under `web/` are also ignored as local development artifacts.
