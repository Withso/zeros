#!/bin/sh
# Source from every Conductor/native hook, before invoking Node or pnpm.
zeros_dev_node_ready() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 18 ? 0 : 1)' >/dev/null 2>&1
}
zeros_dev_select_tools() {
  zeros_dev_original_path="$PATH"
  for zeros_dev_bin in "$HOME/.zeros-dev/tools/bin" /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
    if [ -x "$zeros_dev_bin/node" ] && zeros_dev_node_ready "$zeros_dev_bin/node"; then
      PATH="$zeros_dev_bin:$HOME/.zeros-dev/tools/bin:$zeros_dev_original_path"; export PATH; return 0
    fi
  done
  zeros_dev_saved_ifs="$IFS"; IFS=:
  for zeros_dev_bin in $zeros_dev_original_path; do
    IFS="$zeros_dev_saved_ifs"
    if [ -n "$zeros_dev_bin" ] && [ -x "$zeros_dev_bin/node" ] && zeros_dev_node_ready "$zeros_dev_bin/node"; then
      PATH="$zeros_dev_bin:$HOME/.zeros-dev/tools/bin:$zeros_dev_original_path"; export PATH; return 0
    fi
  done
  IFS="$zeros_dev_saved_ifs"
  echo 'Zeros Dev requires qualified Node 22.18+ in the 22.x line. Install Node 22, then retry.' >&2
  return 1
}
