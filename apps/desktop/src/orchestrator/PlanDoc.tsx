import { Tabs } from "@base-ui/react/tabs";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { WarmTooltip, WarmTooltipGroup } from "./WarmTooltip";

type DocId = "brief" | "b-roll" | "captions";

const linkClass =
  "text-neutral-100 underline decoration-neutral-500 underline-offset-[0.18em] hover:decoration-neutral-100 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400";

const tabClass = cn(
  "rounded-full px-3 py-1 text-sm tracking-tight text-neutral-500 outline-none transition-colors",
  "hover:text-neutral-200",
  "focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1a1a]",
  "data-active:bg-white/12 data-active:text-neutral-50 data-active:shadow-raised data-active:ring-1 data-active:ring-white/16",
);

const bodyClass = "mt-2 max-w-prose space-y-4 text-[0.9375rem] leading-6";

const DOC_TIPS: Record<DocId, string> = {
  brief: "Story and objective",
  "b-roll": "Shots held off the A-roll",
  captions: "Words for the trailer",
};

function DocLink({
  doc,
  children,
  onOpen,
}: {
  doc: DocId;
  children: ReactNode;
  onOpen: (doc: DocId) => void;
}) {
  return (
    <WarmTooltip
      label={DOC_TIPS[doc]}
      render={
        <a
          href={`#${doc}`}
          className={linkClass}
          onClick={(event) => {
            event.preventDefault();
            onOpen(doc);
          }}
        >
          {children}
        </a>
      }
    />
  );
}

function DocTab({ id, children }: { id: DocId; children: ReactNode }) {
  return (
    <WarmTooltip
      label={DOC_TIPS[id]}
      render={
        <Tabs.Tab value={id} className={tabClass}>
          {children}
        </Tabs.Tab>
      }
    />
  );
}

export function PlanDoc() {
  const [doc, setDoc] = useState<DocId>("brief");

  return (
    <WarmTooltipGroup>
      <article
        aria-label="Plan"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[28px] bg-[#1a1a1a] px-8 py-5 text-neutral-100 shadow-raised ring-1 ring-white/8 sm:px-10"
      >
        <Tabs.Root
          className="flex min-h-0 flex-1 flex-col"
          value={doc}
          onValueChange={(value) => setDoc(value as DocId)}
        >
          <Tabs.List
            aria-label="Documents"
            className="flex w-fit items-center gap-1 rounded-full bg-black/30 p-1 ring-1 ring-white/8"
          >
            <DocTab id="brief">Brief</DocTab>
            <DocTab id="b-roll">B-roll shelf</DocTab>
            <DocTab id="captions">Caption pass</DocTab>
          </Tabs.List>

          <Tabs.Panel value="brief">
            <h1 className="mt-2 max-w-prose text-2xl font-medium tracking-tight">
              Talking head rough-cut
            </h1>
            <p className="mt-1 max-w-prose text-sm text-neutral-400">
              Story and objective
            </p>
            <div className={bodyClass}>
              <p>
                One speaker, one room, cut so the argument lands before the
                viewer looks away. The story opens on a line you can repeat,
                spends the middle earning it, and ends on a pay-off that does
                not need a recap.
              </p>
              <p>
                Leave a rough cut Resolve can still grade. Keep the face on the
                A-roll, park extra shots on the{" "}
                <DocLink doc="b-roll" onOpen={setDoc}>
                  B-roll shelf
                </DocLink>
                , and hold the words for the{" "}
                <DocLink doc="captions" onOpen={setDoc}>
                  caption pass
                </DocLink>
                . The source stays as it was shot.
              </p>
              <p>
                What the other sections inherit: the hook in the first breath,
                a setup that does not wander, and a close that matches this
                brief. Edit, effects, and colour work inside this story.
              </p>
            </div>
          </Tabs.Panel>

          <Tabs.Panel value="b-roll">
            <h1 className="mt-2 max-w-prose text-2xl font-medium tracking-tight">
              B-roll shelf
            </h1>
            <p className="mt-1 max-w-prose text-sm text-neutral-400">
              Shots held off the A-roll
            </p>
            <div className={bodyClass}>
              <p>
                Extra angles, cutaways, and a little room tone sit here until
                the rough cut asks for them. Nothing on this shelf is on the
                timeline yet.
              </p>
              <p>
                The face stays on the A-roll. Pull a shot only when the{" "}
                <DocLink doc="brief" onOpen={setDoc}>
                  brief
                </DocLink>{" "}
                needs a breath, and leave the words for the{" "}
                <DocLink doc="captions" onOpen={setDoc}>
                  caption pass
                </DocLink>
                .
              </p>
            </div>
          </Tabs.Panel>

          <Tabs.Panel value="captions">
            <h1 className="mt-2 max-w-prose text-2xl font-medium tracking-tight">
              Caption pass
            </h1>
            <p className="mt-1 max-w-prose text-sm text-neutral-400">
              Words for the trailer
            </p>
            <div className={bodyClass}>
              <p>
                Lines for the trailer, timed to the hook and the pay-off. This
                pass only places words. The source audio stays as it was shot.
              </p>
              <p>
                Match the{" "}
                <DocLink doc="brief" onOpen={setDoc}>
                  brief
                </DocLink>
                , and do not cover a face that the{" "}
                <DocLink doc="b-roll" onOpen={setDoc}>
                  B-roll shelf
                </DocLink>{" "}
                is still holding back.
              </p>
            </div>
          </Tabs.Panel>
        </Tabs.Root>
      </article>
    </WarmTooltipGroup>
  );
}
