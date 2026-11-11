import hoodiecrow from "hoodiecrow-imap";

const BASE_PLUGINS = [
  "ID",
  "ENABLE",
  "CONDSTORE",
  "MOVE",
  "UIDPLUS",
  "SPECIAL-USE",
  "CREATE-SPECIAL-USE",
  "LITERALPLUS",
  "UNSELECT",
  "ESEARCH",
  "COMPRESS",
];

/** An in-process IMAP server (MIT, scriptable) on a free port. Login: testuser / testpass. */
export async function startHoodiecrow(plugins: readonly string[], storage?: object) {
  const server = hoodiecrow({
    plugins: [...BASE_PLUGINS, ...plugins],
    ...(storage ? { storage } : {}),
  });
  // The address clients connect to. On every interface, port 0 can pick a number another process
  // holds on 127.0.0.1 (macOS allows both), and that process gets our clients.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    credentials: {
      host: "127.0.0.1",
      port: server.address().port,
      user: "testuser",
      pass: "testpass",
    },
    stop: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}
