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

## Native playback migration

- Follow [the playback boundary](docs/ADAPTER_TARGETS.md) and the staged
  [Polymer #299 migration](docs/native-playback-migration.md). Rust validates
  commands, compiles semantic inputs, and owns handle lifecycle. Native hosts
  own playback time, interpolation and blending; connectors translate commands
  and native events. Do not add a sampler, playhead integrator, duration deadline,
  fallback animation timer or per-frame pose override to complete the migration.
- Prove the connection to the existing rendering integration before removing
  the old host. Preserve real initialization, start/stop, binding and disposal;
  missing behavior must not be concealed behind no-op compatibility methods.
- Three.js provides playback timing. Polymer and LoomLarge must not call an
  `engine.update(dt)` API or drive an Embody animation clock. Remove existing
  such callers during migration; never preserve them as inert compatibility
  methods. Use native action commands through Embody's connector.
- A command-contract test does not establish Three or LoomLarge integration.
  State which migration slice is implemented and which consumers still use the
  legacy path. Leave local execution and CI/artifact waiting restrictions intact.

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

## Stable npm releases and immutable previews

- `.github/workflows/pr-checks.yml` is the only build/publish workflow. Its verification job installs once, tests Rust, builds the Rust/Wasm and JavaScript package once, tests TypeScript against the generated bindings, and validates that output.
- Pushes to `main` and manual runs on `main` with an empty `ref` input publish a public stable npm version. The separate main-only `npm` environment job requires npm to report the exact existing package as public and uses `NPM_KEY` to publish the verified tarball without rebuilding. Keep provenance disabled for the private source repository. Both manifest and publish command must use public access; never change package visibility implicitly. Version and `gitHead` identify the exact released source; registry or source-history errors must stop publication.
- Stable metadata reads use anonymous requests to `registry.npmjs.org`, without following redirects or transmitting publishing credentials. Public package consumers do not need npm read tokens. Do not expose npm or dispatch secrets to fork PR jobs.
- Stable release version selection and publication share one serialized workflow group. Retry an existing source/version without overwriting it; do not publish an older source as a newer version.
- Pull requests, including drafts, run full verification and publish a preview whose install URL includes the Embody commit SHA. Manual runs with explicit refs, non-main manual runs, and `publish-pkg-pr-new` repository dispatches publish previews, never stable npm releases.
- Keep preview dependencies immutable: use the pkg.pr.new URL containing the full requested commit SHA. Do not use mutable branch URLs and do not make downstream repositories install Embody from a Git/codeload dependency, because Git installs would need Rust/Wasm build tooling.
- After a successful stable or same-repository preview publication, upload only JSON notification data. The separate `workflow_run` receiver checks out `main`, validates the producing run attempt and source/PR identity, and notifies LoomLarge with `upstream-package-published`. Store `CROSS_REPO_CI_TOKEN` only in the `release-coordination` environment; restrict that environment and `npm` to main. Never execute PR/artifact code with the dispatch token, including code from `github.workflow_sha` on a PR. Send the exact source SHA, channel, and version or immutable preview URL; include the upstream PR number when available. Missing credentials, unavailable canonical preview URLs, and failed notifications must fail visibly. LoomLarge owns downstream updates; do not add a parallel updater here.

## Coordinating Polymer changes

1. Open a draft Embody PR and hand it off as **ready to test**. Do not watch, poll, or wait for its `Verify built package` job or preview publication.
2. Once an exact compiled preview URL has already been published by Embody CI, use it in the dependent Polymer branch and commit the matching lockfile. If it is not available, report the downstream dependency still pending; do not invent a URL or use a source archive.
3. Build and publish Polymer from its own CI; LoomLarge PR testing may consume Polymer's immutable preview, without compiling Embody transitively. Production consumes exact npm versions and a committed lockfile.
4. Only when the user explicitly authorizes merging, merge in dependency order: Embody first, then replace Polymer's preview URL with the intended stable Embody release/version before Polymer's stable release, then update LoomLarge.
5. For preview testing that needs a source SHA republished, send repository dispatch event `publish-pkg-pr-new` with `client_payload.sha`, or run the workflow manually with `ref`. This does not create a production release. Do not use the preview URL in Polymer's stable npm package.
