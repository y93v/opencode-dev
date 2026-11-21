#!/usr/bin/env node
// DevCode: thin shim over the opencode CLI loader. Keeps the binary name
// "devcode" on PATH, forwards to the normal cached launcher.
require("./opencode.cjs")
