export interface ScrollableElement {
  scrollLeft: number;
  scrollTop: number;
}

interface ScrollPosition {
  left: number;
  top: number;
  anchor: ScrollAnchor | null;
}

interface ScrollAnchor {
  key: string;
  viewportOffset: number;
}

interface ElementRect {
  top: number;
  bottom: number;
}

interface ScrollAnchorElement {
  dataset: { scrollAnchor?: string };
  getBoundingClientRect(): ElementRect;
}

interface AnchorQueryable {
  getBoundingClientRect(): ElementRect;
  querySelectorAll(selector: string): ArrayLike<ScrollAnchorElement>;
}

/** Keeps independent viewport positions for UI sections that are safely rebuilt. */
export class PanelScrollMemory<Section extends string> {
  private readonly positions = new Map<Section, ScrollPosition>();

  capture(section: Section, element: ScrollableElement): void {
    this.positions.set(section, {
      left: element.scrollLeft,
      top: element.scrollTop,
      anchor: captureAnchor(element)
    });
  }

  restore(section: Section, element: ScrollableElement): void {
    const position = this.positions.get(section);
    if (position === undefined) return;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
    restoreAnchor(element, position.anchor);
  }

  clear(): void {
    this.positions.clear();
  }
}

function captureAnchor(element: ScrollableElement): ScrollAnchor | null {
  const queryable = asAnchorQueryable(element);
  if (queryable === null) return null;
  const viewport = queryable.getBoundingClientRect();
  for (const candidate of Array.from(queryable.querySelectorAll("[data-scroll-anchor]"))) {
    const key = candidate.dataset.scrollAnchor;
    if (!key) continue;
    const bounds = candidate.getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
    return { key, viewportOffset: bounds.top - viewport.top };
  }
  return null;
}

function restoreAnchor(element: ScrollableElement, anchor: ScrollAnchor | null): void {
  if (anchor === null) return;
  const queryable = asAnchorQueryable(element);
  if (queryable === null) return;
  const viewport = queryable.getBoundingClientRect();
  const candidate = Array.from(queryable.querySelectorAll("[data-scroll-anchor]")).find(
    (item) => item.dataset.scrollAnchor === anchor.key
  );
  if (candidate === undefined) return;
  const currentOffset = candidate.getBoundingClientRect().top - viewport.top;
  element.scrollTop = Math.max(0, element.scrollTop + currentOffset - anchor.viewportOffset);
}

function asAnchorQueryable(element: ScrollableElement): AnchorQueryable | null {
  const candidate = element as ScrollableElement & Partial<AnchorQueryable>;
  return typeof candidate.getBoundingClientRect === "function" &&
    typeof candidate.querySelectorAll === "function"
    ? candidate as ScrollableElement & AnchorQueryable
    : null;
}
