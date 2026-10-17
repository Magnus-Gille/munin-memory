import { randomUUID } from "node:crypto";

// Only deliberate application validation belongs in a client response. Keep the
// original message separately so error-like objects/getters cannot impersonate
// trusted validation or make exception handling itself fail.
const publicMessages = new WeakMap<object, string>();

export class PublicValidationError extends Error {
  constructor(message: string) {
    super(message);
    publicMessages.set(this, message);
  }
}

export function getPublicValidationMessage(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? publicMessages.get(error)
    : undefined;
}

/** Stage must be a server-owned label, never request data or exception text. */
export function reportUnexpectedError(stage: string): string | undefined {
  let reference: string | undefined;
  try {
    reference = randomUUID();
    process.stderr.write(`[munin] ${stage}; error_reference=${reference}\n`);
  } catch {
    // Diagnostic output must not change a successful write, primary error, or
    // independently degrading optional section. No exception inspection here.
  }
  return reference;
}
