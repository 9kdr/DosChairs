import type { ChangesetItem } from "@chair/timeline-ir";
import type { PieceLanding } from "../effects/effect-model";
import type { ClipChoice } from "../effects/EffectMaker";
import { PiecesShelf } from "../effects/PiecesShelf";

export type CreationBoardProps = {
  /** Clips an effect-kind piece can land on. */
  clips: ClipChoice[];
  onApplyEffect: (item: ChangesetItem) => string | null;
  onUndoEffect: (itemId: string) => void;
  onOpenHistory: () => void;
  refusal: string | null;
  landings?: Record<string, PieceLanding>;
  onRecordLanding?: (specId: string, landing: PieceLanding) => void;
};

/**
 * Pieces: the one shelf of macros, effects, motion, and sound. Opening or
 * creating an effect-kind piece shows the Effect Maker editor. Applies
 * land on a copy and show in History.
 */
export function CreationBoard(props: CreationBoardProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-4 pb-[9.5rem]">
      <PiecesShelf
        clips={props.clips}
        onApplyPiece={props.onApplyEffect}
        onUndoPiece={props.onUndoEffect}
        onOpenHistory={props.onOpenHistory}
        refusal={props.refusal}
        landings={props.landings}
        onRecordLanding={props.onRecordLanding}
      />
    </div>
  );
}
