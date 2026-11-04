/**
 * The pill drag image: a dot plus a label on a dark chip. Task tiles and
 * shelf rows share it, so every drag into the command bar looks the same
 * instead of falling back to the browser's translucent row snapshot.
 */
export function setPillDragImage(dataTransfer: DataTransfer, label: string, dot: string): void {
  const ghost = document.createElement("div");
  const mark = document.createElement("span");
  mark.style.cssText = `width:8px;height:8px;border-radius:999px;background:${dot};flex:none`;
  const name = document.createElement("span");
  name.textContent = label.length > 28 ? `${label.slice(0, 18)}…` : label;
  name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  ghost.append(mark, name);
  ghost.style.cssText = [
    "position:fixed",
    "top:-1000px",
    "left:0",
    "z-index:80",
    "display:inline-flex",
    "align-items:center",
    "gap:8px",
    "max-width:220px",
    "padding:6px 10px",
    "border-radius:10px",
    "border:1px solid rgb(255 255 255 / 12%)",
    "background:#2a2a2a",
    "color:#f5f5f5",
    "font:500 13px/1.2 ui-sans-serif,system-ui,sans-serif",
    "box-shadow:inset 0 1px 0 rgb(255 255 255 / 10%), 0 10px 24px rgb(0 0 0 / 35%)",
  ].join(";");
  document.body.appendChild(ghost);
  dataTransfer.setDragImage(ghost, 16, 16);
  // The browser snapshots the node during dragstart; drop it right after.
  window.setTimeout(() => ghost.remove(), 0);
}
