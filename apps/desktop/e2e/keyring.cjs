// Loaded into the app's main process on Linux, before the app's own code (`electron -r`).
// Playwright's loader, which runs first, sets Chromium's `--password-store=basic`, and with it the
// app would refuse to save a password: it does not accept the plain-text store. A switch on the
// command line cannot undo that, because the loader appends its own after it. This names the
// Secret Service (GNOME Keyring) again, which is what a person's desktop gives the app.
require("electron").app.commandLine.appendSwitch("password-store", "gnome-libsecret");
