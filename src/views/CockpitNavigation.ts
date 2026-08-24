export const COCKPIT_SECTIONS = ["work", "agents", "cmux"] as const;

export type CockpitSection = (typeof COCKPIT_SECTIONS)[number];

export function sectionForNavigationKey(
  current: CockpitSection,
  key: string
): CockpitSection | null {
  if (key === "Home") return "work";
  if (key === "End") return "cmux";
  if (key === "ArrowLeft") return previousSection[current];
  if (key === "ArrowRight") return nextSection[current];
  return null;
}

const previousSection: Record<CockpitSection, CockpitSection> = {
  work: "cmux",
  agents: "work",
  cmux: "agents"
};

const nextSection: Record<CockpitSection, CockpitSection> = {
  work: "agents",
  agents: "cmux",
  cmux: "work"
};
