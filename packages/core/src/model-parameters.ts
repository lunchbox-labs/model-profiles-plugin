import { type ModelChoice, isRecord } from "./models-file.ts";

export function modelParameters(choice: ModelChoice): Record<string, unknown> {
  const parameters = Object.fromEntries(
    Object.entries(choice).filter(([key]) => key !== "model"),
  );
  const redacted: unknown = JSON.parse(
    JSON.stringify(parameters, (key, value: unknown) =>
      /api[_-]?key|secret|password|authorization|cookie|private[_-]?key|^token$|(?:access|refresh|auth|session|bearer|security|id)[_-]?token$/i.test(
        key,
      )
        ? "[redacted]"
        : value,
    ),
  );
  return isRecord(redacted) ? redacted : {};
}
