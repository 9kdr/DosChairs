import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "motion/react";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { AssetShelf } from "./AssetShelf";
import { parseAction } from "./actions";
import { PlanDoc } from "./PlanDoc";
import { RunningTasks, type RunningTask } from "./RunningTasks";

/**
 * Three small independent motions, each cheap: columns ease widths on a
 * plain CSS transition, the plan wrapper tweens real height, and the tasks
 * panel crossfades between slots. Nothing tracks position, so every frame
 * is opacity plus one width pass.
 */
const MORPH = "380ms cubic-bezier(0.22, 1, 0.36, 1)";
const GAP = 20; // gap-4 at the 20px root
const MIN_LEFT_IDLE = 320; // 16rem at the 20px root
const MIN_RIGHT_EDIT = 360; // 18rem at the 20px root

type PlanMode = "edit" | "talk";

type OrchestratorBoardProps = {
  command?: { id: number; text: string } | null;
  onOpenTask?: (task: RunningTask) => void;
  onUndoTask?: (task: RunningTask) => void;
};

function columnWidths(available: number, editing: boolean) {
  const total = Math.max(0, Math.round(available) - GAP);
  if (editing) {
    const right = Math.max(MIN_RIGHT_EDIT, Math.round((total * 0.85) / 2.4));
    return { left: Math.max(0, total - right), right };
  }
  const left = Math.max(MIN_LEFT_IDLE, Math.round((total * 0.78) / 2.13));
  return { left, right: Math.max(0, total - left) };
}

export function OrchestratorBoard({
  command = null,
  onOpenTask,
  onUndoTask,
}: OrchestratorBoardProps) {
  const [planOpen, setPlanOpen] = useState(false);
  const [planMode, setPlanMode] = useState<PlanMode>("edit");
  const [notice, setNotice] = useState<string | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const seen = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const editing = planOpen && planMode === "edit";
  const box = available == null ? null : columnWidths(available, editing);
  const morph = reduce ? "none" : `width ${MORPH}`;

  // Steady states are unchanged: idle tasks show iff the plan is closed,
  // edit tasks iff editing.
  const side = editing ? "edit" : planOpen ? "none" : "idle";

  // One always-mounted tasks panel, teleported between the columns. Never
  // unmounting means its four WebGL shaders are compiled once and never
  // again — no recompile hitch in the middle of the animation. Relocation
  // is a quick fade out, container swap, fade in.
  const [slots, setSlots] = useState<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({
    left: null,
    right: null,
  });
  const setLeftSlot = useCallback((el: HTMLDivElement | null) => {
    setSlots((current) => (current.left === el ? current : { ...current, left: el }));
  }, []);
  const setRightSlot = useCallback((el: HTMLDivElement | null) => {
    setSlots((current) => (current.right === el ? current : { ...current, right: el }));
  }, []);
  const wantSlot = side === "edit" ? "right" : "left";
  const [liveSlot, setLiveSlot] = useState<"left" | "right">(wantSlot);
  const [lit, setLit] = useState(true);
  // The fade-in timer must survive the re-render caused by the container
  // swap, so it lives outside the effect cleanup: clearing it there (as
  // before) cancels the fade-in and leaves the panel invisible forever.
  const showRef = useRef(0);
  useEffect(() => {
    if (reduce) {
      setLiveSlot(wantSlot);
      setLit(true);
      return;
    }
    if (wantSlot === liveSlot) return;
    window.clearTimeout(showRef.current);
    setLit(false);
    const move = window.setTimeout(() => {
      setLiveSlot(wantSlot);
      showRef.current = window.setTimeout(() => setLit(true), 40);
    }, 160);
    return () => window.clearTimeout(move);
  }, [liveSlot, reduce, wantSlot]);
  useEffect(() => () => window.clearTimeout(showRef.current), []);
  const slotContainer = liveSlot === "left" ? slots.left : slots.right;

  // The plan card swaps between a short closed card and a tall editor.
  // Tween the wrapper's real height on the same ease: content reveals
  // instead of squashing, and siblings ride the reflow. While it runs, the
  // task shaders hold their frame so no canvas rebuilds happen mid-flight.
  // Column widths ease on a CSS transition over the same window; the shelf
  // locks its indicator transitions for the duration so the highlight
  // tracks 1:1 instead of rubber-banding behind the tabs.
  const [planTweening, setPlanTweening] = useState(false);
  const [widthTweening, setWidthTweening] = useState(false);
  const firstEditing = useRef(true);
  useEffect(() => {
    if (firstEditing.current) {
      firstEditing.current = false;
      return;
    }
    if (reduce) return;
    setWidthTweening(true);
    const timer = window.setTimeout(() => setWidthTweening(false), 380);
    return () => window.clearTimeout(timer);
  }, [editing, reduce]);
  const planWrapRef = useRef<HTMLDivElement>(null);
  const planFromRef = useRef<number | null>(null);
  const trackPlanHeight = () => {
    const el = planWrapRef.current;
    planFromRef.current = el ? el.getBoundingClientRect().height : null;
  };
  const handlePlanOpen = (mode: PlanMode) => {
    trackPlanHeight();
    setPlanMode(mode);
    setPlanOpen(true);
  };
  const handlePlanClose = () => {
    trackPlanHeight();
    setPlanOpen(false);
  };
  useLayoutEffect(() => {
    const el = planWrapRef.current;
    const from = planFromRef.current;
    planFromRef.current = null;
    if (!el || from == null || reduce) return;
    const to = el.getBoundingClientRect().height;
    if (Math.abs(to - from) < 2) return;
    el.style.overflow = "hidden";
    setPlanTweening(true);
    const tween = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 380,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
    tween.onfinish = () => {
      el.style.overflow = "";
      setPlanTweening(false);
    };
    return () => {
      tween.cancel();
      el.style.overflow = "";
      setPlanTweening(false);
    };
  }, [planOpen, planMode, reduce]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      const width = Math.round(scroller.getBoundingClientRect().width - 32);
      setAvailable((current) => (current === width ? current : width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!command || seen.current === command.id) return;
    seen.current = command.id;
    const action = parseAction(command.text);
    if (!action) return;
    if (action.key === "brief") {
      setPlanMode("edit");
      setPlanOpen(true);
      setNotice(null);
      return;
    }
    if (action.key === "accept") {
      setPlanOpen(false);
      setNotice("Accepted. The timeline is unchanged.");
      return;
    }
    if (action.key === "again") {
      setNotice("Another pass, same rules.");
      return;
    }
    if (action.slot) setNotice(`${action.key}: ${action.slot}`);
  }, [command]);

  return (
    <>
      <div ref={scrollerRef} className="h-full overflow-x-hidden overflow-y-auto p-4 pb-[9.5rem]">
        <div className="flex min-h-full items-stretch gap-4">
        <div
          className="flex min-h-0 min-w-0 shrink-0 flex-col gap-4"
          style={
            box
              ? { width: box.left, transition: morph }
              : {
                  flexBasis: 0,
                  flexGrow: editing ? 1.55 : 0.78,
                  minWidth: editing ? 0 : MIN_LEFT_IDLE,
                }
          }
        >
          <div
            ref={planWrapRef}
            className={planOpen ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-col"}
          >
            <PlanDoc
              open={planOpen}
              mode={planMode}
              onOpen={handlePlanOpen}
              onClose={handlePlanClose}
              notice={notice}
            />
          </div>
          <div ref={setLeftSlot} className="contents" data-tasks-slot="idle" />
        </div>
        <div
          className="flex min-h-0 min-w-0 shrink-0 flex-col gap-4"
          style={
            box
              ? { width: box.right, transition: morph }
              : {
                  flexBasis: 0,
                  flexGrow: editing ? 0.85 : 1.35,
                  minWidth: editing ? MIN_RIGHT_EDIT : 0,
                }
          }
        >
          <AssetShelf
            className="min-h-0 flex-1"
            transitionLock={widthTweening || planTweening}
          />
          <div ref={setRightSlot} className="contents" data-tasks-slot="edit" />
        </div>
      </div>
      {slotContainer == null
        ? null
        : createPortal(
            <div
              style={{
                display: side === "none" ? "none" : "",
                opacity: lit ? 1 : 0,
                transition: reduce ? "none" : "opacity 160ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            >
              <RunningTasks
                onOpen={onOpenTask}
                onUndo={onUndoTask}
                frozen={planTweening}
              />
            </div>,
            slotContainer,
          )}
      </div>
      <SmoothScrollTarget target={scrollerRef} lerp={0.075} />
    </>
  );
}
