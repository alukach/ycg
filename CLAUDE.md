# CLAUDE.md

Static dashboard for Air Canada flights at Castlegar (YCG). A GitHub Action runs `scripts/fetch.py`, which writes `data/*.json`. The page (`index.html`, `assets/app.js`) renders that data. The cancellation outlook lives in `assets/wx.js`, which has no DOM dependencies, so it also runs under Node.

## Every change

- **CHANGELOG.md**: add an entry under today's date (`## YYYY-MM-DD`, newest first) in `Added` / `Changed` / `Fixed` / `Removed`. Write one line per user-visible or data-visible change, in plain language. Skip pure refactors.
- **README.md**: update it only when how the system works, how to set it up, or where data comes from changes. Keep it short and scannable: the diagram, one bullet per component, setup steps, and the data sources table. Detail belongs in code comments or the changelog, not the README.
- **Commits**: use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`, with an optional scope such as `feat(outlook):`). Make one logical change per commit, and include its changelog line in the same commit.

## Checks

```sh
python -m unittest scripts/test_fetch.py   # fetcher/parser tests
node --test scripts/test_wx.mjs            # outlook tests (wx.js)
python -m http.server                      # view at http://localhost:8000
```

## Conventions

- No build step and no dependencies: Python stdlib, plain ES modules, no frameworks.
- `data/history.json` and `data/events.json` are committed by the Action. Don't hand-edit them except to correct bad records, and note any correction in the changelog.
- The outlook weights are hand-set until enough history exists to fit them. If you change a weight, explain why in a comment.
