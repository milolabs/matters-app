/** The only stylesheet of outgoing mail; juice inlines it, mail clients ignore `<style>` blocks. */
export const MAIL_CSS = `
body { margin: 0; padding: 0; }
.matters-body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #1d1d1f; }
.matters-body p { margin: 0 0 12px 0; }
.matters-body ul, .matters-body ol { margin: 0 0 12px 0; padding-left: 24px; }
.matters-body li { margin: 0 0 4px 0; }
.matters-body a { color: #0b5fb3; }
.matters-body blockquote { margin: 0 0 12px 0; padding: 0 0 0 12px; border-left: 3px solid #c9c9c4; color: #6e6e73; }
.matters-body code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; background: #f3f3f1; padding: 1px 4px; border-radius: 3px; }
.matters-body pre { margin: 0 0 12px 0; padding: 8px 12px; background: #f3f3f1; border-radius: 6px; overflow: auto; }
.matters-body pre code { background: none; padding: 0; }
.matters-body table { border-collapse: collapse; margin: 0 0 12px 0; }
.matters-body th, .matters-body td { border: 1px solid #c9c9c4; padding: 4px 10px; text-align: left; }
.matters-body th { background: #f3f3f1; }
.matters-body h1, .matters-body h2, .matters-body h3 { margin: 16px 0 8px 0; line-height: 1.25; }
.matters-body h1 { font-size: 20px; }
.matters-body h2 { font-size: 17px; }
.matters-body h3 { font-size: 15px; }
.matters-body hr { border: 0; border-top: 1px solid #c9c9c4; margin: 16px 0; }
`;
