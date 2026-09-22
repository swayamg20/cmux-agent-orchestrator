const REPOSITORY_URL = "https://github.com/swayamg20/cmux-agent-orchestrator";

export const FEEDBACK_LINKS = {
  documentation: `${REPOSITORY_URL}/blob/main/SUPPORT.md`,
  bug: `${REPOSITORY_URL}/issues/new?template=bug.yml`,
  compatibility: `${REPOSITORY_URL}/issues/new?template=compatibility.yml`,
  idea: `${REPOSITORY_URL}/discussions/new?category=ideas`,
  question: `${REPOSITORY_URL}/discussions/new?category=q-a`,
  security: `${REPOSITORY_URL}/security/advisories/new`
} as const;

export type FeedbackLinkKind = keyof typeof FEEDBACK_LINKS;
