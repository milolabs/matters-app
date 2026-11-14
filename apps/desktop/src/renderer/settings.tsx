import { createSignal, For, type JSX, Show } from "solid-js";
import { AboutSection } from "./aboutSection.tsx";
import type { AccountsStore } from "./accounts.ts";
import { AccountsSection } from "./accountsSection.tsx";
import { takeSettingsSection, watchSettingsSection } from "./agentPrefs.ts";
import { AgentSection } from "./agentSection.tsx";
import { AppearanceSection } from "./appearanceSection.tsx";
import type { Backend } from "./client.ts";
import { onSettingsSection } from "./files.ts";
import { ImagesSection } from "./imagesSection.tsx";
import { createReleaseStore } from "./newerVersion.ts";
import { NotificationsSection } from "./notificationsSection.tsx";
import { StorageSection } from "./storageSection.tsx";

/** Room for the traffic lights above the list; elsewhere the frame has them. */
const mac = navigator.userAgent.includes("Macintosh");

/** The settings window: its sections down the side, the chosen one beside them (ADR 0036). */
export function Settings(props: { backend: Backend; accounts: AccountsStore }) {
  const release = createReleaseStore();
  // A new section is one more entry here.
  const sections: readonly {
    id: string;
    label: string;
    view: () => JSX.Element;
    dot?: () => boolean;
  }[] = [
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
    {
      id: "appearance",
      label: "Appearance",
      view: () => (
        <AppearanceSection backend={props.backend} onAgents={() => setActive("agents")} />
      ),
    },
    { id: "images", label: "Images", view: () => <ImagesSection backend={props.backend} /> },
    {
      id: "storage",
      label: "Storage",
      view: () => <StorageSection backend={props.backend} accounts={props.accounts} />,
    },
    // Last in the list, with the gear's dot beside it while a newer version is unseen (ADR 0137).
    {
      id: "about",
      label: "About",
      view: () => <AboutSection release={release} />,
      dot: () => release.info()?.dot === true,
    },
  ];
  const known = (id: string | null) => (sections.some((s) => s.id === id) ? id : null);
  // The mail window can open Settings on a section (the plans line links to Agents); main can too,
  // in the address it opens the window at, or by message once it is open (the menu's About item).
  const asked = () => known(takeSettingsSection());
  const fromMain = known(new URLSearchParams(location.search).get("section"));
  const [active, setActive] = createSignal(fromMain ?? asked() ?? sections[0]?.id);
  watchSettingsSection(() => {
    const id = asked();
    if (id !== null) setActive(id);
  });
  onSettingsSection((id) => {
    if (known(id) !== null) setActive(id);
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
              <Show when={section.dot?.()}>
                <span
                  data-newer-dot
                  aria-hidden="true"
                  class="float-right mt-3 size-1.5 rounded-full bg-ink"
                />
              </Show>
            </button>
          )}
        </For>
      </nav>
      <main class="min-w-0 flex-1">{sections.find((s) => s.id === active())?.view()}</main>
    </div>
  );
}
