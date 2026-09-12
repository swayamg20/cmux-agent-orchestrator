export interface ScrollableElement {
  scrollLeft: number;
  scrollTop: number;
}

interface ScrollPosition {
  left: number;
  top: number;
}

/** Keeps independent viewport positions for UI sections that are safely rebuilt. */
export class PanelScrollMemory<Section extends string> {
  private readonly positions = new Map<Section, ScrollPosition>();

  capture(section: Section, element: ScrollableElement): void {
    this.positions.set(section, {
      left: element.scrollLeft,
      top: element.scrollTop
    });
  }

  restore(section: Section, element: ScrollableElement): void {
    const position = this.positions.get(section);
    if (position === undefined) return;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
  }

  clear(): void {
    this.positions.clear();
  }
}
