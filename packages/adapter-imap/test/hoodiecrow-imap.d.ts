declare module "hoodiecrow-imap" {
  interface HoodiecrowServer {
    listen(port: number, host: string, callback: () => void): void;
    close(callback?: () => void): void;
    address(): { port: number };
  }
  export default function hoodiecrow(options?: Record<string, unknown>): HoodiecrowServer;
}
