import type { AgentDetector } from "../agents/AgentDetector";
import type { BindingRecord, ProviderSessionMapping } from "../bindings/types";
import { surfaceKey, type CmuxNotification, type CmuxPreview, type CmuxSnapshot } from "../cmux/types";
import { reduceSessionEvidence } from "../evidence/SessionStateReducer";
import type { SessionEvidence } from "../evidence/types";
import { providerMetadataKey } from "../providers/ProviderMetadataService";
import type { AutomaticProviderSessionMapping } from "../providers/identity/types";
import type {
  ProviderMatchSource,
  ProviderSessionKind,
  ProviderSessionMetadata,
  SessionConversation
} from "../providers/types";
import { isCanonicalUuid, normalizeCanonicalUuid } from "../security/identifiers";
import type { LiveSession, ProviderDetection } from "../state/types";

export interface SessionProjectionInput {
  snapshot: CmuxSnapshot;
  notifications: readonly CmuxNotification[];
  bindings: readonly BindingRecord[];
  providerMappings: readonly ProviderSessionMapping[];
  automaticProviderMappings?: readonly AutomaticProviderSessionMapping[];
  providerMetadata: ReadonlyMap<string, ProviderSessionMetadata>;
  detector: AgentDetector;
  providerEvidence: ReadonlyMap<string, ProviderDetection>;
  previewFor(key: string): CmuxPreview | null;
  evidenceFor(key: string): readonly SessionEvidence[];
}

export function projectLiveSessions(input: SessionProjectionInput): LiveSession[] {
  const liveSurfaces = indexLiveSurfaces(input.snapshot);
  const notificationIndex = new Map<string, CmuxNotification[]>();
  for (const notification of input.notifications) {
    const key = surfaceKey(notification);
    const list = notificationIndex.get(key) ?? [];
    list.push(notification);
    notificationIndex.set(key, list);
  }
  const bindingIndex = new Map(
    input.bindings.map((binding) => [surfaceKey(binding), binding] as const)
  );
  const providerMappingIndex = new Map<string, ExactProviderMapping>();
  const bindingProviderSurfaceIds = new Set<string>();
  const claimedProviderSessions = new Set<string>();
  for (const mapping of input.providerMappings) {
    if (!isCurrentSurface(mapping, liveSurfaces)) continue;
    const providerSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
    if (providerSessionId === null) continue;
    const providerSessionKey = `${mapping.provider}:${providerSessionId}`;
    if (
      providerMappingIndex.has(mapping.surfaceId) ||
      claimedProviderSessions.has(providerSessionKey)
    ) {
      continue;
    }
    providerMappingIndex.set(mapping.surfaceId, {
      workspaceId: mapping.workspaceId,
      paneId: mapping.paneId,
      surfaceId: mapping.surfaceId,
      provider: mapping.provider,
      providerSessionId,
      matchSource: "manual",
      matchConfidence: "high",
      explanation: "The user explicitly matched this exact cmux surface to a provider conversation."
    });
    claimedProviderSessions.add(providerSessionKey);
  }
  for (const mapping of input.automaticProviderMappings ?? []) {
    if (!isCurrentSurface(mapping, liveSurfaces)) continue;
    const providerSessionId = normalizeCanonicalUuid(mapping.providerSessionId);
    if (providerSessionId === null) continue;
    const providerSessionKey = `${mapping.provider}:${providerSessionId}`;
    if (
      providerMappingIndex.has(mapping.surfaceId) ||
      claimedProviderSessions.has(providerSessionKey)
    ) {
      continue;
    }
    providerMappingIndex.set(mapping.surfaceId, {
      workspaceId: mapping.workspaceId,
      paneId: mapping.paneId,
      surfaceId: mapping.surfaceId,
      provider: mapping.provider,
      providerSessionId,
      matchSource: mapping.matchSource,
      matchConfidence: mapping.confidence,
      explanation: mapping.explanation
    });
    claimedProviderSessions.add(providerSessionKey);
  }
  for (const binding of input.bindings) {
    if (
      !isCurrentSurface(binding, liveSurfaces) ||
      providerMappingIndex.has(binding.surfaceId) ||
      (binding.provider !== "claude" && binding.provider !== "codex") ||
      binding.providerSessionId === null ||
      !isCanonicalUuid(binding.providerSessionId)
    ) {
      continue;
    }
    const providerSessionKey = `${binding.provider}:${binding.providerSessionId.toLowerCase()}`;
    if (claimedProviderSessions.has(providerSessionKey)) continue;
    claimedProviderSessions.add(providerSessionKey);
    bindingProviderSurfaceIds.add(binding.surfaceId);
  }

  const sessions: LiveSession[] = [];
  for (const window of input.snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          const key = surfaceKey({ workspaceId: workspace.id, surfaceId: surface.id });
          const preview = input.previewFor(key);
          const titleDetection = input.detector.detect(surface, null);
          const detectedProvider =
            titleDetection.provider === "unknown"
              ? input.providerEvidence.get(key) ?? titleDetection
              : titleDetection;
          const binding = bindingIndex.get(key) ?? null;
          const exactMapping = exactProviderMapping(
            providerMappingIndex.get(surface.id) ?? null,
            workspace.id,
            pane.id,
            surface.id
          );
          const bindingMapping = bindingProviderSurfaceIds.has(surface.id)
            ? exactBindingMapping(binding, workspace.id, pane.id, surface.id)
            : null;
          const mapping = exactMapping ?? bindingMapping;
          const provider = mapping
            ? mappedProvider(mapping)
            : detectedProvider;
          const metadata = mapping
            ? input.providerMetadata.get(providerMetadataKey(mapping.provider, mapping.providerSessionId)) ?? null
            : null;
          const conversation = conversationFor(metadata, mapping, workspace.currentDirectory);
          sessions.push({
            key,
            workspaceId: workspace.id,
            paneId: pane.id,
            surfaceId: surface.id,
            workspaceTitle: workspace.title,
            workspaceIndex: workspace.index,
            paneIndex: pane.index,
            surfaceIndex: surface.indexInPane,
            surfaceTitle: surface.title,
            surfaceType: surface.type,
            currentDirectory: workspace.currentDirectory,
            provider,
            assessment: reduceSessionEvidence(input.evidenceFor(key), input.snapshot.observedAt),
            observedAt: input.snapshot.observedAt,
            notifications: notificationIndex.get(key) ?? [],
            linkedTaskId: binding?.taskId ?? null,
            conversation,
            preview
          });
        }
      }
    }
  }
  return sessions.sort(
    (left, right) =>
      left.workspaceIndex - right.workspaceIndex ||
      left.paneIndex - right.paneIndex ||
      left.surfaceIndex - right.surfaceIndex
  );
}

function indexLiveSurfaces(
  snapshot: CmuxSnapshot
): ReadonlyMap<string, { workspaceId: string; paneId: string }> {
  const liveSurfaces = new Map<string, { workspaceId: string; paneId: string }>();
  for (const window of snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const pane of workspace.panes) {
        for (const surface of pane.surfaces) {
          liveSurfaces.set(surface.id, { workspaceId: workspace.id, paneId: pane.id });
        }
      }
    }
  }
  return liveSurfaces;
}

function isCurrentSurface(
  target: { workspaceId: string; paneId: string; surfaceId: string },
  liveSurfaces: ReadonlyMap<string, { workspaceId: string; paneId: string }>
): boolean {
  const current = liveSurfaces.get(target.surfaceId);
  return current?.workspaceId === target.workspaceId && current.paneId === target.paneId;
}

interface ExactProviderMapping {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  provider: ProviderSessionKind;
  providerSessionId: string;
  matchSource: ProviderMatchSource;
  matchConfidence: "low" | "medium" | "high";
  explanation: string;
}

function exactProviderMapping(
  mapping: ExactProviderMapping | null,
  workspaceId: string,
  paneId: string,
  surfaceId: string
): ExactProviderMapping | null {
  if (
    mapping?.workspaceId !== workspaceId ||
    mapping.paneId !== paneId ||
    mapping.surfaceId !== surfaceId
  ) {
    return null;
  }
  return mapping;
}

function exactBindingMapping(
  binding: BindingRecord | null,
  workspaceId: string,
  paneId: string,
  surfaceId: string
): ExactProviderMapping | null {
  if (
    binding?.workspaceId !== workspaceId ||
    binding.paneId !== paneId ||
    binding.surfaceId !== surfaceId ||
    (binding.provider !== "claude" && binding.provider !== "codex") ||
    binding.providerSessionId === null ||
    !isCanonicalUuid(binding.providerSessionId)
  ) {
    return null;
  }
  const providerSessionId = normalizeCanonicalUuid(binding.providerSessionId);
  if (providerSessionId === null) return null;
  return {
    workspaceId,
    paneId,
    surfaceId,
    provider: binding.provider,
    providerSessionId,
    matchSource: "task-binding",
    matchConfidence: "medium",
    explanation: "The attached task records this provider conversation ID for the exact cmux surface."
  };
}

function mappedProvider(mapping: ExactProviderMapping): ProviderDetection {
  return {
    provider: mapping.provider,
    confidence: mapping.matchConfidence,
    source: providerDetectionSource(mapping.matchSource),
    explanation: mapping.explanation,
    sessionId: mapping.providerSessionId
  };
}

function providerDetectionSource(
  source: ProviderMatchSource
): ProviderDetection["source"] {
  return source === "manual" ? "provider-session-mapping" : source;
}

function conversationFor(
  metadata: ProviderSessionMetadata | null,
  mapping: ExactProviderMapping | null,
  currentDirectory: string | null
): SessionConversation | null {
  if (
    !metadata ||
    !mapping ||
    currentDirectory === null ||
    metadata.provider !== mapping.provider ||
    normalizeCanonicalUuid(metadata.sessionId) !== mapping.providerSessionId ||
    metadata.cwd !== currentDirectory
  ) {
    return null;
  }
  return {
    ...metadata,
    sessionId: mapping.providerSessionId,
    matchSource: mapping.matchSource,
    matchConfidence: mapping.matchConfidence
  };
}
