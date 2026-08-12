# Embody contributor instructions

## Source-only repository

- Commit Rust, TypeScript, configuration, tests, and documentation. Do not commit `dist/`, `target/`, `node_modules/`, npm tarballs, `.wasm` binaries, or other generated output.
- Run `npm run check:generated` before committing. CI runs the same deterministic tracked-file guard.
- Treat `Cargo.lock` and `package-lock.json` as source-controlled dependency inputs; update them intentionally when dependencies change.

## Build and package contract

- Install with `npm ci`, then use `npm run build` to generate the complete package in `dist/`. A clean checkout has no `dist/` directory.
- Build once per source SHA. After the build, use `npm run test:package` to validate the existing output; package checks and publishing lifecycle scripts must never invoke another build.
- `npm run test:exports`, `npm run test:pack`, `npm run check:dist`, `prepack`, and `prepublishOnly` are consumers of the existing `dist/`. If one reports missing output, run `npm run build` explicitly rather than adding a hidden rebuild.
- Never restore `dist/` from a cache. npm and Cargo caches accelerate dependency downloads and compiler intermediates only; they are not package artifacts or a source of truth.

## CI and immutable previews

- `.github/workflows/pr-checks.yml` is the only build/publish workflow. Its single job installs once, tests Rust and TypeScript, builds the Rust/Wasm and JavaScript package once, validates that output, then publishes that exact output to pkg.pr.new.
- Non-draft pull requests publish a preview whose install URL includes the Embody commit SHA. Main pushes, manual dispatches, and `publish-pkg-pr-new` repository dispatches publish the checked-out SHA without creating a PR comment.
- Keep preview dependencies immutable: use the pkg.pr.new URL containing the full requested commit SHA. Do not use mutable branch URLs and do not make downstream repositories install Embody from a Git/codeload dependency, because Git installs would need Rust/Wasm build tooling.

## Coordinating Polymer changes

1. Open the Embody PR and wait for its `Verify built package` job to publish the SHA preview.
2. In the dependent Polymer branch, set the Embody dependency to the exact pkg.pr.new SHA URL printed by Embody CI. Commit Polymer's lockfile update with that temporary preview pin.
3. Build and publish Polymer from its own CI; LoomLarge should consume Polymer's immutable preview, not compile Embody transitively.
4. Merge in dependency order: Embody first, then replace Polymer's preview URL with the intended stable Embody release/version before Polymer's stable release, then update LoomLarge.
5. For staging or production coordination that needs an older/main SHA republished, send repository dispatch event `publish-pkg-pr-new` with `client_payload.sha`, or run the workflow manually with `ref`. Always pass a concrete commit SHA when another repository will consume the result.
