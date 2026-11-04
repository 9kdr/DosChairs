/**
 * The `@` picker's lists, app-wide: footage on the timeline, project
 * assets, pieces, and plan board items. Pure selectors read the shapes
 * the existing fetchers return; one hook loads them all when the picker
 * opens. Nothing here edits those modules.
 */
import { useEffect, useState } from "react";
import type { Timeline } from "@chair/timeline-ir";
import { fetchPieces, type PieceInfo } from "@/effects/pieces-api";
import type { ChairRef } from "@/lib/chair-ref";
import { fetchPlan, type BoardItem } from "@/orchestrator/plan-api";
import { fetchProjectAssets, type ShelfAsset } from "@/project/assets";
import { fetchProjectReview } from "@/project/review";

export type ReferenceGroupId = "footage" | "assets" | "pieces" | "plan";

export type ReferenceOption = {
  ref: ChairRef;
  /** One grey word after the name: the track, the kind, the summary. */
  detail: string;
};

export type ReferenceGroups = Record<ReferenceGroupId, ReferenceOption[]>;

export const REFERENCE_GROUP_LABEL: Record<ReferenceGroupId, string> = {
  footage: "Footage on the timeline",
  assets: "Assets",
  pieces: "Pieces",
  plan: "Plan references",
};

export const EMPTY_GROUPS: ReferenceGroups = { footage: [], assets: [], pieces: [], plan: [] };

/** Every video-track clip in the cut, the way the shell lists apply targets. */
export function clipsOfTimeline(timeline: Timeline | null): ReferenceOption[] {
  if (!timeline) return [];
  return timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) =>
      track.clips.map(
        (clip): ReferenceOption => ({
          ref: { kind: "clip", id: clip.id, label: clip.name },
          detail: track.name,
        }),
      ),
    );
}

export function assetsOfListing(assets: ShelfAsset[]): ReferenceOption[] {
  return assets.map(
    (asset): ReferenceOption => ({
      ref: { kind: "asset", id: asset.id, label: asset.name },
      detail: asset.kind,
    }),
  );
}

export function piecesOfListing(pieces: PieceInfo[]): ReferenceOption[] {
  return pieces.map(
    (piece): ReferenceOption => ({
      ref: { kind: "piece", id: piece.id, label: piece.name },
      detail: piece.kind,
    }),
  );
}

/**
 * Board items as the agent reads them: `board:<id>` refs, the same form
 * the pieces catalogue uses for `@title` lookups.
 */
export function boardOfPlan(board: BoardItem[]): ReferenceOption[] {
  return board.map(
    (item): ReferenceOption => ({
      ref: { kind: "plan", id: `board:${item.id}`, label: item.title },
      detail: item.kind,
    }),
  );
}

export type ReferenceSection = { id: ReferenceGroupId; label: string; options: ReferenceOption[] };

/** Filter every group by a substring of the name; empty groups drop out. */
export function searchReferences(
  groups: ReferenceGroups,
  query: string,
  perGroup = 5,
): ReferenceSection[] {
  const needle = query.trim().toLowerCase();
  const sections: ReferenceSection[] = [];
  for (const id of ["footage", "assets", "pieces", "plan"] as const) {
    const options = groups[id]
      .filter((option) => needle === "" || option.ref.label.toLowerCase().includes(needle))
      .slice(0, perGroup);
    if (options.length > 0) sections.push({ id, label: REFERENCE_GROUP_LABEL[id], options });
  }
  return sections;
}

export type ReferenceLists = { groups: ReferenceGroups; loading: boolean };

/**
 * Load every @ list once while the picker is open. Each fetch fails
 * into an empty group, so one closed service never blanks the rest.
 */
export function useReferenceOptions(projectId: string | null, active: boolean): ReferenceLists {
  const [groups, setGroups] = useState<ReferenceGroups>(EMPTY_GROUPS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    void (async () => {
      const [pieces, assets, plan, review] = await Promise.all([
        fetchPieces("", { limit: 50, signal }).catch((): PieceInfo[] => []),
        projectId ? fetchProjectAssets(projectId, { signal }).catch(() => null) : null,
        projectId ? fetchPlan(projectId, { signal }).catch(() => null) : null,
        projectId ? fetchProjectReview(projectId, { signal }).catch(() => null) : null,
      ]);
      if (signal.aborted) return;
      setGroups({
        footage: clipsOfTimeline(review?.timeline ?? null),
        assets: assetsOfListing(assets?.assets ?? []),
        pieces: piecesOfListing(pieces),
        plan: boardOfPlan(plan?.front.board ?? []),
      });
      setLoading(false);
    })();
    return () => controller.abort();
  }, [projectId, active]);

  return { groups, loading };
}
