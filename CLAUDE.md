# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build TypeScript
npm run build

# Run tests (watch mode by default)
npm test

# Run tests once
npm test -- run

# Run a single test file
npm test -- run tests/cw-logs-event-handler.test.ts

# Run tests with coverage
npm test -- run --coverage

# Lint and format
npm run lint:fix

# Lint only (no fixes)
npm run lint

# CDK commands
npm run cdk synth
npm run cdk deploy
npm run cdk diff
```

## Architecture

This is an AWS CDK application that automatically schedules deletion of CloudWatch Log Groups created by AWS Lambda Powertools e2e tests.

### Event-Driven Flow

1. **EventBridge Rule** (`CWLogsGarbageGooberRule`) listens for `CreateLogGroup` CloudTrail events
2. **Lambda Handler** (`cw-logs-event-handler.ts`) processes the event:
   - Parses EventBridge event using `@aws-lambda-powertools/parser`
   - Fetches log group metadata to get retention settings
   - Creates an EventBridge Scheduler schedule to delete the log group after retention + 1 day
3. **SQS Queue** (`deletion-queue`) receives deletion tasks when schedules fire

### Key Files

- `src/CWLogsGarbageGoober-stack.ts` - CDK stack definition (also the CDK app entry point)
- `src/cw-logs-event-handler.ts` - Lambda handler with class-based structure using decorators

### Testing

- Uses Vitest with `aws-sdk-client-mock` for AWS SDK mocking
- Test setup in `tests/setupEnv.ts` configures custom matchers and silences console output
- Test events stored as JSON files in `tests/` directory
- 100% coverage thresholds enforced (excludes CDK stack and types)

### Code Style

- Biome for linting and formatting (single quotes, semicolons, 2-space indent)
- ESM modules (`"type": "module"` in package.json)
- TypeScript with strict settings targeting ES2022

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:

   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```

5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
