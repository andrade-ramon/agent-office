import type { AgentKind, ToolCategory } from '../schema.js';

const CLAUDE_TOOLS: Record<string, ToolCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  ReadMcpResourceTool: 'read',
  ListMcpResourcesTool: 'read',
  TaskOutput: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  PowerShell: 'bash',
  BashOutput: 'bash',
  KillBash: 'bash',
  KillShell: 'bash',
  Monitor: 'bash',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  LSP: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'plan',
  Task: 'plan',
  TodoWrite: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan',
  TaskGet: 'plan',
  TaskStop: 'plan',
  AskUserQuestion: 'plan',
  SendMessage: 'plan',
  ListAgents: 'plan',
  Workflow: 'plan',
};

const CODEX_TOOLS: Record<string, ToolCategory> = {
  Bash: 'bash',
  exec: 'bash',
  shell: 'bash',
  shell_command: 'bash',
  local_shell: 'bash',
  exec_command: 'bash',
  unified_exec: 'bash',
  write_stdin: 'bash',
  container_exec: 'bash',
  apply_patch: 'edit',
  Edit: 'edit',
  Write: 'write',
  read_file: 'read',
  view_image: 'read',
  list_dir: 'search',
  grep_files: 'search',
  tool_search: 'search',
  file_search: 'search',
  web_search: 'web',
  WebSearch: 'web',
  update_plan: 'plan',
  spawn_agent: 'plan',
  Agent: 'plan',
  send_message: 'plan',
  send_input: 'plan',
  wait_agent: 'plan',
  wait: 'plan',
  close_agent: 'plan',
  resume_agent: 'plan',
  request_user_input: 'plan',
};

const WEB_SERVER = /browser|chrome|playwright|puppeteer|fetch|web|search|firecrawl|tavily|exa\b/i;

function byHeuristic(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (/(^|[_\-.])(bash|shell|exec|terminal|command|powershell|run_command)([_\-.]|$)/.test(n)) return 'bash';
  if (/web|fetch|browser|navigate|http|url|screenshot/.test(n)) return 'web';
  if (/patch|edit|replace|update_file|str_replace/.test(n)) return 'edit';
  if (/write|create_file|save/.test(n)) return 'write';
  if (/search|grep|glob|find|query|list|(^|_)ls($|_)/.test(n)) return 'search';
  if (/read|view|open|cat|get_|fetch_file|download/.test(n)) return 'read';
  if (/plan|todo|task|agent|think/.test(n)) return 'plan';
  return 'other';
}

/** Classifica uma ferramenta em uma das categorias do escritório. */
export function categorizeTool(agent: AgentKind, toolName: string | undefined): ToolCategory {
  if (!toolName) return 'other';
  const table = agent === 'claude' ? CLAUDE_TOOLS : CODEX_TOOLS;
  const direct = table[toolName];
  if (direct) return direct;

  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    const server = mcp[1] ?? '';
    const tool = mcp[2] ?? '';
    if (WEB_SERVER.test(server)) return 'web';
    return byHeuristic(tool);
  }
  return byHeuristic(toolName);
}
