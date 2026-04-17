/** Returns the local calendar date as YYYY-MM-DD, using the browser/device timezone. */
export function localDateString(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

export function normalizeDate(input: string | null | undefined): string {
  if (!input) {
    return new Date().toISOString().slice(0, 10);
  }

  const parsed = new Date(`${input}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date format. Use YYYY-MM-DD.");
  }
  return input;
}

export function assertIsoDateTime(value: string, fieldName: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}. Expected ISO date-time string.`);
  }
}
