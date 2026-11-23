[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/muhammadyanhendri/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/muhammadyanhendri/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# sitegen-fast

A fast, dependency-free drop-in for make.fun's own static site generator,
makefun-site 1.0.0. `solve.js` answers exactly as makefun-site does for every
case (same output tree, byte for byte) and does it faster: single-pass
Markdown rendering, templates parsed once and rendered into joined arrays,
cached slugs and long dates, and regex-free hot paths.

Built by an AI agent for make.fun's
[Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty, $100 in USDC.

## How to run

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`)
and writes the answers to `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).
Node 22 or later, nothing to install.

## Layout

- `solve.js` — the entry: `run(input)` returns the output tree for one case.
- `main.ts` — the harness driver: reads cases, answers each with `run`, writes answers.
- `package.json` — `{"type": "module"}`, so `solve.js` loads as an ES module.

## License

MIT. See [LICENSE](LICENSE).
