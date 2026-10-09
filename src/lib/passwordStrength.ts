import type { ZxcvbnResult } from "@zxcvbn-ts/core";

export type PasswordStrengthEstimator = (password: string, userInputs: string[]) => ZxcvbnResult;

let estimatorPromise: Promise<PasswordStrengthEstimator> | null = null;

/**
 * Lazily loads zxcvbn and its dictionaries. They are large, so they are
 * split out of the main bundle and loaded once on first use.
 */
export function loadPasswordStrengthEstimator(): Promise<PasswordStrengthEstimator> {
  estimatorPromise ??= (async () => {
    const [{ ZxcvbnFactory }, common, en] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en"),
    ]);
    const zxcvbn = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
    return (password, userInputs) => zxcvbn.check(password, userInputs);
  })();
  return estimatorPromise;
}
