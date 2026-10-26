#!/bin/bash
set -euo pipefail

rn_script="$REACT_NATIVE_PATH/scripts/react-native-xcode.sh"
if [[ "$CONFIGURATION" == *Debug* ]]; then
  /bin/bash "$rn_script"
  exit 0
fi

# Always build current source and use Hermes for distributable configurations.
export USE_HERMES=true
export FORCE_BUNDLING=1
unset SKIP_BUNDLING
unset SOURCEMAP_FILE
export EXTRA_PACKAGER_ARGS="${EXTRA_PACKAGER_ARGS:-} --minify true"
/bin/bash "$rn_script"

compiler="${HERMES_CLI_PATH:-$PODS_ROOT/hermes-engine/destroot/bin/hermesc}"
bundle="$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle"
"$compiler" -emit-binary -O -g0 -fstrip-function-names \
  -out "$bundle" "$CONFIGURATION_BUILD_DIR/main.jsbundle"
if [[ -f "$bundle.map" ]]; then
  echo 'error: Source maps must not be packaged in the wallet.' >&2
  exit 1
fi
