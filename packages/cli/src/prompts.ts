import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const readline = createInterface({ input, output });
  try {
    const suffix = defaultValue === undefined ? "" : ` (${defaultValue})`;
    const answer = (await readline.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    readline.close();
  }
}

export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  const answer = (await prompt(`${question} [y/N]`, defaultValue ? "y" : "n")).toLowerCase();
  return answer === "y" || answer === "yes";
}

export async function select<T extends string>(
  question: string,
  choices: readonly T[],
  defaultValue?: T,
): Promise<T> {
  const list = choices.map((choice, index) => `${index + 1}) ${choice}`).join("  ");
  for (;;) {
    const answer = await prompt(
      `${question}\n${list}`,
      defaultValue ? String(choices.indexOf(defaultValue) + 1) : "1",
    );
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    console.log("Choose one listed option.");
  }
}
