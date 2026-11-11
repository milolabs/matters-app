import { createSignal, For, type JSX } from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import { AccountsSection } from "./accountsSection.tsx";
import { takeSettingsSection, watchSettingsSection } from "./agentPrefs.ts";
import { AgentSection } from "./agentSection.tsx";
import type { Backend } from "./client.ts";
import { ImagesSection } from "./imagesSection.tsx";
import { NotificationsSection } from "./notificationsSection.tsx";
import { StorageSection } from "./storageSection.tsx";

/** Room for the traffic lights above the list; elsewhere the frame has them. */
const mac = navigator.userAgent.includes("Macintosh");

/** The settings window: its sections down the side, the chosen one beside them (ADR 0036). */
export function Settings(props: { backend: Backend; accounts: AccountsStore }) {
  // A new section is one more entry here.
  const sections: readonly { id: string; label: string; view: () => JSX.Element }[] = [
    {
      id: "accounts",
      label: "Accounts",
      view: () => (
        <AccountsSection
          backend={props.backend}
          accounts={props.accounts}
          onClose={() => window.close()}
        />
      ),
    },
    {
      id: "agents",
      label: "Agents",
      view: () => <AgentSection backend={props.backend} accounts={props.accounts} />,
    },
    {
      id: "notifications",
      label: "Notifications",
      view: () => <NotificationsSection backend={props.backend} accounts={props.accounts} />,
    },
    { id: "images", label: "Images", view: () => <ImagesSection backend={props.backend} /> },
    {
      id: "storage",
      label: "Storage",
      view: () => <StorageSection backend={props.backend} accounts={props.accounts} />,
    },
  ];
  // The mail window can open Settings on a section (the plans line links to Agents).
  const asked = () => {
    const id = takeSettingsSection();
    return sections.some((s) => s.id === id) ? id : null;
  };
  const [active, setActive] = createSignal(asked() ?? sections[0]?.id);
  watchSettingsSection(() => {
    const id = asked();
    if (id !== null) setActive(id);
  });

  return (
    <div class="flex h-full">
      <nav
        aria-label="Settings"
        class="drag flex w-[188px] shrink-0 flex-col gap-0.5 border-r border-hairline bg-chrome px-2.5"
        classList={{ "pt-[52px]": mac, "pt-3": !mac }}
      >
        <For each={sections}>
          {(section) => (
            <button
              type="button"
              aria-current={active() === section.id ? "page" : undefined}
              class="h-[30px] cursor-default truncate rounded-[7px] px-2.5 text-left text-[13px]"
              classList={{
                "bg-selected font-medium": active() === section.id,
                "text-mid hover:bg-fill": active() !== section.id,
              }}
              onClick={() => setActive(section.id)}
            >
              {section.label}
            </button>
          )}
        </For>
      </nav>
      <main class="min-w-0 flex-1">{sections.find((s) => s.id === active())?.view()}</main>
    </div>
  );
}
