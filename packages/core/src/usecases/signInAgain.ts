import { CredentialsUnavailableError, SignInEndedError, scrubSecrets } from "../domain/errors.ts";
import {
  InvalidAccountError,
  incomingTarget,
  OutgoingServerError,
  outgoingTarget,
} from "./accounts.ts";
import {
  AccountNotFoundError,
  type NewPasswordDeps,
  type NewPasswordResult,
} from "./newPassword.ts";

export interface SignInAgainDeps extends NewPasswordDeps {
  /**
   * The accounts whose sign-in was refused (ADR 0113, rule 4). A new sign-in that both servers
   * took ends the mark, as a verified new password does.
   */
  readonly rejected?: { clear(accountId: string): void };
}

/**
 * *Sign in again* for an account that signs in through the browser (ADR 0133, rule 11): the
 * counterpart of `setNewPassword` (ADR 0113). `signIn` is the handle of a browser sign-in main
 * holds (rule 6). The incoming server must take its token, and the outgoing one must not refuse
 * it (ADR 0113, rule 3), before the vault moves it to the account in one atomic write; until
 * then the stored tokens are untouched. On any failure the handle's sign-in is dropped. Errors
 * never contain the token. The servers, the user names and every local message stay as they
 * are; the caller reconnects (ADR 0113, rule 5).
 */
export async function signInAgain(
  deps: SignInAgainDeps,
  input: { readonly accountId: string; readonly signIn: string },
): Promise<NewPasswordResult> {
  const handle = input.signIn;
  try {
    const result = await verifyAndMove(deps, input.accountId, handle);
    deps.rejected?.clear(input.accountId);
    return result;
  } catch (error) {
    await deps.credentials.delete(handle).catch(() => {});
    throw error;
  }
}

async function verifyAndMove(
  deps: SignInAgainDeps,
  accountId: string,
  handle: string,
): Promise<NewPasswordResult> {
  if (handle === "" || handle === accountId) throw new SignInEndedError();
  const account = await deps.accounts.get(accountId);
  if (!account) throw new AccountNotFoundError();

  const availability = await deps.credentials.availability();
  if (!availability.available) throw new CredentialsUnavailableError(availability.reason);

  const credential = await deps.credentials.get(handle);
  if (credential?.kind !== "oauth2") throw new SignInEndedError();
  // The new sign-in must be for the entry the account uses (ADR 0136, rule 3).
  if ((account.transport === "graph") !== (credential.provider === "microsoftGraph")) {
    throw new InvalidAccountError("That sign-in was made for another kind of account");
  }
  const secrets = [credential.accessToken];
  try {
    const connection = await deps.connector.connect(incomingTarget(account, credential));
    await connection.close().catch(() => {});
  } catch (error) {
    throw withoutSecrets(error, secrets);
  }

  let outgoing: NewPasswordResult["outgoing"] = { state: "none" };
  const target = outgoingTarget(account, credential);
  if (target) {
    // One token serves both servers: both scopes belong to one resource (rule 9). Over Graph the
    // check asks for the Sent Items folder (ADR 0136, rule 9).
    const check = await deps.outgoing.verify(target);
    if (check.ok) outgoing = { state: "verified" };
    else if (check.kind === "auth") {
      throw new OutgoingServerError("auth", scrubSecrets(check.reason, secrets), check.detail);
    } else outgoing = { state: "unchecked", reason: scrubSecrets(check.reason, secrets) };
  }

  try {
    await deps.credentials.move(handle, account.id);
  } catch (error) {
    throw withoutSecrets(error, secrets);
  }
  return { account, outgoing };
}

function withoutSecrets(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return new Error(scrubSecrets(String(error), secrets));
  const clean = scrubSecrets(error.message, secrets);
  if (clean !== error.message) error.message = clean;
  return error;
}
