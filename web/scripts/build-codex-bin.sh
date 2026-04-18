#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
TARGET_DIR="${HOME}/codex-bin"
mkdir -p "${TARGET_DIR}"

cd "${ROOT}/codex-rs"
cargo build --release -p codex-app-server --bin codex-app-server --ignore-rust-version
install -m 0755 "target/release/codex-app-server" "${TARGET_DIR}/codex-app-server"
