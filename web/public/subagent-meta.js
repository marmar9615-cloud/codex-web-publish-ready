export function getThreadSpawnMeta(thread) {
  const source = thread?.source;
  if (!source || typeof source !== "object") return null;
  const subagent = source.subagent;
  if (!subagent || typeof subagent !== "object") return null;
  const threadSpawn = subagent.thread_spawn;
  return threadSpawn && typeof threadSpawn === "object" ? threadSpawn : null;
}

export function getSubagentParentThreadId(thread) {
  return getThreadSpawnMeta(thread)?.parent_thread_id ?? null;
}

export function isSubagentThread(thread) {
  return Boolean(getSubagentParentThreadId(thread));
}

export function subagentThreadLabel(thread) {
  const meta = getThreadSpawnMeta(thread);
  return (
    thread?.agentNickname ??
    meta?.agent_nickname ??
    thread?.agentRole ??
    meta?.agent_role ??
    thread?.name ??
    thread?.preview ??
    thread?.id ??
    "sub-agent"
  );
}
