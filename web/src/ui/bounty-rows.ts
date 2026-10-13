import type { BountyRow } from "../bounty.ts";
import { shortAddress, usdc } from "../format.ts";
import { explorerTx, itemUrl } from "../link.ts";

const METHODS = {
  keeper: "by Bona Fide",
  signature: "by the Maintainer's signature",
  owner: "by the Maintainer",
} as const;

/**
 * Draws Bounties into a table body from its `<template data-bounty-row>`: the issue, the amount, how it
 * ended, and its latest transaction. With `cancel`, open rows show their Cancel button.
 */
export function drawBountyRows(
  body: HTMLTableSectionElement,
  template: HTMLTemplateElement,
  rows: BountyRow[],
  { repo, explorerUrl, cancel }: { repo: string; explorerUrl: string; cancel?: { busy: Set<string> } },
): void {
  const drawn = rows.map((b) => {
    const row = template.content.firstElementChild!.cloneNode(true) as HTMLTableRowElement;
    const cell = (name: string) => row.querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
    const issue = cell("issue") as HTMLAnchorElement;
    issue.textContent = `Issue #${b.issue}`;
    issue.href = itemUrl({ repo, kind: "issue", number: b.issue });
    cell("amount").textContent = usdc(b.amount);
    const tag = cell("tag");
    const hash = b.closedTx ?? b.postedTx;
    const tx = cell("tx") as HTMLAnchorElement;
    tx.textContent = shortAddress(hash);
    tx.href = explorerTx({ explorerUrl }, hash);
    tx.setAttribute("aria-label", `Transaction ${hash}`);
    if (b.status === "open") {
      tag.textContent = "Open";
      tag.classList.add("accent");
      const button = row.querySelector<HTMLButtonElement>('[data-action="cancel-row"]');
      if (button && cancel) {
        button.hidden = false;
        button.dataset.issue = String(b.issue);
        button.setAttribute("aria-label", `Cancel the Bounty on issue #${b.issue}`);
        button.disabled = cancel.busy.size > 0;
        if (cancel.busy.has(`cancel:${b.issue}`)) button.textContent = "Waiting for your wallet";
      }
    } else if (b.status === "paid") {
      tag.textContent = "Paid";
      cell("detail").textContent = `to ${shortAddress(b.payee!)}${b.method ? `, ${METHODS[b.method]}` : ""}`;
    } else {
      tag.textContent = "Cancelled";
      tag.classList.add("neutral");
    }
    return row;
  });
  body.replaceChildren(...drawn);
}
