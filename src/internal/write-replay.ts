export const WRITE_REPLAY_TOOLS: readonly string[] = [
  "memory_write", "memory_log", "memory_update_status",
];
export const WRITE_REPLAY_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const WRITE_REPLAY_HEADER = "X-Munin-Write-Replay";
export const WRITE_REPLAY_VERSION = "v1";
