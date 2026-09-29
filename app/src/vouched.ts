// Vouch's Trustdown format (github.com/mitchellh/vouch): one handle per line, an optional
// "platform:" prefix, "-" to denounce, details after a space, "#" comments. Like Vouch's
// check-user, the first matching line wins and a handle without a platform means GitHub.

export const VOUCHED_PATHS = ["VOUCHED.td", ".github/VOUCHED.td"];

export type VouchStatus = "vouched" | "denounced" | "unknown";

export function vouchStatus(text: string, login: string): VouchStatus {
  const wanted = login.toLowerCase();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const denounced = line.startsWith("-");
    const handle = (denounced ? line.slice(1) : line).split(/\s/, 1)[0]!.toLowerCase();
    const colon = handle.indexOf(":");
    const platform = colon === -1 ? "github" : handle.slice(0, colon);
    const name = colon === -1 ? handle : handle.slice(colon + 1);
    if (platform === "github" && name === wanted) return denounced ? "denounced" : "vouched";
  }
  return "unknown";
}
