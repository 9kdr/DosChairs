import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { ClipChoice } from "@/effects/EffectMaker";
import { PiecesShelf } from "@/effects/PiecesShelf";
import { cn } from "@/lib/utils";
import type { ChangesetItem } from "@chair/timeline-ir";
import type { PieceLanding } from "@/effects/effect-model";
import { AssetShelf } from "./AssetShelf";

export type ShelfKind = "all" | "media" | "pieces" | "sounds";

const KINDS: { id: ShelfKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "media", label: "Media" },
  { id: "pieces", label: "Pieces" },
  { id: "sounds", label: "Sounds" },
];

type ShelfProps = {
  className?: string;
  projectId: string;
  clips?: ClipChoice[];
  onApplyPiece?: (item: ChangesetItem) => string | null;
  onUndoPiece?: (itemId: string) => void;
  onOpenHistory?: () => void;
  pieceRefusal?: string | null;
  landings?: Record<string, PieceLanding>;
  onRecordLanding?: (specId: string, landing: PieceLanding) => void;
  /** Open the Effect Maker as a full page, from the Create button. */
  onCreate: () => void;
};

/**
 * The one Shelf: the assets list and the pieces list as they are,
 * under one kind filter. All stacks both; Media and Sounds scope
 * the assets list; Pieces shows the pieces list alone.
 */
export function Shelf({
  className,
  projectId,
  clips = [],
  onApplyPiece,
  onUndoPiece,
  onOpenHistory,
  pieceRefusal = null,
  landings,
  onRecordLanding,
  onCreate,
}: ShelfProps) {
  const [kind, setKind] = useState<ShelfKind>("all");
  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col gap-3", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Tabs
          value={kind}
          onValueChange={(value) => setKind(value as ShelfKind)}
          className="min-w-0"
        >
          <TabsList size="sm" aria-label="Shelf filter">
            {KINDS.map((item) => (
              <TabsTab key={item.id} value={item.id}>
                {item.label}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto shrink-0"
          title="Open the Effect Maker"
          onClick={onCreate}
        >
          <PlusIcon />
          Create
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        {kind === "pieces" ? (
          <section
            aria-label="Pieces"
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card bg-card p-4 text-neutral-100"
          >
            <PiecesShelf
              clips={clips}
              onApplyPiece={onApplyPiece}
              onUndoPiece={onUndoPiece}
              onOpenHistory={onOpenHistory}
              refusal={pieceRefusal}
              landings={landings}
              onRecordLanding={onRecordLanding}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            />
          </section>
        ) : kind === "media" ? (
          <AssetShelf
            projectId={projectId}
            kindScope="media"
            title="Media"
            className="min-h-0 flex-1"
          />
        ) : kind === "sounds" ? (
          <AssetShelf
            projectId={projectId}
            kindScope="sounds"
            title="Sounds"
            className="min-h-0 flex-1"
          />
        ) : (
          <>
            <AssetShelf projectId={projectId} className="min-h-0 flex-1" />
            <section
              aria-label="Pieces"
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card bg-card p-4 text-neutral-100"
            >
              <PiecesShelf
                clips={clips}
                onApplyPiece={onApplyPiece}
                onUndoPiece={onUndoPiece}
                onOpenHistory={onOpenHistory}
                refusal={pieceRefusal}
                landings={landings}
                onRecordLanding={onRecordLanding}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
