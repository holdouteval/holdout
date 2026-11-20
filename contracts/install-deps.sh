#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
while read -r name repository revision; do
    [[ -n "$name" ]] || continue
    if [[ -f "lib/$name/.revision" ]] && [[ "$(cat "lib/$name/.revision")" == "$revision" ]]; then
        continue
    fi
    stage=$(mktemp -d "lib/.${name}.XXXXXX")
    archive=$(mktemp)
    trap 'rm -rf "$stage"; rm -f "$archive"' EXIT
    curl -4 --fail --silent --show-error --location --connect-timeout 15 --max-time 120 \
        "https://codeload.github.com/$repository/tar.gz/$revision" -o "$archive"
    tar -xzf "$archive" --strip-components=1 -C "$stage"
    printf '%s\n' "$revision" > "$stage/.revision"
    rm -rf "lib/$name"
    mv "$stage" "lib/$name"
    rm -f "$archive"
    trap - EXIT
done < deps.txt
python3 -I script/build-pool-fixture.py
