# Run Worklog in the background on macOS

Worklog can run as a per-user macOS LaunchAgent. When you sign in, `launchd` starts the Node.js server as your user. The agent's `KeepAlive` setting tells macOS to restart the server if it exits. Worklog runs independently of the terminal or Codex session and listens on `127.0.0.1:3737`.

## Install

Use Node.js 22.13 or newer. Stop any copy of Worklog started with `npm start` so the background service can use port 3737. Run this once from the Worklog checkout.

```sh
(
  set -eu
  worklog_dir="$(pwd -P)"
  worklog_node="$(command -v node)"
  worklog_label="com.mucz.agent-log-viewer"
  worklog_plist="$HOME/Library/LaunchAgents/$worklog_label.plist"
  worklog_logs="$HOME/Library/Logs/Worklog"

  test -f "$worklog_dir/server.mjs"
  if [ -e "$worklog_plist" ]; then
    printf 'Worklog LaunchAgent already exists at %s\n' "$worklog_plist" >&2
    exit 1
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$worklog_logs"
  worklog_stage="$(mktemp "$worklog_plist.XXXXXX")"
  trap 'rm -f "$worklog_stage"' EXIT

  plutil -create xml1 "$worklog_stage"
  plutil -insert Label -string "$worklog_label" "$worklog_stage"
  plutil -insert ProgramArguments -array "$worklog_stage"
  plutil -insert ProgramArguments.0 -string "$worklog_node" "$worklog_stage"
  plutil -insert ProgramArguments.1 -string "--disable-warning=ExperimentalWarning" "$worklog_stage"
  plutil -insert ProgramArguments.2 -string "$worklog_dir/server.mjs" "$worklog_stage"
  plutil -insert WorkingDirectory -string "$worklog_dir" "$worklog_stage"
  plutil -insert KeepAlive -bool true "$worklog_stage"
  plutil -insert ThrottleInterval -integer 5 "$worklog_stage"
  plutil -insert EnvironmentVariables -dictionary "$worklog_stage"
  plutil -insert EnvironmentVariables.PORT -string "3737" "$worklog_stage"
  for worklog_key in CODEX_HOME CLAUDE_CONFIG_DIR PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR; do
    if worklog_value="$(printenv "$worklog_key")" && [ -n "$worklog_value" ]; then
      plutil -insert "EnvironmentVariables.$worklog_key" -string "$worklog_value" "$worklog_stage"
    fi
  done
  plutil -insert StandardOutPath -string "$worklog_logs/worklog.log" "$worklog_stage"
  plutil -insert StandardErrorPath -string "$worklog_logs/worklog.err.log" "$worklog_stage"
  plutil -lint "$worklog_stage"
  mv "$worklog_stage" "$worklog_plist"
  launchctl bootstrap "gui/$(id -u)" "$worklog_plist"
)
```

Open [Worklog](http://127.0.0.1:3737). The agent uses absolute paths to Node.js and the checkout. Reinstall the agent if either path changes.

## Check or restart

```sh
launchctl print "gui/$(id -u)/com.mucz.agent-log-viewer"
launchctl kickstart -k "gui/$(id -u)/com.mucz.agent-log-viewer"
```

The first command shows the service state. The second restarts the server, including after updates to its code. Startup and error logs are in `~/Library/Logs/Worklog/`.

## Uninstall

```sh
launchctl bootout "gui/$(id -u)/com.mucz.agent-log-viewer"
rm -f "$HOME/Library/LaunchAgents/com.mucz.agent-log-viewer.plist"
```

`bootout` stops the running service. Removing the plist removes the login entry. If the service is already unloaded, run the second command. Worklog's service logs can be removed separately from `~/Library/Logs/Worklog/`.
