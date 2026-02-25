/**
 * Calculate the number of business days (weekdays) between two dates inclusive.
 */
export function countBusinessDays(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

/**
 * Get all dates between start and end (inclusive) as ISO date strings.
 */
export function getDateRange(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]!);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Calculate consecutive calendar days between two dates (inclusive).
 */
export function consecutiveDays(start: Date, end: Date): number {
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Check if two date ranges overlap.
 */
export function datesOverlap(
  start1: Date, end1: Date,
  start2: Date, end2: Date
): boolean {
  return start1 <= end2 && start2 <= end1;
}
