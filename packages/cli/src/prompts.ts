import * as prompts from "@clack/prompts";

export class PromptCancelledError extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "PromptCancelledError";
  }
}

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

type TextValidator = (value: string) => string | undefined;

function result<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    prompts.cancel("Setup cancelled.");
    throw new PromptCancelledError();
  }
  return value;
}

export function startPromptSession(): void {
  prompts.intro("Chatpack init");
}

export async function prompt(
  question: string,
  defaultValue?: string,
  validate?: TextValidator,
): Promise<string> {
  return result(
    await prompts.text({
      message: question,
      ...(defaultValue === undefined ? {} : { placeholder: defaultValue, defaultValue }),
      ...(validate
        ? { validate: (value: string | undefined) => validate(value || defaultValue || "") }
        : {}),
    }),
  );
}

export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  return result(
    await prompts.confirm({
      message: question,
      initialValue: defaultValue,
    }),
  );
}

export async function select<T extends string>(
  question: string,
  choices: readonly (T | SelectChoice<T>)[],
  defaultValue?: T,
): Promise<T> {
  return result(
    await prompts.select<string>({
      message: question,
      options: choices.map((choice) =>
        typeof choice === "string"
          ? { value: choice, label: choice, hint: "" }
          : {
              value: choice.value,
              label: choice.label,
              hint: choice.hint ?? "",
            },
      ),
      ...(defaultValue ? { initialValue: defaultValue } : {}),
    }),
  ) as T;
}
