#!/usr/bin/env bash
set -euo pipefail

npm run check

ntn doctor
ntn workers exec checkNotionConnection --local -d '{}'
ntn workers exec githubIssuesNotionBackfill --local -d '{"dryRun":true,"page":1,"updatedSince":null,"includeContext":false}'
ntn workers exec startupDocsGithubToNotion --local -d '{"dryRun":true,"paths":null,"ref":null}'
