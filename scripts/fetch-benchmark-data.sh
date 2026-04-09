#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_DIR="$ROOT_DIR/benchmark/data/raw"

usage() {
  cat <<'EOF'
Usage:
  scripts/fetch-benchmark-data.sh <dataset>

Supported datasets:
  longmemeval
  locomo
  beir-scifact

This script only downloads raw public benchmark inputs into benchmark/data/raw/.
It does not convert them into Munin query files yet.
EOF
}

download() {
  local url="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"

  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --output "$dest" "$url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "$dest" "$url"
    return
  fi

  echo "Need curl or wget to download benchmark data." >&2
  exit 1
}

dataset="${1:-}"

if [[ -z "$dataset" ]]; then
  usage
  exit 1
fi

case "$dataset" in
  longmemeval)
    download \
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json" \
      "$RAW_DIR/longmemeval/longmemeval_oracle.json"
    download \
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json" \
      "$RAW_DIR/longmemeval/longmemeval_s_cleaned.json"
    download \
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json" \
      "$RAW_DIR/longmemeval/longmemeval_m_cleaned.json"
    ;;
  locomo)
    download \
      "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" \
      "$RAW_DIR/locomo/locomo10.json"
    ;;
  beir-scifact)
    download \
      "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip" \
      "$RAW_DIR/beir/scifact.zip"
    ;;
  *)
    echo "Unknown dataset: $dataset" >&2
    usage
    exit 1
    ;;
esac

echo "Downloaded $dataset into $RAW_DIR"
