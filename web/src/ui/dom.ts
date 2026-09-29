import { localDate, localTime, utcTime } from "../format.ts";

/**
 * What a page shows. The markup names its parts with data attributes:
 * - `data-show="a b"` / `data-hide="a b"`: shown only in, or hidden in, those states;
 * - `data-if="flag"`: shown only while the flag is on;
 * - `data-text="name"` and `<a data-href="name">`: filled from the view;
 * - `<time data-time="name">` shows local time, or only the date with `data-date-only`, with UTC in its tooltip;
 * - `data-action="name"`: a button the page handles; with `data-busy-label`, it can show progress. Buttons
 *   inside `data-self-managed` are left to the page.
 */
export interface View {
  state: string;
  flags: Record<string, boolean>;
  text: Record<string, string>;
  times: Record<string, Date>;
  hrefs: Record<string, string>;
  /** Actions in progress: their buttons show a spinner and their busy label. */
  busy: Set<string>;
  /** Actions that can't run now. */
  disabled: Set<string>;
}

export function newView(state: string): View {
  return { state, flags: {}, text: {}, times: {}, hrefs: {}, busy: new Set(), disabled: new Set() };
}

const buttonContent = new WeakMap<HTMLElement, Node[]>();

function words(value: string | undefined): string[] | null {
  return value === undefined ? null : value.split(/\s+/).filter(Boolean);
}

export function render(view: View, root: Document = document): void {
  root.documentElement.dataset.state = view.state;
  root.documentElement.dataset.rendered = "";
  for (const el of root.querySelectorAll<HTMLElement>("[data-show], [data-hide], [data-if]")) {
    const show = words(el.dataset.show);
    const hide = words(el.dataset.hide);
    const flag = el.dataset.if;
    el.hidden =
      (show !== null && !show.includes(view.state)) ||
      (hide !== null && hide.includes(view.state)) ||
      (flag !== undefined && !view.flags[flag]);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-text]")) {
    const value = view.text[el.dataset.text!];
    if (value !== undefined && el.textContent !== value) el.textContent = value;
  }
  for (const el of root.querySelectorAll<HTMLTimeElement>("time[data-time]")) {
    const date = view.times[el.dataset.time!];
    if (!date) continue;
    el.dateTime = date.toISOString();
    el.textContent = el.dataset.dateOnly === undefined ? localTime(date) : localDate(date);
    el.title = utcTime(date);
  }
  for (const el of root.querySelectorAll<HTMLAnchorElement>("a[data-href]")) {
    const href = view.hrefs[el.dataset.href!];
    if (href) el.href = href;
    else el.removeAttribute("href");
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    if (button.closest("[data-self-managed]")) continue;
    const action = button.dataset.action!;
    const busy = view.busy.has(action) && button.dataset.busyLabel !== undefined;
    button.disabled = busy || view.disabled.has(action);
    if (busy && !buttonContent.has(button)) {
      buttonContent.set(button, [...button.childNodes]);
      const spinner = root.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      button.replaceChildren(spinner, button.dataset.busyLabel!);
    } else if (!busy && buttonContent.has(button)) {
      button.replaceChildren(...buttonContent.get(button)!);
      buttonContent.delete(button);
    }
  }
}

/** Calls `handle` with the action of any `data-action` button or link that is clicked. */
export function onAction(handle: (action: string, element: HTMLElement) => void, root: Document = document): void {
  root.addEventListener("click", (event) => {
    const element = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!element || (element as HTMLButtonElement).disabled) return;
    event.preventDefault();
    handle(element.dataset.action!, element);
  });
}

/** Moves focus to the first heading or button of the card now shown, for keyboard and screen reader users. */
export function focusState(root: Document = document): void {
  const card = root.querySelector<HTMLElement>(
    `.card[data-show~="${root.documentElement.dataset.state}"]:not([hidden])`,
  );
  const target = card?.querySelector<HTMLElement>("h2, [role=status]");
  if (target && !target.contains(root.activeElement)) {
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
}
