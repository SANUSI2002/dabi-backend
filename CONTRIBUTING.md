# Contributing to Sabi Health Backend

## Branches
- `main` — production. Never push directly.
- `develop` — working branch. All feature branches start from and merge back into here.
- Feature branches: `feature/short-description` (e.g. `feature/appointments-api`)

## Workflow
1. Pull the latest `develop`.
2. Create your branch from `develop`.
3. Commit with clear messages.
4. Open a Pull Request into `develop`.
5. Get at least 1 approval before merging.
6. Delete your branch after merging.

## Environment variables
- Never commit `.env` or real secrets.
- Copy `.env.example` to `.env` and fill in your own local values.

## API contracts
- Before building a new endpoint, check with the frontend team on what
  fields/shape they expect in the response — avoids rework on both sides.
