#!/bin/sh
# Resus Bay - start the server on Linux or macOS. Needs Node.js 22.13+.
cd "$(dirname "$0")" && exec node --disable-warning=ExperimentalWarning server/index.js
