# Embody contributor instructions

## Engineering writing

- Before drafting issues, implementation plans, design proposals, PR
  descriptions, or reviews, read `VISION_AND_PRD.md` for product intent,
  `README.md` for the current architecture and public contracts, and the
  relevant feature documentation and owning code. Distinguish roadmap goals
  from implemented capabilities; support current-behavior claims with evidence.
- Lead with the concrete problem or missing capability, the affected consumer,
  and the user or developer flow. Name the affected API, profile, model, or
  runtime behavior and the host surface when known. Explain how a semantic
  control or rig change affects observable character behavior, or state the
  engineering constraint it removes when the benefit is indirect.
- Identify the owning layer: Embody's Rust/Wasm core owns semantic controls and
  profile/runtime computation; adapters handle renderer objects; host animation
  libraries own clip playback and blending. Explain any required Polymer or
  application integration. Do not imply that a library change alone delivers a
  new authoring UI, character interaction, or released product experience.
- Separate observed current behavior, proposed decisions, delivered behavior,
  and follow-on work. Link code or documentation for factual claims, label
  hypotheses and unresolved choices, and explain what each blocking dependency
  prevents. Distinguish an interface or scaffold from working runtime behavior.
- Define completion using concrete inputs and observable outputs or actions,
  including relevant invalid-input or lifecycle cases. PR descriptions must
  reflect the final diff and explain why it addresses the linked issue, what
  changed for consumers, and actual verification with its limits. Identify any
  acceptance criteria left incomplete; planned checks are not completed checks.
- Use precise, searchable titles naming the affected behavior or contract, and
  concise active prose proportional to the change. Define unfamiliar terms and
  replace claims such as "improve expressiveness" with a specific result. Keep
  durable design rationale in repository documentation and link it rather than
  repeating it across tickets.
- Review findings must explain the triggering condition, failure, consequence,
  and evidence. Name the concrete consumer or system impact of an architecture
  violation; a prose preference alone is not a correctness defect.

## Source-only repository

- Commit Rust, TypeScript, configuration, tests, and documentation. Do not commit `dist/`, `target/`, `node_modules/`, npm tarballs, `.wasm` binaries, or other generated output.
- Run `npm run check:generated` before committing. CI runs the same deterministic tracked-file guard.
- Treat `Cargo.lock` and `package-lock.json` as source-controlled dependency inputs; update them intentionally when dependencies change.

## Build and package contract

- Install with `npm ci`, then use `npm run build` to generate the complete package in `dist/`. A clean checkout has no `dist/` directory.
- Build before `npm test` or `npm run typecheck`: the public loader is typed from the wasm-bindgen declarations generated in `dist/wasm/`. Rebuild after changing Rust exports; do not commit or hand-maintain a copy of those signatures.
- Build once per source SHA. After the build, use `npm run test:package` to validate the existing output; package checks and publishing lifecycle scripts must never invoke another build.
- `npm run test:exports`, `npm run test:pack`, `npm run check:dist`, `prepack`, and `prepublishOnly` are consumers of the existing `dist/`. If one reports missing output, run `npm run build` explicitly rather than adding a hidden rebuild.
- Never restore `dist/` from a cache. npm and Cargo caches accelerate dependency downloads and compiler intermediates only; they are not package artifacts or a source of truth.

## CI and immutable previews

- `.github/workflows/pr-checks.yml` is the only build/publish workflow. Its single job installs once, tests Rust, builds the Rust/Wasm and JavaScript package once, tests TypeScript against the generated bindings, validates that output, then publishes that exact output to pkg.pr.new.
- Non-draft pull requests publish a preview whose install URL includes the Embody commit SHA. Main pushes, manual dispatches, and `publish-pkg-pr-new` repository dispatches publish the checked-out SHA without creating a PR comment.
- Keep preview dependencies immutable: use the pkg.pr.new URL containing the full requested commit SHA. Do not use mutable branch URLs and do not make downstream repositories install Embody from a Git/codeload dependency, because Git installs would need Rust/Wasm build tooling.

## Coordinating Polymer changes

1. Open the Embody PR and wait for its `Verify built package` job to publish the SHA preview.
2. In the dependent Polymer branch, set the Embody dependency to the exact pkg.pr.new SHA URL printed by Embody CI. Commit Polymer's lockfile update with that temporary preview pin.
3. Build and publish Polymer from its own CI; LoomLarge should consume Polymer's immutable preview, not compile Embody transitively.
4. Merge in dependency order: Embody first, then replace Polymer's preview URL with the intended stable Embody release/version before Polymer's stable release, then update LoomLarge.
5. For staging or production coordination that needs an older/main SHA republished, send repository dispatch event `publish-pkg-pr-new` with `client_payload.sha`, or run the workflow manually with `ref`. Always pass a concrete commit SHA when another repository will consume the result.
