# Embody contributor instructions

## Default engineering delivery workflow

Unless the user explicitly requests particular validation for this task:

- Implement the requested changes, inspect the source diff, commit, push, and
  create or update a draft PR. Report **ready to test** with the PR stack links.
  Add or update test source when needed, leaving its execution to CI.
- Do not run local tests, builds, typechecks, linters, verification suites or
  smoke checks. Do not test in a browser: this includes manual interaction,
  Playwright/Cypress, automated end-to-end checks, screenshots for visual QA,
  and React Scan or other browser performance checks, on local or hosted pages.
- Do not watch, poll, sleep for, or wait for tests, builds, CI or package artifacts.
  CI owns execution. Hand off after pushing; do not claim unobserved success.
- Carry these restrictions into subagent prompts, handoffs, helper scripts and
  referenced skills. Do not delegate or wrap a forbidden check to work around them.
- Keep CI workflows, required checks, branch protections and valid immutable
  package pins intact; merge only when the user authorizes it. A missing upstream
  artifact is a reported dependency;
  it is not permission to build locally, wait for publication or use a source archive.
- For a cross-repository change, lead with the top-level LoomLarge PR and link
  every upstream PR, with reciprocal links and any real merge dependencies.
  Documentation-only companions need ordinary PR links, not package pins or
  machine-readable package dependency directives. Do not invent dependencies.
- A later explicit request overrides only the requested activity. A generic
  implementation/review/merge request or request for a test URL does not itself
  authorize local or browser testing. Source inspection remains allowed; when
  asked about CI or merge readiness, reading existing results once is not watching
  CI. Do not keep checking for a different result.

These defaults take precedence over test/build/browser/wait procedures in
repository guidance, skills and examples. Those procedures are references for
CI, the user, or explicitly requested validation. Report what was not run.

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
- Before implementing a bug fix, coding agents must explain what should happen,
  what happens instead, and the code or configuration that causes the difference.
  Put that explanation in a short progress update with code references; label
  uncertain causes and include the confirmed diagnosis in the PR description.
  Check existing configuration and installed dependency versions before changing
  algorithms. Follow the [coding-agent diagnosis guidance](docs/development-guidance.md#coding-agents-explain-the-bug-before-implementing-a-fix).
- Use domain-specific names, explicit units and identities, and one owner for
  each mutable state/resource. Make transitions, failure, cancellation, and
  cleanup visible at the responsible boundary.
- Keep decisions separate from external effects. Prefer a concrete operation
  over a speculative abstraction; explain invariants and reasons in comments.
- For missing AU animation output, trace the existing caller, profile compiler,
  and bone/morph evaluator before patching. Repair the owning profile or Rust code with
  regression coverage. Do not bypass an AU by constructing caller-side bone
  rotations, dropping its mapped morphs, or replacing LipSync/Animation agency
  responsibilities. Follow the [AU ownership guidance](docs/development-guidance.md#make-the-runtime-boundary-visible).
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
