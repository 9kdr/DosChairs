import { Film, Image, Music, Sparkles, Video, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";

type AssetCategory = "clips" | "stills" | "audio";

type AssetGroup = {
  category: string;
  type: AssetCategory;
  items: string[];
};

type AssetShelfProps = {
  className?: string;
  groups?: AssetGroup[];
};

const DEFAULT_ASSET_GROUPS: AssetGroup[] = [
  {
    category: "Clips",
    type: "clips",
    items: [
      "A001_C004_1024_RAW.mov",
      "interview_sync_take1.mov",
      "b_roll_desk_overhead.mp4",
    ],
  },
  {
    category: "Stills",
    type: "stills",
    items: ["hero_frame_graded.png", "title_card_clean.png"],
  },
  {
    category: "Audio",
    type: "audio",
    items: ["dialogue_clean_stem.wav", "score_temp_v3.mp3"],
  },
];

export function AssetShelf({ className, groups = DEFAULT_ASSET_GROUPS }: AssetShelfProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-[28px] bg-[#1a1a1a] p-5 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film className="size-4 text-neutral-400" />
          <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
            Project Assets
          </h2>
        </div>
        <span className="text-xs text-neutral-400">
          {groups.reduce((acc, g) => acc + g.items.length, 0)} items
        </span>
      </div>

      <div className="flex flex-col gap-3.5">
        {groups.map((group) => {
          const Icon =
            group.type === "clips"
              ? Video
              : group.type === "stills"
                ? Image
                : Music;
          return (
            <div key={group.category} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-400">
                <Icon className="size-3.5" />
                <span>{group.category}</span>
              </div>
              <ul className="flex flex-col gap-1">
                {group.items.map((name) => (
                  <li
                    key={name}
                    className="truncate rounded-xl bg-white/[0.03] px-3 py-1.5 font-mono text-xs text-neutral-200 ring-1 ring-white/[0.04]"
                    title={name}
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ReferenceItem = {
  id: string;
  kind: "video" | "effect";
  title: string;
  detail: string;
};

type ReferenceShelfProps = {
  className?: string;
  references?: ReferenceItem[];
};

const DEFAULT_REFERENCES: ReferenceItem[] = [
  {
    id: "ref-video",
    kind: "video",
    title: "Fincher Match-Cut Pacing",
    detail: "Cold open rhythm & match cuts",
  },
  {
    id: "ref-effect",
    kind: "effect",
    title: "Boris FX Sapphire Glow",
    detail: "Optical diffusion & subtle highlight halation",
  },
];

export function ReferenceShelf({
  className,
  references = DEFAULT_REFERENCES,
}: ReferenceShelfProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-[28px] bg-[#1a1a1a] p-5 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-neutral-400" />
          <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
            Inspiration
          </h2>
        </div>
        <span className="text-xs text-neutral-400">References</span>
      </div>

      <div className="flex flex-col gap-2.5">
        {references.map((item) => {
          const Icon = item.kind === "video" ? Video : Wand2;
          return (
            <div
              key={item.id}
              className="flex items-start gap-3 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.04]"
            >
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-neutral-300">
                <Icon className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-medium text-neutral-100">
                    {item.title}
                  </p>
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-neutral-400">
                    {item.kind === "video" ? "Video ref" : "Effect ref"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-400">
                  {item.detail}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
