#!/usr/bin/env bash
# Build the Rust protocol bridge into src/wasm-pkg (ES module for Vite).
set -euo pipefail
cd "$(dirname "$0")/../wasm"
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack not found. Install with: rustup target add wasm32-unknown-unknown && cargo install wasm-pack" >&2
  exit 1
fi
wasm-pack build --target web --release --out-dir ../src/wasm-pkg --no-pack
