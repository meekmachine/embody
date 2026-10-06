# Embody contributor instructions

## Default agent delivery workflow

- Make the requested source, test, and documentation changes, then commit, push,
  and create or update a draft PR. Tell the user **ready to test** with the PR
  link; use the same wording in the PR handoff.
- Do not run local tests, builds, typechecks, or browser testing, including
  automated browser checks. CI owns validation. Do not watch, poll, or wait for
  CI, test, build, or package-publication results before handing off the PR.
- Add or update relevant tests without executing them locally. Report that
  validation is delegated to CI; never claim a check passed unless its result
  was actually observed, and do not imply that "ready to test" means verified.
- Keep normal CI workflows, required checks, branch protections, and immutable
  package requirements intact. Do not bypass them or merge automatically.
- An explicit future user request can authorize particular local checks,
  browser testing, or CI monitoring for that task. Otherwise this default takes
  precedence over validation and waiting instructions in repository docs,
  examples, and referenced agent skills; those remain reference procedures,
  not instructions to execute checks during ordinary agent delivery.

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

## Code clarity and contract documentation

- Before changing behavior, read [development guidance](docs/development-guidance.md)
  and trace the affected path through its owning code. Apply the relevant rules
  to new and touched code; do not expand a task into an unrelated cleanup.
- Use domain-specific names, explicit units and identities, and one owner for
  each mutable state/resource. Make transitions, failure, cancellation, and
  cleanup visible at the responsible boundary.
- Keep decisions separate from external effects. Prefer a concrete operation
  over a speculative abstraction; explain invariants and reasons in comments.
- Update the existing contract document identified by the development guide
  when changing a public contract or ownership boundary. Keep examples aligned
  with exports and distinguish implemented behavior from intended work.
- Add focused tests for changed behavior, including relevant lifecycle edges,
  for CI to execute. In review, identify the ambiguity and its concrete failure
  risk rather than imposing subjective style preferences or size limits.

## Source-only repository

- Commit Rust, TypeScript, configuration, tests, and documentation. Do not commit `dist/`, `target/`, `node_modules/`, npm tarballs, `.wasm` binaries, or other generated output.
- CI runs `npm run check:generated`, the deterministic tracked-file guard. Do not run it locally as a prerequisite to committing.
- Treat `Cargo.lock` and `package-lock.json` as source-controlled dependency inputs; update them intentionally when dependencies change.

## CI build and package contract

These are CI/package-maintenance requirements, not local agent steps. Follow the
default delivery workflow unless the user explicitly requests local validation.

- CI installs with `npm ci`, then uses `npm run build` to generate the complete package in `dist/`. A clean checkout has no `dist/` directory.
- CI must build before `npm test` or `npm run typecheck`: the public loader is typed from the wasm-bindgen declarations generated in `dist/wasm/`. Rebuild after changing Rust exports; do not commit or hand-maintain a copy of those signatures.
- CI builds once per source SHA. After the build, it uses `npm run test:package` to validate the existing output; package checks and publishing lifecycle scripts must never invoke another build.
- `npm run test:exports`, `npm run test:pack`, `npm run check:dist`, `prepack`, and `prepublishOnly` are consumers of the existing `dist/`. If one reports missing output, fix the explicit CI build ordering rather than adding a hidden rebuild or building locally by default.
- Never restore `dist/` from a cache. npm and Cargo caches accelerate dependency downloads and compiler intermediates only; they are not package artifacts or a source of truth.

## CI and immutable previews

- `.github/workflows/pr-checks.yml` is the only build/publish workflow. Its single job installs once, tests Rust, builds the Rust/Wasm and JavaScript package once, tests TypeScript against the generated bindings, validates that output, then publishes that exact output to pkg.pr.new.
- Non-draft pull requests publish a preview whose install URL includes the Embody commit SHA. Main pushes, manual dispatches, and `publish-pkg-pr-new` repository dispatches publish the checked-out SHA without creating a PR comment.
- Keep preview dependencies immutable: use the pkg.pr.new URL containing the full requested commit SHA. Do not use mutable branch URLs and do not make downstream repositories install Embody from a Git/codeload dependency, because Git installs would need Rust/Wasm build tooling.

## Coordinating Polymer changes

1. Open a draft Embody PR and hand it off as **ready to test**. Do not watch, poll, or wait for its `Verify built package` job or preview publication.
2. Once an exact compiled preview URL has already been published by Embody CI, use it in the dependent Polymer branch and commit the matching lockfile. If it is not available, report the downstream dependency still pending; do not invent a URL or use a source archive.
3. Build and publish Polymer from its own CI; LoomLarge should consume Polymer's immutable preview, not compile Embody transitively.
4. Only when the user explicitly authorizes merging, merge in dependency order: Embody first, then replace Polymer's preview URL with the intended stable Embody release/version before Polymer's stable release, then update LoomLarge.
5. For staging or production coordination that needs an older/main SHA republished, send repository dispatch event `publish-pkg-pr-new` with `client_payload.sha`, or run the workflow manually with `ref`. Always pass a concrete commit SHA when another repository will consume the result.
