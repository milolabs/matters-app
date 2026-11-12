import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";
import solid from "vite-plugin-solid";

// Workspace packages are TypeScript sources: bundle them instead of externalizing.
const bundleWorkspace = {
  exclude: [
    "@matters/adapter-autoconfig",
    "@matters/adapter-claude-code",
    "@matters/adapter-codex",
    "@matters/adapter-compose",
    "@matters/adapter-files",
    "@matters/adapter-filetext",
    "@matters/adapter-imap",
    "@matters/adapter-mime",
    "@matters/adapter-ollama",
    "@matters/adapter-publicsuffix",
    "@matters/adapter-secrets",
    "@matters/adapter-smtp",
    "@matters/adapter-sqlite",
    "@matters/contracts",
    "@matters/core",
    "@matters/testkit",
  ],
};

export default defineConfig(({ command }) => ({
  // main also builds the backend: `import "../backend/main.ts?modulePath"` emits it as a
  // separate entry and yields its file path for utilityProcess.fork (ADR 0005).
  main: {
    build: {
      externalizeDeps: bundleWorkspace,
      // node:sqlite is a prefix-only builtin; never let the bundler try to resolve it.
      rollupOptions: { external: ["node:sqlite"] },
    },
  },
  preload: {
    build: {
      externalizeDeps: bundleWorkspace,
      // A sandboxed preload cannot be an ES module.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    // Dev only: the page's module graph is transformed while Electron starts, so the page finds it
    // ready (ADR 0103, rule 6: the page's script starts ~175 ms sooner).
    server: {
      warmup: { clientFiles: ["./main.tsx"] },
    },
    build: {
      rollupOptions: {
        // preview.html is the frame that shows the message to be sent (its own, looser policy).
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
          // The settings window (ADR 0036).
          settings: resolve(import.meta.dirname, "src/renderer/settings.html"),
          preview: resolve(import.meta.dirname, "src/renderer/preview.html"),
          // A message as sent, with images blocked or allowed (ADR 0024).
          mail: resolve(import.meta.dirname, "src/renderer/mail.html"),
          "mail-images": resolve(import.meta.dirname, "src/renderer/mail-images.html"),
        },
      },
    },
    plugins: [solid(), tailwindcss(), csp(command === "serve")],
  },
}));

// The page ships one strict policy. The dev server needs inline styles and a websocket for HMR.
function csp(dev: boolean) {
  const prod =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
    // Frames only from our own origin: the sandboxed preview page. Scripts and styles stay as strict.
    "frame-src 'self'";
  const relaxed = `${prod
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace("connect-src 'none'", "connect-src ws://localhost:*")}`;
  return {
    name: "matters-csp",
    transformIndexHtml: (html: string) => html.replace("__CSP__", dev ? relaxed : prod),
  };
}
