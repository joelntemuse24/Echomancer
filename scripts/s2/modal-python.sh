# Resolve a Python that can import modal.
#
# MODAL_PYTHON wins when it is set. Otherwise the first python3 or python on
# PATH whose `import modal` succeeds. A miss exits 1 with a message. This
# does not guess a system python that lacks the package: the Contabo
# worker's python3 is that python, and `ModuleNotFoundError: modal` is how
# post-deploy cover used to stop.

resolve_modal_python() {
  if [ -n "${MODAL_PYTHON:-}" ]; then
    if [ ! -x "$MODAL_PYTHON" ]; then
      echo "MODAL_PYTHON=$MODAL_PYTHON is not an executable file." >&2
      return 1
    fi
    if ! "$MODAL_PYTHON" -c "import modal" >/dev/null 2>&1; then
      echo "MODAL_PYTHON=$MODAL_PYTHON cannot import modal." >&2
      return 1
    fi
    printf '%s\n' "$MODAL_PYTHON"
    return 0
  fi
  local dir name candidate
  local ifs_old="$IFS"
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    for name in python3 python; do
      candidate="$dir/$name"
      if [ -x "$candidate" ] && "$candidate" -c "import modal" >/dev/null 2>&1; then
        IFS="$ifs_old"
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  done
  IFS="$ifs_old"
  echo "No Python on PATH can import modal. Set MODAL_PYTHON to that interpreter." >&2
  return 1
}
