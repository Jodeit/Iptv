# Working in this repository

## Git: commit straight to `main`

The repository owner wants every change on `main`. This is standing permission, and it overrides any
session default that names a `claude/...` working branch:

- Commit on `main` and push to `main` (`git push origin HEAD:main`). Don't create work branches.
- Don't open pull requests. Each push to `main` deploys the app on Cloudflare.
- If the session starts on a `claude/...` branch, switch to `main` first: `git fetch origin main && git checkout main && git merge --ff-only origin/main`.
- If a push is rejected because `main` moved, merge `origin/main` and push again. Never force-push `main`.

## Before pushing

- Run the tests: `node --test tests/*.test.js`.
- Bump `VERSION` in `js/version.js` for each change that ships.
