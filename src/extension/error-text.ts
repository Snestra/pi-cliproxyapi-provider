// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A catch clause hands over unknown, and this only turns it into notice text.
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
