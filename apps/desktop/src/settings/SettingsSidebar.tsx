import {
  KeyRoundIcon,
  ClapperboardIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useState, type FocusEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  moveSectionIndex,
  SECTIONS,
  type SectionId,
} from "./sections";

const SECTION = "[data-settings-section]";

const SECTION_ICON = {
  keys: KeyRoundIcon,
  editors: ClapperboardIcon,
  preferences: SlidersHorizontalIcon,
} as const;

/**
 * One Tab stop for the whole sidebar; arrows move focus without
 * opening a section, Enter/Space opens. After t3code's
 * useSettingsSectionNavigation, minus the page concept.
 */
function useSectionNavigation(current: SectionId) {
  const [focused, setFocused] = useState<{
    section: SectionId;
    page: SectionId;
  } | null>(null);
  const tabStop = focused?.page === current ? focused.section : current;

  const remember = (element: HTMLElement) => {
    const section = element.dataset.settingsSection;
    if (
      section === "keys" ||
      section === "editors" ||
      section === "preferences"
    ) {
      setFocused({ section, page: current });
    }
  };

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.matches(SECTION)
    ) {
      remember(event.target);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(event.target instanceof HTMLElement) ||
      !event.target.matches(SECTION)
    ) {
      return;
    }
    // Sections are leaves, not a tree: Left and Right do nothing.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(SECTION),
    );
    const next = moveSectionIndex(
      items.length,
      items.indexOf(event.target),
      event.key,
    );
    const target = next == null ? undefined : items[next];
    if (!target) return;
    event.preventDefault();
    remember(target);
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
  };

  const tabIndexFor = (section: SectionId) => (section === tabStop ? 0 : -1);
  return { containerProps: { onFocus, onKeyDown }, tabIndexFor };
}

type SettingsSidebarProps = {
  current: SectionId;
  onSelect: (section: SectionId) => void;
};

/** Section list for settings. The active row brightens with a 1px line. */
export function SettingsSidebar({ current, onSelect }: SettingsSidebarProps) {
  const { containerProps, tabIndexFor } = useSectionNavigation(current);
  return (
    <nav aria-label="Settings sections" {...containerProps}>
      <ul className="flex flex-col gap-0.5">
        {SECTIONS.map((section) => {
          const Icon = SECTION_ICON[section.id];
          const active = section.id === current;
          return (
            <li key={section.id}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-settings-section={section.id}
                tabIndex={tabIndexFor(section.id)}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(section.id)}
                className={cn(
                  "h-8 w-full justify-start px-2.5 font-normal",
                  active ? "text-neutral-100" : "text-neutral-400",
                )}
              >
                <Icon aria-hidden="true" />
                <span
                  className={cn(
                    "border-b pb-px",
                    active ? "border-emerald-400" : "border-transparent",
                  )}
                >
                  {section.label}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
