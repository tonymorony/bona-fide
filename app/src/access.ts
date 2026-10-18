import type { GitHub, Permission, Repo } from "./ports.ts";

/** Write, maintain or admin access: what it takes to merge. GitHub reports maintain as write, and triage as read. */
export function canPush(permission: Permission): permission is "admin" | "write" {
  return permission === "admin" || permission === "write";
}

/**
 * Whether the last to add `label` to the PR or issue can push. Triage access is enough to add a
 * label, so the label alone isn't a Maintainer's word.
 */
export async function maintainerAdded(
  github: Pick<GitHub, "labeledBy" | "permissionOf">,
  repo: Repo,
  number: number,
  label: string,
): Promise<boolean> {
  const by = await github.labeledBy(repo, number, label);
  return by !== null && canPush(await github.permissionOf(repo, by));
}
