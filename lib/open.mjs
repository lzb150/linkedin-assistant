// Cross-platform "open this file/URL in the default app". Best-effort,
// never throws — opening a browser is a convenience, not a requirement.
import { execFile as nodeExecFile } from "node:child_process";

export function openCommand(target, platform) {
  if (platform === "darwin") return ["open", [target]];
  return ["xdg-open", [target]];
}

export function openPath(target, { platform = process.platform, exec = nodeExecFile } = {}) {
  const [cmd, args] = openCommand(target, platform);
  try { exec(cmd, args, () => {}); } catch {}
}
