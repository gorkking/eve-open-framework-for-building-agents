#!/usr/bin/env bash
# Discover and validate the model and workflow-world e2e suites.
set -euo pipefail

node .github/scripts/discover-e2e-fixtures.mjs
