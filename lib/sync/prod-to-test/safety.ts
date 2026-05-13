export class SafetyError extends Error {}

export interface SafetyInput {
  prodUrl: string;
  testUrl: string;
  prodHostHint: string | undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function assertEnvSafe(input: SafetyInput): void {
  if (!input.prodUrl || !input.testUrl) {
    throw new SafetyError("PROD_DATABASE_URL and DATABASE_URL must both be set");
  }
  if (input.prodUrl === input.testUrl) {
    throw new SafetyError(
      "PROD_DATABASE_URL must not equal DATABASE_URL — refusing to write to prod"
    );
  }
  if (input.prodHostHint && input.prodHostHint.trim() !== "") {
    const testHost = hostOf(input.testUrl);
    if (testHost.includes(input.prodHostHint)) {
      throw new SafetyError(
        `DATABASE_URL host "${testHost}" looks like prod (matched hint "${input.prodHostHint}")`
      );
    }
  }
}
