export function validateRecord(record: unknown): unknown;
export function validateRecords(records: unknown[], options?: { contextRecords?: unknown[] }): unknown[];
export function aggregateRecords(records: unknown[], options?: { expectedAttempts?: unknown; contextRecords?: unknown[] }): unknown;
